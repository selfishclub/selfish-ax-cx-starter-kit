/**
 * 카카오 채널 대화 이력 추출 v3 (2026-09-28)
 *
 * 무엇 — 카카오 채널 관리자의 채팅방을 최근 것부터 20개씩 열어 대화를 뽑는다.
 *        「고객 말 / 우리 답 / 자동 답」을 갈라서 저장한다. 8월 v2 는 본문 선택자가 틀려 0자를 뽑았다.
 * 왜   — 운영자가 실제로 답해 온 문장을 모아 답변 정책(policy/answers.md)과 추가 사실 파일을 채우려고.
 *
 * 쓰는 법 (키트 폴더에서 · 창을 띄우지 않는다 — 마우스를 안 뺏는다)
 *   node tools/extract-history.js                 1묶음(최근 20개)
 *   node tools/extract-history.js --batch 2       2묶음(21~40번째)
 *   node tools/extract-history.js --size 30       한 묶음 크기
 *   node tools/extract-history.js --since 2026-01-01   이 날짜 이전 방은 안 연다 (기본값)
 *   node tools/extract-history.js --since-days 7 --prefix weekly-2026-10-05
 *                                                              지난 7일에 대화가 있던 방을 전부(최대 --size) → weekly-….json (주 1회 학습용)
 *
 * 결과 (cx-data/history/ · 깃에 안 올라간다)
 *   raw-<n>.json     원본. 이름·번호 그대로 — 내 맥 밖으로 내보내지 않는다
 *   masked-<n>.json  이름 김*은 · 번호·이메일·긴 숫자 가림. 분석은 이 파일로만
 *   rooms.json       방 목록(id · 마지막 날짜). 묶음을 이어 갈 때 쓴다
 *
 * 주의 — 수집기(run.js --watch)와 같은 브라우저 폴더를 쓴다. 돌리기 전에 수집기를 잠시 멈춘다.
 *   launchctl bootout gui/$(id -u)/cx.starter-kit.collector   → 끝나면 pipeline/launchd/install.sh 로 다시
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { maskName, maskText } = require('../src/mask');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const BATCH = parseInt(opt('--batch', '1'), 10);
const SIZE = parseInt(opt('--size', '20'), 10);
const SINCE_DAYS = parseInt(opt('--since-days', '0'), 10);
const SINCE = SINCE_DAYS > 0 ? new Date(Date.now() - SINCE_DAYS * 864e5).toISOString().slice(0, 10) : opt('--since', '2026-01-01');
const PREFIX = opt('--prefix', ''); // 있으면 raw-<prefix>.json 대신 <prefix>.json 으로, 방 목록도 새로 만든다
const SIZE_EFFECTIVE = PREFIX ? parseInt(opt('--size', '80'), 10) : SIZE;

const OUT = path.join(config.dataDir, 'history');
const { channelId, baseUrl } = config.kakao;

/** 목록의 날짜 표기 → YYYY-MM-DD. 「오후 5:41」=오늘 · 「9월 27일」=올해 · 「2025. 12. 3.」=그대로 */
function listDateToIso(text) {
  const now = new Date();
  const y = now.getFullYear();
  let m;
  if ((m = text.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = text.match(/(\d{1,2})월\s*(\d{1,2})일/))) return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (/오[전후]\s*\d{1,2}:\d{2}/.test(text)) return now.toISOString().slice(0, 10);
  if (/어제/.test(text)) return new Date(now - 864e5).toISOString().slice(0, 10);
  return '';
}

/** 채팅 목록을 스크롤하며 방을 모은다. SINCE 이전 방이 보이면 멈춘다 */
async function listRooms(page) {
  const rooms = [];
  let idle = 0;
  for (let i = 0; i < 400; i++) {
    const items = await page.$$eval('[role="grid"] li', (lis) =>
      lis.map((li) => {
        const cb = li.querySelector('input[type="checkbox"]');
        return {
          id: cb ? cb.id.replace('chat-select-', '') : null,
          name: li.querySelector('.txt_name')?.textContent.trim() || '',
          date: li.querySelector('.txt_date')?.textContent.trim() || '',
          unread: parseInt(li.querySelector('.num_round')?.textContent.trim() || '0', 10) || 0,
        };
      }).filter((x) => x.id)
    );
    let added = 0;
    for (const it of items) if (!rooms.find((r) => r.id === it.id)) { rooms.push({ ...it, lastDate: listDateToIso(it.date) }); added++; }
    const last = rooms[rooms.length - 1];
    if (last && last.lastDate && last.lastDate < SINCE) break;
    idle = added ? 0 : idle + 1;
    if (idle > 8) break;
    await page.evaluate(() => { const g = document.querySelector('[role="grid"]'); if (g) g.scrollTop += 500; });
    await page.waitForTimeout(700);
  }
  return rooms.filter((r) => !r.lastDate || r.lastDate >= SINCE);
}

