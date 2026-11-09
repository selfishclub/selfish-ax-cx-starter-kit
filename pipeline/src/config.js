/**
 * 환경 설정 로드 및 검증
 *
 * 값은 키트 루트의 .env.local 에서 읽는다 (이름은 .env.example 참고).
 * 보안: 이 파일은 시크릿 값을 절대 로그로 출력하지 않는다. 누락 여부만 키 이름으로 알린다.
 */

const fs = require('fs');
const path = require('path');

// 키트 루트 (pipeline/src → 두 칸 위). .env.local · policy/ 가 여기 있다
const KIT_ROOT = path.join(__dirname, '..', '..');
// 파이프라인 자신의 폴더 — 문의 기록(cx-data) · 로그인 세션(auth-state)이 여기 쌓인다 (둘 다 깃 제외)
const ROOT = process.env.CX_HOME || path.join(__dirname, '..');

// .env.local 읽기 — 값은 화면에 찍지 않는다
const envFile = path.join(KIT_ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^"|"$/g, '');
  }
}

const policyDir = path.join(KIT_ROOT, 'policy');

const config = {
  root: ROOT,
  kitRoot: KIT_ROOT,
  dataDir: path.join(ROOT, 'cx-data'),
  policyDir,
  // 답변 정책 — 없으면 샘플(가상 커뮤니티)로 돈다. 실제 운영 전에 cx-interview 스킬로 내 것을 만든다
  policyFile: process.env.CX_POLICY_FILE || path.join(policyDir, 'answers.md'),
  policySampleFile: path.join(policyDir, 'answers.sample.md'),
  // 새면 안 되는 말 — 없으면 example 로
  leakWordsFile: fs.existsSync(path.join(policyDir, 'leak-words.json')) ? path.join(policyDir, 'leak-words.json') : path.join(policyDir, 'leak-words.example.json'),
  // 초안이 정책과 함께 읽는 추가 사실(선택) — 예: 마이페이지 안내 문장을 모은 파일. 비워 두면 정책 문서만 본다
  factsFile: process.env.CX_FACTS_FILE || '',
  // 카카오 메뉴 버튼 · 자동 답장 목록 — 내 채널에 맞게 pipeline/filters.json 을 고친다
  filtersFile: path.join(ROOT, 'filters.json'),
  // 예전 방식: 로그인 순간의 쿠키를 사진처럼 파일에 저장
  authStateFile: path.join(ROOT, 'auth-state', 'kakao-biz.json'),
  // 지금 방식: 크롬처럼 살아 있는 브라우저 폴더. 실행할 때마다 쿠키가 갱신돼 세션이 더 오래 간다
  profileDir: path.join(ROOT, 'auth-state', 'kakao-profile'),

  // 초안 프롬프트에 들어가는 우리 이름 — 「당신은 ○○의 CX 담당자입니다」
  brandName: process.env.CX_BRAND_NAME || '우리 커뮤니티',

  kakao: {
    channelId: process.env.KAKAO_CHANNEL_ID || '',
    baseUrl: 'https://business.kakao.com',
  },

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    channel: process.env.SLACK_CX_CHANNEL || '#cx-inbox',
    // 운영 알림(로그인 풀림 · 브리핑) — 비워 두면 카드 채널과 같은 곳
    briefingChannel: process.env.SLACK_BRIEFING_CHANNEL || process.env.SLACK_CX_CHANNEL || '#cx-inbox',
  },

  // --watch 일 때 몇 분마다 카카오를 확인하나
  watchMinutes: parseInt(process.env.CX_WATCH_MINUTES || '5', 10),

  ai: {
    // cli — Claude Code 구독 사용 (API 키 불필요, 기본값)
    // api — Claude API 직접 호출 (ANTHROPIC_API_KEY 필요)
    provider: process.env.CX_AI_PROVIDER || 'cli',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || '',
  },
};

/**
 * 필요한 키가 있는지 확인한다.
 * @param {string[]} required - 확인할 기능 이름 ('slack' | 'ai' | 'kakao')
 */
function verify(required) {
  const missing = [];

  if (required.includes('slack')) {
    if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
    if (!config.slack.appToken) missing.push('SLACK_APP_TOKEN');
  }
  // cli 프로바이더는 Claude Code 구독을 쓰므로 API 키가 필요 없다
  if (required.includes('ai') && config.ai.provider === 'api') {
    if (!config.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');
  }
  if (required.includes('kakao') && !config.kakao.channelId) missing.push('KAKAO_CHANNEL_ID');

  if (missing.length > 0) {
    console.error('\n키트 루트의 .env.local 에 다음 값이 없습니다:');
    missing.forEach((k) => console.error(`  - ${k}`));
    console.error('\n.env.example 을 복사해(cp .env.example .env.local) 이름 옆에 값을 넣어주세요.\n');
    process.exit(1);
  }
}

module.exports = { config, verify };
