/**
 * 문의 처리 상태 저장소
 *
 * 파일 기반(JSON). 어떤 문의를 이미 슬랙에 올렸는지, 초안이 뭐였는지,
 * 운영자가 어떻게 결정했는지를 기록한다.
 *
 * 보안: 고객 개인정보가 들어가므로 cx-data/ 는 .gitignore 처리되어 있다.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const STATE_FILE = path.join(config.dataDir, 'state.json');

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { inquiries: {} };
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
}

function save(state) {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** 이미 슬랙에 올린 문의인지 */
function isSeen(key) {
  return Boolean(load().inquiries[key]);
}

/** 문의 기록 (슬랙 발송 시점) */
function record(key, data) {
  const state = load();
  state.inquiries[key] = {
    ...data,
    recordedAt: new Date().toISOString(),
    decision: null,
  };
  save(state);
}

/** 운영자의 결정 기록 (승인 / 건너뛰기 / 수정 / direct = 카카오에서 직접 답함) */
function decide(key, decision, note) {
  const state = load();
  if (!state.inquiries[key]) return null;
  // sent 는 approve/edit 뒤에 오는 「보냈다」 표시 — 무엇을 보냈는지(edit 의 note)는 남긴다
  if (decision === 'sent') { state.inquiries[key].sentAt = new Date().toISOString(); if (state.inquiries[key].decision === 'edit') { state.inquiries[key].edited = true; } }
  state.inquiries[key].decision = decision;
  state.inquiries[key].decidedAt = new Date().toISOString();
  if (note) state.inquiries[key].note = note;
  save(state);
  return state.inquiries[key];
}

function get(key) {
  return load().inquiries[key] || null;
}

function stats() {
  const all = Object.values(load().inquiries);
  return {
    total: all.length,
    pending: all.filter((i) => !i.decision).length,
    approved: all.filter((i) => i.decision === 'approve' || i.decision === 'sent').length,
    edited: all.filter((i) => i.decision === 'edit').length,
    skipped: all.filter((i) => i.decision === 'skip').length,
    direct: all.filter((i) => i.decision === 'direct').length,
  };
}

/**
 * 아직 결정이 없는 카카오 카드 — 최근 days 일 안에 올라온 것만 (2026-09-29)
 * 「카카오에서 직접 답했나」 확인용. 방 번호는 열쇠(kakao:<방>:<지문>)에서 꺼낸다.
 */
function pendingKakao(days = 7) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return Object.entries(load().inquiries)
    .filter(([key, v]) => key.startsWith('kakao:') && !v.decision && new Date(v.recordedAt || 0).getTime() >= since)
    .map(([key, v]) => ({ key, chatId: key.split(':')[1], freshAt: v.freshAt || null, slackTs: v.slackTs || null }));
}

/**
 * 운영자가 결정한 것 중 「보낸 답」이 있는 최근 n건 — 승인(approve)이면 초안, 수정(edit)이면 고친 문장 (2026-09-28)
 * 초안기가 예시로 읽는다. 시험 카드(sample:)는 뺀다.
 */
function recentDecisions(n = 10) {
  const all = Object.entries(load().inquiries)
    .filter(([key, v]) => !key.startsWith('sample:') && ['approve', 'edit', 'sent'].includes(v.decision))
    .map(([, v]) => ({
      category: v.category || '기타',
      summary: v.summary || '',
      text: v.decision === 'edit' || v.edited ? v.note || v.draft || '' : v.draft || '',
      edited: v.decision === 'edit' || !!v.edited,
      at: v.decidedAt || v.recordedAt || '',
    }))
    .filter((e) => e.text.trim())
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  return all.slice(0, n).map((e) => ({ ...e, category: e.edited ? `${e.category} · 수정` : e.category }));
}

/** 대시보드용 최근 카드 n장 — 유형·요약·결정·시각만. 이름·원문 없음 (요약은 초안기가 쓴 한 줄이라 이름이 섞일 수 있어 가린다) */
function recentCards(n = 30, mask = (t) => t) {
  return Object.entries(load().inquiries)
    .filter(([k]) => !k.startsWith('sample:'))
    .map(([key, v]) => ({
      key, category: v.category || '기타', summary: mask(String(v.summary || '')).slice(0, 120), needsHuman: !!v.needsHuman,
      decision: v.decision || null, recordedAt: v.recordedAt || null, decidedAt: v.decidedAt || null, sentAt: v.sentAt || null,
      history: v.history || null,
    }))
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
    .slice(0, n);
}

/*
 * 다시 올릴 목록 (2026-10-26) — 카드를 못 올린 문의를 잃지 않게.
 *
 * 수집기는 「안 읽은 방」만 연다. 여는 순간 카카오에서 읽음이 되므로, 슬랙에 카드를 못 올리고 아무 기록도 안 남기면
 * 다음 바퀴엔 그 방이 「안 읽음」이 아니어서 고객이 또 말하기 전까지 카드가 생기지 않았다.
 * 실패하면 여기에 문의 · 초안을 남겨 두고, 다음 바퀴에 이것부터 다시 올린다. 개인정보가 있어 state.json(gitignore)에만.
 */

/** 카드를 못 올린 문의를 남긴다 — 이미 있으면 시도 횟수만 늘린다 */
function queueRetry(key, payload, error) {
  const state = load();
  state.retry = state.retry || {};
  const prev = state.retry[key];
  state.retry[key] = {
    ...(prev || {}),
    ...payload,
    attempts: (prev?.attempts || 0) + 1,
    firstFailedAt: prev?.firstFailedAt || new Date().toISOString(),
    lastFailedAt: new Date().toISOString(),
    lastError: String(error?.message || error || '').split('\n')[0].slice(0, 200),
  };
  save(state);
  return state.retry[key];
}

/** 다시 올릴 문의들 — 오래된 것부터 */
function retryList() {
  return Object.entries(load().retry || {})
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (a.firstFailedAt < b.firstFailedAt ? -1 : 1));
}

function inRetry(key) {
  return Boolean((load().retry || {})[key]);
}

function clearRetry(key) {
  const state = load();
  if (state.retry && state.retry[key]) {
    delete state.retry[key];
    save(state);
  }
}

module.exports = { isSeen, record, decide, get, stats, pendingKakao, recentDecisions, recentCards, queueRetry, retryList, inRetry, clearRetry };
