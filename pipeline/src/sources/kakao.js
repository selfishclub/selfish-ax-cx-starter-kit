/**
 * 카카오 채널 문의 수집기
 *
 * 카카오는 1:1 채팅 수신 API를 제공하지 않는다 (공식 확인 완료).
 * 상담톡은 딜러사 경유 유료. 그래서 관리자 웹을 Playwright로 직접 읽는다.
 * 브라우저 도구는 바꿔 끼워도 된다 — collect · checkAnswered · send 세 함수만 Playwright 를 쓴다 (docs/04 · pipeline/README).
 *
 * headless로 돌린다 — 창이 뜨면 마우스/키보드를 뺏겨서 다른 일을 못 한다.
 *
 * 세션 (2026-09-28 부터)
 *   auth-state/kakao-profile 폴더를 크롬처럼 살아 있는 브라우저로 쓴다. 돌 때마다 카카오가
 *   갱신해 주는 쿠키가 폴더에 쌓여, 자주 돌리면 로그인이 더 오래 간다. 만료되면 SessionExpiredError 를
 *   던진다 — run.js 가 받아서 슬랙에 알린다. 다시 로그인은 npm run login.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const { config } = require('../config');

const { channelId, baseUrl } = config.kakao;

/** 로그인이 풀렸을 때. 다른 오류와 구분해서 슬랙에 다르게 알리기 위해 */
class SessionExpiredError extends Error {
  constructor(msg) {
    super(msg || '카카오 로그인이 풀렸습니다. npm run login 으로 다시 로그인해주세요.');
    this.name = 'SessionExpiredError';
  }
}

/**
 * 브라우저 폴더는 한 번에 하나만 연다 — 15분 확인(collect)과 발송(send)이 겹치면 프로필 잠금이 충돌한다.
 * 순서대로 줄을 세운다.
 */
let queue = Promise.resolve();
function withBrowser(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function hasSession() {
  return fs.existsSync(config.profileDir) || fs.existsSync(config.authStateFile);
}

/**
 * 살아 있는 폴더가 있으면 그걸 열고, 없으면(예전 방식만 있으면) 사진 파일로 연다.
 */
async function openContext(headless) {
  if (fs.existsSync(config.profileDir)) {
    const context = await chromium.launchPersistentContext(config.profileDir, {
      headless,
      channel: 'chromium',
      viewport: { width: 1280, height: 900 },
    });
    return { context, close: () => context.close() };
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: config.authStateFile });
  return { context, close: () => browser.close() };
}

/**
 * 미읽음 문의만 수집한다.
 * 전체 이력 수집(tools/extract-history.js)과 달리, 아직 답 안 한 것만 본다.
 *
 * @param {object} opts
 * @param {number} opts.limit - 최대 수집 개수
 * @param {boolean} opts.headless - 창을 띄울지 (기본 true)
 * @returns {Promise<Array>} 공통 스키마의 문의 배열
 */
async function collect(opts = {}) {
  return withBrowser(() => collectNow(opts));
}

