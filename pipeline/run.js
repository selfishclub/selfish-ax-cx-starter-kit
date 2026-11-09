/**
 * CX 파이프라인
 *
 *   카카오/Gmail 수집 → AI 초안 → 슬랙 카드 → 운영자가 승인/수정/건너뛰기
 *
 * 사용법:
 *   node run.js              카카오에서 미읽음 문의를 한 번 가져와 처리하고, 슬랙 버튼을 기다린다
 *   node run.js --watch      15분마다 다시 확인한다 (맥 자동 시작용. 간격은 .env.local 의 CX_WATCH_MINUTES)
 *   node run.js --limit 3    한 번에 처리할 문의 수 제한 (기본 20)
 *   node run.js --sample     가짜 문의 1건으로 전체 흐름 테스트 (카카오 접속 안 함)
 *   node run.js --show       창을 띄워서 카카오 동작 확인 (마우스를 뺏기니 주의)
 *
 * 처리 후에도 프로세스는 계속 떠 있는다. 슬랙 버튼 클릭을 받아야 하기 때문.
 * 종료는 Ctrl+C.
 *
 * 로그인이 풀리면 (2026-09-28)
 *   카카오 세션은 며칠마다 풀린다. 저희가 처음 돌리고 얼마 안 돼 멈춘 진짜 이유였다. 풀리면 운영 알림 채널 에 한 줄 알리고,
 *   다시 로그인(npm run login)될 때까지는 같은 알림을 반복하지 않는다. 프로세스는 죽지 않고 계속 확인한다.
 */

const { config, verify } = require('./src/config');
const store = require('./src/store');
const kakao = require('./src/sources/kakao');
const gmail = require('./src/sources/gmail');
const slack = require('./src/slack');
const deliver = require('./src/deliver');
const { setStatus } = require('./src/status');
const { maskText } = require('./src/mask');

const args = process.argv.slice(2);
const isSample = args.includes('--sample');
const showBrowser = args.includes('--show');
const watch = args.includes('--watch');

// 첫 실행이나 점검할 때 한꺼번에 쏟아지지 않게 제한할 수 있다
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) || 20 : 20;

const SAMPLE = {
  source: 'kakao',
  key: `sample:${Date.now()}`,
  customerName: '테스트',
  receivedAt: '오늘',
  preview: '다시보기는 언제 올라오나요?',
  body: '[2026년 11월 1일 오후 1:27] 고객: 아 네 알림톡 받았어요, 감사합니다! 그런데 어제 세미나 다시보기는 언제쯤 올라오나요?',
  // 앞선 대화 — 실제 수집기가 주는 모양 그대로 (카드에는 요약만 실린다, 2026-11-01)
  context: [
    '[2026년 10월 31일 오후 6:40] 고객: 안녕하세요, 오늘 세미나 신청했는데 입장 링크를 못 받았어요',
    '[2026년 10월 31일 오후 6:52] 우리: 안녕하세요! 입장 링크는 신청하실 때 적으신 연락처로 알림톡과 이메일로 보내드렸어요. 한 번 더 확인 부탁드려요 :)',
  ].join('\n'),
  history: { customerMessages: 1, firstDate: '2026년 10월 31일 금요일' },
  url: '',
  collectedAt: new Date().toISOString(),
};

