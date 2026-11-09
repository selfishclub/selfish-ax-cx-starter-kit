/**
 * 카카오 관리자 화면 선택자 점검 — 화면이 바뀌어 수집기가 0건을 읽을 때 연다.
 *   node tools/debug-selectors.js
 * 창을 띄우고(headed) 채팅 목록의 링크 · grid 구조를 찍어 준다. 읽기만 한다.
 */
const { chromium } = require('playwright');
const { config, verify } = require('../src/config');

verify(['kakao']);

async function run() {
  const context = await chromium.launchPersistentContext(config.profileDir, { headless: false, channel: 'chromium', viewport: { width: 1280, height: 900 } });
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(`${config.kakao.baseUrl}/${config.kakao.channelId}/chats`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);
  if (page.url().includes('accounts.kakao.com') || page.url().includes('/login')) {
    console.log('로그인이 풀려 있어요. npm run login 을 먼저.');
    await context.close();
    return;
  }

  const allLinks = await page.$$eval('a', (els) => els.map((el) => ({ href: el.href, text: el.textContent.trim().substring(0, 80) })).filter((l) => l.href.includes('/chats/')));
  console.log(`chats 관련 링크: ${allLinks.length}개`);
  allLinks.slice(0, 5).forEach((l) => console.log(`  ${l.href} → ${l.text.replace(/\d{3,4}-\d{4}/g, '[번호]')}`));

  const gridInfo = await page.$$eval('[role="grid"]', (els) => els.map((el) => ({ tag: el.tagName, children: el.children.length })));
  console.log(`\ngrid 요소: ${gridInfo.length}개`);
  gridInfo.forEach((g) => console.log(`  ${g.tag}, children: ${g.children}`));

  const rows = await page.$$eval('[role="grid"] li', (lis) => lis.slice(0, 3).map((li) => ({
    hasCheckbox: !!li.querySelector('input[type="checkbox"]'),
    name: !!li.querySelector('.txt_name'), info: !!li.querySelector('.txt_info'), date: !!li.querySelector('.txt_date'), unread: !!li.querySelector('.num_round'),
  })));
  console.log('\n목록 행 선택자 (앞 3행) — 수집기가 기대하는 클래스가 있는지:');
  rows.forEach((r, i) => console.log(`  [${i + 1}] checkbox:${r.hasCheckbox} txt_name:${r.name} txt_info:${r.info} txt_date:${r.date} num_round:${r.unread}`));
  console.log('\nfalse 가 보이면 src/sources/kakao.js 의 선택자를 그 화면에 맞게 고쳐요.');

  await context.close();
}

run().catch((e) => { console.error('오류:', e.message); process.exit(1); });
