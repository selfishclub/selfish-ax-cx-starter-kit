/**
 * 카카오 채널 관리자 로그인
 *
 * 창을 띄우고 운영자가 직접 로그인하면 세션을 저장한다.
 * 이후 run.js는 headless로 이 세션을 재사용한다.
 *
 * 2026-09-28 — 저장 방식을 바꿨다.
 *   예전: 로그인 순간의 쿠키를 파일에 사진처럼 찍어 둠(auth-state/kakao-biz.json). 안 쓰면 그대로 늙어서 만료.
 *   지금: 크롬처럼 살아 있는 브라우저 폴더(auth-state/kakao-profile). 수집기가 돌 때마다 카카오가
 *         갱신해 주는 쿠키가 그 폴더에 그대로 쌓여, 자주 돌리면 세션이 더 오래 간다.
 *   로그인 화면에 「로그인 상태 유지」가 있으면 꼭 켠다 — 카카오가 세션을 길게 주는 조건.
 *
 * 세션이 만료되면 수집기가 슬랙에 알려준다. 그때 다시 실행하면 된다.
 *   npm run login   (키트 폴더에서)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const { config, verify } = require('./src/config');
verify(['kakao']);
const { setStatus } = require('./src/status');

const CHANNEL_ID = config.kakao.channelId;

async function run() {
  fs.mkdirSync(config.profileDir, { recursive: true });

  console.log('\n브라우저를 엽니다. 카카오 계정으로 로그인해주세요.');
  console.log('「로그인 상태 유지」가 보이면 꼭 체크해주세요.\n');

  // 살아 있는 폴더를 그대로 연다. 창을 띄우는(headed) 쪽과 안 띄우는(headless) 쪽이
  // 같은 폴더를 쓰도록 채널을 chromium 으로 고정한다.
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(`${config.kakao.baseUrl}/${CHANNEL_ID}/chats`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // 카카오는 페이지를 띄운 뒤 자바스크립트로 로그인 페이지로 보낸다.
  // goto 직후에 URL을 보면 아직 원래 주소라 '로그인됨'으로 오판한다.
  await page.waitForTimeout(4000);

  const needsLogin = page.url().includes('accounts.kakao.com') || page.url().includes('login');

  if (needsLogin) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  열린 창에서 로그인해주세요.');
    console.log('  완료되면 자동으로 저장됩니다. (최대 5분 대기)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
      await page.waitForURL('**/business.kakao.com/**', { timeout: 300000 });
    } catch {
      console.error('\n시간이 초과됐습니다. 다시 실행해주세요.');
      await context.close();
      process.exit(1);
    }
  } else {
    console.log('이미 로그인되어 있습니다.');
  }

  // 채팅 목록이 실제로 보이는지까지 확인하고 닫는다 (닫을 때 폴더에 저장된다)
  await page.waitForTimeout(3000);
  const ok = await page
    .waitForSelector('[role="grid"]', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  // 예전 방식 파일도 같이 남겨 둔다 — 혹시 폴더 방식에 문제가 생기면 되돌릴 수 있게
  await context.storageState({ path: config.authStateFile });

  if (ok) {
    const count = await page.$$eval('[role="grid"] li', (l) => l.length).catch(() => 0);
    await setStatus('cx:login', { lastLoginAt: new Date().toISOString(), rooms: count });
    console.log(`\n✅ 세션 저장 완료. 채팅 목록 ${count}건 확인.`);
    console.log('   이제 npm run cx 를 실행하면 됩니다.\n');
  } else {
    console.log('\n⚠️  세션은 저장했지만 채팅 목록을 확인하지 못했습니다.');
    console.log('   채널 관리자 페이지가 맞는지 확인해주세요.\n');
  }

  await context.close();
}

run().catch((err) => {
  console.error('오류:', err.message);
  process.exit(1);
});
