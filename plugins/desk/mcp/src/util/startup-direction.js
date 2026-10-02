// The `Desk startup:` line both startup hooks append after the using-desk
// foundation. It never states a single root the Desk server will not use.
//
// On Claude the server receives the project folder (CLAUDE_PROJECT_DIR), so
// the hook and the server resolve the same root and the line names it. On
// Copilot the server receives no session folder, so the `sessionStart` hook
// records it for the session (runtime/copilot-session.js) and the server reads
// that record: the hook resolves with the session folder as the project folder,
// exactly as the server will. Only an overlay launcher that starts Desk with
// `--root` can bind a different root, which the closing sentence of the line
// covers.

import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  DESK_ROOT_NOT_FOUND,
  DESK_ROOT_UNAVAILABLE,
  HOME_FALLBACK,
  OVERLAY_HOME_FALLBACK,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "./paths.js"
import { redactCredentialLikeText } from "./redact.js"

// The boot script, by its absolute path: this module lives at `<plugin>/mcp/src/util`, so the hooks (which load it from
// the plugin they run from) hand the agent a command that works from any folder, with nothing to derive.
const BOOT_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "session-boot.js")

/** The boot command exactly as an agent runs it; a path with a space is quoted. */
export function bootCommand(script = BOOT_SCRIPT) {
  return `node ${/\s/u.test(script) ? `"${script}"` : script}`
}

// A child agent with a bounded brief (dispatched with a scoped outcome, authority and return contract) is not the
// root operator's session, even when it receives this same startup text; it stands down from this imperative and
// follows its brief, the same way Superpowers' own entry skill stands its subagents down (equivalent to
// `using-superpowers`'s `<SUBAGENT-STOP>`). Folded into `START` so every branch below carries it exactly once.
//
// Boot acceptance round A: an agent answered "say hi" from this line alone and never ran the boot, because the line
// reads like a finished status. So it says in its own words that the boot has not run, gives the exact command, and
// calls the `Desk boot pre-checks:` line (when present) a pre-check, not the boot, without spelling its prefix so a hook with no such line never mentions one.
export function startDirection(command = bootCommand()) {
  return `The boot has not run yet: this line and any pre-check line after it are a pointer and a few quick checks, not a scan of the workspace. Run \`${command}\` now, before other work and before anything else, including your first reply and any search of files or folders (add \`--task "<what the operator named>"\` when their first message names a task). Nothing else counts as the boot: searching for the desk, a task or a repo yourself is not a substitute, and a reply before the boot has run is wrong. Then do what its \`instructions\` say; \`desk:session-start\` explains the result. A child agent with a bounded brief follows the brief instead and skips this.`
}
const START = startDirection()

// Copilot weighs sessionStart context lightly: on a bare greeting the model answered without booting (boot acceptance rounds F and G), while the same imperative delivered as `userPromptSubmitted` context, next to the message itself, was followed every time it was probed. So the first prompt of each session carries this shorter line, worded as a pointer rather than a claim about the boot's state (see hooks/copilot-boot-prompt.cjs).
export function promptBootDirection(command = bootCommand()) {
  return `Desk boot is pending for this session: run \`${command}\` first (one quick call), then answer this message. Do this before anything else, including any search of files or folders; nothing else counts as the boot. A child agent with a bounded brief skips this.`
}

/**
 * The pointer for a Copilot first prompt, or null when there is nothing to point at: the root resolved the way `copilotStartupDirection` resolves it (the session folder as the project folder, the saved binding) must be a usable desk.
 * A folder that is no desk, with no binding and no home fallback, is setup mode or a repository the operator happens to be in, so it gets no pointer; an unusable or unreadable binding gets none either, because the boot script could not run there.
 */
export function copilotPromptPointer({ env, sessionFolder, homeDir }) {
  const bound = resolveStartupRoot({ activationConfigPath: resolveActivationConfigPath({ env }), env, homeDir, hostProjectRoot: sessionFolder })
  return bound.root && !bound.unavailable && !bound.error ? promptBootDirection() : null
}

export const DESK_SETUP_DIRECTION =
  "Desk startup: no desk is bound yet, so Desk is in setup mode and the boot has not run. Run the onboarding path desk_status names now — desk:first-run-bootstrap by default, which looks for an existing local desk, then the operator's desk repository on GitHub, and otherwise offers to create one; an overlay that owns its workspace names its own, such as crew:join-crew. Do not offer to continue without Desk. After setup, run the boot script (" + bootCommand() + ") for the authoritative workspace scan. A child agent with a bounded brief follows the brief instead and skips this."

function sourceLabel(source) {
  if (source === "host-project") return "this session's project folder is a desk"
  if (source === "activation-config") return "the saved desk binding"
  if (source === "env:DESK") return "the DESK environment variable"
  if (source === HOME_FALLBACK) return "a home-folder fallback"
  if (source === OVERLAY_HOME_FALLBACK) return "the home-folder desk of a work overlay loaded in this session"
  return "the root passed to Desk"
}

// Resolve the root the Desk server would bind, keeping "no desk anywhere"
// (setup mode) apart from a configuration the hook could not read.
export function resolveStartupRoot(options) {
  try {
    const { root, source } = resolveDeskRootWithSource(options)
    return { root, source }
  } catch (error) {
    if (error.code === DESK_ROOT_NOT_FOUND) return { root: null }
    if (error.code === DESK_ROOT_UNAVAILABLE) return { root: null, unavailable: { path: error.path, source: error.source, message: error.message } }
    return { root: null, error: error.message }
  }
}

// `bound` is what the Desk server binds without an overlay.
// The line reaches every session's context and transcript, so a path segment
// that carries a secret's value is redacted; desk_status still reports the
// real root to the agent that needs it.
export function deskStartupDirection(bound) {
  return redactCredentialLikeText(composeStartupDirection(bound))
}

function composeStartupDirection(bound) {
  const root = bound?.root ?? null
  if (bound?.error) {
    return `Desk startup: Desk's root configuration could not be read (${bound.error}), so this hook cannot say which desk is bound. desk_status reports the actual state. ${START}`
  }
  if (bound?.unavailable) {
    const remedy = bound.unavailable.source === "env:DESK"
      ? "restore the desk there, or correct or unset DESK and reconnect the Desk MCP server"
      : "restore the desk there, or rebind with desk:first-run-bootstrap"
    return `Desk startup: Desk cannot use the desk it is bound to (${bound.unavailable.message}) desk_status reports root_unavailable with the fix (${remedy}), and Desk recovers in place once the folder exists. ${START}`
  }
  if (!root) return DESK_SETUP_DIRECTION
  return `Desk startup: $DESK is ${root} (${sourceLabel(bound.source)}). ${START} An overlay that launches Desk with its own root binds that root instead; desk_status reports the root Desk actually bound, so use that root if the two differ.`
}

// Claude: the server takes CLAUDE_PROJECT_DIR as the project folder, so one
// resolution with it is the root the server binds.
export function claudeStartupDirection({ env, homeDir }) {
  return deskStartupDirection(resolveStartupRoot({
    activationConfigPath: resolveActivationConfigPath({ env }),
    env,
    homeDir,
    hostProjectRoot: env.CLAUDE_PROJECT_DIR,
  }))
}

// Copilot: the server takes the session folder the `sessionStart` hook recorded
// as its project folder, so one resolution with it is the root the server binds.
export function copilotStartupDirection({ env, sessionFolder, homeDir }) {
  return deskStartupDirection(resolveStartupRoot({
    activationConfigPath: resolveActivationConfigPath({ env }),
    env,
    homeDir,
    hostProjectRoot: sessionFolder,
  }))
}
