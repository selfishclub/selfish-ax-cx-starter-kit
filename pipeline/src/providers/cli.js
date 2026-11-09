/**
 * Claude Code CLI 프로바이더
 *
 * 코드가 터미널의 `claude` 명령어를 대신 실행한다.
 * 운영자의 Claude Code 구독으로 동작하므로 별도 API 키가 필요 없다.
 *
 * 트레이드오프: Claude Code가 자기 시스템 프롬프트를 매번 같이 보내서
 * 건당 토큰이 API 직접 호출보다 훨씬 크다. 추가 청구는 없지만
 * 구독 사용량 한도를 소모한다. 문의량이 늘면 api 프로바이더로 전환할 것.
 */

const { spawn } = require('child_process');
const os = require('os');

const TIMEOUT_MS = 120000;

/**
 * 프롬프트를 stdin으로 넘겨 claude를 실행하고 응답 텍스트를 받는다.
 */
function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--strict-mcp-config'];
    if (model) args.push('--model', model);

    // 빈 디렉토리에서 실행한다 — 프로젝트의 CLAUDE.md가 딸려 들어가면
    // 토큰만 늘고 답변에도 영향을 준다.
    const child = spawn('claude', args, { cwd: os.tmpdir() });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude 응답이 2분을 넘겨 중단했습니다.'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`claude 실행 실패: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude 종료 코드 ${code}: ${stderr.slice(0, 200)}`));
      }
      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        return reject(new Error('claude 출력을 JSON으로 읽지 못했습니다.'));
      }
      if (payload.is_error) {
        return reject(new Error(`claude 오류: ${payload.result || 'unknown'}`));
      }
      resolve({ text: payload.result, costUsd: payload.total_cost_usd });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * 모델이 코드펜스로 감싸 보내는 경우가 있어 방어적으로 파싱한다.
 * (API 프로바이더와 달리 구조화 출력을 강제할 수 없다)
 */
function parseJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('응답에서 JSON을 찾지 못했습니다.');
    return JSON.parse(match[0]);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.system - 시스템 지시문
 * @param {string} opts.user - 사용자 입력
 * @param {object} opts.schema - 기대하는 JSON 형태 (프롬프트에 포함됨)
 */
async function complete({ system, user, schema, model }) {
  const prompt = `${system}

반드시 아래 JSON 스키마에 맞는 JSON만 출력하세요.
설명, 인사말, 코드펜스 없이 JSON 객체 하나만 출력합니다.

<schema>
${JSON.stringify(schema, null, 2)}
</schema>

${user}`;

  const { text, costUsd } = await runClaude(prompt, model);
  return { data: parseJson(text), costUsd };
}

module.exports = { complete, name: 'cli' };
