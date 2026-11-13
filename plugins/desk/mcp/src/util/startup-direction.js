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

// The plugin's own folder, for the skills that name a script inside it (crew's join and start commands): this module lives at `<plugin>/mcp/src/util`, so the hooks (which load it from the plugin they run from) give the agent a path that works from any folder.
const PLUGIN_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

// Desk runs the session boot itself (runtime/startup-boot.js), so the agent is told what it will receive, never a command to run.
// A child agent with a bounded brief (dispatched with a scoped outcome, authority and return contract) is not the root operator's
// session, even when it receives this same startup text: the boot's instructions are not its brief, and Desk's tools work without
// them (desk_status needs no boot, and desk-web's browser_command and browser_context never read the desk). One sentence, because
// a child that had to guess between "follow the boot" and "follow my brief" stopped and blocked its parent.
export const BOOT_STAND_DOWN = "The boot's instructions are for the operator's session: a child agent with a bounded brief, or a session the operator told not to boot, follows its brief and ignores them."

// The agent's whole instruction about the boot. Acceptance rounds showed an agent answering "say hi" from a status-like line
// without the desk's state, so the line says the boot's result is not here yet and that nothing about the desk is known until it is.
export const START = `Desk runs the session boot itself, so there is nothing for you to run: its result (headed \`Desk boot\`) is in your context or comes with your next message or your first Desk tool reply. Until it arrives, say nothing about the desk's state. Desk's plugin folder is ${PLUGIN_FOLDER}. ${BOOT_STAND_DOWN}`

/**
 * The root the first-prompt hook may boot, or null: the root resolved the way `copilotStartupDirection` resolves it (the session folder as the project folder, the saved binding) must be a usable desk.
 * A folder that is no desk, with no binding and no home fallback, is setup mode or a repository the operator happens to be in, so it gets no boot; an unusable or unreadable binding gets none either, because the boot could not bind a desk there.
 */
export function copilotBootRoot({ env, sessionFolder, homeDir }) {
  const bound = resolveStartupRoot({ activationConfigPath: resolveActivationConfigPath({ env }), env, homeDir, hostProjectRoot: sessionFolder })
  return bound.root && !bound.unavailable && !bound.error ? bound.root : null
}

/** The same for Claude, where the server takes CLAUDE_PROJECT_DIR as the project folder. */
export function claudeBootRoot({ env, homeDir }) {
  return copilotBootRoot({ env, sessionFolder: env.CLAUDE_PROJECT_DIR, homeDir })
}

export const DESK_SETUP_DIRECTION =
  "Desk startup: no desk is bound yet, so Desk is in setup mode and no boot ran. Run the onboarding path desk_status names now — desk:first-run-bootstrap by default, which looks for an existing local desk, then the operator's desk repository on GitHub, and otherwise offers to create one; an overlay that owns its workspace names its own, such as crew:join-crew. Do not offer to continue without Desk. The next session start boots the desk you set up. " + BOOT_STAND_DOWN

function sourceLabel(source) {
  if (source === "host-project") return "the project folder"
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
  return `Desk startup: $DESK is ${root} (${sourceLabel(bound.source)}). ${START} An overlay that launches Desk with its own root binds that root instead; desk_status reports the root Desk actually bound; use it if they differ.`
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
