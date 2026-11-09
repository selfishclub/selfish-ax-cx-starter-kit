/**
 * 슬랙 연동 — 문의 카드 발송 + 승인/수정/건너뛰기 버튼 처리
 *
 * Socket Mode를 쓴다. 공개 서버 URL 없이 로컬에서 버튼 클릭을 받을 수 있어서
 * ngrok 같은 터널이 필요 없다.
 *
 * 주의: 이 카드에는 고객 문의 내용이 들어간다. 내부 비공개 채널에만 발송할 것.
 * 2026-09-28 — 카드에는 최소한만 싣는다. 이름은 가리고(김*은), 본문의 전화번호·이메일·긴 숫자·금액은 지운다.
 *   원본은 카카오 관리자 화면에 그대로 있다(「원본 열기」).
 */

const { App } = require('@slack/bolt');
const { config } = require('./config');
const store = require('./store');
const { maskName, maskText } = require('./mask');
const { setStatus } = require('./status');

const SLACK_TEXT_LIMIT = 2800;

function truncate(text, limit = SLACK_TEXT_LIMIT) {
  if (!text) return '(내용 없음)';
  return text.length > limit ? `${text.slice(0, limit)}\n\n…(생략)` : text;
}

function createApp() {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });
}

/**
 * 카드 읽기 쉽게 (2026-11-01)
 *   - 머리글에 색 점만이 아니라 말로 상태를 쓴다 — 「초안 있어요」 「사람이 봐야 해요」
 *   - 초안기가 이미 쓰는 한 줄 요약(summary)을 카드 맨 위에 굵게. 지금까지는 기록에만 남고 카드에는 안 실렸다
 *   - 문의는 인용(>)으로, 초안은 본문으로 — 어느 쪽이 고객 말이고 어느 쪽이 보낼 말인지 모양으로 갈린다
 *   - 근거는 한 줄로 줄인다(200자). 긴 설명은 「사람이 봐야 해요」 카드에만 싣는다
 *   - 버튼 이름을 누르면 무슨 일이 나는지로 — 「이대로 보내기」 「고쳐서 보내기」
 */

/** 「이 분과의 대화」 한 토막 — 카카오 방 기록만으로. 처음 온 분인지 자주 오는 분인지 (2026-09-28) */
function historyLine(h) {
  if (!h) return '';
  const short = (d) => d.replace(/^2026년\s*/, '').replace(/요일$/, '').replace(/\s+/g, ' ').trim();
  if (!h.customerMessages || h.customerMessages <= 0) return '처음 오신 분';
  // 마지막 대화는 당연히 오늘이라 안 적는다 (운영자 9/28)
  const parts = [`이전 메시지 ${h.customerMessages}건`];
  if (h.firstDate) parts.push(`처음 ${short(h.firstDate)}`);
  return parts.join(' · ');
}

/** 수집기가 붙인 「[날짜 시간] 고객: 」 꼬리표를 뗀다 — 시각은 위 줄에 이미 있고, 카드에서는 말만 보이면 된다 (2026-11-01) */
function stripStamps(text) {
  return String(text || '').replace(/^\[[^\]]*\]\s*(고객|우리):\s*/gm, '');
}

/** 앞선 대화 한 줄 — 초안기가 쓴 요약이 있으면 그것, 없으면(초안 실패 등) 원문을 짧게 */
function priorLine(inquiry, draft) {
  const summary = String(draft.contextSummary || '').trim();
  if (summary) return maskText(summary).slice(0, 300);
  if (inquiry.context) return truncate(maskText(stripStamps(inquiry.context)), 300);
  return '';
}

/** 여러 줄을 슬랙 인용(>)으로 */
function quote(text) {
  return String(text)
    .split('\n')
    .map((line) => `>${line}`)
    .join('\n');
}

