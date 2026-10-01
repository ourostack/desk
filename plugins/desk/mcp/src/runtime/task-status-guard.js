// Desk's task-card guard: a Claude Code `PreToolUse` hook on `Write`/`Edit`/`MultiEdit` that denies any direct
// edit of an EXISTING task card (`.../task.md`) and names the `task_update` call to use instead. Creating a card is
// `task_create`'s job, but a brand new card path may still be written (and may not be born `done`).
//
// Round A widening (2026-09-30), from the status-only guard it replaces: an agent resumed a task whose push route
// was a fork, could not open the PR, then edited the card body to claim "Push routing confirmed ... scenario is
// handled", committed, pushed and told the operator it was "completed" -- with no PR and no check. The earlier
// guard only compared `status:`, so a body edit passed. Every write to a card now goes through `task_update`:
// `frontmatter` (status, repos, iterations), `note` (a dated line under `## Progress log`), `next_step` (replaces
// the recorded next step) and `body_append`. Desk's own code (the task tools, tidy, migrations, tests) writes cards
// through the file system, which this hook never sees: it only inspects host tool calls.
//
// Round 5 history: an agent finished real work, then edited task.md straight to `status: validating` with a
// hand-written "Completed work" section and committed it, bypassing `task_update` (valid transitions, `done`
// evidence, staging and committing). The deny reason still spells out the exact status call when a status line
// changes, and the `done` evidence shape when it becomes `done`.
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
// Scope. This module only recognizes Claude Code's own `PreToolUse` wire shape and its `Write`/`Edit`/`MultiEdit`
// tool-input shapes (`file_path`, `content`, `old_string`, `new_string`, `replace_all`, and MultiEdit's
// `edits: [{ old_string, new_string }, ...]` -- the same fields `runtime/ask-gate.js` already reads). It denies every
// such call whose target is an existing `task.md`; a Write to a path with no card yet passes unless it would create a
// card already `done`. It cannot see a shell command that writes the file (`sed -i`, a heredoc): that is the reach
// of any tool-call hook, and the commit-time evidence check in `task_update` remains the real gate for `done`.
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
  const target = `{ track: "${track}", slug: "${slug}"`
  const shown = (value) => (value === null ? "no status" : `\`${value}\``)
  const statusPart = change === null
    ? ""
    : ` This edit changes the card's \`status:\` (${shown(change.from)} to ${shown(change.to)}): call \`task_update\` with ${target}, frontmatter: { status: "${change.to === null ? "<new status>" : change.to}" } }; it checks the transition.` +
      (change.to === "done"
        ? " A move to `done` also needs `evidence: { kind, ref }` (kind one of pr, commit, ci_run, non_code; ref the PR URL, a commit on a remote branch, the CI run URL, or the non-code outcome's own proof link; a card that lists `repos` accepts only a PR URL in one of them or a pushed commit from one of them) -- it validates the evidence, and \"resume <task>\" never authorizes declaring a task done without it."
        : "")
  return (
    "Desk denies a direct edit of an existing task card: every write to a card goes through `task_update`, which commits it for you and keeps its history honest." +
    statusPart +
    ` To record progress: \`task_update\` with ${target}, note: "<one line of what actually happened>" } (a dated line under \`## Progress log\`). ` +
    `To change what is next: ${target}, next_step: "<the next action>" }. ` +
    `Other fields (repos, iterations, a repo's url): ${target}, frontmatter: { ... } }; more text: ${target}, body_append: "<markdown>" }. ` +
    "A note is only a note: a task is finished by its pull request or check, and a card that says otherwise without one is not true."
  )
}

/**
 * `input` is the hook's JSON stdin (Claude Code's `PreToolUse` payload).
 * Returns Claude Code's `PreToolUse` deny shape when this call would edit an
 * existing task card (or create one already `done`), or `{}` to let
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
  // An existing card is never edited directly; a path with no card yet is `task_create`'s, so only a `done` birth is denied.
  if (change === null && read(args.file_path) === null) return {}

  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(args.file_path, change) } }
}

export { isTaskCardPath, statusOf, statusChange }
