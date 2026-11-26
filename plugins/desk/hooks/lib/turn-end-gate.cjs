"use strict";

// The turn-end gate for "keep the work moving": a session whose focused card is open may end its turn only one of four ways,
// each stated as a last `Ending:` line the hook checks against the session's own transcript (see docs/keep-the-work-moving.md).
// It blocks at most once per turn, so it can neither loop nor push an agent to invent work: "no ready work" is a valid ending.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const TAG = "[DESK_TURN_END_GATE]";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const MAX_WAIT_MS = 7 * 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DESK = /^(?:desk-|mcp__[^ ]*desk[^ ]*__)(task_create|task_focus|task_update|task_archive|task_signoff)$/u;
// A wake exists only if a tool that registers one ran in this session and returned or was given the id the ending cites.
const WAKE_TOOL = /(?:schedule|automation|wake|watch|remind)/iu;
const CLOSED = new Set(["done", "cancelled", "archived", "drafting"]);
const NOT_A_PERSON = /^(?:me|myself|i|us|nobody|no one|none|n\/a|na|the user|user|agent|an agent|the agent|a session|session|ci|the system|system|tbd|unknown|someone|anyone)$/iu;
const FORM = `Ending: done; shipped: <PR or run URL or commit sha this session produced>
Ending: waiting; on: <named event>; wake: <id of the schedule or watch you registered>; expires: <ISO time within 7 days>; blocks: <what cannot move>
Ending: blocked; on: <named person>; resume: <exact step that restarts the work>
Ending: no ready work; checked: <where you looked for ready work>`;
const text = value => typeof value === "string";
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const failure = diagnostic => ({ status: "unavailable", diagnostic });