function now() {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

async function collectAll() {
  if (isSample) {
    console.log('  샘플 모드 — 가짜 문의 1건\n');
    return [SAMPLE];
  }

  const inquiries = [];

  console.log(`  [${now()}] 카카오 채널 확인 중... (최대 ${limit}건)`);
  const fromKakao = await kakao.collect({ headless: !showBrowser, limit });
  console.log(`  카카오: ${fromKakao.length}건`);
  inquiries.push(...fromKakao);

  if (gmail.implemented) {
    const fromGmail = await gmail.collect();
    console.log(`  Gmail: ${fromGmail.length}건`);
    inquiries.push(...fromGmail);
  }

  return inquiries;
}

/** 한 바퀴 — 수집 → 초안 → 카드. 실패해도 던지지 않고 결과만 돌려준다 */
async function runOnce(app, state) {
  let inquiries;
  try {
    inquiries = await collectAll();
  } catch (err) {
    if (err.name === 'SessionExpiredError') {
      state.expiredSince = state.expiredSince || new Date().toISOString();
      await setStatus('cx:collector', { lastCheckAt: new Date().toISOString(), session: 'expired', expiredSince: state.expiredSince, watchMinutes: config.watchMinutes, sendEnabled: process.env.CX_SEND_ENABLED !== 'false' });
      if (!state.sessionAlerted) {
        // 풀린 것을 한 번만 알린다. 다시 로그인되면 아래에서 sessionAlerted 를 되돌린다
        await slack
          .notify(app, `⚠️ 카카오 채널 로그인이 풀렸어요. 문의 수집이 멈춰 있어요 — 키트 폴더에서 \`npm run login\` 을 실행해 다시 로그인해 주세요. (${now()})`)
          .catch((e) => console.error(`  슬랙 알림 실패: ${e.message}`));
        state.sessionAlerted = true;
      }
      console.log(`  [${now()}] 카카오 로그인이 풀렸습니다. 재로그인을 기다립니다.`);
      return;
    }
    console.error(`  [${now()}] 수집 실패: ${err.message.split('\n')[0]}`);
    return;
  }

  state.expiredSince = null;
  if (state.sessionAlerted) {
    state.sessionAlerted = false;
    await slack.notify(app, `✅ 카카오 채널 로그인이 다시 이어졌어요. 문의 수집을 계속해요. (${now()})`).catch(() => {});
  }

  // 지난번에 카드를 못 올린 문의부터 — 그 방은 이미 읽음이라 다시 수집되지 않는다(2026-10-26)
  const retry = await deliver.retryPending(app, (line) => console.log(line));
  if (retry.retried) console.log(`  다시 올리기: ${retry.retried}건 중 ${retry.posted}건 성공 · 남음 ${retry.waiting}건`);

  const fresh = inquiries.filter((i) => !store.isSeen(i.key) && !store.inRetry(i.key));
  const skipped = inquiries.length - fresh.length;

  console.log(`  처리 대상 ${fresh.length}건${skipped > 0 ? ` (이미 올린 ${skipped}건 제외)` : ''}`);

  for (const inquiry of fresh) {
    // 개인정보라 이름·내용은 로그에 남기지 않는다
    process.stdout.write(`  [${inquiry.key}] 초안 생성 중... `);
    // 초안 · 카드가 실패해도 문의를 잃지 않는다 — 실패하면 다시 올릴 목록에 남는다(src/deliver.js)
    const { ok, result } = await deliver.deliver(app, inquiry);
    const cost = result.costUsd ? ` ($${result.costUsd.toFixed(3)})` : '';
    console.log(ok ? `${result.needsHuman ? '확인 필요' : '초안 완료'} → 슬랙 발송${cost}` : '슬랙에 못 올림 → 다음 바퀴에 다시');
  }

  await closeAnsweredInKakao(app, state);

  const s = store.stats();
  console.log(`  누적: 총 ${s.total}건 · 대기 ${s.pending} · 승인 ${s.approved} · 수정 ${s.edited} · 건너뜀 ${s.skipped} · 카카오에서 답함 ${s.direct}`);
  // 대시보드 — 상태 한 줄 + 최근 카드 요약(가림). 표가 없으면 조용히 건너뛴다
  await setStatus('cx:collector', { lastCheckAt: new Date().toISOString(), session: 'ok', unread: inquiries.length, posted: fresh.length, retryWaiting: store.retryList().length, watchMinutes: config.watchMinutes, sendEnabled: process.env.CX_SEND_ENABLED !== 'false', totals: s });
  await setStatus('cx:cards', store.recentCards(30, maskText));
}

/**
 * 카카오 채널에서 직접 답한 문의의 카드를 닫는다 (2026-09-29)
 * 운영자가 슬랙 대신 카카오에서 바로 답하면 카드가 계속 「대기」로 남아 브리핑의 「답 안 한 문의」 숫자가 틀어졌다.
 * 방을 여는 일이라 매번은 하지 않는다 — CX_ANSWER_CHECK_MINUTES(기본 15분)마다, 최근 7일 카드만.
 * 실패해도 수집은 계속된다.
 */
const ANSWER_CHECK_MS = Math.max(5, parseInt(process.env.CX_ANSWER_CHECK_MINUTES || '15', 10) || 15) * 60 * 1000;

async function closeAnsweredInKakao(app, state) {
  if (isSample) return;
  if (state.lastAnswerCheck && Date.now() - state.lastAnswerCheck < ANSWER_CHECK_MS) return;
  state.lastAnswerCheck = Date.now();
  const pending = store.pendingKakao(7);
  if (!pending.length) return;
  let results;
  try {
    results = await kakao.checkAnswered(pending, { headless: !showBrowser });
  } catch (err) {
    console.error(`  [${now()}] 답 확인 건너뜀: ${err.message.split('\n')[0]}`);
    return;
  }
  const answered = results.filter((r) => r.answered);
  for (const r of answered) {
    store.decide(r.key, 'direct');
    const rec = store.get(r.key);
    await slack.markAnsweredInKakao(app, rec?.slackTs, r.at).catch((e) => console.error(`  카드 닫기 실패: ${e.message}`));
  }
  console.log(`  [${now()}] 답 확인: 대기 ${pending.length}건 중 카카오에서 이미 답한 것 ${answered.length}건${answered.length ? ' → 카드 닫음' : ''}`);
}

async function main() {
  verify(isSample ? ['slack', 'ai'] : ['slack', 'ai', 'kakao']);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  CX 파이프라인');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(
    `  초안: ${config.ai.provider === 'cli' ? 'Claude Code 구독' : 'Claude API'} (${config.anthropic.model})`
  );
  console.log(`  방식: ${watch ? `${config.watchMinutes}분마다 확인` : '한 번 확인'}\n`);

  const app = slack.createApp();
  // 승인·수정 저장 → 카카오로 발송 (운영자 9/28). 시험(--sample)에서는 보내지 않는다. 비상 스위치 CX_SEND_ENABLED=false
  slack.registerHandlers(app, { send: isSample ? null : (chatId, text) => kakao.send(chatId, text, { headless: !showBrowser }) });
  console.log(`  발송: ${isSample ? '시험 모드 — 안 보냄' : process.env.CX_SEND_ENABLED === 'false' ? '꺼짐(CX_SEND_ENABLED=false)' : '승인·수정 저장 시 카카오로 보냄'}`);
  await app.start();
  console.log(`슬랙 연결됨 (Socket Mode) → ${config.slack.channel}\n`);

  const state = { sessionAlerted: false };
  await runOnce(app, state);

  if (!watch) {
    console.log('\n슬랙에서 버튼을 눌러주세요. 종료하려면 Ctrl+C.\n');
    return;
  }

  // 반복 — 한 바퀴가 끝난 뒤 N분 쉬고 다시. 겹쳐서 돌지 않는다
  const ms = Math.max(1, config.watchMinutes) * 60 * 1000;
  const loop = async () => {
    await runOnce(app, state);
    setTimeout(loop, ms);
  };
  setTimeout(loop, ms);
  console.log(`\n${config.watchMinutes}분마다 다시 확인합니다. 슬랙 버튼도 계속 받습니다. 종료는 Ctrl+C.\n`);
}

main().catch((err) => {
  console.error('\n오류:', err.message);
  process.exit(1);
});
