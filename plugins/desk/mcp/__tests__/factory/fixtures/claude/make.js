// Generator for the synthetic Claude Code transcript fixtures `derive-claude.js`
// is tested against. Every fixture here is invented: no line, timestamp, id or
// piece of text was copied from a real `~/.claude/projects` transcript. Run
// `node make.js` from this directory to regenerate the checked-in `.jsonl`
// files from the scenarios built below — the generator is the reviewable
// source of truth for the fixture structure; the written files are what the
// tests actually read (mirroring how `derive-claude.js` streams a real one).
//
// `SENTINEL` is planted in every free-text field a real transcript would
// carry (prompt text, assistant text, tool input, tool output, tracked file
// paths, Desk tool track/slug) so the privacy test can assert it never
// reaches the derived facts — only the coarse counts, buckets and enums a
// facts file is allowed to hold.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

export const SENTINEL = "SENTINEL-7f3a"
// A 40-character hex token shaped like a commit SHA, planted only inside a
// Bash result's stdout — the one place `derive-claude.js` is allowed to look
// for one (`events.commitShas`, never `facts`).
export const COMMIT_SHA = "ab34cd56".repeat(5)

export const SESSION_IDS = Object.freeze({
  full: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60",
  truncated: "4c1d2e3f-9b0a-4d1e-8f2a-2b3c4d5e6f71",
  unreadable: "5d2e3f40-ac1b-4e2f-903b-3c4d5e6f7182",
  empty: "6e3f4051-bd2c-4f30-a14c-4d5e6f718293",
})

function makeClock(startIso) {
  let cursor = Date.parse(startIso)
  return () => {
    const iso = new Date(cursor).toISOString()
    cursor += 1000
    return iso
  }
}

function textBlock(text) {
  return { type: "text", text }
}

function usage(inputTokens, outputTokens, cacheRead, cacheWrite) {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  }
}

function toJsonl(lines) {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
}

// ---------------------------------------------------------------------------
// "full": exercises every derivation rule in one session — duplicated usage
// lines, a 429 retry, every tool outcome, a same-kind retry after an error,
// a desk tool call, two kinds of file-write event, both PR-ref sources
// (deduplicated), a compaction, a hook-injected line that must not become a
// turn, and one subagent with its own model.
// ---------------------------------------------------------------------------

