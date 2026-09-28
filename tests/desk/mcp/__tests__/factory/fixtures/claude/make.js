// Generator for the synthetic Claude Code transcript fixtures `derive-claude.js`
// is tested against. Every fixture here is invented: no line, timestamp, id or
// piece of text was copied from a real `~/.claude/projects` transcript. Run
// `node make.js` from this directory to regenerate the checked-in `.jsonl`
// files from the scenarios built below — the generator is the reviewable
// source of truth for the fixture structure; the written files are what the
// tests actually read (mirroring how `derive-claude.js` streams a real one).
//
// `SENTINEL` is planted in every free-text field a real transcript would
// carry (prompt text, assistant text, thinking, tool input, tool output,
// tracked file paths, cwd/gitBranch, hook names, queued commands, Desk
// track/slug, meta agentType) so the privacy test can assert it never
// reaches the derived facts — only the coarse counts, buckets and enums a
// facts file is allowed to hold.
//
// The shapes below follow a structure-only probe of real transcripts on
// this Mac (types and enum values only, no content read) plus the M3-2
// fix-round-1 review: most `user` lines with array content are `tool_result`
// blocks, a few are text or image+text; a typed human prompt in the desktop
// app has `promptSource: "sdk"` and `origin: {kind: "human"}`; an injected
// line is `isMeta: true`, or `promptSource: "system"` with
// `origin: {kind: "task-notification"}`, or `isCompactSummary: true`; an
// API-error line's model can be `<synthetic>`; PR URLs are usually GitHub
// but the deriver must not assume it.

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
  noEnvelope: "6e3f4051-bd2c-4f30-a14c-4d5e6f718293",
  oddShapes: "8a516273-df4e-4152-936e-6f7182930a1b",
})

// A transcript whose file name is not a session UUID (its lines are fine).
export const NON_UUID_FILE_STEM = "not-a-session-uuid"

// The exact end of the "full" session's first turn: the last assistant line
// before the second human prompt (the non-retryable 400 API error), whose
// timestamp is written with a `+00:00` offset and no milliseconds so the
// test also proves timestamps are normalized before they reach facts.
// The "truncated" session's skewed tool result, earlier than every other line.
export const TRUNCATED_SKEWED_RESULT_AT = "2026-09-25T08:59:59.000Z"

export const FULL_TURN_1_END = "2026-09-25T08:00:49.000Z"

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

function imageBlock() {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: `${SENTINEL}-image-bytes` } }
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
// "full": the main scenario. Built in numbered sections so each review
// finding maps onto one clearly-labeled block below.
// ---------------------------------------------------------------------------

