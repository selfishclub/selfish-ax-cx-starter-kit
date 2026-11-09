// 아침 브리핑 — 어제 카카오 문의를 한 장으로 슬랙에. 매일 9시(launchd).
//
//   어제 카드 N건 · 유형별 · 사람이 봐야 했던 것 · 아직 답 안 한 것 · 「이렇게 고치면 어때요」 제안 한 줄
//
// 쓰는 법
//   미리 보기(슬랙에 안 올림)   node briefing.mjs --dry
//   오늘 것으로 미리 보기        node briefing.mjs --dry --today
//   실제로 올리기                node briefing.mjs
//   제안을 규칙으로만            node briefing.mjs --no-claude
//
// 읽는 것 — 수집기가 남기는 cx-data/state.json 뿐. 거기에는 문의마다 「언제 카드로 올렸나 · 유형 · 요약 · 운영자가 승인/수정/건너뜀 중 무엇을 했나」가 있다.
// 지키는 것
//   - 요약은 가린 뒤 쓴다(이름 · 번호 · 긴 숫자). Claude 에게 가는 글에도 개인정보가 없다.
//   - 읽기만 한다. 제안은 「제안」일 뿐이다. 승인 전에는 아무것도 바뀌지 않는다.
//   - claude 가 없거나 실패하면 단순한 규칙으로 돌아간다 — 브리핑이 안 올라오는 일은 없다.

import { readFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { config } = require(path.join(HERE, "src", "config.js"));
const { maskText } = require(path.join(HERE, "src", "mask.js"));
const { setStatus } = require(path.join(HERE, "src", "status.js"));

const DRY = process.argv.includes("--dry");
const TODAY = process.argv.includes("--today");
const USE_CLAUDE = !process.argv.includes("--no-claude");
const JUDGE_MODEL = process.env.CX_BRIEFING_MODEL || "sonnet";
const JUDGE_TIMEOUT_MS = 120_000;

const KST = 9 * 60 * 60 * 1000;
/** 한국 시간 기준 하루의 시작·끝(UTC). offsetDays: 0=오늘, -1=어제 */
function kstDay(offsetDays) {
  const nowKst = new Date(Date.now() + KST);
  const start = Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate() + offsetDays) - KST;
  return { from: new Date(start), to: new Date(start + 24 * 60 * 60 * 1000) };
}

