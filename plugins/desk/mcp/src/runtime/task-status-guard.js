// Desk's task-status guard: a Claude Code `PreToolUse` hook on
// `Write`/`Edit`/`MultiEdit` that denies a direct edit changing a task
// card's `status:` frontmatter line (any value, not only `done`), pointing
// the agent at `task_update` instead. Body edits, other fields and brand
// new cards (a Write to a path that does not exist yet) pass through; a new
// card may still not be born `done`.
//
// Round 5 widening (2026-09-30): an agent finished real work, then edited
// task.md straight to `status: validating` with a hand-written "Completed
// work" section and committed it, bypassing `task_update`. Every status move
// belongs to `task_update` (valid transitions, `done` evidence, staging and
// committing), so the guard now compares the card's `status:` before and
// after the call instead of matching only `done`. It reads the card from
// disk to apply an Edit/MultiEdit to it; when the card cannot be read or an
// edit does not apply, it compares the status lines inside the edit's own
// old and new strings.
//
// Why (the invented-completion finding, 2026-09-29): an acceptance run
// under the `resume-named-task` scenario was told to resume a fixture
// task. Instead of calling `task_update`, it edited the task card
// directly with the host's own Edit tool, set `status: done` and wrote a
// fabricated "Completed work" section claiming tests passed and a branch
// merged -- none of which had happened -- then committed it with a
// message claiming the work was "fully implemented and tested".
// `task_update` now refuses a move to `done` with no evidence
// (`../tools/task.js`'s `assertDoneEvidence`), but that check only runs
// inside `task_update` itself; a direct Edit/Write/MultiEdit to `task.md`
// never calls it. This hook is the other half: it catches the bypass at the
// tool-call boundary, before the write lands, and tells the agent which
// tool call does carry the evidence check.
//
// Scope, deliberately narrow (the lightest mechanism that works on Claude
// Code first). This module only recognizes Claude Code's own `PreToolUse`
// wire shape and its `Write`/`Edit`/`MultiEdit` tool-input shapes
// (`file_path`, `content`, `old_string`, `new_string`, `replace_all`, and
// MultiEdit's `edits: [{ old_string, new_string }, ...]` -- the same
// `Write`/`Edit` fields `runtime/ask-gate.js` already reads for those two
// tools, plus MultiEdit's array). It denies exactly the write that changes
// the card's frontmatter `status:` -- for MultiEdit, the edits are applied
// in order and the final text is compared; every other task-card edit -- a
// body section, a different field, a non-`task.md` file -- passes through
// untouched. Whether a `done` claim carries evidence is `task_update`'s own
// question, not this hook's: it just refuses the direct-edit shortcut.
//
// What Copilot and Codex would need (not done here): their own
// `PreToolUse` tool-name and tool-input field mapping, the way
// `host-enforcement.js`'s `toolNameFromPayload`/`sessionIdFromPayload`
// already do per host, plus confirmation of each host's own
// Edit/Write/MultiEdit tool-input shape before trusting
// `file_path`/`content`/`edits` there. This
// module returns `{}` (allow) for any host but `"claude"` until that
// evidence exists, the same restriction `ask-gate.js` already documents
// and applies to itself.
//
// This hook matches on path shape (`.../task.md`) alone -- the same
// trade-off `ask-gate.js`'s own activation-path match makes -- so it
// cannot distinguish a real desk's task card from a fixture or scratch
// file that happens to share the basename; denying a legitimate edit to
// such a file is a minor cost next to letting the actual bypass through.

import { readFileSync } from "node:fs"

const TASK_CARD_BASENAME = "task.md"

// Matches an unindented, top-level `status:` line (a nested `status:` under `repos:` is indented and never matches), quoted or not, anywhere in the given text. It does
// not require YAML frontmatter delimiters around it: `content` (Write) and `new_string` (Edit)
// may hold only a fragment of the file, not the whole document.
const ANY_STATUS_LINE = /(^|\r?\n)status:[ \t]*["']?([^"'\r\n]*?)["']?[ \t]*(?=\r?\n|$)/u
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/u

/** True for a `file_path` whose final path segment is exactly `task.md`. */
function isTaskCardPath(filePath) {
  if (typeof filePath !== "string" || filePath === "") return false
  const normalized = filePath.replace(/\\/gu, "/")
  return normalized === TASK_CARD_BASENAME || normalized.endsWith(`/${TASK_CARD_BASENAME}`)
}

