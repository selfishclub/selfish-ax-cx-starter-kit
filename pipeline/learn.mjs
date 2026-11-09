// 주 1회 학습 — 일요일 밤에 돈다(launchd). 「특정 주기로 알아서 배우게」
//
// 배움 = 모델 훈련이 아니라, 초안기가 읽는 답변 정책(policy/answers.md)을 새 데이터로 고치자고 제안하는 것.
//
//   ① 지난 7일 대화가 있던 카카오 방을 전부 뽑는다 (창 없이 · 읽기만 · 안 읽은 방은 건너뜀)
//   ② 그 주에 운영자가 카드에서 결정한 것(승인·수정·보냄·건너뜀)을 읽는다
//   ③ Claude(claude -p)가 둘을 보고 「정책에 더할 것·고칠 것」을 쓴다
//   ④ 브랜치 cx/learn-<날짜> + PR(꼬리표 cx-learn) 로 올린다 — main 은 건드리지 않는다
//   ⑤ 슬랙 운영 알림 채널에 한 줄. 월요일 브리핑에도 「승인 대기」로 뜬다
//
// 자동으로 하지 않는 것 — 정책을 사람 확인 없이 덮어쓰기. 회원에게 나가는 말의 근거라 Merge 버튼은 사람이 누른다.
// 키트 폴더가 깃 저장소가 아니거나 gh 가 없으면 ④ 대신 policy/learn-log/<날짜>.md 파일로만 남긴다.
//
//   node learn.mjs            실제로 (추출 → PR 또는 파일 → 슬랙)
//   node learn.mjs --dry      추출·판단까지만, PR·슬랙은 안 올림 (결과는 화면에)
//   node learn.mjs --days 14  기간
//
// Claude 에게 가는 글에는 이름·번호·이메일이 없다(가린 사본만 읽는다). 결과 파일에도 없다.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { config } = require(path.join(HERE, "src", "config.js"));
const { MENU } = require(path.join(HERE, "src", "filters.js"));
const { setStatus } = require(path.join(HERE, "src", "status.js"));

const DRY = process.argv.includes("--dry");
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) || 7 : 7;
const MODEL = process.env.CX_BRIEFING_MODEL || "sonnet";
const KIT = config.kitRoot;
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const PREFIX = `weekly-${TODAY}`;
const LABEL = "cx-learn";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const log = (m) => console.log(`[학습 ${new Date().toTimeString().slice(0, 5)}] ${m}`);

/** 수집기(launchd)는 같은 브라우저 폴더를 쓴다 — 뽑는 동안만 멈춘다. 등록돼 있지 않으면 아무것도 안 한다 */
const CX = `gui/${os.userInfo().uid}/cx.starter-kit.collector`;
const CX_PLIST = path.join(os.homedir(), "Library/LaunchAgents/cx.starter-kit.collector.plist");
function pauseCollector() { try { sh("launchctl", ["bootout", CX]); log("수집기 잠시 멈춤"); return true; } catch { return false; } }
function resumeCollector(was) { if (!was) return; try { sh("launchctl", ["bootstrap", `gui/${os.userInfo().uid}`, CX_PLIST]); log("수집기 다시 켬"); } catch (e) { log(`⚠️ 수집기를 다시 못 켰습니다: ${e.message}`); } }

/** 자동 답장·카드·메뉴 버튼을 빼고 고객 말과 운영자 답만 — tools/summarize-history.js 와 같은 기준 */
function digest(rooms) {
  const norm = (t) => t.replace(/\s+/g, " ").trim().slice(0, 80);
  const freq = new Map();
  for (const r of rooms) for (const m of r.messages) if (m.who === "us" && m.kind !== "card") freq.set(norm(m.text), (freq.get(norm(m.text)) || 0) + 1);
  const out = []; let customer = 0, human = 0;
  for (const r of rooms) {
    const lines = [];
    for (const m of r.messages) {
      const t = m.text.replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (m.who === "customer") { if (MENU.test(t)) continue; customer++; lines.push(`고객: ${t.slice(0, 240)}`); }
      else { if (m.kind === "card" || /type_card/.test(m.cls) || (freq.get(norm(m.text)) || 0) >= 3) continue; human++; lines.push(`운영자: ${t.slice(0, 240)}`); }
    }
    const recent = lines.slice(-14); // 지난 기간의 대화만 — 옛 대화는 이미 배웠다
    if (recent.length) out.push(`### 방 ${r.name} (마지막 ${r.lastDate})\n${recent.join("\n")}`);
  }
  return { text: out.join("\n\n"), customer, human, rooms: out.length };
}