function buildFullSession() {
  const sessionId = SESSION_IDS.full
  const version = "2.1.282"
  const entrypoint = "claude-desktop"
  const next = makeClock("2026-09-25T08:00:00.000Z")
  const envelope = (extra) => ({ sessionId, timestamp: next(), version, entrypoint, ...extra })
  const lines = []

  // Turn 1: human prompt with no explicit promptSource (the "undefined counts
  // as a human prompt" case).
  lines.push(envelope({ type: "user", message: { role: "user", content: [textBlock(`do the thing ${SENTINEL}`)] } }))

  // One assistant message split across three streamed lines that all repeat
  // the same usage; only the last carries the tool_use block. Token counting
  // must take this message's usage once, not three times. Its model
  // (claude-haiku-5) is a first-seen minority against the claude-opus-5-5
  // majority that follows, so picking the root's most-frequent model has to
  // genuinely overtake it rather than just keep whichever model is seen first.
  const msg1Usage = usage(100, 40, 10, 5)
  lines.push(envelope({ type: "assistant", message: { id: "msg-1a", model: "claude-haiku-5", usage: msg1Usage, content: [textBlock(`thinking ${SENTINEL}`)] } }))
  lines.push(envelope({ type: "assistant", message: { id: "msg-1a", model: "claude-haiku-5", usage: msg1Usage, content: [textBlock(`still thinking ${SENTINEL}`)] } }))
  lines.push(envelope({
    type: "assistant",
    message: {
      id: "msg-1a",
      model: "claude-haiku-5",
      usage: msg1Usage,
      content: [{ type: "tool_use", id: "tool-bash-1", name: "Bash", input: { command: `rm -rf nonexistent ${SENTINEL}` } }],
    },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-bash-1", is_error: true }] },
    toolUseResult: { stdout: `Exit code 1 ${SENTINEL}`, stderr: `fatal ${SENTINEL}` },
  }))

  // Same tool kind (shell) called again right after an error: one retry.
  const msg2Usage = usage(20, 15, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-2", model: "claude-opus-5-5", usage: msg2Usage, content: [{ type: "tool_use", id: "tool-bash-2", name: "Bash", input: { command: `git status ${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-bash-2", is_error: false }] },
    toolUseResult: {
      stdout: `On branch main ${COMMIT_SHA} ${SENTINEL}`,
      gitOperation: { pr: { number: 42, url: "https://github.com/ourostack/desk/pull/42", action: "opened" } },
    },
  }))

  // Interrupted outcome.
  const msg3Usage = usage(12, 8, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-3", model: "claude-opus-5-5", usage: msg3Usage, content: [{ type: "tool_use", id: "tool-read-1", name: "Read", input: { file_path: `/tmp/x-${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-read-1", is_error: false }] },
    toolUseResult: { interrupted: true, stdout: `partial ${SENTINEL}` },
  }))

  // Timeout outcome.
  const msg4Usage = usage(9, 3, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-4", model: "claude-opus-5-5", usage: msg4Usage, content: [{ type: "tool_use", id: "tool-bash-3", name: "Bash", input: { command: `sleep 100 ${SENTINEL}` } }] },
  }))
  // No `stdout` in this result at all (only Bash results are scanned for
  // commit shas, and only some of them carry stdout) — the fallback side of
  // that optional read must not throw or fabricate a value.
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-bash-3", is_error: true }] },
    toolUseResult: { timedOutAfterMs: 5000 },
  }))

  // Two Desk tool calls (binding events only, never facts): one with a
  // status and no person, one with neither — both optional fields must fall
  // back to null independently, not just the one that happens to be set.
  const msg5Usage = usage(7, 4, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: {
      id: "msg-5",
      model: "claude-opus-5-5",
      usage: msg5Usage,
      content: [{ type: "tool_use", id: "tool-desk-1", name: "mcp__plugin_desk_desk__task_update", input: { track: `${SENTINEL}-track`, slug: `${SENTINEL}-slug`, status: "processing" } }],
    },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-desk-1", is_error: false }] },
    toolUseResult: { stdout: `updated ${SENTINEL}` },
  }))
  const msg9Usage = usage(2, 1, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: {
      id: "msg-9",
      model: "claude-opus-5-5",
      usage: msg9Usage,
      content: [{ type: "tool_use", id: "tool-desk-2", name: "mcp__plugin_desk_desk__task_create", input: { track: `${SENTINEL}-track2`, slug: `${SENTINEL}-slug2` } }],
    },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-desk-2", is_error: false }] },
    toolUseResult: { stdout: `created ${SENTINEL}` },
  }))

  // A file write (binding event only).
  const msg6Usage = usage(6, 2, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: {
      id: "msg-6",
      model: "claude-opus-5-5",
      usage: msg6Usage,
      content: [{ type: "tool_use", id: "tool-write-1", name: "Write", input: { file_path: `${SENTINEL}-path/file.txt`, content: `${SENTINEL} file body` } }],
    },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-write-1", is_error: false }] },
    toolUseResult: { stdout: `wrote ${SENTINEL}` },
  }))

  // A non-retryable API error (not 429, not 5xx): must not count as a retry
  // or grow an api_retry interval. Placed before msg-7 so it never becomes
  // the last activity in the turn (msg-7 still is). Its usage fields are
  // `null` rather than `0` (a request that errored before any accounting) —
  // every token field's own fallback to 0 must hold independently.
  lines.push(envelope({
    type: "assistant",
    isApiErrorMessage: true,
    apiErrorStatus: 400,
    error: `bad request ${SENTINEL}`,
    message: { id: "msg-err-400", model: "claude-opus-5-5", usage: usage(null, null, null, null), content: [] },
  }))

  // A native PR ref, and a compaction, and a second file-write source.
  lines.push(envelope({ type: "pr-link", prNumber: 42, prRepository: "ourostack/desk", prUrl: "https://github.com/ourostack/desk/pull/42" }))
  // Two more distinct refs, to exercise the same-repo and different-repo
  // sides of the sort once dedup leaves more than one entry behind.
  lines.push(envelope({ type: "pr-link", prNumber: 7, prRepository: "ourostack/desk", prUrl: "https://github.com/ourostack/desk/pull/7" }))
  lines.push(envelope({ type: "pr-link", prNumber: 3, prRepository: "another-org/repo", prUrl: "https://github.com/another-org/repo/pull/3" }))
  lines.push(envelope({ type: "system", subtype: "compact_boundary" }))
  // A system line with a different subtype: must not count as a compaction.
  lines.push(envelope({ type: "system", subtype: "stop_hook_summary" }))
  lines.push(envelope({ type: "file-history-delta", trackingPath: `${SENTINEL}-tracked/path.txt` }))

  // A 429 API error, retried by the next assistant line.
  lines.push(envelope({
    type: "assistant",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    error: `rate limited ${SENTINEL}`,
    message: { id: "msg-err", model: "claude-opus-5-5", usage: usage(0, 0, 0, 0), content: [] },
  }))
  const msg7Usage = usage(5, 5, 0, 0)
  lines.push(envelope({ type: "assistant", message: { id: "msg-7", model: "claude-opus-5-5", usage: msg7Usage, content: [textBlock(`retried ok ${SENTINEL}`)] } }))

  // A hook-injected line shaped like a user prompt: must not become a turn.
  lines.push(envelope({ type: "user", promptSource: "hook", message: { role: "user", content: [textBlock(`injected ${SENTINEL}`)] } }))

  // Turn 2: explicit promptSource "user", spawns the subagent.
  lines.push(envelope({ type: "user", promptSource: "user", message: { role: "user", content: [textBlock(`second ask ${SENTINEL}`)] } }))
  const msg8Usage = usage(3, 2, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-8", model: "claude-opus-5-5", usage: msg8Usage, content: [{ type: "tool_use", id: "tool-agent-1", name: "Agent", input: { prompt: `spawn subagent ${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-agent-1", is_error: false }] },
    toolUseResult: { stdout: `subagent done ${SENTINEL}` },
  }))

  // Turn 3: a third human prompt with nothing after it at all (the session
  // just ends) — a degenerate turn whose end equals its own start, since
  // there is no later activity to bound it.
  lines.push(envelope({ type: "user", promptSource: "user", message: { role: "user", content: [textBlock(`third ask, nothing follows ${SENTINEL}`)] } }))

  const subNext = makeClock("2026-09-25T08:00:12.500Z")
  const subEnvelope = (extra) => ({ sessionId, timestamp: subNext(), version, entrypoint, ...extra })
  const subUsage1 = usage(2, 3, 0, 0)
  const subUsage2 = usage(1, 1, 0, 0)
  const subUsage3 = usage(1, 2, 0, 0)
  const subagentLines = [
    // A tool_use with no matching tool_result anywhere in the transcript
    // (the model moved on, or the log ends first): must be dropped from
    // intervals and counts, not crash and not fabricate an outcome. Its
    // usage still counts — the model call itself happened.
    subEnvelope({
      type: "assistant",
      message: { id: "sub-msg-1", model: "claude-sonnet-5", usage: subUsage1, content: [{ type: "tool_use", id: "sub-tool-1", name: "Read", input: { file_path: `${SENTINEL}-sub-path` } }] },
    }),
    // A tool result with no `toolUseResult` at all — every optional-chained
    // read of it (interrupted, timedOutAfterMs, gitOperation, stdout,
    // stderr) must fall back cleanly rather than throw. Also the first call
    // whose finalization looks back at sub-tool-1, which never resolved.
    subEnvelope({
      type: "assistant",
      message: { id: "sub-msg-2", model: "claude-sonnet-5", usage: subUsage2, content: [{ type: "tool_use", id: "sub-tool-2", name: "Edit", input: { file_path: `${SENTINEL}-sub-edit-path` } }] },
    }),
    subEnvelope({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub-tool-2", is_error: false }] },
    }),
    subEnvelope({
      type: "assistant",
      message: { id: "sub-msg-3", model: "claude-sonnet-5", usage: subUsage3, content: [{ type: "tool_use", id: "sub-tool-3", name: "Read", input: { file_path: `${SENTINEL}-sub-path-2` } }] },
    }),
    subEnvelope({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub-tool-3", is_error: false }] },
      toolUseResult: { stdout: `sub output 2 ${SENTINEL}` },
    }),
  ]
  const subagentMeta = {
    agentType: "general-purpose",
    description: `investigate something ${SENTINEL}`,
    toolUseId: "tool-agent-1",
    spawnDepth: 1,
    model: "claude-sonnet-5",
  }

  return {
    sessionId,
    lines,
    subagents: [{ fileStem: "agent-a1", lines: subagentLines, meta: subagentMeta }],
  }
}

