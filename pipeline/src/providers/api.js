/**
 * Claude API 프로바이더
 *
 * Anthropic 서버를 직접 호출한다. ANTHROPIC_API_KEY가 필요하다.
 * CLI 프로바이더보다 빠르고 건당 토큰이 훨씬 적으며 구조화 출력을 강제할 수 있다.
 * 문의량이 늘거나 24시간 자동 운영으로 갈 때 이쪽으로 전환한다.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

async function complete({ system, user, schema, model }) {
  const response = await getClient().messages.create({
    model: model || config.anthropic.model,
    max_tokens: 16000,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('안전 필터에 걸렸습니다. 직접 확인이 필요합니다.');
  }

  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error('응답에 텍스트가 없습니다.');

  return { data: JSON.parse(text.text), costUsd: null };
}

module.exports = { complete, name: 'api' };
