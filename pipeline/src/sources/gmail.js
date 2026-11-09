/**
 * Gmail 문의 수집기 — 아직 미구현
 *
 * 카카오와 같은 공통 스키마를 반환하도록 만들 것.
 * OAuth 셋업이 필요해서 카카오 파이프라인이 돌아간 뒤에 붙인다.
 *
 * 붙일 때 필요한 것:
 *   - Google Cloud 프로젝트 + Gmail API 활성화
 *   - OAuth 클라이언트 (데스크톱 앱)
 *   - GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
 */

async function collect() {
  return [];
}

module.exports = { collect, implemented: false };
