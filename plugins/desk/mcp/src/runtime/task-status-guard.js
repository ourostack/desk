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
// Scope. Claude Code's own `PreToolUse` wire shape and its `Write`/`Edit`/`MultiEdit` tool-input shapes (`file_path`, `content`, `old_string`, `new_string`, `replace_all`, and MultiEdit's
// `edits: [{ old_string, new_string }, ...]` -- the same fields `runtime/ask-gate.js` already reads), and Copilot CLI's: a `copilotToolCalls` payload (`runtime/copilot-hook-payload.js`) turns Copilot's
// `bash`, `powershell`, `create`, `edit` and `apply_patch` calls into the same Claude-shaped calls, so the logic below is shared and the deny is the only thing written per host (flat for Copilot).
// Codex stays unguarded (this module returns `{}` for it): Codex's hook trust gate leaves any Desk hook inactive (`docs/host-enforcement-live-proof.md`), and its edit tool's payload has not been seen live.
//
// Which files count (review of #123). The path is expanded (`~`), trimmed, resolved against the session folder and
// realpath'd (the file, or its parent when the file does not exist yet), so a symlink or `TASK.md` on a
// case-insensitive disk cannot hide a card; names are compared case-insensitively; and an existing file with other
// hard links is also matched by inode against the desk's live cards. The desk is the bound root
// (`resolveHookDeskRoot`: the project folder when it is a desk, the saved binding, `$DESK`, the home fallbacks);
// when no root can be determined, the nearest ancestor folder that `isDeskWorkspace` recognizes (`_meta/` plus
// `_archive/` or `desks/`) stands in for it. Within it:
//   - a LIVE card is `<root>/<track>/<slug>/task.md` (or the same under `desks/<alias>/`): every Write, Edit or
//     MultiEdit of an existing one is denied, unless its frontmatter no longer parses, because a corrupted card
//     must stay repairable by hand;
//   - an ARCHIVED card (`.../_archive/<slug>/task.md`) stays on the earlier status-only guard;
//   - a path with no card yet is `task_create`'s, so only a card born `done` is denied;
//   - any other `task.md`, in particular one outside a desk, is none of this hook's business.
// Shell commands (round 12, after round E run 8: a node script run through Bash rewrote a live card and the agent committed it by hand). A `Bash` or
// `PowerShell` command that names a live card of the bound desk and writes it (a redirect, `tee`, `sed -i`, a script that writes files, `mv`/`cp` onto it,
// `git checkout` of it) is denied the same way; reading it (`cat`, `grep`, `git diff`) passes. `shell-card-writes.js` has the forms and what it cannot
// see (a path held in a variable or built in pieces with no slug in the command). It is a best-effort net: the desk's own pre-commit hook
// (`../desk/card-commit-guard.js`) is the layer underneath, and the evidence check inside `task_update` remains the real gate for `done`.
//
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { resolveHookDeskRoot } from "../../scripts/resolve-desk-root.js"
import { loadFrontmatterParser } from "../desk/organization.js"
import { isDeskWorkspace } from "../util/paths.js"
import { deferredToolsLoadHint } from "../util/deferred-tools.js"
import { COPILOT_SESSION_ENV, readCopilotSession } from "./copilot-session.js"
import { copilotDeny, copilotToolCalls } from "./copilot-hook-payload.js"
import { deskToolName } from "./desk-tool-name.js"
import { shellCardWrites } from "./shell-card-writes.js"

const TASK_CARD_BASENAME = "task.md"

// Matches an unindented, top-level `status:` line (a nested `status:` under `repos:` is indented and never matches), quoted or not, anywhere in the given text. It does
// not require YAML frontmatter delimiters around it: `content` (Write) and `new_string` (Edit)
// may hold only a fragment of the file, not the whole document.
const ANY_STATUS_LINE = /(^|\r?\n)status:[ \t]*["']?([^"'\r\n]*?)["']?[ \t]*(?=\r?\n|$)/u
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/u

const lower = (text) => text.toLowerCase()
const parseFrontmatter = loadFrontmatterParser()

/** `file_path` made absolute: trimmed, `~` expanded, relative paths resolved against `cwd`. */
function absolutePath(filePath, { cwd, home }) {
  const text = filePath.trim()
  const expanded = text === "~" ? home : text.startsWith("~/") || text.startsWith("~\\") ? path.join(home, text.slice(2)) : text
  return path.resolve(cwd, expanded)
}

/** The real path of the file, or of its parent plus the name when the file does not exist yet. */
function realTarget(absolute) {
  try {
    return realpathSync.native(absolute)
  } catch {
    try {
      return path.join(realpathSync.native(path.dirname(absolute)), path.basename(absolute))
    } catch {
      return absolute
    }
  }
}