/** 방 하나의 메시지를 구조로 뽑는다. 위로 스크롤해 더 실리면 계속 */
async function readRoom(page) {
  let prev = -1;
  for (let i = 0; i < 12; i++) {
    const n = await page.$$eval('.item_chat', (els) => els.length);
    if (n === prev) break;
    prev = n;
    await page.evaluate(() => { const s = document.querySelector('.fake_scroll'); if (s) s.scrollTop = 0; });
    await page.waitForTimeout(1200);
  }
  return page.evaluate(() => {
    const out = [];
    let date = '';
    const nodes = document.querySelectorAll('.item_date, .item_chat');
    for (const el of nodes) {
      if (el.classList.contains('item_date')) {
        const d = el.querySelector('.emph_date')?.textContent.trim() || '';
        if (/\d{4}년|\d{1,2}월\s*\d{1,2}일/.test(d)) date = d; // 「메시지가 삭제되었습니다」 같은 안내는 날짜가 아니다
        continue;
      }
      const cls = el.className;
      // 화면 표시 그대로 둔다. item_me = 채널 쪽(우리) · 없으면 고객. 세부 구분(운영시간 카드·알림톡·자동 답장·사람이 친 답)은
      // 분석 단계에서 반복 횟수와 표시로 가른다 — 2026-09-28 1묶음에서 item_aiauto_me 에 사람이 친 답이 섞여 있는 것을 봤다
      const who = cls.includes('item_me') ? 'us' : 'customer';
      const text = [...el.querySelectorAll('.txt_chat')].map((t) => t.innerText.trim()).filter(Boolean).join('\n');
      const card = [...el.querySelectorAll('.box_info_produce dt, .box_info_produce dd, .tit_item')].map((t) => t.textContent.trim()).filter(Boolean).join(' / ');
      const time = el.querySelector('.txt_time')?.textContent.trim() || '';
      const kind = cls.includes('type_card') ? 'card' : cls.includes('item_url') ? 'url' : el.querySelector('img.thumb_img, .wrap_img img') && !text ? 'image' : 'text';
      const hasImg = !!el.querySelector('img:not(.thumb_profile):not([class*="profile"])');
      out.push({ date, time, who, kind: !text && !card && hasImg ? 'image' : kind, cls: cls.replace(/\s+/g, ' ').trim(), text: text || card || (hasImg ? '[사진]' : '') });
    }
    return out;
  });
}

function maskMessages(msgs) {
  return msgs.map((m) => ({ ...m, text: maskText(m.text) }));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(config.profileDir)) { console.error('로그인 세션이 없습니다. npm run login 을 먼저.'); process.exit(1); }

  const ctx = await chromium.launchPersistentContext(config.profileDir, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(`${baseUrl}/${channelId}/chats`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    if (page.url().includes('accounts.kakao.com') || page.url().includes('/login')) { console.error('카카오 로그인이 풀렸습니다. npm run login'); process.exit(1); }

    // 방 목록 — 1묶음 때 새로 만들고, 그 뒤 묶음은 같은 목록을 쓴다(중간에 순서가 바뀌지 않게)
    const roomsFile = path.join(OUT, 'rooms.json');
    let rooms;
    if (PREFIX || BATCH === 1 || !fs.existsSync(roomsFile)) {
      rooms = await listRooms(page);
      if (!PREFIX) fs.writeFileSync(roomsFile, JSON.stringify(rooms, null, 2));
    } else {
      rooms = JSON.parse(fs.readFileSync(roomsFile, 'utf8'));
    }
    const slice = PREFIX ? rooms.slice(0, SIZE_EFFECTIVE) : rooms.slice((BATCH - 1) * SIZE, BATCH * SIZE);
    console.log(`방 ${rooms.length}개 (${SINCE} 이후) · ${BATCH}묶음 = ${(BATCH - 1) * SIZE + 1}~${(BATCH - 1) * SIZE + slice.length}번째`);
    if (slice.length === 0) { console.log('이 묶음에는 방이 없습니다. 끝.'); return; }

    const raw = [];
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i];
      // 안 읽은 문의가 있는 방은 열지 않는다 — 열면 「읽음」이 돼 수집기(run.js)가 새 문의로 보지 못한다
      if (r.unread > 0) {
        raw.push({ id: r.id, name: r.name, lastDate: r.lastDate, messages: [], skipped: 'unread' });
        console.log(`  [${(BATCH - 1) * SIZE + i + 1}] ${maskName(r.name).padEnd(6)} ${r.lastDate}  안 읽은 문의가 있어 건너뜀 (수집기 몫)`);
        continue;
      }
      const p2 = await ctx.newPage();
      try {
        await p2.goto(`${baseUrl}/${channelId}/chats/${r.id}`, { waitUntil: 'networkidle', timeout: 25000 });
        await p2.waitForTimeout(1500);
        const messages = await readRoom(p2);
        raw.push({ id: r.id, name: r.name, lastDate: r.lastDate, messages });
        const c = messages.filter((m) => m.who === 'customer').length, u = messages.length - c;
        console.log(`  [${(BATCH - 1) * SIZE + i + 1}] ${maskName(r.name).padEnd(6)} ${r.lastDate}  메시지 ${messages.length} (고객 ${c} · 채널 ${u})`);
      } catch (e) {
        raw.push({ id: r.id, name: r.name, lastDate: r.lastDate, messages: [], error: e.message.split('\n')[0] });
        console.log(`  [${(BATCH - 1) * SIZE + i + 1}] ${maskName(r.name).padEnd(6)} 실패: ${e.message.split('\n')[0].slice(0, 60)}`);
      } finally { await p2.close(); }
    }

    const rawName = PREFIX ? `${PREFIX}-raw.json` : `raw-${BATCH}.json`;
    const maskedName = PREFIX ? `${PREFIX}-masked.json` : `masked-${BATCH}.json`;
    fs.writeFileSync(path.join(OUT, rawName), JSON.stringify(raw, null, 2));
    const masked = raw.map((r) => ({ id: r.id, name: maskName(r.name), lastDate: r.lastDate, messages: maskMessages(r.messages), error: r.error }));
    fs.writeFileSync(path.join(OUT, maskedName), JSON.stringify(masked, null, 2));
    const total = raw.reduce((s, r) => s + r.messages.length, 0);
    console.log(`\n저장: cx-data/history/${rawName} · ${maskedName} — 방 ${raw.length} · 메시지 ${total}`);
    if (!PREFIX) console.log(`다음 묶음: node tools/extract-history.js --batch ${BATCH + 1}`);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error('오류:', e.message.split('\n')[0]); process.exit(1); });
