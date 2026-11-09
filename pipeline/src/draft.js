/**
 * AI 답변 초안 생성기
 *
 * policy/answers.md 를 근거로 문의별 답변 초안을 만든다.
 * 정책에 근거가 없으면 초안을 쓰지 않고 needsHuman: true 로 넘긴다.
 * — 고객에게 나가는 답변이라 지어내는 것보다 비우는 게 낫다.
 *
 * 어떤 Claude를 쓸지는 프로바이더가 결정한다 (.env.local 의 CX_AI_PROVIDER):
 *   cli — Claude Code 구독 사용, API 키 불필요 (기본값)
 *   api — Claude API 직접 호출, ANTHROPIC_API_KEY 필요
 */

const fs = require('fs');
const { config } = require('./config');
const { maskText } = require('./mask');
const store = require('./store');

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    needsHuman: {
      type: 'boolean',
      description: '운영자가 직접 확인해야 하는 문의면 true',
    },
    category: {
      type: 'string',
      description: '문의 유형 — 정책 문서의 유형 이름 중 하나, 없으면 기타',
    },
    summary: {
      type: 'string',
      description: '문의 내용 한 줄 요약 — 40자 안. 슬랙 카드 맨 위에 굵게 실린다',
    },
    draft: {
      type: 'string',
      description: '고객에게 보낼 답변 초안. needsHuman이 true면 빈 문자열.',
    },
    contextSummary: {
      type: 'string',
      description: '앞선 대화가 있으면 무슨 일이 있었는지 한두 문장으로 요약 (날짜·원문 인용 없이, 해요체. 예: 「입장 링크를 못 받았다고 해서 알림톡으로 보냈다고 안내했고, 받았다고 했어요」). 앞선 대화가 없으면 빈 문자열. 슬랙 카드에는 원문 대신 이 요약이 실린다',
    },
    reason: {
      type: 'string',
      description: 'needsHuman이 true면 사람이 무엇을 확인해야 하는지 두세 문장. false면 어떤 정책 항목을 근거로 썼는지 한 문장(예: 「정책 1. 다시보기 — 어디서 보나」). 카드에 그대로 실리니 짧게, 「~해요」로 끝나는 해요체로(「~함」 「~필요」 같은 개조식 금지. 예: 「직접 확인해야 해요」).',
    },
  },
  required: ['needsHuman', 'category', 'summary', 'contextSummary', 'draft', 'reason'],
  additionalProperties: false,
};

/** 초안에 들어가면 안 되는 내부 용어 — policy/leak-words.json (없으면 example) */
function findLeak(text) {
  if (!text) return null;
  let list;
  try { list = JSON.parse(fs.readFileSync(config.leakWordsFile, 'utf8')); } catch { return null; }
  const lower = text.toLowerCase();
  for (const w of list.words || []) {
    if (w.startsWith('(')) continue; // example 의 안내 문장
    if (lower.includes(w.toLowerCase())) return w;
  }
  for (const w of list['_단어_경계'] || []) if (new RegExp(`(^|[^A-Za-z0-9가-힣])${w}([^A-Za-z0-9가-힣]|$)`).test(text)) return w;
  return null;
}

function getProvider() {
  const name = config.ai.provider;
  if (name === 'api') return require('./providers/api');
  if (name === 'cli') return require('./providers/cli');
  throw new Error(`알 수 없는 CX_AI_PROVIDER: ${name} (cli 또는 api)`);
}

let policyNoticeShown = false;
/** 정책 문서 — 내 것(policy/answers.md)이 없으면 가상 커뮤니티 샘플로 돈다 */
function loadPolicy() {
  if (fs.existsSync(config.policyFile)) return fs.readFileSync(config.policyFile, 'utf-8');
  if (fs.existsSync(config.policySampleFile)) {
    if (!policyNoticeShown) {
      policyNoticeShown = true;
      console.log('  (policy/answers.md 가 없어 policy/answers.sample.md 로 돌아요. 내 정책은 cx-interview 스킬로 만들어요)');
    }
    return fs.readFileSync(config.policySampleFile, 'utf-8');
  }
  throw new Error('policy/answers.md 가 없습니다. START_HERE.md 의 프롬프트 A 로 먼저 만들어주세요.');
}

/**
 * 추가 사실 파일 (선택) — 예: 회원 화면 안내 문장을 모아 둔 파일.
 * 정책 문서와 어긋나면 이쪽을 더 최신으로 본다. 없으면 정책 문서만으로 간다 — 초안이 안 나오는 일은 없다.
 */
function loadFacts() {
  const file = config.factsFile;
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8').slice(0, 9000);
}