/** The path under `root` as segments, or null when it is not under it (compared case-insensitively). */
function segmentsUnder(root, real) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (!lower(real).startsWith(lower(prefix))) return null
  return real.slice(prefix.length).split(path.sep).filter((part) => part !== "")
}

/** `live` / `archived` / null for segments below the desk root; a live card is track/slug/task.md, optionally under desks/<alias>. */
function cardKind(segments) {
  if (segments === null || lower(segments.at(-1)) !== TASK_CARD_BASENAME) return null
  const inner = segments[0] === "desks" ? segments.slice(2) : segments
  if (inner.length === 3 && !inner[0].startsWith("_")) return "live"
  if (inner.length === 4 && !inner[0].startsWith("_") && lower(inner[1]) === "_archive") return "archived"
  return null
}

/** The nearest ancestor of the file that is a desk workspace, standing in for an undetermined bound root. */
function discoverRoot(real) {
  let dir = path.dirname(real)
  for (let depth = 0; depth < 7 && dir !== path.dirname(dir); depth += 1) {
    dir = path.dirname(dir)
    if (isDeskWorkspace(dir)) return dir
  }
  return null
}

/** The `[track, slug, task.md]` of the live card an existing file with other hard links shares an inode with, or null. */
function liveCardByInode(root, real) {
  let target
  try {
    target = statSync(real)
  } catch {
    return null
  }
  if (target.nlink < 2) return null
  const names = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("_")).map((entry) => path.join(dir, entry.name))
    } catch {
      return []
    }
  }
  for (const track of names(root)) {
    for (const slug of names(track)) {
      try {
        const card = statSync(path.join(slug, TASK_CARD_BASENAME))
        if (card.ino === target.ino && card.dev === target.dev) return [path.basename(track), path.basename(slug), TASK_CARD_BASENAME]
      } catch {
        // No card in this folder.
      }
    }
  }
  return null
}

/**
 * Classifies a `file_path`: `{ kind: "live" | "archived", absolute, segments }` for a task card of the bound desk
 * (see the module comment), or null for anything else.
 */
function classifyCard(filePath, { root, cwd, home }) {
  if (typeof filePath !== "string" || filePath.trim() === "") return null
  const absolute = absolutePath(filePath, { cwd, home })
  const real = realTarget(absolute)
  let deskRoot = root === null ? discoverRoot(real) : realTarget(root)
  if (deskRoot === null) return null
  deskRoot = realTarget(deskRoot)
  const segments = segmentsUnder(deskRoot, real)
  const kind = cardKind(segments)
  if (kind !== null) return { kind, absolute, segments }
  const aliased = liveCardByInode(deskRoot, real)
  return aliased === null ? null : { kind: "live", absolute, segments: aliased }
}

/** True when the card text has a frontmatter block that parses to a mapping; a card that does not stays hand-repairable. */
function isReadableCard(text) {
  if (!FRONTMATTER.test(text)) return false
  try {
    const data = parseFrontmatter(text).data
    return data !== null && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length > 0
  } catch {
    return false
  }
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

function taskCoordinates({ kind, segments }) {
  return { track: segments.at(kind === "archived" ? -4 : -3), slug: segments.at(-2) }
}

/** The top-level frontmatter keys whose value differs between two card texts, or null when either does not parse. */
function changedFrontmatter(existing, proposed) {
  if (existing === null || proposed === null) return null
  try {
    const before = parseFrontmatter(existing).data, after = parseFrontmatter(proposed).data
    return Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])))
  } catch {
    return null
  }
}

/** The text a card's body gained, or null when the body was not only added to. */
function appendedBody(existing, proposed) {
  if (existing === null || proposed === null) return null
  const body = (text) => text.replace(FRONTMATTER, "")
  const before = body(existing), after = body(proposed)
  return after.length > before.length && after.startsWith(before) ? after.slice(before.length) : null
}

/** The `task_update` fields that carry what an edit tried to set: its changed frontmatter and appended text, else a note to fill in. */
function updateFields({ change, existing, proposed, via }) {
  const note = { note: "<one line of what actually happened>" }
  if (via !== null) return note
  const frontmatter = { ...changedFrontmatter(existing, proposed) }
  if (change !== null && change.to !== null) frontmatter.status = change.to
  const fields = {}
  if (Object.keys(frontmatter).length > 0) fields.frontmatter = frontmatter
  if (frontmatter.status === "done") fields.evidence = { kind: "pr", ref: "<PR URL>" }
  const appended = appendedBody(existing, proposed)
  if (appended !== null) fields.body_append = appended
  return Object.keys(fields).length > 0 ? fields : note
}