function fields(rest) {
  const out = {};
  for (const part of rest.split(";")) {
    const at = part.indexOf(":");
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  return out;
}

// The reply's last `Ending:` line, within its final lines, as { kind, fields }, or null.
function endingOf(reply) {
  if (!text(reply)) return null;
  const lines = reply.split(/\r?\n/u).map(x => x.replace(/[*_`]/gu, "").trim()).filter(Boolean).slice(-6);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^Ending:\s*(done|waiting|blocked|no ready work)\b[;:,.\s-]*(.*)$/iu.exec(lines[i]);
    if (m) return { kind: m[1].toLowerCase(), fields: fields(m[2]) };
  }
  return null;
}

// Judges an ending against evidence taken from the transcript. Returns { ok: true, record } or { ok: false, why }.
function judge(ending, evidence, now) {
  if (!ending) return { ok: false, why: "no `Ending:` line closes the reply" };
  const f = ending.fields;
  if (ending.kind === "done") {
    const ref = f.shipped ?? "";
    const shaped = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:pull\/\d+|actions\/runs\/\d+)\b/u.test(ref) || /^[0-9a-f]{7,40}$/iu.test(ref);
    if (!shaped) return { ok: false, why: "`done` needs `shipped:` with a PR or run URL or a commit sha" };
    if (!evidence.tools.includes(ref.toLowerCase())) return { ok: false, why: `\`shipped: ${ref}\` appears in no tool result of this session, so it is not something this session produced` };
    return { ok: true, record: { kind: "done", shipped: ref } };
  }
  if (ending.kind === "waiting") {
    for (const key of ["on", "wake", "expires", "blocks"]) if (!f[key]) return { ok: false, why: `\`waiting\` needs \`${key}:\`` };
    const at = Date.parse(f.expires);
    if (!Number.isFinite(at) || at <= now) return { ok: false, why: "`expires:` must be an ISO time in the future" };
    if (at - now > MAX_WAIT_MS) return { ok: false, why: "`expires:` is more than 7 days out; a longer wait is a decision for a person (`blocked`)" };
    if (f.wake.length < 4 || !evidence.wakes.includes(f.wake.toLowerCase())) return { ok: false, why: `no schedule, automation or watch this session registered carries \`wake: ${f.wake}\`; register one, then cite its id` };
    return { ok: true, record: { kind: "waiting", on: f.on, wake: f.wake, expires: new Date(at).toISOString(), blocks: f.blocks } };
  }
  if (ending.kind === "blocked") {
    if (!f.on || NOT_A_PERSON.test(f.on)) return { ok: false, why: "`blocked` needs `on:` naming a person, not a system or yourself" };
    if (!f.resume || f.resume.length < 8) return { ok: false, why: "`blocked` needs `resume:` with the exact step that restarts the work" };
    return { ok: true, record: { kind: "blocked", on: f.on, resume: f.resume } };
  }
  if (!f.checked || f.checked.length < 8) return { ok: false, why: "`no ready work` needs `checked:` naming where you looked (the roadmap's ready list, the issue queue)" };
  return { ok: true, record: { kind: "no_ready_work", checked: f.checked } };
}

function resultText(content) {
  if (Array.isArray(content)) content = content.filter(x => x?.type === "text").map(x => x.text).join("");
  return text(content) ? content : plain(content) ? JSON.stringify(content) : "";
}
function parse(value) {
  if (plain(value)) return value;
  const t = resultText(value);
  if (!t || t.length > 65536) return null;
  try { const v = JSON.parse(t); return plain(v) ? v : null; } catch { return null; }
}

function state() {
  return { calls: new Map(), target: null, status: null, tools: new Set(), wakes: new Set(), human: null,
    interrupted: false, corrected: false, final: null, envelope: false };
}
function remember(set, raw, extract) {
  for (const m of raw.matchAll(extract)) set.add(m[0].toLowerCase());
}
const REFS = /https:\/\/github\.com\/[^\s/"\\]+\/[^\s/"\\]+\/(?:pull\/\d+|actions\/runs\/\d+)|\b[0-9a-f]{7,40}\b/giu;
const WORDS = /[A-Za-z0-9][A-Za-z0-9._:-]{3,}/gu;

function toolDone(s, call, failed, content) {
  if (!call || failed) return;
  const raw = resultText(content);
  remember(s.tools, raw, REFS);
  if (WAKE_TOOL.test(call.name)) {
    remember(s.wakes, raw, WORDS);
    remember(s.wakes, call.args, WORDS);
  }
  if (!call.kind) return;
  const value = parse(content);
  if (call.kind === "task_focus") {
    if (call.clear) { s.target = null; s.status = null; return; }
    if (value?.status === "focused") { s.target = call.target; s.status = value.task_status ?? null; }
    return;
  }
  if (!call.target) return;
  if (call.kind === "task_create" && call.focus && value?.status === "created") { s.target = call.target; s.status = call.status ?? "drafting"; return; }
  if (call.target !== s.target) return;
  if (call.kind === "task_archive") { s.status = "archived"; return; }
  if (call.kind === "task_signoff") { s.status = value?.signoff?.state === "refused" ? "processing" : "done"; return; }
  if (call.kind === "task_update" && call.status) s.status = call.status;
}

function callOf(name, args) {
  if (!text(name)) return null;
  const match = DESK.exec(name);
  const target = plain(args) && text(args.track) && text(args.slug) ? `${args.track}/${args.slug}` : null;
  const raw = plain(args) ? JSON.stringify(args) : "";
  if (!match) return { kind: null, name, args: raw };
  if (match[1] === "task_focus" && plain(args) && args.clear === true) return { kind: "task_focus", clear: true, name, args: raw };
  return { kind: match[1], target, name, args: raw, status: args?.status ?? args?.frontmatter?.status, focus: args?.focus === true };
}

function copilot(s, e, payload) {
  const d = e.data ?? {};
  if (e.agentId || d.agentId || d.parentToolCallId) return;
  if (e.type === "session.start" || e.type === "session.resume") s.envelope = d.sessionId === payload.sessionId && d.context?.cwd === payload.cwd;
  if (e.type === "user.message") {
    if (text(d.content) && d.content.includes(TAG)) s.corrected = true;
    else if (!d.source && !d.isAutopilotContinuation && text(d.content) && text(d.interactionId)) {
      s.human = d.interactionId; s.interrupted = false; s.corrected = false; s.final = null;
    }
  }
  if (e.type === "abort" || e.type === "session.error" || e.type === "session.shutdown") s.interrupted = true;
  if (e.type === "tool.execution_start") s.calls.set(d.toolCallId, callOf(d.toolName, d.arguments));
  if (e.type === "tool.execution_complete") {
    const call = s.calls.get(d.toolCallId); s.calls.delete(d.toolCallId);
    toolDone(s, call, d.success === false || d.result?.isError === true, d.result?.content);
  }
  if (e.type === "assistant.message" && d.interactionId === s.human && !d.toolRequests?.length && text(d.content) && d.content.trim()) s.final = d.content;
  if (e.type === "hook.end" && d.hookType === "agentStop" && d.output?.decision === "block" && text(d.output.reason) && d.output.reason.includes(TAG)) s.corrected = true;
}

function claude(s, e, payload) {
  if (e.isSidechain || e.agentId) return;
  if (e.sessionId && e.sessionId !== payload.session_id) return;
  if (e.cwd === payload.cwd && e.sessionId === payload.session_id) s.envelope = true;
  const blocks = e.message?.content;
  const content = text(blocks) ? blocks : Array.isArray(blocks) ? blocks.filter(x => x?.type === "text" && text(x.text)).map(x => x.text).join("\n") : "";
  if (e.type === "user") {
    if (content.includes(TAG) && (e.isMeta || e.promptSource === "system" || e.origin?.kind === "system")) s.corrected = true;
    else if (!e.isMeta && !e.isCompactSummary && !["system", "sdk"].includes(e.promptSource) && e.origin?.kind === "human"
      && (text(blocks) || Array.isArray(blocks) && blocks.some(x => ["text", "image"].includes(x?.type)))) {
      s.human = "human"; s.interrupted = false; s.corrected = false; s.final = null;
    }
    if (content.startsWith("[Request interrupted by user")) s.interrupted = true;
  }
  if (e.toolUseResult?.interrupted || e.message?.stop_reason === "refusal") s.interrupted = true;
  if (e.type === "assistant" && Array.isArray(blocks)) {
    for (const b of blocks) if (b.type === "tool_use") s.calls.set(b.id, callOf(b.name, b.input));
  }
  if (e.type === "user" && Array.isArray(blocks)) for (const b of blocks) {
    if (b.type === "text" && text(b.text) && b.text.includes(TAG)) s.corrected = true;
    if (b.type !== "tool_result") continue;
    const call = s.calls.get(b.tool_use_id); s.calls.delete(b.tool_use_id);
    toolDone(s, call, b.is_error === true, b.content);
  }
}

function ledgerDir(env) {
  const home = env.HOME || os.homedir();
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  return path.join(base, "ouroboros-skills", "desk", "turn-ends");
}
// The ending is recorded for the runner outside the agent (a wait's expiry, "no ready work" audits). Recording never blocks the turn.
function record(env, entry) {
  try {
    const dir = ledgerDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, `${entry.session}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* the gate stays fail-open */ }
}

async function checkTurnEnd({ host, payload, env = process.env, now = Date.now }) {
  if (!plain(payload) || !["copilot", "claude"].includes(host)) return { status: "excluded" };
  if (env.DESK_FACTORY_HEADLESS && env.DESK_FACTORY_HEADLESS !== "0") return { status: "excluded" };
  if (payload.agentId || payload.agent_id || payload.agent_transcript_path || payload.parent_thread_id || payload.error) return { status: "excluded" };
  if (host === "copilot" ? payload.stopReason !== "end_turn" || payload.reason : payload.hook_event_name !== "Stop" || (payload.stop_reason && payload.stop_reason !== "end_turn")) return { status: "excluded" };
  const id = host === "copilot" ? payload.sessionId : payload.session_id;
  const log = host === "copilot" ? payload.transcriptPath : payload.transcript_path;
  if (!UUID.test(id ?? "") || !text(log) || !path.isAbsolute(log) || !text(payload.cwd) || !path.isAbsolute(payload.cwd)) return failure("invalid_identity");
  const home = host === "copilot" ? env.COPILOT_HOME || path.join(env.HOME || "", ".copilot") : path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || "", ".claude"), "projects");
  const expected = host === "copilot" ? path.join(home, "session-state", id, "events.jsonl") : null;
  if (expected ? path.resolve(log) !== path.resolve(expected) : !path.resolve(log).startsWith(path.resolve(home) + path.sep) || path.basename(log) !== `${id}.jsonl`) return failure("foreign_transcript");
  const until = host === "copilot" ? payload.timestamp : Date.now();
  if (!Number.isSafeInteger(until) || until < 0) return failure("invalid_timestamp");
  const s = state();
  let bytes = 0;
  try {
    const stat = await fs.promises.lstat(log);
    if (!stat.isFile() || stat.size > MAX_BYTES) return failure("transcript_limit");
    const actual = await fs.promises.realpath(log);
    if (!actual.startsWith(await fs.promises.realpath(home) + path.sep)) return failure("foreign_transcript");
    const stream = fs.createReadStream(log);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > MAX_BYTES || Buffer.byteLength(line) > MAX_LINE) return failure("transcript_limit");
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { return failure("transcript_unreadable"); }
        const time = Date.parse(e.timestamp);
        if (!Number.isFinite(time)) return failure("transcript_timestamp");
        if (time > until) continue;
        if (host === "copilot") copilot(s, e, payload); else claude(s, e, payload);
      }
    } finally { lines.close(); stream.destroy(); }
  } catch { return failure("transcript_unreadable"); }
  if (!s.envelope) return failure("foreign_session");
  if (!s.human || s.interrupted || !s.target || CLOSED.has(s.status)) return { status: "no_open_job" };
  const final = host === "claude" ? payload.last_assistant_message : s.final;
  if (!text(final)) return failure("final_reply_unavailable");
  const evidence = { tools: [...s.tools], wakes: [...s.wakes] };
  const at = now();
  const verdict = judge(endingOf(final), evidence, at);
  const entry = { session: id, host, at: new Date(at).toISOString(), card: s.target, card_status: s.status };
  if (verdict.ok) { record(env, { ...entry, ending: verdict.record }); return { status: "complete" }; }
  if (payload.stop_hook_active === true || s.corrected) {
    record(env, { ...entry, ending: { kind: "unverified", why: verdict.why } });
    return { status: "unverified", diagnostic: "turn_end_gate_exhausted" };
  }
  return { status: "correction", output: { decision: "block", reason:
    `Keep working the card, or end the reply with one Ending line. ${TAG} Your focused card ${s.target} is ${s.status}, and ${verdict.why}. If ready work remains, do it. If not, end with exactly one of these lines, filled in with facts you can show:\n${FORM}\n"No ready work" is a valid ending: say it, never invent work to avoid it. This is the only correction; do not repeat finished steps.` } };
}

// Headless lanes (no transcript, no hooks): `check` reads the lane's output file and judges its last `Ending:` line.
// A `done` counts only if GitHub shows a PR for the lane's branch, since the output file is the agent's own words.
// `waiting` is refused: a headless lane has no registered wake to verify. Exit 0 = acceptable, 10 = not shipped, 2 = bad call.
function headlessCheck({ session, output, repo, head, prExists, env = process.env, now = Date.now }) {
  const at = now();
  const ending = endingOf(output);
  let verdict;
  if (ending && ending.kind === "waiting") verdict = { ok: false, why: "a headless lane cannot register a wake; end `done`, `blocked` on a person, or `no ready work`" };
  else if (ending && ending.kind === "done") {
    const pr = prExists(repo, head);
    verdict = pr ? { ok: true, record: { kind: "done", shipped: pr } } : { ok: false, why: `\`done\` but GitHub shows no pull request for ${head} in ${repo}; push the branch and open one` };
  } else verdict = judge(ending, { tools: [], wakes: [] }, at);
  record(env, { session, host: "headless", at: new Date(at).toISOString(), card: head, ending: verdict.ok ? verdict.record : { kind: "unverified", why: verdict.why } });
  if (verdict.ok) return { code: 0, text: "" };
  return { code: 10, text: `Keep working, or end with exactly one of these lines, filled in with facts you can show. ${TAG} ${verdict.why}.\n${FORM.split("\n").filter(l => !l.includes("waiting")).join("\n")}\n"No ready work" is a valid ending: say it, never invent work.` };
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const a = {};
  for (let i = 0; i < rest.length; i += 2) a[rest[i]?.replace(/^--/u, "")] = rest[i + 1];
  const BAD_CALL = "bad-call";
  const usage = "usage: node turn-end-gate.cjs check --session <id> --evidence-file <output.txt> --pr-head <branch> --repo <owner/repo>";
  if (cmd !== "check" || !a.session || !a["evidence-file"] || !a["pr-head"] || !/^[\w.-]+\/[\w.-]+$/u.test(a.repo ?? "")) { process.stderr.write(`${BAD_CALL}: ${usage}\n`); return 2; }
  let output;
  try { output = fs.readFileSync(a["evidence-file"], "utf8"); } catch (e) { process.stderr.write(`${BAD_CALL}: ${usage}\n`); return 2; }
  const prExists = (repo, head) => {
    const r = require("node:child_process").spawnSync("gh", ["pr", "list", "--repo", repo, "--head", head, "--state", "all", "--json", "url", "--limit", "1"], { encoding: "utf8", windowsHide: true });
    try { return JSON.parse(r.stdout)[0]?.url ?? null; } catch { return null; }
  };
  const r = headlessCheck({ session: a.session.replace(/[^\w.-]/gu, "_"), output, repo: a.repo, head: a["pr-head"], prExists });
  if (r.text) process.stdout.write(`${r.text}\n`);
  return r.code;
}
if (require.main === module) process.exitCode = cli(process.argv.slice(2));
module.exports = { checkTurnEnd, endingOf, judge, headlessCheck };