function buildFullSession() {
  const sessionId = SESSION_IDS.full
  const version = "2.1.282"
  const entrypoint = "claude-desktop"
  const next = makeClock("2026-09-25T08:00:00.000Z")
  let uuidCounter = 0
  const envelope = (extra) => {
    uuidCounter += 1
    return {
      sessionId,
      timestamp: next(),
      version,
      entrypoint,
      cwd: `/tmp/${SENTINEL}-cwd`,
      gitBranch: `${SENTINEL}-branch`,
      uuid: `${SENTINEL}-uuid-${uuidCounter}`,
      parentUuid: uuidCounter > 1 ? `${SENTINEL}-uuid-${uuidCounter - 1}` : null,
      requestId: `${SENTINEL}-request-${uuidCounter}`,
      ...extra,
    }
  }
  const lines = []

  // --- 1. Typed human prompt (desktop app real shape): string content,
  // promptSource "sdk", origin.kind "human". ------------------------------
  lines.push(envelope({
    type: "user",
    promptSource: "sdk",
    origin: { kind: "human" },
    message: { role: "user", content: `do the thing ${SENTINEL}` },
  }))

  // --- 2. Injected lines that must NOT become turns. ----------------------
  lines.push(envelope({ type: "user", isMeta: true, message: { role: "user", content: [textBlock(`meta injected ${SENTINEL}`)] } }))
  lines.push(envelope({ type: "user", isCompactSummary: true, message: { role: "user", content: `compact summary ${SENTINEL}` } }))
  lines.push(envelope({
    type: "user",
    promptSource: "system",
    origin: { kind: "task-notification" },
    message: { role: "user", content: [textBlock(`task notification ${SENTINEL}`)] },
  }))
  lines.push(envelope({
    type: "user",
    origin: { kind: "tool" },
    message: { role: "user", content: [textBlock(`non-human origin ${SENTINEL}`)] },
  }))
  // A user line with no `message` field at all: must be skipped, not crash.
  lines.push(envelope({ type: "user" }))
  // An assistant line with no `message` field at all: same guard, other side.
  lines.push(envelope({ type: "assistant" }))
  // A human-prompt-shaped user line whose own timestamp does not normalize:
  // must be dropped from turn tracking, not crash or corrupt the state.
  lines.push(envelope({ type: "user", timestamp: "not-a-timestamp", message: { role: "user", content: [textBlock(`bad timestamp prompt ${SENTINEL}`)] } }))
  // A real (non-synthetic, non-API-error) model that doesn't match the
  // model-id pattern: its usage must be dropped, not put invalid facts
  // through, and `unavailable` must gain `{models, source_unreadable}`.
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-bad-model", model: "not a valid model id!", usage: usage(9, 9, 0, 0), content: [] },
  }))

  // --- 3. One assistant message streamed across three lines with growing,
  // non-monotonic usage: token counting must take the MAX of each field
  // across the id's lines, not the first or the last. Model is a
  // first-seen minority (claude-haiku-5) against the claude-opus-5-5
  // majority that follows, so root-model selection must count distinct
  // messages and genuinely pick the majority, not just the first-seen id
  // or a line count. Includes a `thinking` block (free text, sentinel). --
  const msg1UsageA = usage(30, 10, 5, 2)
  const msg1UsageB = usage(70, 25, 10, 3)
  const msg1UsageC = usage(100, 40, 8, 2)
  lines.push(envelope({ type: "assistant", message: { id: "msg-1a", model: "claude-haiku-5", usage: msg1UsageA, content: [{ type: "thinking", thinking: `pondering ${SENTINEL}` }] } }))
  lines.push(envelope({ type: "assistant", message: { id: "msg-1a", model: "claude-haiku-5", usage: msg1UsageB, content: [textBlock(`still thinking ${SENTINEL}`)] } }))
  lines.push(envelope({
    type: "assistant",
    message: {
      id: "msg-1a",
      model: "claude-haiku-5",
      usage: msg1UsageC,
      content: [{ type: "tool_use", id: "tool-bash-1", name: "Bash", input: { command: `rm -rf nonexistent ${SENTINEL}` } }],
    },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-bash-1", is_error: true, content: `Exit code 1 ${SENTINEL}` }] },
    toolUseResult: { stdout: `Exit code 1 ${SENTINEL}`, stderr: `fatal ${SENTINEL}` },
  }))
  // (After msg-1a, so claude-haiku-5 stays the first-seen model.)
  // A tool_use whose paired tool_result carries an unparseable timestamp:
  // the call must be dropped (no interval, no count), not crash or use a
  // fabricated end time.
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-bad-result-ts", model: "claude-opus-5-5", usage: usage(2, 2, 0, 0), content: [{ type: "tool_use", id: "tool-grep-1", name: "Grep", input: { pattern: `${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    timestamp: "also-not-a-timestamp",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-grep-1", is_error: false }] },
  }))

  // --- 4. A different tool kind in between (Read, interrupted), then a
  // same-kind Bash call that STARTS after the first Bash call ENDED: the
  // new retry rule ("a later call of the same kind that starts after a
  // failed call ended") must count this as a retry even though it is not
  // the immediately-next call issued. --------------------------------------
  const msg2Usage = usage(12, 8, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-2", model: "claude-opus-5-5", usage: msg2Usage, content: [{ type: "tool_use", id: "tool-read-1", name: "Read", input: { file_path: `/tmp/x-${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-read-1", is_error: false }] },
    toolUseResult: { interrupted: true, stdout: `partial ${SENTINEL}` },
  }))
  const msg3Usage = usage(20, 15, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-3", model: "claude-opus-5-5", usage: msg3Usage, content: [{ type: "tool_use", id: "tool-bash-2", name: "Bash", input: { command: `git status ${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-bash-2", is_error: false, content: `On branch main ${SENTINEL}` }],
    },
    toolUseResult: {
      stdout: `On branch main ${COMMIT_SHA} ${SENTINEL}`,
      gitOperation: { pr: { number: 42, url: "https://github.com/ourostack/desk/pull/42", action: "opened" } },
    },
  }))

  // --- 5. Timeout outcome, and a `timedOutAfterMs: null` regression case
  // (must NOT be treated as a timeout). -------------------------------------
  const msg4Usage = usage(9, 3, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-4", model: "claude-opus-5-5", usage: msg4Usage, content: [{ type: "tool_use", id: "tool-bash-3", name: "Bash", input: { command: `sleep 100 ${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-bash-3", is_error: true }] },
    toolUseResult: { timedOutAfterMs: 5000 },
  }))
  const msg4bUsage = usage(4, 4, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-4b", model: "claude-opus-5-5", usage: msg4bUsage, content: [{ type: "tool_use", id: "tool-bash-4", name: "Bash", input: { command: `echo fine ${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-bash-4", is_error: false }] },
    toolUseResult: { timedOutAfterMs: null, stdout: `fine ${SENTINEL}` },
  }))

  // --- 6. A non-GitHub PR URL on a Bash result's gitOperation.pr: must not
  // crash, and must not become a ref. ---------------------------------------
  const msg4cUsage = usage(3, 3, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-4c", model: "claude-opus-5-5", usage: msg4cUsage, content: [{ type: "tool_use", id: "tool-bash-5", name: "Bash", input: { command: `az repos pr create ${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-bash-5", is_error: false }] },
    toolUseResult: {
      stdout: `created ${SENTINEL}`,
      gitOperation: { pr: { number: 99, url: `https://dev.azure.com/${SENTINEL}-org/repo/pullrequest/99`, action: "opened" } },
    },
  }))

  // --- 7. Two Desk tool calls (binding events only, never facts): one with
  // a status and no person, one with neither. --------------------------------
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

  // --- 8. File writes: a successful Write, a FAILED Edit (must not bind),
  // and a successful NotebookEdit (path comes from `notebook_path`). --------
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
  const msg6bUsage = usage(2, 2, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: {
      id: "msg-6b",
      model: "claude-opus-5-5",
      usage: msg6bUsage,
      content: [{ type: "tool_use", id: "tool-edit-fail", name: "Edit", input: { file_path: `${SENTINEL}-failed-edit-path` } }],
    },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-edit-fail", is_error: true }] },
    toolUseResult: { stdout: `Exit code 1 ${SENTINEL}` },
  }))
  const msg6cUsage = usage(1, 1, 0, 0)
  lines.push(envelope({
    type: "assistant",
    message: {
      id: "msg-6c",
      model: "claude-opus-5-5",
      usage: msg6cUsage,
      content: [{ type: "tool_use", id: "tool-notebook-1", name: "NotebookEdit", input: { notebook_path: `${SENTINEL}-notebook.ipynb` } }],
    },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-notebook-1", is_error: false }] },
  }))

  // --- 9. A native PR ref, two more distinct refs (same-repo and
  // cross-repo, so the dedup sort's real ordering is exercised), a
  // compaction, a non-matching system subtype, and the other
  // structure-completeness line types: hook attachment, last-prompt,
  // queue-operation. -----------------------------------------------------
  lines.push(envelope({ type: "pr-link", prNumber: 42, prRepository: "ourostack/desk", prUrl: "https://github.com/ourostack/desk/pull/42" }))
  lines.push(envelope({ type: "pr-link", prNumber: 7, prRepository: "ourostack/desk", prUrl: "https://github.com/ourostack/desk/pull/7" }))
  lines.push(envelope({ type: "pr-link", prNumber: 3, prRepository: "another-org/repo", prUrl: "https://github.com/another-org/repo/pull/3" }))
  lines.push(envelope({ type: "system", subtype: "compact_boundary" }))
  lines.push(envelope({ type: "system", subtype: "stop_hook_summary" }))
  lines.push(envelope({ type: "file-history-delta", trackingPath: `${SENTINEL}-tracked/path.txt` }))
  lines.push(envelope({ type: "attachment", attachmentType: "hook_success", hookName: `${SENTINEL}-hook`, hookEvent: "PreToolUse", exitCode: 0 }))
  lines.push(envelope({ type: "last-prompt", prompt: `${SENTINEL} last prompt text` }))
  lines.push(envelope({ type: "queue-operation", command: `${SENTINEL} queued command` }))
  lines.push(envelope({ type: "custom-title", customTitle: `${SENTINEL} custom title` }))
  lines.push(envelope({ type: "agent-setting", agentSetting: `${SENTINEL} agent setting` }))
  lines.push(envelope({ type: "cost-state", note: `${SENTINEL} cost state` }))

  // --- 10. API errors with the real `<synthetic>` model: excluded from
  // usage/requests/root-model, still counted in api_retries. A 429
  // (retried by the next assistant line) and a non-retryable 400 (not
  // counted as a retry, but its presence as "the next assistant line"
  // still closes out the 429's pending interval since it comes second). --
  lines.push(envelope({
    type: "assistant",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    error: `rate limited ${SENTINEL}`,
    message: { id: "msg-err-429", model: "<synthetic>", usage: usage(0, 0, 0, 0), content: [] },
  }))
  const msg7Usage = usage(5, 5, 0, 0)
  lines.push(envelope({ type: "assistant", message: { id: "msg-7", model: "claude-opus-5-5", usage: msg7Usage, content: [textBlock(`retried ok ${SENTINEL}`)] } }))
  lines.push(envelope({
    type: "assistant",
    isApiErrorMessage: true,
    apiErrorStatus: 400,
    error: `bad request ${SENTINEL}`,
    message: { id: "msg-err-400", model: "<synthetic>", usage: usage(0, 0, 0, 0), content: [] },
  }))
  // Same instant, offset form: `normalizeTimestamp` must turn it back into
  // the strict `.000Z` shape (see FULL_TURN_1_END).
  lines[lines.length - 1].timestamp = lines[lines.length - 1].timestamp.replace(".000Z", "+00:00")

  // --- 11. A hook-injected-shaped line that must still not become a turn,
  // then turn 2 (spawns the subagent chain). --------------------------------
  lines.push(envelope({ type: "user", promptSource: "system", origin: { kind: "task-notification" }, message: { role: "user", content: `injected ${SENTINEL}` } }))

  lines.push(envelope({ type: "user", message: { role: "user", content: [textBlock(`second ask ${SENTINEL}`)] } }))
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
  // SendMessage resumes agent-a1: `agent` bucket, but a `tool` interval.
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-8b", model: "claude-opus-5-5", usage: usage(1, 1, 0, 0), content: [{ type: "tool_use", id: "tool-send-1", name: "SendMessage", input: { to: `${SENTINEL}-agent`, message: `carry on ${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-send-1", is_error: false, content: `sent ${SENTINEL}` }] },
  }))
  // A Task call that fails before any transcript exists: still a `subagent`
  // interval (never `tool`), and an `agent` failure.
  lines.push(envelope({
    type: "assistant",
    message: { id: "msg-8c", model: "claude-opus-5-5", usage: usage(1, 1, 0, 0), content: [{ type: "tool_use", id: "tool-task-1", name: "Task", input: { prompt: `doomed ${SENTINEL}` } }] },
  }))
  lines.push(envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-task-1", is_error: true, content: `failed ${SENTINEL}` }] },
  }))

  // --- 12. Turn 3: nothing after it at all (a degenerate turn), with
  // image+text content (the "a few are text, or image+text" real shape). --
  lines.push(envelope({ type: "user", message: { role: "user", content: [imageBlock(), textBlock(`third ask, nothing follows ${SENTINEL}`)] } }))

  // --- Subagents. agent-a1 (parent 0) opens with its task prompt and is
  // later resumed by SendMessage: two turns, but no human_wait (it waits on
  // the parent, not a human). agent-a4 spawns agent-a2 via its own Agent
  // call — depth 2, with the child's file sorting BEFORE its parent's, so
  // parent resolution must not depend on file order. agent-a3 has no
  // .meta.json at all and must still count, with model "unknown" and
  // parent 0; it also carries the retry edge cases. ------------------------
  const sub1Next = makeClock("2026-09-25T08:00:12.500Z")
  let sub1Uuid = 0
  const sub1Envelope = (extra) => {
    sub1Uuid += 1
    return {
      sessionId,
      timestamp: sub1Next(),
      version,
      entrypoint,
      isSidechain: true,
      agentId: `${SENTINEL}-agent-a1-id`,
      uuid: `${SENTINEL}-sub1-uuid-${sub1Uuid}`,
      ...extra,
    }
  }
  const subUsage1 = usage(2, 3, 0, 0)
  const subUsage2 = usage(1, 1, 0, 0)
  const subagent1Lines = [
    // The subagent's task prompt: its first turn starts here.
    sub1Envelope({ type: "user", message: { role: "user", content: `investigate ${SENTINEL}` } }),
    // A tool_use with no matching tool_result anywhere: dropped, not
    // fabricated. Its usage still counts (the model call happened).
    sub1Envelope({
      type: "assistant",
      message: { id: "sub1-msg-1", model: "claude-sonnet-5", usage: subUsage1, content: [{ type: "tool_use", id: "sub1-tool-1", name: "Read", input: { file_path: `${SENTINEL}-sub-path` } }] },
    }),
    // A tool result with no `toolUseResult` at all.
    sub1Envelope({
      type: "assistant",
      message: { id: "sub1-msg-2", model: "claude-sonnet-5", usage: subUsage2, content: [{ type: "tool_use", id: "sub1-tool-2", name: "Edit", input: { file_path: `${SENTINEL}-sub-edit-path` } }] },
    }),
    sub1Envelope({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub1-tool-2", is_error: false }] },
    }),
    sub1Envelope({ type: "assistant", message: { id: "sub1-msg-3", model: "claude-sonnet-5", usage: usage(2, 2, 0, 0), content: [textBlock(`reporting back ${SENTINEL}`)] } }),
    // Resumed by the parent's SendMessage: a second turn, no human_wait.
    sub1Envelope({ type: "user", message: { role: "user", content: [textBlock(`carry on ${SENTINEL}`)] } }),
    sub1Envelope({ type: "assistant", message: { id: "sub1-msg-4", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [textBlock(`done ${SENTINEL}`)] } }),
  ]
  const subagent1Meta = {
    agentType: `general-purpose-${SENTINEL}`,
    description: `investigate something ${SENTINEL}`,
    toolUseId: "tool-agent-1",
    spawnDepth: 1,
    model: "claude-sonnet-5",
  }

  const sub2Next = makeClock("2026-09-25T08:00:37.500Z")
  const sub2Envelope = (extra) => ({ sessionId, timestamp: sub2Next(), version, entrypoint, isSidechain: true, agentId: `${SENTINEL}-agent-a2-id`, ...extra })
  const subagent2Lines = [
    sub2Envelope({
      type: "assistant",
      message: { id: "sub2-msg-1", model: "claude-opus-5-5", usage: usage(1, 1, 0, 0), content: [{ type: "tool_use", id: "sub2-tool-1", name: "Read", input: { file_path: `${SENTINEL}-sub2-path` } }] },
    }),
    sub2Envelope({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub2-tool-1", is_error: false }] },
      toolUseResult: { stdout: `sub2 output ${SENTINEL}` },
    }),
  ]
  const subagent2Meta = {
    agentType: `general-purpose-${SENTINEL}`,
    description: `nested investigation ${SENTINEL}`,
    toolUseId: "tool-agent-2",
    spawnDepth: 2,
    model: "claude-opus-4-1",
  }

  const sub3Next = makeClock("2026-09-25T08:00:30.000Z")
  const sub3Envelope = (extra) => ({ sessionId, timestamp: sub3Next(), version, entrypoint, isSidechain: true, agentId: `${SENTINEL}-agent-a3-id`, ...extra })
  const bashUse = (id) => ({ type: "tool_use", id, name: "Bash", input: { command: `probe ${SENTINEL}` } })
  const bashResult = (id, isError) => ({ type: "tool_result", tool_use_id: id, is_error: isError, content: `out ${SENTINEL}` })
  const subagent3Lines = [
    sub3Envelope({
      type: "assistant",
      message: { id: "sub3-msg-1", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [{ type: "tool_use", id: "sub3-tool-1", name: "Read", input: { file_path: `${SENTINEL}-sub3-path` } }] },
    }),
    sub3Envelope({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub3-tool-1", is_error: false }] },
      toolUseResult: { stdout: `sub3 output ${SENTINEL}` },
    }),
    // Retry edge 1: a same-kind call starting at the very instant the failed
    // call ended is not "after" it, so it is not a retry.
    sub3Envelope({ type: "assistant", message: { id: "sub3-msg-2", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [bashUse("sub3-bash-1")] } }),
    sub3Envelope({ type: "user", message: { role: "user", content: [bashResult("sub3-bash-1", true)] } }),
    sub3Envelope({ type: "assistant", message: { id: "sub3-msg-3", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [bashUse("sub3-bash-2")] } }),
    sub3Envelope({ type: "user", message: { role: "user", content: [bashResult("sub3-bash-2", false)] } }),
    // Retry edge 2: after a new failure, two parallel same-kind calls in one
    // message count ONE retry (a failure is retried at most once), and both
    // results arrive in one user line (every tool_result block is paired).
    sub3Envelope({ type: "assistant", message: { id: "sub3-msg-4", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [bashUse("sub3-bash-3")] } }),
    sub3Envelope({ type: "user", message: { role: "user", content: [bashResult("sub3-bash-3", true)] } }),
    sub3Envelope({ type: "assistant", message: { id: "sub3-msg-5", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [bashUse("sub3-bash-4"), bashUse("sub3-bash-5")] } }),
    sub3Envelope({ type: "user", message: { role: "user", content: [bashResult("sub3-bash-4", false), bashResult("sub3-bash-5", false)] } }),
    // A tool_use on a line with no readable timestamp: dropped (no interval,
    // no count) like an unresolved call, never given an invented start.
    sub3Envelope({ type: "assistant", timestamp: "not-a-timestamp", message: { id: "sub3-msg-6", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [{ type: "tool_use", id: "sub3-read-2", name: "Read", input: { file_path: `${SENTINEL}-sub3-path-2` } }] } }),
    sub3Envelope({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub3-read-2", is_error: false }] } }),
  ]
  // Edge 1's second call starts at exactly the failed call's end.
  subagent3Lines[4].timestamp = subagent3Lines[3].timestamp

  const sub4Next = makeClock("2026-09-25T08:00:35.000Z")
  const sub4Envelope = (extra) => ({ sessionId, timestamp: sub4Next(), version, entrypoint, isSidechain: true, agentId: `${SENTINEL}-agent-a4-id`, ...extra })
  const subagent4Lines = [
    sub4Envelope({
      type: "assistant",
      message: { id: "sub4-msg-1", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [{ type: "tool_use", id: "sub4-tool-1", name: "Read", input: { file_path: `${SENTINEL}-sub4-path` } }] },
    }),
    sub4Envelope({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub4-tool-1", is_error: false }] },
      toolUseResult: { stdout: `sub4 output ${SENTINEL}` },
    }),
    // Depth 2: this subagent spawns agent-a2, whose file sorts before this one.
    sub4Envelope({
      type: "assistant",
      message: { id: "sub4-msg-2", model: "claude-sonnet-5", usage: usage(2, 2, 0, 0), content: [{ type: "tool_use", id: "tool-agent-2", name: "Agent", input: { prompt: `spawn nested subagent ${SENTINEL}` } }] },
    }),
    sub4Envelope({ type: "assistant", message: { id: "sub4-msg-3", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [textBlock(`waiting ${SENTINEL}`)] } }),
    sub4Envelope({ type: "assistant", message: { id: "sub4-msg-4", model: "claude-sonnet-5", usage: usage(1, 1, 0, 0), content: [textBlock(`still waiting ${SENTINEL}`)] } }),
    sub4Envelope({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-agent-2", is_error: false }] },
      toolUseResult: { stdout: `nested subagent done ${SENTINEL}` },
    }),
  ]
  // A meta.json that exists but whose `model` doesn't match the model-id
  // pattern: distinct from agent-a3's missing meta — falls back to
  // "unknown" for a different reason, and must still count.
  const subagent4Meta = {
    agentType: `general-purpose-${SENTINEL}`,
    description: `bad model meta ${SENTINEL}`,
    toolUseId: "no-matching-tool-use",
    spawnDepth: 1,
    model: "not a valid model id!",
  }

  return {
    sessionId,
    lines,
    subagents: [
      { fileStem: "agent-a1", lines: subagent1Lines, meta: subagent1Meta },
      { fileStem: "agent-a2", lines: subagent2Lines, meta: subagent2Meta },
      // No meta for agent-a3 at all: must fall back to model "unknown" and
      // parent 0, and still count.
      { fileStem: "agent-a3", lines: subagent3Lines, meta: null },
      { fileStem: "agent-a4", lines: subagent4Lines, meta: subagent4Meta },
    ],
  }
}

// ---------------------------------------------------------------------------
// "truncated": a tool result stamped earlier than its own tool_use (clock
// skew: the interval is dropped, never emitted with end < start, and the
// earliest timestamp becomes started_at), a retryable 5xx API error with no
// assistant line anywhere after it (so a retry interval is not added, but
// api_retries still counts it), then a raw line cut off mid-write with no
// trailing newline. A blank line in between must not be mistaken for
// truncation.
// ---------------------------------------------------------------------------

function buildTruncatedSession() {
  const sessionId = SESSION_IDS.truncated
  const next = makeClock("2026-09-25T09:00:00.000Z")
  const envelope = (extra) => ({ sessionId, timestamp: next(), version: "2.1.100", entrypoint: "cli", ...extra })
  const lines = [
    envelope({ type: "user", message: { role: "user", content: [textBlock(`hi ${SENTINEL}`)] } }),
    envelope({
      type: "assistant",
      message: { id: "t-msg-0", model: "claude-opus-5-5", usage: usage(1, 1, 0, 0), content: [{ type: "tool_use", id: "t-bash-1", name: "Bash", input: { command: `ls ${SENTINEL}` } }] },
    }),
    envelope({
      type: "user",
      timestamp: TRUNCATED_SKEWED_RESULT_AT,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-bash-1", is_error: false, content: `listing ${SENTINEL}` }] },
    }),
    envelope({
      type: "assistant",
      isApiErrorMessage: true,
      apiErrorStatus: 503,
      error: `server error ${SENTINEL}`,
      message: { id: "t-msg-1", model: "<synthetic>", usage: usage(4, 2, 0, 0), content: [] },
    }),
  ]
  const raw = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n\n  \n{"type":"assistant","sessionId":"${sessionId}","timestamp":"2026-09-25T09:00:02.000`
  return { sessionId, raw }
}

// ---------------------------------------------------------------------------
// "unreadable": zero usable assistant lines, a malformed non-final line, and
// a tool_result for a tool_use id never seen (dropped, not crashed on).
// ---------------------------------------------------------------------------

function buildUnreadableSession() {
  const sessionId = SESSION_IDS.unreadable
  const next = makeClock("2026-09-25T10:00:00.000Z")
  const envelope = (extra) => ({ sessionId, timestamp: next(), version: "2.0.5", entrypoint: "sdk-node", ...extra })
  const first = envelope({ type: "user", message: { role: "user", content: [textBlock(`q ${SENTINEL}`)] } })
  const broken = `{"type":"user","sessionId":"${sessionId}", broken`
  const dangling = envelope({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown-tool-use-id", is_error: false }] },
  })
  const last = envelope({ type: "system", subtype: "compact_boundary" })
  const raw = `${JSON.stringify(first)}\n${broken}\n${JSON.stringify(dangling)}\n${JSON.stringify(last)}\n`
  return { sessionId, raw }
}

// ---------------------------------------------------------------------------
// "oddShapes": lines that parse but carry shapes a deriver must tolerate
// without throwing or emitting invalid facts. Its root has no orphan call
// no invalid model and no truncation, so those signals can only come from
// its one subagent, whose meta.json is valid JSON but not an object.
// ---------------------------------------------------------------------------

function buildOddShapesSession() {
  const sessionId = SESSION_IDS.oddShapes
  const next = makeClock("2026-09-25T13:00:00.000Z")
  const envelope = (extra) => ({ sessionId, timestamp: next(), version: "2.1.282", entrypoint: "cli", ...extra })
  const lines = [
    // Two back-to-back human prompts: the first turn has no activity, so it
    // ends where it starts.
    envelope({ type: "user", message: { role: "user", content: `first ${SENTINEL}` } }),
    envelope({ type: "user", message: { role: "user", content: `second ${SENTINEL}` } }),
    // Usage fields that are not non-negative numbers count as 0; string
    // content carries no tool calls.
    envelope({ type: "assistant", message: { id: "odd-1", model: "claude-opus-5-5", usage: { input_tokens: "12", output_tokens: -3, cache_read_input_tokens: null, cache_creation_input_tokens: 4 }, content: `plain ${SENTINEL}` } }),
    // No usage object at all; a tool_use with no input, a Write with no
    // file_path, and a block that is not an object.
    envelope({ type: "assistant", message: { id: "odd-2", model: "claude-opus-5-5", content: [null, { type: "tool_use", id: "odd-tool-1", name: "Bash" }, { type: "tool_use", id: "odd-tool-2", name: "Write", input: { content: `${SENTINEL}` } }] } }),
    // Results for both, plus a tool_result block with no usable tool_use_id.
    envelope({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "odd-tool-1", is_error: false }, { type: "tool_result", tool_use_id: "odd-tool-2", is_error: false }, { type: "tool_result", tool_use_id: 7 }] } }),
    // A retryable error on a line with no readable timestamp: counted, but
    // it opens no interval.
    envelope({ type: "assistant", timestamp: "not-a-timestamp", isApiErrorMessage: true, apiErrorStatus: 529, message: { id: "odd-err-1", model: "<synthetic>", content: [] } }),
    // A retryable error closed only by an assistant line with no readable
    // timestamp: counted, but its interval has no end, so none is emitted.
    envelope({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, message: { id: "odd-err-2", model: "<synthetic>", content: [] } }),
    envelope({ type: "assistant", timestamp: "not-a-timestamp", message: { id: "odd-3", model: "claude-opus-5-5", usage: usage(1, 1, 0, 0), content: [] } }),
    // A pr-link whose repository is free text, and file-history deltas with
    // no path or no readable timestamp: none may reach facts or events.
    envelope({ type: "pr-link", prNumber: 5, prRepository: `${SENTINEL} not a repo`, prUrl: `https://example.invalid/${SENTINEL}` }),
    envelope({ type: "file-history-delta", trackingPath: 42 }),
    envelope({ type: "file-history-delta", timestamp: "not-a-timestamp", trackingPath: `${SENTINEL}-untimed-path` }),
  ]
  const raw = `${toJsonl(lines)}null\n"${SENTINEL} a bare string"\n42\n`
  const subagentLines = [
    // An orphan call and an invalid model: only this subagent carries them.
    { sessionId, timestamp: "2026-09-25T13:00:05.500Z", version: "2.1.282", type: "assistant", message: { id: "odd-sub-1", model: "not a valid model id!", usage: usage(1, 1, 0, 0), content: [{ type: "tool_use", id: "odd-sub-tool-1", name: "Read", input: { file_path: `${SENTINEL}` } }] } },
  ]
  // The subagent's own last line is cut off mid-write: truncation in any
  // agent's file, not only the root's, reports turns/log_truncated.
  return { sessionId, raw, subagents: [{ fileStem: "agent-b1", lines: subagentLines, rawMeta: "null\n", truncatedTail: `{"type":"assistant","timestamp":"2026-09-25T13:00:0` }] }
}

