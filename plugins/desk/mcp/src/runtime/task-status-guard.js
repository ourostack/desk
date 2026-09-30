// Desk's task-status guard: a Claude Code `PreToolUse` hook on
// `Write`/`Edit`/`MultiEdit` that denies a direct edit setting a task
// card's `status:` frontmatter line to `done`, pointing the agent at
// `task_update` instead.
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
// (`file_path`, `content`, `old_string`, `new_string`, and MultiEdit's own
// `edits: [{ old_string, new_string }, ...]` -- the same `Write`/`Edit`
// fields `runtime/ask-gate.js` already reads for those two tools, plus
// MultiEdit's array). It denies exactly the write that sets `status:` to
// `done` -- for MultiEdit, any one of its `edits` doing so is enough, since
// every edit in the call lands atomically if the call succeeds; every other
// task-card edit -- a different field, a different status value, a
// non-`task.md` file -- passes through untouched. Whether that `done` claim
// carries evidence is `task_update`'s own question, not this hook's: this
// hook only ever sees the raw bytes a tool call would write, never the
// card's prior state, so it cannot tell a legitimate
// `task_update`-mirroring edit from a fabricated one -- it just refuses the
// direct-edit shortcut either way.
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

const TASK_CARD_BASENAME = "task.md"

// Matches a frontmatter-shaped `status:` line whose value is `done`, quoted
// or not, anywhere in the given text -- the same line `patchMarkdownFrontmatter`
// and a hand edit would both produce. It does not require YAML frontmatter
// delimiters around it: `content` (Write) and `new_string` (Edit) may hold
// only a fragment of the file, not the whole document.
const DONE_STATUS_LINE = /(^|\r?\n)[ \t]*status:[ \t]*["']?done["']?[ \t]*(\r?\n|$)/u

/** True for a `file_path` whose final path segment is exactly `task.md`. */
function isTaskCardPath(filePath) {
  if (typeof filePath !== "string" || filePath === "") return false
  const normalized = filePath.replace(/\\/gu, "/")
  return normalized === TASK_CARD_BASENAME || normalized.endsWith(`/${TASK_CARD_BASENAME}`)
}

/** True when this call's own write would leave a `status: done` line behind. */
function setsStatusToDone(toolName, args) {
  if (toolName === "Write") return DONE_STATUS_LINE.test(String(args?.content ?? ""))
  if (toolName === "Edit") return DONE_STATUS_LINE.test(String(args?.new_string ?? ""))
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(args?.edits) ? args.edits : []
    return edits.some((edit) => DONE_STATUS_LINE.test(String(edit?.new_string ?? "")))
  }
  return false
}

const DENY_REASON =
  "Desk denies a direct edit that sets a task card's `status:` to `done`. Use `task_update` " +
  "instead, with `frontmatter: { status: \"done\" }` and an `evidence: { kind, ref }` " +
  "reference (kind one of pr, commit, ci_run, non_code; ref the PR URL, a commit on a remote " +
  "branch, the CI run URL, or the non-code outcome's own proof link) -- it validates the " +
  "evidence, then stages and commits the write itself. A direct Edit/Write/MultiEdit to task.md " +
  "does none of that, and \"resume <task>\" never authorizes declaring it done without evidence."

/**
 * `input` is the hook's JSON stdin (Claude Code's `PreToolUse` payload).
 * Returns Claude Code's `PreToolUse` deny shape when this call would write
 * `status: done` straight into a task card's frontmatter, or `{}` to let the
 * call through untouched. Only `host === "claude"` is recognized today (see
 * the module doc comment for what Copilot/Codex would need).
 */
export function taskStatusGuardHook(input, host) {
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
  if (!setsStatusToDone(toolName, args)) return {}

  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON } }
}

export { isTaskCardPath, setsStatusToDone }