/**
 * 운영자가 최근에 실제로 보낸 답 — 승인한 초안과 「고쳐서 보내기」로 고친 문장. 최근 10건.
 * 운영자 본인의 말이라 승인 없이 바로 예시로 쓴다. 이름·번호는 가린다.
 */
function recentExamples() {
  try {
    const ex = store.recentDecisions(10);
    if (!ex.length) return '';
    const lines = ex.map((e, i) => `${i + 1}. [${e.category}] 문의 요약: ${maskText(e.summary)}\n   보낸 답: ${maskText(e.text).slice(0, 300)}`);
    return `

아래는 운영자가 최근에 실제로 보낸 답입니다. 말투와 길이, 무엇을 말하고 무엇을 말하지 않는지를 이 예시에 맞추세요.
「수정」 표시가 있는 것은 AI 초안을 운영자가 고친 것이라 더 정확한 기준입니다.

<recent_answers>
${lines.join('\n')}
</recent_answers>`;
  } catch { return ''; }
}

function buildSystem(policy, facts, examples) {
  const factsBlock = facts
    ? `

아래는 정책 문서와 함께 보는 추가 사실입니다. 정책 문서와 어긋나면 이 사실이 더 최신입니다.

<facts>
${facts}
</facts>`
    : '';

  return `당신은 ${config.brandName}의 CX 담당자입니다.
고객 문의에 대한 답변 초안을 작성합니다. 이 초안은 운영자가 검토하고 승인해야 발송됩니다.

아래는 답변 정책 문서입니다. 이 문서에 근거가 있는 내용만 답변하세요.

<policy>
${policy}
</policy>${factsBlock}${examples || ''}

판단 기준:
- 정책 문서에 근거가 있으면 초안을 작성합니다.
- 정책 문서에 없는 날짜, 금액, 조건은 절대 지어내지 않습니다.
- 정책에 "[확인 필요]"로 표시된 항목이 답변에 필요하면 needsHuman을 true로 하세요.
- 정책의 "확인 필요로 넘겨야 하는 경우"에 해당하면 needsHuman을 true로 하세요.
- 애매하면 needsHuman을 true로 합니다. 잘못된 답변보다 사람이 보는 게 낫습니다.

초안은 고객에게 그대로 보낼 수 있는 완성된 문장으로 씁니다.
인사말과 맺음말을 포함하되, 정책의 말투 원칙을 따르세요.`;
}

function buildUser(inquiry) {
  // 모델에 보내기 전에 이름·번호·이메일·긴 숫자를 가린다 — 답하는 데 필요 없는 값이고, 개인정보를 LLM 에 그대로 보내지 않는다
  return `다음 문의에 대한 답변 초안을 작성해주세요. 문의 속 [이름] [전화번호] [이메일] 은 가려진 자리이니 그대로 두고, 답에 되풀이해 적지 마세요.

유입 경로: ${inquiry.source === 'kakao' ? '카카오 채널' : inquiry.source}
접수 시각: ${inquiry.receivedAt}

<새_문의>
${maskText(inquiry.body || inquiry.preview)}
</새_문의>
${inquiry.context ? `
<앞선_대화 — 참고만, 답은 새 문의에>
${maskText(inquiry.context)}
</앞선_대화>` : ''}`;
}

/**
 * 문의 하나에 대한 초안을 만든다.
 * @param {object} inquiry - 공통 스키마의 문의
 * @returns {Promise<object>} { needsHuman, category, summary, contextSummary, draft, reason, costUsd }
 */
async function generate(inquiry) {
  const provider = getProvider();
  const policy = loadPolicy();
  const facts = loadFacts();
  const examples = recentExamples();

  try {
    const { data, costUsd } = await provider.complete({
      system: buildSystem(policy, facts, examples),
      user: buildUser(inquiry),
      schema: DRAFT_SCHEMA,
      model: config.anthropic.model,
    });
    // 내부 용어가 섞인 초안은 내보내지 않는다 — 사람이 본다
    const leaked = findLeak(data.draft);
    if (leaked) {
      return { ...data, needsHuman: true, draft: '', reason: `초안에 내부 용어(${leaked})가 들어 있어 사람이 확인해야 해요. 원래 근거: ${data.reason}`, costUsd };
    }
    return { ...data, costUsd };
  } catch (err) {
    // 초안 생성이 실패해도 문의는 놓치면 안 된다 — 사람에게 넘긴다
    return {
      needsHuman: true,
      category: '기타',
      summary: '(초안 생성 실패)',
      contextSummary: '',
      draft: '',
      reason: `AI 초안을 만들지 못했어요: ${err.message}`,
      costUsd: null,
    };
  }
}

module.exports = { generate, DRAFT_SCHEMA, findLeak, buildSystem, buildUser };
