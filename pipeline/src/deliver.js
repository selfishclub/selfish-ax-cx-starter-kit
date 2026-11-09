/**
 * 문의 하나를 「초안 → 슬랙 카드 → 기록」으로 넘긴다 (2026-10-26 — run.js 에서 떼어 냄)
 *
 * 지키는 것: 카카오 방을 연 문의는 어떤 실패가 나도 잃지 않는다.
 *   - 초안기가 통째로 멈춰도(정책 · 추가 사실 파일 읽기 등) 「확인 필요」 카드로 바꿔 올린다
 *     (AI 호출 실패는 draft.generate 가 이미 「확인 필요」로 바꿔 준다)
 *   - 슬랙에 못 올리면 다시 올릴 목록(store.queueRetry)에 남기고, 다음 바퀴에 그것부터 다시 올린다
 * 개인정보라 이름 · 내용은 로그에 남기지 않는다 — 열쇠(key)와 결과만.
 */

const store = require('./store');
const draft = require('./draft');
const slack = require('./slack');

/** 초안기가 던졌을 때 대신 쓰는 결과 — draft.generate 의 실패 결과와 같은 모양 */
function fallbackDraft(err) {
  return {
    needsHuman: true,
    category: '기타',
    summary: '(초안 생성 실패)',
    draft: '',
    reason: `AI 초안을 만들지 못했습니다: ${String(err?.message || err).split('\n')[0]}`,
    costUsd: null,
  };
}

function recordPosted(inquiry, result, ts) {
  store.record(inquiry.key, {
    source: inquiry.source,
    category: result.category,
    summary: result.summary,
    draft: result.draft,
    needsHuman: result.needsHuman,
    slackTs: ts,
    history: inquiry.history || null,
    freshAt: inquiry.freshAt || null,
  });
}

/** 카드를 올리고 기록한다. 실패하면 다시 올릴 목록에 남기고 false */
async function post(app, inquiry, result) {
  try {
    const ts = await slack.postInquiry(app, inquiry, result);
    recordPosted(inquiry, result, ts);
    store.clearRetry(inquiry.key);
    return true;
  } catch (err) {
    store.queueRetry(inquiry.key, { inquiry, result }, err);
    return false;
  }
}

/**
 * 지난번에 못 올린 카드부터 다시 올린다.
 * @returns {{ retried: number, posted: number, waiting: number }}
 */
async function retryPending(app, log = () => {}) {
  const list = store.retryList();
  let posted = 0;
  for (const item of list) {
    if (store.isSeen(item.key)) { store.clearRetry(item.key); continue; }
    const ok = await post(app, item.inquiry, item.result);
    if (ok) posted++;
    log(`  [${item.key}] 다시 올리기 ${ok ? '성공' : `실패(${item.attempts + 1}번째)`}`);
  }
  return { retried: list.length, posted, waiting: store.retryList().length };
}

/**
 * 새 문의 하나를 처리한다.
 * @returns {Promise<{ ok: boolean, result: object }>}
 */
async function deliver(app, inquiry) {
  let result;
  try {
    result = await draft.generate(inquiry);
  } catch (err) {
    result = fallbackDraft(err);
  }
  const ok = await post(app, inquiry, result);
  return { ok, result };
}

module.exports = { deliver, retryPending, fallbackDraft };