// ---------------------------------------------------------------------------
// "noEnvelope": every line fails to parse, so no root line ever yields a
// usable envelope (a valid timestamp and a valid version together).
// ---------------------------------------------------------------------------

function buildNoEnvelopeSession() {
  return { sessionId: SESSION_IDS.noEnvelope, raw: "not json\nalso not json\n" }
}

// A well-formed line in a file whose name is not a session UUID.
function buildNonUuidSession() {
  const line = { type: "user", timestamp: "2026-09-25T12:00:00.000Z", version: "2.1.282", entrypoint: "cli", message: { role: "user", content: `hello ${SENTINEL}` } }
  return { raw: toJsonl([line]) }
}

// ---------------------------------------------------------------------------
// A large synthetic transcript for the memory-growth check. Not written to
// this directory (it is a stress artifact, not a structural example) —
// callers write it to a scratch path themselves.
// ---------------------------------------------------------------------------

// About 90 MiB on disk: each message's Bash call carries the blob once in
// its input and twice in its result.
export const LARGE_SESSION = Object.freeze({ sessionId: "7f405162-ce3d-4041-b25d-5e6f7182930a", messageCount: 5000, blobSize: 6000 })

export function buildLargeSessionLines({ sessionId, messageCount, blobSize }) {
  const next = makeClock("2026-09-25T11:00:00.000Z")
  const envelope = (extra) => ({ sessionId, timestamp: next(), version: "2.1.282", entrypoint: "cli", ...extra })
  const blob = "x".repeat(blobSize)
  function* generate() {
    yield envelope({ type: "user", message: { role: "user", content: [textBlock("start")] } })
    for (let i = 0; i < messageCount; i += 1) {
      yield envelope({
        type: "assistant",
        message: {
          id: `large-msg-${i}`,
          model: "claude-opus-5-5",
          usage: usage(1, 1, 0, 0),
          content: [{ type: "tool_use", id: `large-tool-${i}`, name: "Bash", input: { command: `echo ${blob}` } }],
        },
      })
      yield envelope({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `large-tool-${i}`, is_error: false, content: blob }] },
        toolUseResult: { stdout: blob },
      })
    }
  }
  return { sessionId, generate }
}

