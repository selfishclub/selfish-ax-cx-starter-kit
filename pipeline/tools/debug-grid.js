/**
 * 카카오 관리자 화면 채팅 목록(grid) 내부 구조 보기 — 선택자를 새로 잡아야 할 때.
 *   node tools/debug-grid.js
 * 창을 띄우고(headed) grid 의 HTML 앞부분과 클릭 가능한 요소를 찍는다. 읽기만 한다.
 * ⚠️ 출력에 고객 이름 · 미리보기 글이 섞일 수 있다 — 화면에서만 보고 어디에도 붙여 넣지 않는다.
 */
const { chromium } = require('playwright');
const { config, verify } = require('../src/config');

verify(['kakao']);

async function run() {
  const context = await chromium.launchPersistentContext(config.profileDir, { headless: false, channel: 'chromium', viewport: { width: 1280, height: 900 } });
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(`${config.kakao.baseUrl}/${config.kakao.channelId}/chats`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);

  const gridHTML = await page.$eval('[role="grid"]', (el) => el.innerHTML.substring(0, 3000)).catch(() => 'grid not found');
  console.log('=== Grid 내부 HTML (처음 3000자) ===');
  console.log(gridHTML);
  console.log('');

  const clickables = await page.$$eval('[role="grid"] a, [role="grid"] button, [role="grid"] [onclick], [role="grid"] [role="link"]',
    (els) => els.map((el) => ({ tag: el.tagName, href: el.href || '', role: el.getAttribute('role') || '', className: String(el.className).substring(0, 60) }))
  );
  console.log(`=== Grid 내 클릭 가능 요소: ${clickables.length}개 ===`);
  clickables.slice(0, 10).forEach((c) => console.log(`  ${c.tag} | href=${c.href.substring(0, 50)} | class=${c.className}`));

  await context.close();
}

run().catch((e) => { console.error('오류:', e.message); process.exit(1); });