// ---------------------------------------------------------------------------
// "truncated": a clean turn followed by a final line that was cut off
// mid-write (no trailing newline, invalid JSON) — must be reported as
// `{field: "turns", reason: "log_truncated"}` and nothing else about the
// earlier, valid content should be lost.
// ---------------------------------------------------------------------------

function buildTruncatedSession() {
  const sessionId = SESSION_IDS.truncated
  const next = makeClock("2026-09-25T09:00:00.000Z")
  const envelope = (extra) => ({ sessionId, timestamp: next(), version: "2.1.100", entrypoint: "cli", ...extra })
  const lines = [
    envelope({ type: "user", message: { role: "user", content: [textBlock(`hi ${SENTINEL}`)] } }),
    // A retryable (5xx) API error with no assistant line after it anywhere
    // in the transcript: must not crash looking for one, and must not count
    // as a retry (there is nothing to retry into).
    envelope({
      type: "assistant",
      isApiErrorMessage: true,
      apiErrorStatus: 503,
      error: `server error ${SENTINEL}`,
      message: { id: "t-msg-1", model: "claude-opus-5-5", usage: usage(4, 2, 0, 0), content: [] },
    }),
  ]
  const raw = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"type":"assistant","sessionId":"${sessionId}","timestamp":"2026-09-25T09:00:02.000`
  return { sessionId, raw }
}