async function collectNow({ limit = 20, headless = true } = {}) {
  if (!hasSession()) {
    throw new SessionExpiredError('로그인 세션이 없습니다. npm run login 을 먼저 실행해주세요.');
  }

  const { context, close } = await openContext(headless);
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(`${baseUrl}/${channelId}/chats`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    if (page.url().includes('accounts.kakao.com') || page.url().includes('/login')) {
      throw new SessionExpiredError();
    }

    // 목록에서 미읽음만 골라낸다
    const unread = await page.$$eval('[role="grid"] li', (lis) =>
      lis
        .map((li) => {
          const checkbox = li.querySelector('input[type="checkbox"]');
          const nameEl = li.querySelector('.txt_name');
          const previewEl = li.querySelector('.txt_info');
          const dateEl = li.querySelector('.txt_date');
          const unreadEl = li.querySelector('.num_round');

          return {
            id: checkbox ? checkbox.id.replace('chat-select-', '') : null,
            name: nameEl ? nameEl.textContent.trim() : '',
            preview: previewEl ? previewEl.textContent.trim() : '',
            date: dateEl ? dateEl.textContent.trim() : '',
            unread: unreadEl ? parseInt(unreadEl.textContent.trim(), 10) : 0,
          };
        })
        .filter((item) => item.id && item.unread > 0)
    );

    const targets = unread.slice(0, limit);
    const inquiries = [];

    for (const chat of targets) {
      const url = `${baseUrl}/${channelId}/chats/${chat.id}`;
      const chatPage = await context.newPage();

      try {
        await chatPage.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
        await chatPage.waitForTimeout(1500);

        // 화면의 메시지를 구조로 읽는다 — 새 문의(안 읽은 것)와 앞선 대화를 가르기 위해 (2026-09-28)
        const read = await readChat(chatPage);
        const split = splitMessages(read.msgs, chat.unread);

        // 카드 열쇠 = 방 + 새 문의의 지문. 같은 방이라도 새 메시지가 오면 새 카드가 된다
        // (2026-09-28)
        const sig = fingerprint(split.fresh || chat.preview || '');
        inquiries.push({
          source: 'kakao',
          key: `kakao:${chat.id}:${sig}`,
          customerName: chat.name,
          receivedAt: chat.date,
          preview: chat.preview,
          body: split.fresh || (split.freshMenuOnly ? '(메뉴 버튼만 눌렀고 질문은 없음)' : chat.preview), // 새 문의 — 안 읽은 고객 말만
          context: split.context,                 // 앞선 대화 — 최근 몇 줄 (메뉴·자동 답장 제외)
          // 이 방의 이력 — 화면에 실린 만큼. 이름·번호·회원 표 없이 「처음 온 분인지 자주 오는 분인지」만 (2026-09-28)
          history: { customerMessages: split.previousCustomer, firstDate: read.firstDate },
          // 새 문의의 마지막 말이 화면에서 언제였나 — 나중에 「그 뒤에 우리 답이 붙었나」를 볼 때 기준점 (2026-09-29)
          freshAt: split.lastFresh,
          url,
          collectedAt: new Date().toISOString(),
        });
      } catch (err) {
        // 한 건 실패해도 나머지는 계속 — 개인정보가 섞일 수 있으니 메시지만 남긴다
        console.error(`  [수집 실패] ${chat.id}: ${err.message.split('\n')[0]}`);
      } finally {
        await chatPage.close();
      }

      await page.waitForTimeout(300);
    }

    // 예전 방식 파일도 갱신해 둔다 (되돌릴 때를 위해). 폴더 방식은 닫을 때 저절로 저장된다
    await context.storageState({ path: config.authStateFile }).catch(() => {});

    return inquiries;
  } finally {
    await close();
  }
}

/** 열린 대화방 화면의 메시지를 순서대로 — { date, me(우리 쪽인가), card(카드형 말풍선인가), text, time } */
function readChat(chatPage) {
  return chatPage.evaluate(() => {
    // 시각 칸 앞에 「안 읽음」 숫자가 붙어 나온다(예: 1오후01:19) — 「오후01:19」만 남긴다
    const cleanTime = (t) => { const x = (t || '').trim(); return (x.match(/(오전|오후)\s*\d{1,2}:\d{2}/) || [x])[0]; };
    const msgs = [];
    let date = '';
    const dates = [];
    for (const el of document.querySelectorAll('.item_date, .item_chat')) {
      if (el.classList.contains('item_date')) {
        const d = el.querySelector('.emph_date')?.textContent.trim() || '';
        if (/\d{4}년|\d{1,2}월\s*\d{1,2}일/.test(d)) { date = d; dates.push(d); }
        continue;
      }
      const me = el.classList.contains('item_me');
      const card = el.classList.contains('type_card');
      const text = [...el.querySelectorAll('.txt_chat')].map((t) => t.innerText.trim()).filter(Boolean).join('\n');
      const img = !text && !!el.querySelector('img:not([class*="profile"])');
      msgs.push({ date: date.replace(/요일$/, ''), me, card, text: text || (img ? '[사진]' : ''), time: cleanTime(el.querySelector('.txt_time')?.textContent) });
    }
    return { msgs, firstDate: dates[0] || '' };
  });
}

