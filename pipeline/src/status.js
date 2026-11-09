/**
 * 대시보드용 상태 한 줄 적기 (선택)
 *
 * Supabase 표 cx_status 에 「마지막 확인 시각 · 세션 상태 · 대기 건수」 같은 숫자만 적는다.
 * 이름 · 번호 · 원문은 절대 넣지 않는다.
 * .env.local 에 SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 가 없거나 @supabase/supabase-js 가 설치돼 있지 않으면
 * 조용히 건너뛴다 — 파이프라인은 대시보드 없이도 똑같이 돈다.
 *
 * 표 만들기(한 번): create table cx_status (key text primary key, value jsonb, updated_at timestamptz);
 */
require('./config'); // .env.local 을 process.env 에 싣는다
let sb = null;
let unavailable = false;
function client() {
  if (sb || unavailable) return sb;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { unavailable = true; return null; }
  try {
    const { createClient } = require('@supabase/supabase-js');
    sb = createClient(url, key);
  } catch { unavailable = true; }
  return sb;
}
async function setStatus(key, value) {
  const c = client();
  if (!c) return false;
  try {
    const { error } = await c.from('cx_status').upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) {
      if (!/does not exist|relation|schema cache/i.test(error.message)) console.error(`  상태 기록 실패(${key}): ${error.message}`);
      return false;
    }
    return true;
  } catch { return false; }
}
module.exports = { setStatus };