// A suggested call longer than this is shown with placeholders for what the edit carried: a denial must stay readable.
const CALL_LIMIT = 400

/** The suggested call as JSON, with a placeholder for text too long to repeat, and whether one was used. */
function suggestedCall(coordinates, fields) {
  const whole = JSON.stringify({ ...coordinates, ...fields })
  if (whole.length <= CALL_LIMIT) return { call: whole, shortened: false }
  const short = { ...fields }
  if (short.body_append !== undefined) short.body_append = "<your appended text>"
  if (JSON.stringify({ ...coordinates, ...short }).length > CALL_LIMIT) short.frontmatter = "<the fields you changed>"
  return { call: JSON.stringify({ ...coordinates, ...short }), shortened: true }
}

function denyReason(card, change, via, host, { existing = null, proposed = null } = {}) {
  const { track, slug } = taskCoordinates(card)
  const target = `{ track: "${track}", slug: "${slug}"`
  const tool = deskToolName(host, "task_update")
  const { call, shortened } = suggestedCall({ track, slug }, updateFields({ change, existing, proposed, via }))
  const instead = via === null ? "editing the card" : "writing the card from the shell"
  // The first sentence is the fix; when the exact call is too long for it, the call follows in the next one.
  const first = `Call ${tool} with ${call}.`
  const opening = (first.length <= 120 ? first : `Call ${tool} instead of ${instead}. The call: ${call}.`) + (shortened ? " Pass your text in the placeholder fields; the call is shortened." : "")
  const shown = (value) => (value === null ? "no status" : `\`${value}\``)
  const statusPart = change === null
    ? ""
    : ` This edit changes the card's \`status:\` (${shown(change.from)} to ${shown(change.to)}): call \`task_update\` with ${target}, frontmatter: { status: "${change.to === null ? "<new status>" : change.to}" } }; it checks the transition.` +
      (change.to === "done"
        ? " A move to `done` also needs `evidence: { kind, ref }` (kind one of pr, commit, ci_run, non_code; ref the PR URL, a commit on a remote branch, the CI run URL, or the non-code outcome's own proof link; a card that lists `repos` accepts only a PR URL in one of them, a pushed commit from one of them, or a commit in a clone that has no remote at all) -- it validates the evidence, and \"resume <task>\" never authorizes declaring a task done without it."
        : "")
  return (
    `${opening} ` +
    (via === null
      ? "Desk denies a direct edit of an existing task card: "
      : `Desk denies a shell command that writes an existing task card (${via}; reading a card with cat, grep or git diff is fine): `) +
    "every write to a card goes through `task_update`, which commits it for you and keeps its history honest. A commit that changes a card is refused by the desk's own git hook unless Desk makes it." +
    statusPart +
    ` To record progress: \`task_update\` with ${target}, note: "<one line of what actually happened>" } (a dated line under \`## Progress log\`). ` +
    `To change what is next: ${target}, next_step: "<the next action>" }. ` +
    `Other fields (repos, iterations, a repo's url): ${target}, frontmatter: { ... } }; more text: ${target}, body_append: "<markdown>" }. ` +
    "If the card's frontmatter is corrupted so that it no longer parses, a direct edit is allowed so it can be repaired; this card parses, so it is not that case." +
    " A note is only a note: a task is finished by its pull request or check, and a card that says otherwise without one is not true. " +
    deferredToolsLoadHint(host)
  )
}

/** Claude Code's call in the shape `copilotToolCalls` returns: `[{ toolName, args }]`, or none for a tool this hook does not judge or arguments it cannot read. */
function claudeToolCalls(input) {
  const toolName = String(input?.tool_name ?? input?.toolName ?? "")
  if (toolName !== "Bash" && toolName !== "PowerShell" && toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") return []
  let args = input?.tool_input ?? input?.toolArgs
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      return []
    }
  }
  return args && typeof args === "object" ? [{ toolName, args }] : []
}

/** The card text this Write or Edit would leave, or null when it cannot be worked out (an edit whose old text is not in the card). */
function proposedText(toolName, args, existing) {
  if (toolName === "Write") return String(args.content ?? "")
  return existing === null ? null : applyEdits(existing, editsOf(toolName, args))
}

/** Claude's deny for one call, or null when the call may go ahead. */
function decide({ toolName, args }, { root, cwd, home, read, host }) {
  if (toolName === "Bash" || toolName === "PowerShell") return shellDecision(args.command, { root, cwd, home, read, host })
  const card = classifyCard(args.file_path, { root, cwd, home })
  if (card === null) return null

  const target = { ...args, file_path: card.absolute }
  const change = statusChange(toolName, target, read)
  const existing = read(card.absolute)
  // A path with no card yet is `task_create`'s, and an archived card keeps the status-only guard.
  if (card.kind === "archived" || existing === null) {
    if (change === null) return null
  } else if (!isReadableCard(existing)) {
    return null
  }

  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(card, change, null, host, { existing, proposed: proposedText(toolName, target, existing) }) } }
}

