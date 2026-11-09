/**
 * 뽑은 대화 이력을 읽기 좋게 가른다 (2026-09-28)
 *
 *   node tools/summarize-history.js --batch 1            통계 + 자동 답장 목록 + 대화(고객 · 운영자 답만)
 *   node tools/summarize-history.js --batch 1 --out 파일  결과를 파일로
 *
 * 가린 사본(masked-N.json)만 읽는다. 채널 쪽 메시지는 이렇게 가른다 —
 *   card      운영시간 카드 · 알림톡 · 브랜드 메시지 (type_card)
 *   template  같은 문장이 corpus 에서 3번 이상 — 자동 답장(챗봇 · 환영 · 부재중)
 *   human     나머지 — 운영자가 직접 친 답
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BATCH = opt('--batch', '1');
const OUTFILE = opt('--out', '');
const file = path.join(config.dataDir, 'history', `masked-${BATCH}.json`);
const rooms = JSON.parse(fs.readFileSync(file, 'utf8'));

const norm = (t) => t.replace(/\s+/g, ' ').replace(/\d{4}년 \d{2}월 \d{2}일 \d{2}:\d{2}/g, '').trim().slice(0, 80);
const freq = new Map();
for (const r of rooms) for (const m of r.messages) if (m.who === 'us' && m.kind !== 'card') freq.set(norm(m.text), (freq.get(norm(m.text)) || 0) + 1);
// 메뉴 버튼을 누른 고객 말은 진짜 질문이 아니다 — 목록은 pipeline/filters.json
const { MENU } = require('../src/filters');
const label = (m) => m.who === 'customer' ? (MENU.test(m.text.trim()) ? 'menu' : 'customer') : m.kind === 'card' || /type_card/.test(m.cls) ? 'card' : (freq.get(norm(m.text)) || 0) >= 3 ? 'template' : 'human';

const L = [];
const stat = { customer: 0, menu: 0, card: 0, template: 0, human: 0 };
for (const r of rooms) for (const m of r.messages) stat[label(m)]++;
L.push(`# ${BATCH}묶음 — 방 ${rooms.length} · 메시지 ${Object.values(stat).reduce((a, b) => a + b, 0)}`);
L.push(`고객 말 ${stat.customer} · 메뉴 버튼 클릭 ${stat.menu} · 카드/알림톡 ${stat.card} · 자동 답장 ${stat.template} · 운영자가 친 답 ${stat.human}`);
L.push('', '## 자동 답장(3회 이상 반복) — 앞 80자 · 횟수');
for (const [k, v] of [...freq].filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1])) L.push(`${String(v).padStart(4)}  ${k}`);
L.push('', '## 대화 — 고객 말과 운영자가 친 답만 (카드·자동 답장 생략)');
for (const r of rooms) {
  const lines = r.messages.filter((m) => { const l = label(m); return l === 'customer' || l === 'human'; });
  if (!lines.length) continue;
  L.push('', `### 방 ${r.name} (마지막 ${r.lastDate}) — 고객 ${lines.filter((m) => m.who === 'customer').length} · 답 ${lines.filter((m) => m.who !== 'customer').length}`);
  for (const m of lines) L.push(`[${m.date.replace(/2026년 |요일/g, '')} ${m.time}] ${m.who === 'customer' ? '고객' : '운영자'}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 260)}`);
}
const text = L.join('\n');
if (OUTFILE) { fs.writeFileSync(OUTFILE, text); console.log(`저장: ${OUTFILE} (${L.length}줄)`); } else console.log(text);
