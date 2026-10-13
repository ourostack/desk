"use strict";

// A reply check, not a second task lifecycle. Native Desk receipts are read
// only in this human turn; no transcript, packet or correction state is saved.
// Host decision contracts: docs.github.com/en/copilot/reference/hooks-reference
// and code.claude.com/docs/en/hooks#stop. The native active flag is a ceiling,
// not permission to consume the hosts' larger runaway-continuation budget.
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const TAG = "[DESK_DELIVERY_CORRECTION]";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DESK = /^(?:desk-|mcp__[^ ]*desk[^ ]*__)(task_update|task_archive|task_signoff)$/u;
const text = value => typeof value === "string";
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clean = value => value.replace(/(\*\*|__)(.+?)\1/gu, "$2").replace(/`([^`]+)`/gu, "$1").trim();
function proofIn(line, ref) {
  const proof = ref.trim();
  if (/^[0-9a-f]{7,40}$/iu.test(proof)) {
    return (clean(line).match(/\b[0-9a-f]{7,40}\b/giu) ?? []).some(x => x.length <= proof.length && proof.toLowerCase().startsWith(x.toLowerCase()));
  }
  return line.includes(proof);
}
function packetOf(value) {
  if (!plain(value) || value.signoff !== "delivered_unsigned") return null;
  const p = value.signoff_packet;
  return Array.isArray(p) && p.length === 3 && p.every(x => text(x) && x.length <= 2000 && !/[\r\n]/u.test(x))
    && /^Asked: \S/u.test(p[0]) && /^Delivered: \S/u.test(p[1]) && p[2] === "Accept or send back?" ? p : null;
}
function hasEnding(reply, packets) {
  if (!text(reply)) return false;
  const lines = reply.split(/\r?\n/u).map(x => x.trim()).filter(Boolean);
  const tail = lines.slice(-packets.length * 3);
  return tail.length === packets.length * 3 && packets.every((p, i) =>
    /^Asked:\s*\S/u.test(clean(tail[i * 3])) && /^Delivered:\s*\S/u.test(clean(tail[i * 3 + 1]))
    && proofIn(tail[i * 3 + 1], p[1].slice("Delivered: ".length)) && clean(tail[i * 3 + 2]) === "Accept or send back?");
}
function resultOf(content) {
  if (plain(content)) return content;
  if (Array.isArray(content)) content = content.filter(x => x?.type === "text").map(x => x.text).join("");
  if (!text(content) || content.length > 65536) return null;
  try { return JSON.parse(content); } catch { return null; }
}
function targetOf(args) {
  return plain(args) && [args.track, args.slug].every(x => text(x) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(x) && x.length < 200)
    ? `${args.track}/${args.slug}` : null;
}
const failure = reason => ({ status: "unavailable", diagnostic: reason });
function state() {
  return { calls: new Map(), packets: new Map(), delivered: new Set(), human: null,
    corrected: false, interrupted: false, envelope: false, final: null, currentHook: null };
}
function reset(s, human) {
  s.calls.clear(); s.packets.clear(); s.delivered.clear();
  s.human = human; s.corrected = false; s.interrupted = false; s.final = null;
}
function receipt(s, call, value) {
  if (!call || !value) return;
  if (["blocked", "collaborating", "paused"].includes(call.status)) s.interrupted = true;
  if (call.kind === "task_signoff" || (call.kind === "task_update" && call.status && call.status !== "done")) {
    s.packets.delete(call.target); return;
  }
  const packet = packetOf(value);
  if (!packet) {
    // A newer native observation without unsigned evidence cannot keep an older
    // packet authoritative (accepted/cancelled/returned or no longer evidenced).
    s.packets.delete(call.target); return;
  }
  const key = `${call.target}\n${packet.join("\n")}`;
  if (!s.delivered.has(key)) s.packets.set(call.target, { packet, key });
}
function reply(s, content) {
  if (!text(content) || !content.trim()) return;
  s.final = content;
  if (s.packets.size && hasEnding(content, [...s.packets.values()].map(x => x.packet))) {
    for (const held of s.packets.values()) s.delivered.add(held.key);
    s.packets.clear(); return;
  }
  for (const [target, held] of s.packets) {
    if (hasEnding(content, [held.packet])) {
      s.delivered.add(held.key); s.packets.delete(target);
    }
  }
}
function callOf(name, args) {
  const match = text(name) ? DESK.exec(name) : null;
  const target = targetOf(args);
  return match && target ? { kind: match[1], target, status: args.status ?? args.frontmatter?.status } : null;
}
function copilot(s, e, payload) {
  const d = e.data ?? {};
  if (e.agentId || d.agentId || d.parentToolCallId) return;
  if (e.type === "session.start" || e.type === "session.resume") {
    reset(s, null);
    s.envelope = d.sessionId === payload.sessionId && d.context?.cwd === payload.cwd;
  }
  if (e.type === "user.message") {
    if (text(d.content) && d.content.includes(TAG)) {
      s.corrected = true;
      if (text(d.interactionId)) s.human = d.interactionId;
    } else if (!d.source && !d.isAutopilotContinuation && text(d.content) && text(d.interactionId)) reset(s, d.interactionId);
  }
  if (!s.human) return;
  if (e.type === "abort" || e.type === "session.error" || e.type === "session.shutdown") s.interrupted = true;
  if (e.type === "tool.execution_start") {
    const call = callOf(d.toolName, d.arguments);
    if (call) s.calls.set(d.toolCallId, call);
  }
  if (e.type === "tool.execution_complete") {
    const call = s.calls.get(d.toolCallId); s.calls.delete(d.toolCallId);
    if (d.success === true && !d.result?.isError && d.interactionId === s.human) receipt(s, call, resultOf(d.result?.content));
    if ((d.success === false || d.result?.isError) && d.interactionId === s.human && s.packets.size) s.interrupted = true;
  }
  if (e.type === "assistant.message" && d.interactionId === s.human && !d.toolRequests?.length) reply(s, d.content);
  if (e.type === "hook.end" && d.hookType === "agentStop" && d.output?.decision === "block" && text(d.output.reason) && d.output.reason.startsWith(TAG)) s.corrected = true;
  if (e.type === "hook.start" && d.hookType === "agentStop" && d.input?.timestamp === payload.timestamp && d.input?.sessionId === payload.sessionId) {
    s.currentHook = e.parentId;
  }
}
function claude(s, e, payload) {
  if (e.isSidechain || e.agentId) return;
  if (e.sessionId && e.sessionId !== payload.session_id) return;
  if (e.cwd === payload.cwd && e.sessionId === payload.session_id) s.envelope = true;
  const blocks = e.message?.content;
  const content = text(blocks) ? blocks : Array.isArray(blocks) ? blocks.filter(x => x?.type === "text" && text(x.text)).map(x => x.text).join("\n") : "";
  if (e.type === "user") {
    if (content.includes(TAG) && (e.isMeta || e.promptSource === "system" || e.origin?.kind === "system")) s.corrected = true;
    else if (!e.isMeta && !e.isCompactSummary && !["system", "sdk"].includes(e.promptSource)
      && !Object.hasOwn(e, "scheduledTaskId") && !Object.hasOwn(e, "scheduledFireId")
      && (!Object.hasOwn(e, "turnOrigin") || e.turnOrigin === "human") && e.origin?.kind === "human"
      && (text(blocks) || Array.isArray(blocks) && blocks.some(x => ["text", "image"].includes(x?.type)))) reset(s, "human");
    if (content.startsWith("[Request interrupted by user")) s.interrupted = true;
  }
  if (!s.human) return;
  if (e.type === "system" && ["error", "api_error", "stop_hook_error"].includes(e.subtype)) {
    if (text(e.content) && e.content.includes(TAG)) s.corrected = true;
    else s.interrupted = true;
  }
  if (e.toolUseResult?.interrupted || e.toolUseResult?.timedOutAfterMs || e.message?.stop_reason === "refusal") s.interrupted = true;
  if (e.type === "assistant" && Array.isArray(blocks)) {
    for (const block of blocks) if (block.type === "tool_use") {
      const call = callOf(block.name, block.input);
      if (call) s.calls.set(block.id, call);
    }
    if (["end_turn", "stop_sequence"].includes(e.message.stop_reason)) reply(s, blocks.filter(x => x.type === "text").map(x => x.text).join("\n"));
  }
  if (e.type === "user" && Array.isArray(blocks)) for (const block of blocks) {
    if (block.type === "text" && text(block.text) && block.text.includes(TAG)) s.corrected = true;
    if (block.type !== "tool_result") continue;
    const call = s.calls.get(block.tool_use_id); s.calls.delete(block.tool_use_id);
    if (!block.is_error) receipt(s, call, resultOf(block.content));
    else if (s.packets.size) s.interrupted = true;
  }
}
async function checkDelivery({ host, payload, env = process.env }) {
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
  let bytes = 0, lastId = null, finalEndId = null;
  try {
    const stat = await fs.promises.lstat(log);
    if (!stat.isFile() || stat.size > MAX_BYTES) return failure("transcript_limit");
    // Resolve the actual file as well as its lexical path: a foreign symlink is not an admitted transcript.
    const actual = await fs.promises.realpath(log);
    const admitted = await fs.promises.realpath(home);
    if (!actual.startsWith(admitted + path.sep)) return failure("foreign_transcript");
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
        if (host === "copilot") {
          copilot(s, e, payload);
          if (e.type === "assistant.turn_end" && e.parentId === lastId) finalEndId = e.id;
          if (e.type === "assistant.message" && e.data?.interactionId === s.human && text(e.data?.content) && !e.data?.toolRequests?.length) lastId = e.id;
        } else claude(s, e, payload);
      }
    } finally { lines.close(); stream.destroy(); }
  } catch { return failure("transcript_unreadable"); }
  if (!s.envelope) return failure("foreign_session");
  if (!s.human || s.interrupted) return { status: "not_delivery" };
  if (s.packets.size === 0) return { status: s.delivered.size ? "complete" : "not_delivery" };
  if (host === "copilot" && (!s.currentHook || s.currentHook !== finalEndId)) return { status: "not_delivery" };
  const packets = [...s.packets.values()].map(x => x.packet);
  // Claude explicitly supplies this field because final transcript persistence can lag Stop.
  const final = host === "claude" ? payload.last_assistant_message : s.final;
  if (!text(final)) return failure("final_reply_unavailable");
  if (hasEnding(final, packets)) return { status: "complete" };
  if (payload.stop_hook_active === true || s.corrected) return { status: "unverified", diagnostic: "correction_exhausted" };
  return { status: "correction", output: { decision: "block", reason:
    `${TAG} Correct only the final delivery reply. End it with the existing packet below, retaining its evidence. Do not rerun completed implementation, call task/card tools, create a commit, reopen approval, infer acceptance, or repeat external effects. This is the only correction; continue no further work.\n\n${packets.flat().join("\n")}` } };
}
module.exports = { checkDelivery };