/** 짧은 지문 — 같은 글이면 같은 값 (djb2) */
function fingerprint(text) {
  let h = 5381;
  for (const ch of String(text)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** 메뉴 버튼 이름 · 채널 자동 답장 — 고객이나 사람이 친 말이 아니다. 목록은 pipeline/filters.json */
const { MENU, AUTO } = require('../filters');

/**
 * 화면의 메시지를 「새 문의」와 「앞선 대화」로 가른다.
 *   fresh    안 읽은 수(unread)만큼의 마지막 고객 말 — 메뉴 버튼은 뺀다
 *   context  그 앞의 고객 말·운영자 답 최근 8줄 — 메뉴·카드·자동 답장은 뺀다
 */
function splitMessages(msgs, unread) {
  const isCustomerReal = (m) => !m.me && m.text && !MENU.test(m.text.trim());
  const idx = [];
  for (let i = msgs.length - 1; i >= 0 && idx.length < Math.max(1, unread); i--) if (!msgs[i].me && msgs[i].text) idx.unshift(i);
  const freshMsgs = idx.map((i) => msgs[i]);
  const cut = idx.length ? idx[0] : msgs.length;
  const before = msgs.slice(0, cut).filter((m) => m.text && !m.card && (m.me ? !AUTO.test(m.text.trim()) : !MENU.test(m.text.trim())));
  const fmt = (m) => `[${m.date}${m.time ? ' ' + m.time : ''}] ${m.me ? '우리' : '고객'}: ${m.text}`;
  return {
    fresh: freshMsgs.filter((m) => !MENU.test(m.text.trim())).map(fmt).join('\n'),
    freshMenuOnly: freshMsgs.length > 0 && freshMsgs.every((m) => MENU.test(m.text.trim())),
    context: before.slice(-8).map(fmt).join('\n'),
    previousCustomer: msgs.slice(0, cut).filter(isCustomerReal).length,
    lastFresh: freshMsgs.length ? { date: freshMsgs[freshMsgs.length - 1].date, time: freshMsgs[freshMsgs.length - 1].time } : null,
  };
}

/**
 * 대기 중인 카드가 카카오에서 이미 답을 받았나 (2026-09-29)
 *
 * 카드마다 그 방을 열어, 새 문의의 마지막 말(freshAt) 뒤에 우리 쪽 말풍선이 있는지만 본다.
 *   - 자동 답장(운영시간 안내·환영 인사)과 카드형 말풍선은 답으로 세지 않는다
 *   - freshAt 이 없는 예전 카드는 「마지막 고객 말」을 기준으로 본다
 *   - 지금 안 읽은 메시지가 있는 방은 열지 않는다 — 열면 읽음이 되어 collect 가 새 문의를 놓친다
 * 읽기만 한다. 아무것도 보내지 않는다. 답의 글자는 돌려주지 않는다(시각만).
 *
 * @param {Array<{key: string, chatId: string, freshAt?: {date: string, time: string}|null}>} cards
 * @returns {Promise<Array<{key: string, answered: boolean, at: string|null}>>}
 */
async function checkAnswered(cards, { headless = true } = {}) {
  if (!cards.length) return [];
  return withBrowser(async () => {
    if (!hasSession()) throw new SessionExpiredError();
    const { context, close } = await openContext(headless);
    const page = context.pages()[0] || (await context.newPage());
    try {
      await page.goto(`${baseUrl}/${channelId}/chats`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
      if (page.url().includes('accounts.kakao.com') || page.url().includes('/login')) throw new SessionExpiredError();
      const unreadIds = new Set(
        await page.$$eval('[role="grid"] li', (lis) =>
          lis
            .filter((li) => li.querySelector('.num_round'))
            .map((li) => (li.querySelector('input[type="checkbox"]')?.id || '').replace('chat-select-', ''))
            .filter(Boolean)
        )
      );

      const results = [];
      for (const card of cards) {
        if (unreadIds.has(card.chatId)) continue;
        const chatPage = await context.newPage();
        try {
          await chatPage.goto(`${baseUrl}/${channelId}/chats/${card.chatId}`, { waitUntil: 'networkidle', timeout: 20000 });
          await chatPage.waitForTimeout(1500);
          const { msgs } = await readChat(chatPage);
          const reply = replyAfter(msgs, card.freshAt);
          results.push({ key: card.key, answered: !!reply, at: reply ? `${reply.date} ${reply.time}`.trim() : null });
        } catch (err) {
          console.error(`  [답 확인 실패] ${card.chatId}: ${err.message.split('\n')[0]}`);
        } finally {
          await chatPage.close();
        }
        await page.waitForTimeout(300);
      }
      return results;
    } finally {
      await close();
    }
  });
}

/** 기준점(새 문의의 마지막 말) 뒤에 붙은 첫 「사람이 쓴」 우리 쪽 말풍선. 없으면 null */
function replyAfter(msgs, freshAt) {
  let anchor = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.me || !m.text) continue;
    if (freshAt ? m.date === freshAt.date && m.time === freshAt.time : !MENU.test(m.text.trim())) { anchor = i; break; }
  }
  if (anchor < 0) return null; // 기준점을 화면에서 못 찾으면 답했다고 하지 않는다
  return msgs.slice(anchor + 1).find((m) => m.me && m.text && !m.card && !AUTO.test(m.text.trim())) || null;
}

/**
 * 답 보내기 — 운영자가 슬랙 카드에서 「승인」(또는 수정 저장)을 눌렀을 때만 부른다 (2026-09-28).
 * 입력칸(textarea#chatWrite)에 글자를 넣고 「전송」을 누른다. 보낸 뒤 화면에 그 글이 우리 쪽 말풍선으로 붙었는지 확인한다.
 * CX_SEND_ENABLED=false 면 아무것도 보내지 않는다(비상 스위치).
 */
async function send(chatId, text, { headless = true } = {}) {
  if (process.env.CX_SEND_ENABLED === 'false') throw new Error('CX_SEND_ENABLED=false — 발송이 꺼져 있습니다');
  if (!hasSession()) throw new SessionExpiredError();
  const body = String(text || '').trim();
  if (!body) throw new Error('보낼 글이 비어 있습니다');
  return withBrowser(async () => {
    const { context, close } = await openContext(headless);
    const page = context.pages()[0] || (await context.newPage());
    try {
      await page.goto(`${baseUrl}/${channelId}/chats/${chatId}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
      if (page.url().includes('accounts.kakao.com') || page.url().includes('/login')) throw new SessionExpiredError();
      const box = await page.waitForSelector('textarea#chatWrite', { timeout: 15000 });
      await box.click();
      await box.fill(body);
      await page.waitForTimeout(300);
      const btn = await page.waitForSelector('button.btn_submit:not(.disabled):not([disabled])', { timeout: 10000 });
      await btn.click();
      // 보낸 글이 붙었는지 — 우리 쪽 말풍선의 마지막 글과 앞 30자를 비교
      await page.waitForTimeout(2500);
      const last = await page.evaluate(() => {
        const mine = [...document.querySelectorAll('.item_chat.item_me .txt_chat')];
        return mine.length ? mine[mine.length - 1].innerText.trim() : '';
      });
      const head = body.slice(0, 30).replace(/\s+/g, ' ');
      if (!last.replace(/\s+/g, ' ').includes(head)) throw new Error('보내기를 눌렀지만 화면에서 글을 확인하지 못했습니다 — 카카오 관리자에서 직접 확인해 주세요');
      await context.storageState({ path: config.authStateFile }).catch(() => {});
      return { ok: true };
    } finally {
      await close();
    }
  });
}

module.exports = { collect, send, checkAnswered, SessionExpiredError };
