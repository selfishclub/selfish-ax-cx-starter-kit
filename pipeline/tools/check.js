/**
 * 받은 직후 점검 — 슬랙 · 카카오 없이 「정책 → 초안」 한 바퀴만 돌려 본다.
 *   node tools/check.js            가짜 문의 1건으로 초안 JSON 을 찍는다 (Claude Code 구독 또는 API)
 *   node tools/check.js --prompt   AI 를 부르지 않고 초안기에 들어가는 프롬프트만 보여 준다
 * 아무것도 보내지 않고 아무 기록도 남기지 않는다.
 */
const { config } = require('../src/config');
const draft = require('../src/draft');
const { maskText } = require('../src/mask');

const SAMPLE = {
  source: 'kakao',
  key: 'check:0',
  customerName: '테스트',
  receivedAt: '오늘',
  preview: '다시보기는 언제 올라오나요?',
  body: '[오늘 오후 1:27] 고객: 어제 세미나 다시보기는 언제쯤 올라오나요? 제 번호는 010-1234-5678 이에요',
  context: '[어제 오후 6:40] 고객: 안녕하세요, 오늘 세미나 신청했는데 입장 링크를 못 받았어요\n[어제 오후 6:52] 우리: 안녕하세요! 입장 링크는 신청하실 때 적으신 연락처로 알림톡과 이메일로 보내드렸어요 :)',
  history: { customerMessages: 1, firstDate: '어제' },
};

(async () => {
  console.log(`정책 문서: ${require('fs').existsSync(config.policyFile) ? config.policyFile : `${config.policySampleFile} (샘플)`}`);
  console.log(`새면 안 되는 말: ${config.leakWordsFile}`);
  console.log(`초안 AI: ${config.ai.provider}${config.anthropic.model ? ` (${config.anthropic.model})` : ''} · 우리 이름: ${config.brandName}`);
  console.log(`가리기 확인: ${maskText('홍길동 010-1234-5678 test@example.com 120,000원')}`);
  if (process.argv.includes('--prompt')) {
    console.log('\n── system ──\n' + draft.buildSystem(require('fs').readFileSync(require('fs').existsSync(config.policyFile) ? config.policyFile : config.policySampleFile, 'utf8'), '', '').slice(0, 1500) + '\n…');
    console.log('\n── user ──\n' + draft.buildUser(SAMPLE));
    return;
  }
  console.log('\n초안 생성 중… (Claude Code 구독이면 30초쯤 걸려요)');
  const r = await draft.generate(SAMPLE);
  console.log(JSON.stringify(r, null, 2));
  console.log(r.needsHuman ? '\n→ 「확인 필요」 카드가 됩니다.' : '\n→ 초안 카드가 됩니다. 실제로는 슬랙에서 사람이 버튼을 눌러야 나가요.');
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