/** 어제 카드와 아직 답 안 한 카드 — state.json 읽기만. 「sample:」 시험 카드는 세지 않는다 */
function kakaoStats(day) {
  const file = path.join(config.dataDir, "state.json");
  if (!existsSync(file)) return null;
  let all;
  try { all = Object.entries(JSON.parse(readFileSync(file, "utf8")).inquiries ?? {}).filter(([k]) => !k.startsWith("sample:")).map(([, v]) => v); } catch { return null; }
  const inDay = all.filter((i) => { const t = new Date(i.recordedAt ?? 0).getTime(); return t >= day.from.getTime() && t < day.to.getTime(); });
  // 답 안 한 것은 최근 2주 것만 센다 — 오래된 시험 카드를 매일 되풀이하지 않게
  const since = day.to.getTime() - 14 * 24 * 60 * 60 * 1000;
  const pending = all.filter((i) => !i.decision && new Date(i.recordedAt ?? 0).getTime() >= since);
  const byCategory = new Map();
  for (const i of inDay) byCategory.set(i.category ?? "기타", (byCategory.get(i.category ?? "기타") ?? 0) + 1);
  return {
    count: inDay.length,
    needsHuman: inDay.filter((i) => i.needsHuman).length,
    edited: inDay.filter((i) => i.decision === "edit" || i.edited).length,
    skipped: inDay.filter((i) => i.decision === "skip").length,
    direct: inDay.filter((i) => i.decision === "direct").length,
    pending: pending.length,
    categories: [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(" · "),
    rows: inDay.map((i) => ({ category: i.category ?? "기타", summary: maskText(String(i.summary ?? "")).slice(0, 120), needsHuman: !!i.needsHuman, decision: i.decision ?? null, edited: i.decision === "edit" || !!i.edited, draft: maskText(String(i.draft ?? "")).slice(0, 200), final: i.decision === "edit" ? maskText(String(i.note ?? "")).slice(0, 200) : "" })),
  };
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--strict-mcp-config", "--model", JUDGE_MODEL], { cwd: os.tmpdir() });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("시간 초과")); }, JUDGE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude 종료 코드 ${code}`));
      try { const payload = JSON.parse(out); if (payload.is_error) return reject(new Error("claude 오류")); resolve(String(payload.result || "")); } catch { reject(new Error("claude 출력을 읽지 못했습니다")); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** 규칙 제안 — Claude 를 못 부를 때의 대비책 */
function ruleSuggestion(k) {
  if (!k || k.count === 0) return "어제는 고칠 것이 보이지 않았어요.";
  if (k.needsHuman >= Math.ceil(k.count / 2)) return `어제 문의 ${k.count}건 중 ${k.needsHuman}건이 「사람이 봐야 해요」였어요. 그 유형(${k.categories})의 표준 답을 정책 문서에 더하면 초안이 더 많이 나와요.`;
  if (k.edited >= 2) return `어제 초안을 ${k.edited}번 고쳐서 보냈어요. 고친 문장은 다음 초안의 예시로 쓰이지만, 정책 문서의 표준 답도 같이 바꾸면 더 빨라요.`;
  return "어제는 고칠 것이 보이지 않았어요.";
}

/** Claude 에게 어제의 카드를 보여주고 「한 가지」 제안을 받는다. 실패하면 null */
async function judgeWithClaude(k) {
  if (!USE_CLAUDE || !k || k.count === 0) return null;
  let policy = "";
  try { policy = readFileSync(existsSync(config.policyFile) ? config.policyFile : config.policySampleFile, "utf8").slice(0, 9000); } catch { /* 없어도 판단은 한다 */ }
  const log = k.rows.slice(0, 40).map((r, i) => `${i + 1}. [${r.category}${r.needsHuman ? " · 사람이 봐야 함" : ""}${r.decision ? ` · ${r.decision}` : " · 아직 결정 없음"}] ${r.summary}${r.edited ? `\n   AI 초안: ${r.draft}\n   운영자가 보낸 답: ${r.final}` : ""}`).join("\n");
  const prompt = `당신은 ${config.brandName}의 문의 답변 운영 기록을 읽고, 운영자(비개발자)에게 개선을 한 가지만 제안하는 역할입니다.

[지금 정책 문서 — 초안기가 답의 근거로 삼는 유일한 문서]
${policy}

[어제의 카드 — 개인정보는 이미 가려져 있음]
${log}

할 일
1. 같은 뜻의 문의를 묶어 무엇이 반복되는지 봅니다.
2. 「사람이 봐야 함」이 많은 유형이 있으면, 정책에 어떤 표준 답을 더하면 초안이 나올지 봅니다.
3. 운영자가 초안을 고친 방향(말투 · 길이 · 무엇을 빼고 더했나)이 있으면 찾아냅니다.
4. 가장 효과가 클 개선을 한 가지만 고릅니다. 고칠 것이 없으면 없다고 말합니다.

아래 JSON 하나만 출력하세요. 다른 글은 쓰지 마세요. 값은 전부 한국어 해요체, 각 120자 이내.
{"suggestion":"무엇을 하면 좋은지 한두 문장","evidence":"그렇게 본 근거 — 건수와 문의 예","where":"고칠 곳 — 정책 문서의 유형 이름 / 말투 / 넘기는 기준 / 없음","risk":"낮음 / 보통 / 높음 과 이유 한마디"}`;
  try {
    const text = await runClaude(prompt);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!j.suggestion) return null;
    const clip = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    return { suggestion: clip(j.suggestion), evidence: clip(j.evidence), where: clip(j.where), risk: clip(j.risk) };
  } catch (e) {
    console.error(`Claude 판단을 받지 못해 규칙으로 돌아갑니다: ${e.message}`);
    return null;
  }
}

/** 승인 대기 PR — learn.mjs 가 올린 정책 수정안. gh 가 없거나 실패하면 그 줄만 빠진다 */
function pendingPrs() {
  try {
    const out = execFileSync("gh", ["pr", "list", "--label", "cx-learn", "--state", "open", "--json", "number,title,url", "--limit", "10"], { encoding: "utf8", timeout: 15_000, cwd: config.kitRoot });
    return JSON.parse(out);
  } catch { return []; }
}

function buildBriefing(k, day, judged) {
  const dateLabel = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short" }).format(day.from);
  const lines = [`*CX 아침 브리핑 — ${dateLabel}*`];
  if (!k) {
    lines.push("수집기 기록(cx-data/state.json)이 아직 없어요. `npm run cx` 를 한 번 돌리면 생겨요.");
    return lines.join("\n");
  }
  if (k.count === 0) lines.push("어제 새로 카드로 올라온 문의는 없었어요.");
  else {
    lines.push(`문의 ${k.count}건 (${k.categories}) · 초안이 나온 것 ${k.count - k.needsHuman}건 · 사람이 봐야 했던 것 ${k.needsHuman}건`);
    const acts = [];
    if (k.edited) acts.push(`고쳐서 보냄 ${k.edited}`);
    if (k.skipped) acts.push(`건너뜀 ${k.skipped}`);
    if (k.direct) acts.push(`카카오에서 직접 답함 ${k.direct}`);
    if (acts.length) lines.push(acts.join(" · "));
  }
  if (k.pending > 0) lines.push(`아직 답 안 한 문의 ${k.pending}건 — 슬랙 ${config.slack.channel} 카드에서 버튼을 눌러 주세요.`);

  const prs = pendingPrs();
  if (prs.length) {
    lines.push("", `*승인 대기 — 주 1회 학습이 올린 정책 수정안 ${prs.length}건*`);
    for (const p of prs) lines.push(`• #${p.number} ${p.title} — ${p.url}`);
    lines.push("_열어서 틀린 줄은 지우고 「Merge」를 누르면 다음 초안부터 반영돼요. 아니면 「Close」._");
  }

  if (judged) {
    lines.push("", "*제안* _(Claude 가 판단)_", judged.suggestion);
    if (judged.evidence) lines.push(`• 근거 — ${judged.evidence}`);
    if (judged.where) lines.push(`• 고칠 곳 — ${judged.where}`);
    if (judged.risk) lines.push(`• 위험도 — ${judged.risk}`);
  } else {
    lines.push("", "*제안* _(규칙)_", ruleSuggestion(k));
  }
  lines.push("_하실 거면 Claude Code 에서 키트 폴더를 열고 「오늘 브리핑 제안 하자」라고 말해 주세요. 승인 전에는 아무것도 바뀌지 않아요._");
  return lines.join("\n");
}

async function main() {
  const day = kstDay(TODAY ? 0 : -1);
  const k = kakaoStats(day);
  const judged = await judgeWithClaude(k);
  const text = buildBriefing(k, day, judged);

  if (DRY) {
    console.log("── 미리 보기 (슬랙에 올리지 않았습니다) ──\n" + text);
    return;
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error(".env.local 에 SLACK_BOT_TOKEN 이 없습니다");
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel: config.slack.briefingChannel, text, mrkdwn: true }),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(`슬랙에 올리지 못했습니다: ${out.error}`);
  console.log("슬랙에 올렸습니다.");
  await setStatus("briefing:last", { at: new Date().toISOString(), ok: true, text: text.slice(0, 2000) });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