function decisions(sinceIso) {
  const file = path.join(config.dataDir, "state.json");
  if (!existsSync(file)) return [];
  const all = Object.entries(JSON.parse(readFileSync(file, "utf8")).inquiries || {});
  return all
    .filter(([k, v]) => !k.startsWith("sample:") && v.decision && (v.decidedAt || v.recordedAt || "") >= sinceIso)
    .map(([, v]) => ({ decision: v.decision, category: v.category, summary: v.summary, draft: v.draft, final: v.note || v.draft, edited: !!v.edited || v.decision === "edit" }));
}

function leakWords() {
  try { return (JSON.parse(readFileSync(config.leakWordsFile, "utf8")).words || []).filter((w) => !String(w).startsWith("(")).join("·"); } catch { return ""; }
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--strict-mcp-config", "--model", MODEL], { cwd: os.tmpdir() });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("시간 초과")); }, 240_000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude 종료 코드 ${code}`));
      try { const p = JSON.parse(out); if (p.is_error) return reject(new Error("claude 오류")); resolve(String(p.result || "")); } catch { reject(new Error("claude 출력을 읽지 못했습니다")); }
    });
    child.stdin.write(prompt); child.stdin.end();
  });
}

async function judge(policy, dig, dec) {
  const decText = dec.length ? dec.map((d, i) => `${i + 1}. [${d.category}] ${d.decision}${d.edited ? "(운영자가 고침)" : ""} · 문의 요약: ${d.summary}\n   ${d.edited ? `AI 초안: ${String(d.draft || "").slice(0, 200)}\n   운영자가 보낸 답: ` : "보낸 답: "}${String(d.final || "").slice(0, 300)}`).join("\n") : "(이번 주 카드 결정 없음)";
  const prompt = `당신은 ${config.brandName}의 문의 「답변 정책 문서」를 관리하는 역할입니다. 정책 문서는 AI 초안기가 초안을 쓸 때 근거로 삼는 유일한 문서라, 여기에 없는 내용은 초안기가 답하지 않습니다.

아래 셋을 읽고, 정책에 「더할 것」과 「고칠 것」을 찾아 주세요. 이미 정책에 있는 내용은 다시 쓰지 마세요. 새 사실·바뀐 답·운영자가 초안을 고친 방향(말투·길이·무엇을 빼고 무엇을 더했나)만 봅니다.

지켜야 할 것
- 정책 문서에 없는 날짜·금액·조건을 지어내지 않습니다. 대화에서 운영자가 실제로 말한 것만 옮깁니다.
- 이름·번호·이메일·링크·계좌는 쓰지 않습니다(이미 가려져 있음).
- 내부 도구·업체 이름(${leakWords() || "내부 도구 이름"})은 쓰지 않습니다.
- 확실하지 않으면 「확인 필요」로 표시합니다.
- 한국어 해요체, 항목마다 120자 이내.

[현재 정책 문서]
${policy.slice(0, 14000)}

[지난 ${DAYS}일 카카오 대화 — 고객 말과 운영자 답만, 개인정보는 가려짐]
${dig.text.slice(0, 20000)}

[지난 ${DAYS}일 운영자의 카드 결정]
${decText}

아래 JSON 하나만 출력하세요. 다른 글은 쓰지 마세요.
{"additions":[{"type":"유형 이름","fact":"정책에 더할 사실 한 문장","draft":"초안 표준 문장(운영자 말투)","evidence":"근거 — 어느 대화·결정에서"}],"corrections":[{"where":"정책의 어느 부분","from":"지금 문장 요지","to":"이렇게","evidence":"근거"}],"styleNotes":["운영자가 초안을 고친 방향 — 있으면"],"nothing":false}
고칠 것이 정말 없으면 {"additions":[],"corrections":[],"styleNotes":[],"nothing":true}`;
  const text = await runClaude(prompt);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude 답에서 JSON 을 찾지 못했습니다");
  return JSON.parse(m[0]);
}