/** 머리글 한 줄 — 「🟢 VOD · 초안 있어요」 「🔴 환불 · 사람이 봐야 해요」 */
function headline(draft) {
  return draft.needsHuman ? `🔴 ${draft.category} · 사람이 봐야 해요` : `🟢 ${draft.category} · 초안 있어요`;
}

/** 한 줄 요약 — 초안기가 쓴 것. 실패 표시나 빈 값이면 안 싣는다 */
function summaryLine(draft) {
  const s = String(draft.summary || '').trim();
  if (!s || s.startsWith('(')) return '';
  return maskText(s).slice(0, 120);
}

/** 문의 + 초안을 카드로 만든다 */
function buildBlocks(inquiry, draft) {
  const sourceLabel = inquiry.source === 'kakao' ? '카카오 채널' : inquiry.source;
  const meta = [sourceLabel, maskName(inquiry.customerName), inquiry.receivedAt, historyLine(inquiry.history)]
    .filter(Boolean)
    .join(' · ');
  const summary = summaryLine(draft);
  const prior = priorLine(inquiry, draft);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headline(draft) },
    },
    ...(summary ? [{ type: 'section', text: { type: 'mrkdwn', text: `*${summary}*` } }] : []),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: meta }],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `💬 *문의*\n${quote(truncate(maskText(stripStamps(inquiry.body || inquiry.preview)), 1500))}` },
    },
    ...(prior ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `앞선 대화 — ${prior}` }] }] : []),
    { type: 'divider' },
  ];

  if (draft.needsHuman) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🙋 *사람 확인이 필요한 것*\n${truncate(maskText(draft.reason), 600)}` },
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `✍️ *보낼 답 (초안)*\n${truncate(maskText(draft.draft))}` },
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `근거 — ${truncate(maskText(draft.reason), 200)}` }],
    });
  }

  const buttons = [];
  if (!draft.needsHuman) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: '이대로 보내기' },
      style: 'primary',
      action_id: 'cx_approve',
      value: inquiry.key,
    });
  }
  buttons.push(
    {
      type: 'button',
      text: { type: 'plain_text', text: draft.needsHuman ? '답 써서 보내기' : '고쳐서 보내기' },
      action_id: 'cx_edit',
      value: inquiry.key,
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '건너뛰기' },
      action_id: 'cx_skip',
      value: inquiry.key,
    }
  );

  if (inquiry.url) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: '카카오에서 열기' },
      url: inquiry.url,
      action_id: 'cx_open',
    });
  }

  blocks.push({ type: 'actions', elements: buttons });

  return blocks;
}

/** 카드 발송 */
async function postInquiry(app, inquiry, draft) {
  const result = await app.client.chat.postMessage({
    channel: config.slack.channel,
    text: `[CX] ${headline(draft)}${summaryLine(draft) ? ` — ${summaryLine(draft)}` : ''}`,
    blocks: buildBlocks(inquiry, draft),
  });
  return result.ts;
}

/**
 * 운영 알림 한 줄 — 로그인 풀림 같은 것. 문의 카드와 달리 운영 알림 채널 으로 간다.
 * (SLACK_BRIEFING_CHANNEL 이 없으면 카드 채널과 같은 곳)
 */
async function notify(app, text) {
  await app.client.chat.postMessage({ channel: config.slack.briefingChannel, text });
}

/** 결정 후 카드를 상태 표시로 바꾼다 */
async function markDecided(client, channel, ts, label, detail) {
  await client.chat.update({
    channel,
    ts,
    text: label,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${label}` } },
      ...(detail
        ? [{ type: 'section', text: { type: 'mrkdwn', text: truncate(detail) } }]
        : []),
    ],
  });
}

/**
 * 카카오 채널에서 직접 답한 카드를 닫는다 (2026-09-29) — 수집기가 그 방에서 우리 답을 확인했을 때.
 * 버튼이 없어지고 한 줄만 남는다. 무엇을 답했는지는 싣지 않는다(원본은 카카오 관리자 화면에).
 */