/**
 * `input` is the hook's JSON stdin: Claude Code's `PreToolUse` payload for `host === "claude"`, Copilot's for `"copilot"`.
 * Returns the host's deny shape (Claude Code's `hookSpecificOutput` wrapper, Copilot's flat pair) when this call would edit an
 * existing live task card of the bound desk, change an archived card's status, or create a card already `done`, or `{}` to let
 * the call through untouched. `context` is a test seam: `{ root, env, home }`. Any other host is allowed (see the module doc comment).
 */
export function taskStatusGuardHook(input, host, read = readCard, context = {}) {
  if (host !== "claude" && host !== "copilot") return {}
  const calls = host === "copilot" ? copilotToolCalls(input) : claudeToolCalls(input)
  if (calls.length === 0) return {}
  const cwd = typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd()
  const env = context.env ?? process.env
  const root = context.root === undefined ? boundRoot(env, cwd, host === "copilot" ? copilotProjectFolder(input, env, cwd) : undefined) : context.root
  const home = context.home ?? os.homedir()
  for (const call of calls) {
    const denied = decide(call, { root, cwd, home, read, host })
    if (denied !== null) return host === "copilot" ? copilotDeny(denied) : denied
  }
  return {}
}

/** The folder Copilot's `sessionStart` hook recorded for this session, which is the project folder the server binds, or else the session's current folder. */
function copilotProjectFolder(input, env, cwd) {
  return readCopilotSession({ env: { ...env, [COPILOT_SESSION_ENV]: input?.sessionId } })?.folder ?? cwd
}

/** The live, readable card `word` names when it is resolved against any of `bases` (absolute folders), or null. A card that no longer parses stays hand-repairable. */
function liveCardNamed(word, bases, { root, home, read }) {
  for (const base of bases) {
    const card = classifyCard(word, { root, cwd: base, home })
    if (card === null || card.kind !== "live") continue
    const existing = read(card.absolute)
    if (existing !== null && isReadableCard(existing)) return card
  }
  return null
}

/** `{ card, slug }` of every live card of the desk at `root` (and of each `desks/<alias>`), for a path a script builds in pieces. */
function liveCardsOf(root, home, read) {
  if (root === null) return []
  const folders = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".")).map((entry) => path.join(dir, entry.name))
    } catch {
      return []
    }
  }
  const found = []
  for (const base of [root, ...folders(path.join(root, "desks"))]) {
    for (const track of folders(base)) {
      for (const slug of folders(track)) {
        const card = liveCardNamed(path.join(slug, TASK_CARD_BASENAME), [root], { root, home, read })
        if (card !== null) found.push({ card, slug: path.basename(slug) })
      }
    }
  }
  return found
}

/** Whether git lists `file` as unmerged (a merge, cherry-pick or revert stopped on it): the one state where a checkout of a card is conflict resolution. */
function cardIsConflicted(file) {
  const result = spawnSync("git", ["-C", path.dirname(file), "ls-files", "-u", "--", path.basename(file)], { encoding: "utf8", timeout: 3000 })
  return result.status === 0 && result.stdout.trim() !== ""
}

/**
 * The deny for a `Bash` or `PowerShell` command that writes a live card of the bound desk (see `shell-card-writes.js` for the forms it reads and what
 * it cannot see), or `{}`. The words are resolved against the session folder, the desk and any folder the command moves into.
 */
function shellDecision(command, { root, cwd, home, read, host }) {
  if (typeof command !== "string") return null
  const resolve = (word, directories) => {
    const bases = [cwd, ...(root === null ? [] : [root]), ...directories.map((directory) => absolutePath(directory, { cwd, home }))]
    return liveCardNamed(word, bases, { root, home, read })
  }
  const vars = root === null ? { HOME: home } : { DESK: root, HOME: home }
  const conflicted = (card) => cardIsConflicted(card.absolute)
  const writes = shellCardWrites(command, { resolve, vars, conflicted, slugCards: () => liveCardsOf(root, home, read) })
  if (writes.length === 0) return null
  const [{ card, via }] = writes
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(card, null, via, host) } }
}

/** The desk root this session binds, or null when it cannot be determined (the marker fallback then applies). `hostProjectRoot` defaults to Claude's project folder. */
function boundRoot(env, cwd, hostProjectRoot = env.CLAUDE_PROJECT_DIR) {
  return resolveHookDeskRoot({ env, cwd, hostProjectRoot }).root
}

export { classifyCard, isReadableCard, statusOf, statusChange }