function renderSection(j) {
  const L = [`## 주 1회 학습 — ${TODAY} (자동 제안 · 승인 전)`, "", `> 지난 ${DAYS}일 카카오 대화와 카드 결정에서 Claude 가 뽑은 것. **Merge 하면 그때부터 초안기가 이 내용을 읽는다.** 틀린 줄은 지우고 Merge 하거나 Close.`, ""];
  if (j.additions?.length) { L.push("**더할 것**"); for (const a of j.additions) L.push(`- **${a.type}** — ${a.fact}\n  > ${a.draft}\n  근거: ${a.evidence}`); L.push(""); }
  if (j.corrections?.length) { L.push("**고칠 것**"); for (const c of j.corrections) L.push(`- ${c.where}: 「${c.from}」 → 「${c.to}」 (근거: ${c.evidence})`); L.push(""); }
  if (j.styleNotes?.length) { L.push("**운영자가 초안을 고친 방향**"); for (const s of j.styleNotes) L.push(`- ${s}`); L.push(""); }
  return L.join("\n");
}

async function slack(text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` }, body: JSON.stringify({ channel: config.slack.briefingChannel, text, mrkdwn: true }) }).catch(() => {});
}

function canPr() {
  try { sh("git", ["rev-parse", "--is-inside-work-tree"], { cwd: KIT }); sh("gh", ["--version"]); sh("git", ["remote", "get-url", "origin"], { cwd: KIT }); return true; } catch { return false; }
}

async function main() {
  if (!existsSync(config.policyFile)) { console.error("policy/answers.md 가 없어요. 내 정책이 있어야 학습할 것이 있어요 (START_HERE.md 프롬프트 A)."); process.exit(1); }
  const sinceIso = new Date(Date.now() - DAYS * 864e5).toISOString();
  // ① 추출
  const was = pauseCollector();
  let extracted = "";
  try {
    extracted = sh("node", [path.join(HERE, "tools", "extract-history.js"), "--since-days", String(DAYS), "--prefix", PREFIX, "--size", "80"], { cwd: HERE });
  } finally { resumeCollector(was); }
  log(extracted.split("\n").filter((l) => /^방|저장:/.test(l)).join(" · "));
  const maskedFile = path.join(config.dataDir, "history", `${PREFIX}-masked.json`);
  const rooms = existsSync(maskedFile) ? JSON.parse(readFileSync(maskedFile, "utf8")) : [];
  const dig = digest(rooms);
  const dec = decisions(sinceIso);
  log(`방 ${dig.rooms} · 고객 말 ${dig.customer} · 운영자 답 ${dig.human} · 카드 결정 ${dec.length}`);
  if (dig.rooms === 0 && dec.length === 0) { log("배울 재료가 없어요."); if (!DRY) { await slack(`📚 주 1회 학습(${TODAY}) — 지난 ${DAYS}일 새 대화·카드 결정이 없어 건너뛰었어요.`); await setStatus("learn:last", { at: new Date().toISOString(), ok: true, pr: null, note: "재료 없음" }); } return; }

  // ③ 판단
  const policy = readFileSync(config.policyFile, "utf8");
  const j = await judge(policy, dig, dec);
  const section = renderSection(j);
  const n = (j.additions?.length || 0) + (j.corrections?.length || 0);
  if (j.nothing || n === 0) { log("고칠 것이 없다고 판단했어요."); if (!DRY) { await slack(`📚 주 1회 학습(${TODAY}) — 방 ${dig.rooms}·결정 ${dec.length}건을 봤지만 정책에 더할 것이 없었어요.`); await setStatus("learn:last", { at: new Date().toISOString(), ok: true, pr: null, rooms: dig.rooms, decisions: dec.length, note: "더할 것 없음" }); } return; }
  if (DRY) { console.log("\n── 미리 보기 (PR·슬랙에 안 올림) ──\n" + section); return; }

  const summary = `지난 ${DAYS}일: 방 ${dig.rooms} · 고객 말 ${dig.customer} · 운영자 답 ${dig.human} · 카드 결정 ${dec.length}건. 원본은 내 컴퓨터에만(깃 제외).`;
  const logDir = path.join(config.policyDir, "learn-log");

  // ④-b 깃 · gh 가 없으면 파일로만
  if (!canPr()) {
    mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `${TODAY}.md`);
    writeFileSync(file, `# 주 1회 학습 — ${TODAY}\n\n${summary}\n\n${section}`);
    log(`PR 을 열 수 없어(깃 저장소 아님 또는 gh 없음) 파일로 남겼어요: ${file}`);
    await slack(`📚 *주 1회 학습(${TODAY})* — 정책에 더할 것 ${j.additions?.length || 0}·고칠 것 ${j.corrections?.length || 0}. 제안은 policy/learn-log/${TODAY}.md 에 있어요. 읽고 맞는 것만 policy/answers.md 에 옮겨 주세요.`);
    await setStatus("learn:last", { at: new Date().toISOString(), ok: true, pr: null, file, additions: j.additions?.length || 0, corrections: j.corrections?.length || 0 });
    return;
  }

  // ④ 브랜치 + PR — 작업 상태를 건드리지 않게 임시 작업 폴더에서
  const branch = `cx/learn-${TODAY}`;
  const wt = path.join(os.tmpdir(), `cx-learn-${TODAY}`);
  const base = sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: KIT }).replace(/^origin\//, "") || "main";
  sh("git", ["fetch", "-q", "origin", base], { cwd: KIT });
  try { sh("git", ["worktree", "remove", "--force", wt], { cwd: KIT }); } catch {}
  try { sh("git", ["branch", "-D", branch], { cwd: KIT }); } catch {}
  sh("git", ["worktree", "add", "-q", "-b", branch, wt, `origin/${base}`], { cwd: KIT });
  try {
    const rel = path.relative(KIT, config.policyFile);
    const pPolicy = path.join(wt, rel);
    writeFileSync(pPolicy, readFileSync(pPolicy, "utf8").trimEnd() + "\n\n---\n\n" + section + "\n");
    const wtLog = path.join(wt, "policy", "learn-log"); mkdirSync(wtLog, { recursive: true });
    writeFileSync(path.join(wtLog, `${TODAY}.md`), `# 주 1회 학습 — ${TODAY}\n\n${summary}\n\n${section}`);
    sh("git", ["add", "-A"], { cwd: wt });
    sh("git", ["commit", "-q", "-m", `정책 학습 ${TODAY} — 더할 것 ${j.additions?.length || 0} · 고칠 것 ${j.corrections?.length || 0} (자동 제안 · 승인 전)`], { cwd: wt });
    sh("git", ["push", "-q", "-u", "origin", branch], { cwd: wt });
    try { sh("gh", ["label", "create", LABEL, "--color", "E9ED12", "--description", "주 1회 학습이 올린 정책 수정안"], { cwd: wt }); } catch {}
    const url = sh("gh", ["pr", "create", "--label", LABEL, "--base", base, "--head", branch, "--title", `정책 학습 ${TODAY} — 더할 것 ${j.additions?.length || 0} · 고칠 것 ${j.corrections?.length || 0}`, "--body", `자동 제안입니다. 틀린 줄은 지우고 Merge 하거나 Close 해 주세요.\n\n${summary}\n\n${section}`], { cwd: wt });
    log(`PR: ${url}`);
    await setStatus("learn:last", { at: new Date().toISOString(), ok: true, pr: url, rooms: dig.rooms, decisions: dec.length, additions: j.additions?.length || 0, corrections: j.corrections?.length || 0 });
    await slack(`📚 *주 1회 학습(${TODAY})* — 지난 ${DAYS}일 대화 ${dig.rooms}방·결정 ${dec.length}건에서 정책에 더할 것 ${j.additions?.length || 0}·고칠 것 ${j.corrections?.length || 0}. 승인 대기: ${url}\n_열어서 틀린 줄은 지우고 Merge 하면 다음 초안부터 반영돼요._`);
  } finally {
    try { sh("git", ["worktree", "remove", "--force", wt], { cwd: KIT }); } catch {}
  }
}

main().catch(async (e) => { console.error(`오류: ${e.message}`); if (!DRY) { await slack(`⚠️ 주 1회 학습(${TODAY})이 실패했어요: ${e.message.slice(0, 120)}`); await setStatus("learn:last", { at: new Date().toISOString(), ok: false, error: e.message.slice(0, 200) }); } process.exit(1); });
