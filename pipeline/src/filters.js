/**
 * 카카오 화면의 「사람이 친 말이 아닌 것」 걸러내기 — pipeline/filters.json 을 읽어 정규식으로 만든다.
 *   MENU  고객 말풍선에 들어온 메뉴 버튼 이름 → 새 문의로 세지 않는다
 *   AUTO  채널 쪽 자동 답장 첫 문장 → 「답했는지」 확인과 말투 예시에서 뺀다
 * 목록이 비어 있으면 아무것도 안 거른다 (파이프라인은 그대로 돈다).
 */
const fs = require('fs');
const { config } = require('./config');

function load() {
  try { return JSON.parse(fs.readFileSync(config.filtersFile, 'utf8')); } catch { return {}; }
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function prefixRegex(list) {
  const items = (list || []).map((s) => String(s).trim()).filter(Boolean).map(esc);
  return items.length ? new RegExp(`^(${items.join('|')})`) : /^(?!)/;
}
const f = load();
module.exports = { MENU: prefixRegex(f.menu), AUTO: prefixRegex(f.auto) };