async function markAnsweredInKakao(app, ts, at) {
  if (!ts) return;
  await markDecided(app.client, config.slack.channel, ts, `💬 *카카오에서 직접 답했어요*${at ? ` _(${at})_` : ''} — 수집기가 확인하고 카드를 닫았어요`);
}

/**
 * 승인·수정 저장 뒤 실제로 보낸다 (2026-09-28)
 * send 가 없으면(시험 모드) 기록만 한다. 실패하면 카드에 「직접 보내주세요」와 글을 남긴다.
 */
async function deliver(client, channel, ts, key, text, user, send) {
  const chatId = key.startsWith('kakao:') ? key.split(':')[1] : null; // kakao:<방>:<지문>
  if (!send || !chatId) {
    await markDecided(client, channel, ts, `✅ *승인됨* — <@${user}> _(${chatId ? '발송 기능 없음' : '시험 카드'} · 보내지 않음)_`, text);
    return;
  }
  await markDecided(client, channel, ts, `⏳ *카카오로 보내는 중…* — <@${user}>`, text);
  try {
    await send(chatId, text);
    store.decide(key, 'sent');
    await markDecided(client, channel, ts, `📨 *카카오로 보냈어요* — <@${user}>`, text);
  } catch (e) {
    await markDecided(client, channel, ts, `⚠️ *보내지 못했어요 — 카카오 관리자에서 직접 보내주세요* (${e.message.split('\n')[0].slice(0, 80)})`, text);
  }
  await setStatus('cx:cards', store.recentCards(30, maskText));
}

/** 버튼 핸들러 등록. opts.send = (chatId, text) => Promise — 있으면 승인·수정이 곧 발송 */
function registerHandlers(app, opts = {}) {
  const { send } = opts;
  app.action('cx_open', async ({ ack }) => ack());

  app.action('cx_approve', async ({ ack, body, client, action }) => {
    await ack();
    const key = action.value;
    const record = store.get(key);
    store.decide(key, 'approve');
    await deliver(client, body.channel.id, body.message.ts, key, record?.draft || '', body.user.id, send);
  });

  app.action('cx_skip', async ({ ack, body, client, action }) => {
    await ack();
    const key = action.value;
    store.decide(key, 'skip');
    await markDecided(client, body.channel.id, body.message.ts, `⏭ *건너뜀* — <@${body.user.id}>`);
    await setStatus('cx:cards', store.recentCards(30, maskText));
  });

  app.action('cx_edit', async ({ ack, body, client, action }) => {
    await ack();
    const key = action.value;
    const record = store.get(key);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'cx_edit_submit',
        // 어느 문의를 수정 중인지 + 어떤 카드를 갱신할지 넘긴다
        private_metadata: JSON.stringify({
          key,
          channel: body.channel.id,
          ts: body.message.ts,
        }),
        title: { type: 'plain_text', text: '고쳐서 보내기' },
        submit: { type: 'plain_text', text: '카카오로 보내기' },
        blocks: [
          {
            type: 'input',
            block_id: 'draft_block',
            label: { type: 'plain_text', text: '보낼 답 — 이 글이 그대로 카카오로 나가요' },
            element: {
              type: 'plain_text_input',
              action_id: 'draft_input',
              multiline: true,
              initial_value: record?.draft || '',
            },
          },
        ],
      },
    });
  });

  app.view('cx_edit_submit', async ({ ack, body, view, client }) => {
    await ack();
    const { key, channel, ts } = JSON.parse(view.private_metadata);
    const edited = view.state.values.draft_block.draft_input.value;

    // 수정본은 다음 초안의 예시가 된다 (draft.js recentExamples)
    store.decide(key, 'edit', edited);
    await deliver(client, channel, ts, key, edited, body.user.id, send);
  });
}

module.exports = { createApp, postInquiry, registerHandlers, notify, markAnsweredInKakao };