function writeSubagents(sessionDir, subagents) {
  if (subagents.length === 0) return
  const subagentsDir = path.join(sessionDir, "subagents")
  mkdirSync(subagentsDir, { recursive: true })
  for (const subagent of subagents) {
    writeFileSync(path.join(subagentsDir, `${subagent.fileStem}.jsonl`), `${toJsonl(subagent.lines)}${subagent.truncatedTail ?? ""}`)
    if (subagent.rawMeta !== undefined) {
      writeFileSync(path.join(subagentsDir, `${subagent.fileStem}.meta.json`), subagent.rawMeta)
    } else if (subagent.meta !== null) {
      writeFileSync(path.join(subagentsDir, `${subagent.fileStem}.meta.json`), `${JSON.stringify(subagent.meta, null, 2)}\n`)
    }
  }
}

export function generate({ outDir = here } = {}) {
  const full = buildFullSession()
  const truncated = buildTruncatedSession()
  const unreadable = buildUnreadableSession()
  const noEnvelope = buildNoEnvelopeSession()
  const nonUuid = buildNonUuidSession()
  const oddShapes = buildOddShapesSession()

  rmSync(path.join(outDir, full.sessionId), { recursive: true, force: true })
  writeFileSync(path.join(outDir, `${full.sessionId}.jsonl`), toJsonl(full.lines))
  writeSubagents(path.join(outDir, full.sessionId), full.subagents)

  writeFileSync(path.join(outDir, `${truncated.sessionId}.jsonl`), truncated.raw)
  writeFileSync(path.join(outDir, `${unreadable.sessionId}.jsonl`), unreadable.raw)
  writeFileSync(path.join(outDir, `${noEnvelope.sessionId}.jsonl`), noEnvelope.raw)
  writeFileSync(path.join(outDir, `${NON_UUID_FILE_STEM}.jsonl`), nonUuid.raw)
  rmSync(path.join(outDir, oddShapes.sessionId), { recursive: true, force: true })
  writeFileSync(path.join(outDir, `${oddShapes.sessionId}.jsonl`), oddShapes.raw)
  writeSubagents(path.join(outDir, oddShapes.sessionId), oddShapes.subagents)

  return { full, truncated, unreadable, noEnvelope, nonUuid, oddShapes }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  generate()
  // eslint-disable-next-line no-console
  console.log(`wrote fixtures to ${here}`)
}
