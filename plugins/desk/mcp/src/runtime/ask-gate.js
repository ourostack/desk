// A noninteractive first-run-bootstrap session (for example `claude -p`) has
// no human to answer A3's "ask once" gate, so prose alone cannot stop it from
// picking a desk on its own, binding it, and reporting completion: two real
// `claude -p --model haiku` reproductions against the strengthened wording
// still did exactly that (`~/.local/state/desk-evidence/eng-workflow-v2/
// wrapup/ask-gate/raw/NOTES.md`). This hook is the mechanical backstop: it
// denies the specific write that performs the bind, but only when it can
// positively confirm nobody can answer, so it never has an opinion about an
// interactive session.
//
// The noninteractive signal is CLAUDE_CODE_SESSION_ATTENDED, an environment
// variable Claude Code's own engine sets on itself (confirmed by inspecting
// the hook subprocess's own `process.env`, not by anything in the hook's
// JSON stdin, and confirmed not to originate from any wrapper this repo
// controls). It is not documented in Claude Code's public hooks reference,
// so it is read narrowly and defensively: only the literal string "0" is
// read as "confirmed nobody is attending"; anything else -- "1", an
// unexpected value, or the variable being absent entirely (an older Claude
// Code build, a different host, Copilot) -- is read as "cannot confirm
// noninteractive" and allowed through untouched. Evidence, 2026-09-28,
// Claude Code 2.1.283: a live attended TUI/agent session reports "1";
// `claude -p --model haiku --dangerously-skip-permissions --output-format
// json "<prompt>" < /dev/null` (the exact form the ask-gate reproduction
// used) and a bare `claude "<prompt>"` with non-TTY stdin and no explicit
// -p both report "0". No Claude Code documentation describes a `permission_mode`,
// TTY, or hook-payload field that distinguishes print/headless from
// interactive sessions (a hook's own stdin is always a piped JSON payload,
// never a real TTY, in both cases), so this environment variable is the only
// signal found; see the evidence trail linked from this change's changelog
// fragment for the research that ruled the alternatives out.
//
// The gate denies every matching write while unattended, whether or not a
// binding already exists, and does not special-case "already bound" as a
// rebind a human is driving. Once the session is confirmed unattended
// (line below), an existing target file cannot mean a human is at the
// keyboard approving a rebind: a real interactive rebind never reaches this
// branch at all (the attendance check above already let it through), and a
// driver that needs to write this file itself runs from its own shell,
// outside the model and outside this hook entirely. An earlier version of
// this gate exempted an already-bound target; an independent review of this
// change found that exemption allowed exactly the write that caused this
// change's own live-proof incident (2026-09-28): a throwaway-profile
// session's Write/Edit tool resolved a mis-typed `~`-relative path to the
// operator's real, already-bound activation file. The gate now matches
// purely on path shape for Write/Edit -- any `.../plugins/data/<plugin-id>/
// desk.activation.json`, not only this session's own CLAUDE_PLUGIN_DATA --
// with no existence check at all.

import * as path from "node:path"

const ATTENDED_ENV = "CLAUDE_CODE_SESSION_ATTENDED"
const CONFIRMED_UNATTENDED = "0"
const GATED_TOOLS = new Set(["Write", "Edit", "Bash", "PowerShell"])
const ACTIVATION_FILENAME = "desk.activation.json"

// Best-effort only, unlike protected-checkout's real shell-command inspector.
// Deny-by-default: once the filename appears in the command text, the
// command is denied unless every `;`/`&&`/`||`/`|`-separated segment is
// plainly one of a short read-only allowlist, with none of the tokens that
// can still smuggle a write through a read-shaped command name (a redirect,
// `-i`/`-c`/`-e` in-place-or-inline-code flags, `tee`, `of=`, or the
// PowerShell write cmdlets). Denying a legitimate read is a minor cost (the
// noninteractive session reports it cannot proceed and stops); allowing an
// unrecognized write-shaped command through is the failure this hook exists
// to prevent, so the default leans toward denying.
const READ_ONLY_SEGMENT = /^(?:cat|head|tail|grep|jq|ls|stat|test\s+-f|\[\s+-f|Get-Content|Test-Path|Get-Item)\b/iu
const RISKY_TOKEN_PATTERN = /(>>?(?!=)|(?:^|\s)-i\b|\btee\b|\bof=|(?:^|\s)-c\b|(?:^|\s)-e\b|Set-Content|Out-File|Add-Content)/iu

function shellCommandTargets(command) {
  if (typeof command !== "string" || !command.includes(ACTIVATION_FILENAME)) return false
  if (RISKY_TOKEN_PATTERN.test(command)) return true
  // The filename check above guarantees at least one non-separator segment,
  // so every() below always has something to evaluate.
  const segments = command.split(/&&|\|\||[;|]/u).map((segment) => segment.trim()).filter(Boolean)
  return !segments.every((segment) => READ_ONLY_SEGMENT.test(segment))
}

// Only called once the caller already knows the tool is Write or Edit.
function writeTargetPath(toolInput, cwd) {
  if (typeof toolInput?.file_path !== "string") return null
  return path.resolve(cwd ?? process.cwd(), toolInput.file_path)
}

// True for `.../plugins/data/<any plugin id>/desk.activation.json`, the
// shape Claude Code gives every plugin's activation file under any config
// dir -- not only this session's own. Deliberately structural rather than a
// bare filename match, so an unrelated file that happens to share the name
// (for example a test fixture) does not collide with it.
function looksLikeClaudeActivationPath(resolvedPath) {
  if (path.basename(resolvedPath) !== ACTIVATION_FILENAME) return false
  const pluginDir = path.dirname(resolvedPath)
  const dataDir = path.dirname(pluginDir)
  return path.basename(dataDir) === "data" && path.basename(path.dirname(dataDir)) === "plugins"
}

// `input` is the hook's JSON stdin (never carries env). `env` defaults to
// this process's own environment -- the attendance signal lives there, set
// by the Claude Code engine on the hook subprocess, never in the payload.
export async function askGateHook(input, host, env = process.env) {
  // No validated noninteractive signal exists for any host but Claude Code
  // today (CLAUDE_CODE_SESSION_ATTENDED is Claude Code's own variable); a
  // future host gets this gate only once the same evidence exists for it.
  if (host !== "claude") return {}
  const name = String(input?.tool_name ?? input?.toolName ?? "")
  if (!GATED_TOOLS.has(name)) return {}
  if (env?.[ATTENDED_ENV] !== CONFIRMED_UNATTENDED) return {}

  let args = input.tool_input ?? input.toolArgs
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      return {}
    }
  }
  if (!args || typeof args !== "object") return {}

  if (name === "Write" || name === "Edit") {
    const resolved = writeTargetPath(args, input.cwd)
    if (resolved === null) return {}
    if (!looksLikeClaudeActivationPath(resolved)) return {}
  } else {
    if (!shellCommandTargets(args.command)) return {}
  }

  const reason = "Report the desk-binding question to the human and stop; do not pick or bind a desk yourself. "
    + `Desk ask-gate: this session reports nobody attending (${ATTENDED_ENV}=${CONFIRMED_UNATTENDED}). `
    + "Binding or rebinding a desk is the consequential, irreversible choice first-run-bootstrap's A3 step "
    + "(and SETUP.md step 5) require asking a human about. Include everything A1 and A2 found, "
    + "and do not retry around this gate or report bootstrap as complete."
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
}
