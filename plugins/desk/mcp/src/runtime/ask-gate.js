// A noninteractive first-run-bootstrap session (for example `claude -p`) has
// no human to answer A3's "ask once" gate, so prose alone cannot stop it from
// picking a desk on its own, binding it, and reporting completion: two real
// `claude -p --model haiku` reproductions against the strengthened wording
// still did exactly that (`~/.local/state/desk-evidence/eng-workflow-v2/
// wrapup/ask-gate/raw/NOTES.md`). This hook is the mechanical backstop: it
// denies the specific write that performs the bind, but only when it can
// positively confirm both that nobody can answer and that no desk is bound
// yet, so it never has an opinion about an interactive session or a rebind.
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

import { existsSync } from "node:fs"
import * as path from "node:path"
import { claudeBindingPath } from "../util/paths.js"

const ATTENDED_ENV = "CLAUDE_CODE_SESSION_ATTENDED"
const CONFIRMED_UNATTENDED = "0"
const GATED_TOOLS = new Set(["Write", "Edit", "Bash", "PowerShell"])

// Best-effort only, unlike protected-checkout's real shell-command inspector:
// a false negative here just leaves today's prose-only rule as the only
// backstop, while a false positive would deny a legitimate write elsewhere,
// so this only fires when the exact filename and a write-shaped pattern are
// both present in the command text.
const SHELL_WRITE_PATTERN = /(>>?(?!=)|\btee\b|\bcp\b|\bmv\b|\bdd\s+of=|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item)/iu

function shellCommandTargets(command, filename) {
  if (typeof command !== "string" || !command.includes(filename)) return false
  return SHELL_WRITE_PATTERN.test(command)
}

function writeTargetPath(toolName, toolInput, cwd) {
  if (toolName !== "Write" && toolName !== "Edit") return null
  if (typeof toolInput?.file_path !== "string") return null
  return path.resolve(cwd ?? process.cwd(), toolInput.file_path)
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

  const target = claudeBindingPath(env)
  if (target === null) return {} // can't compute the real binding path: fail open
  if (existsSync(target)) return {} // already bound: never block a rebind a human drives

  let args = input.tool_input ?? input.toolArgs
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      return {}
    }
  }
  if (!args || typeof args !== "object") return {}

  const filename = path.basename(target)
  const hit = name === "Write" || name === "Edit"
    ? writeTargetPath(name, args, input.cwd) === target
    : shellCommandTargets(args.command, filename)
  if (!hit) return {}

  const reason = "Desk ask-gate: this session reports nobody attending "
    + `(${ATTENDED_ENV}=${CONFIRMED_UNATTENDED}) and no desk is bound yet. `
    + "Binding a desk is the consequential, irreversible choice first-run-bootstrap's A3 step "
    + "(and SETUP.md step 5) require asking a human about. Report that question, plus everything "
    + "A1 and A2 found, and stop -- do not retry around this gate, pick a desk on your own, or "
    + "report bootstrap as complete."
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
}