/**
 * The value of the `status:` line in `text`, or null when there is none.
 * A whole card is read inside its frontmatter block only, so a `status:`
 * line quoted in the body never counts; a fragment (no frontmatter block)
 * is searched whole.
 */
function statusOf(text) {
  const block = FRONTMATTER.exec(text)
  const found = ANY_STATUS_LINE.exec(block === null ? text : block[1])
  return found === null ? null : found[2].trim()
}

function readCard(filePath) {
  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return null
  }
}

function editsOf(toolName, args) {
  if (toolName === "Edit") return [args]
  return Array.isArray(args?.edits) ? args.edits : []
}

// Applies the edits to the card's text in order, the way the host would;
// null when an edit's old_string is empty or absent, so the caller falls back to the fragments.
function applyEdits(text, edits) {
  let current = text
  for (const edit of edits) {
    const oldString = String(edit?.old_string ?? "")
    if (oldString === "" || !current.includes(oldString)) return null
    const newString = String(edit?.new_string ?? "")
    current = edit.replace_all === true ? current.split(oldString).join(newString) : current.replace(oldString, () => newString)
  }
  return current
}

/**
 * `{ from, to }` when this call would change the card's `status:` (either
 * side null for an added or removed line), or null when it leaves it alone.
 * A Write to a path with no card yet is a new card: only a `done` birth
 * counts as a change.
 */
function statusChange(toolName, args, read = readCard) {
  const existing = read(args.file_path)
  if (toolName === "Write") {
    const to = statusOf(String(args.content ?? ""))
    if (existing === null) return to === "done" ? { from: null, to } : null
    const from = statusOf(existing)
    return from === to ? null : { from, to }
  }
  const edits = editsOf(toolName, args)
  if (existing !== null) {
    const applied = applyEdits(existing, edits)
    if (applied !== null) {
      const from = statusOf(existing)
      const to = statusOf(applied)
      return from === to ? null : { from, to }
    }
  }
  for (const edit of edits) {
    const from = statusOf(String(edit?.old_string ?? ""))
    const to = statusOf(String(edit?.new_string ?? ""))
    if (from !== to) return { from, to }
  }
  return null
}

function taskCoordinates(filePath) {
  const parts = filePath.replace(/\\/gu, "/").split("/").filter((part) => part !== "")
  return { track: parts.at(-3) ?? "<track>", slug: parts.at(-2) ?? "<slug>" }
}

function denyReason(filePath, change) {
  const { track, slug } = taskCoordinates(filePath)
  const shown = (value) => (value === null ? "no status" : `\`${value}\``)
  const target = change.to === null ? "<new status>" : change.to
  const evidence = change.to === "done"
    ? " A move to `done` also needs `evidence: { kind, ref }` (kind one of pr, commit, ci_run, non_code; ref the PR URL, a commit on a remote branch, the CI run URL, or the non-code outcome's own proof link) -- it validates the evidence, and \"resume <task>\" never authorizes declaring a task done without it."
    : ""
  return (
    `Desk denies a direct edit that changes a task card's \`status:\` (${shown(change.from)} to ${shown(change.to)}). ` +
    `Call \`task_update\` instead with \`{ track: "${track}", slug: "${slug}", frontmatter: { status: "${target}" } }\`: ` +
    "it checks the transition, stages and commits the write itself, and keeps the card's history honest." +
    evidence +
    " Editing the card's body or other fields directly is fine; only the status line belongs to `task_update`."
  )
}

/**
 * `input` is the hook's JSON stdin (Claude Code's `PreToolUse` payload).
 * Returns Claude Code's `PreToolUse` deny shape when this call would change
 * a task card's `status:` (or create a card already `done`), or `{}` to let
 * the call through untouched. Only `host === "claude"` is recognized today
 * (see the module doc comment for what Copilot/Codex would need).
 */
export function taskStatusGuardHook(input, host, read = readCard) {
  if (host !== "claude") return {}
  const toolName = String(input?.tool_name ?? input?.toolName ?? "")
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") return {}

  let args = input?.tool_input ?? input?.toolArgs
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      return {}
    }
  }
  if (!args || typeof args !== "object") return {}
  if (!isTaskCardPath(args.file_path)) return {}
  const change = statusChange(toolName, args, read)
  if (change === null) return {}

  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(args.file_path, change) } }
}

export { isTaskCardPath, statusOf, statusChange }