// ---------------------------------------------------------------------------
// "unreadable": zero assistant lines, and a malformed line that is NOT the
// last one (so this is not truncation) — models must be `[]` with
// `{field: "models", reason: "source_unreadable"}`.
// ---------------------------------------------------------------------------

function buildUnreadableSession() {
  const sessionId = SESSION_IDS.unreadable
  const next = makeClock("2026-09-25T10:00:00.000Z")
  const envelope = (extra) => ({ sessionId, timestamp: next(), version: "2.0.5", entrypoint: "sdk-node", ...extra })
  const first = envelope({ type: "user", message: { role: "user", content: [textBlock(`q ${SENTINEL}`)] } })
  const broken = `{"type":"user","sessionId":"${sessionId}", broken`
  // A tool result for a tool_use id that was never seen (e.g. the call
  // happened before this log window): must be dropped, not crash.
  const dangling = envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown-tool-use-id", is_error: false }] },
  })
  const last = envelope({ type: "system", subtype: "compact_boundary" })
  const raw = `${JSON.stringify(first)}\n${broken}\n${JSON.stringify(dangling)}\n${JSON.stringify(last)}\n`
  return { sessionId, raw }
}

// ---------------------------------------------------------------------------
// "empty": the file exists but has zero lines — every value must fall back
// (session id from the file name, `now` for the timestamps, the documented
// defaults for host_version/entrypoint) rather than crash.
// ---------------------------------------------------------------------------

function buildEmptySession() {
  return { sessionId: SESSION_IDS.empty, raw: "" }
}

function writeSubagents(sessionDir, subagents) {
  if (subagents.length === 0) return
  const subagentsDir = path.join(sessionDir, "subagents")
  mkdirSync(subagentsDir, { recursive: true })
  for (const subagent of subagents) {
    writeFileSync(path.join(subagentsDir, `${subagent.fileStem}.jsonl`), toJsonl(subagent.lines))
    writeFileSync(path.join(subagentsDir, `${subagent.fileStem}.meta.json`), `${JSON.stringify(subagent.meta, null, 2)}\n`)
  }
}

export function generate({ outDir = here } = {}) {
  const full = buildFullSession()
  const truncated = buildTruncatedSession()
  const unreadable = buildUnreadableSession()
  const empty = buildEmptySession()

  rmSync(path.join(outDir, full.sessionId), { recursive: true, force: true })
  writeFileSync(path.join(outDir, `${full.sessionId}.jsonl`), toJsonl(full.lines))
  writeSubagents(path.join(outDir, full.sessionId), full.subagents)

  writeFileSync(path.join(outDir, `${truncated.sessionId}.jsonl`), truncated.raw)
  writeFileSync(path.join(outDir, `${unreadable.sessionId}.jsonl`), unreadable.raw)
  writeFileSync(path.join(outDir, `${empty.sessionId}.jsonl`), empty.raw)

  return { full, truncated, unreadable, empty }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  generate()
  // eslint-disable-next-line no-console
  console.log(`wrote fixtures to ${here}`)
}
