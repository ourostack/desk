// The `Desk startup:` line both startup hooks append after the using-desk
// foundation. It never states a single root the Desk server will not use.
//
// On Claude the server receives the project folder (CLAUDE_PROJECT_DIR), so
// the hook and the server resolve the same root and the line names it. On
// Copilot the plain Desk server gets no session folder; only an overlay
// launcher that starts Desk with `--root` binds it. So when the session folder
// is a desk that plain Desk would not bind, the line names both roots and says
// desk_status reports the one actually bound.

import * as path from "node:path"

import {
  DESK_ROOT_NOT_FOUND,
  isDeskWorkspace,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "./paths.js"

const START = "Invoke desk:session-start now for the authoritative workspace scan before other work."

export const DESK_SETUP_DIRECTION =
  "Desk startup: no desk is bound yet, so Desk is in setup mode. Run the onboarding path desk_status names now — desk:first-run-bootstrap by default, which looks for an existing local desk, then the operator's desk repository on GitHub, and otherwise offers to create one; an overlay that owns its workspace names its own, such as crew:join-crew. Do not offer to continue without Desk. After setup, desk:session-start remains the authoritative workspace scan."

function sourceLabel(source) {
  if (source === "host-project") return "this session's project folder is a desk"
  if (source === "activation-config") return "the saved desk binding"
  if (source === "env:DESK") return "the DESK environment variable"
  if (typeof source === "string" && source.startsWith("fallback:")) return "a home-folder fallback"
  return "the root passed to Desk"
}

// Resolve the root the Desk server would bind, keeping "no desk anywhere"
// (setup mode) apart from a configuration the hook could not read.
export function resolveStartupRoot(options) {
  try {
    const { root, source } = resolveDeskRootWithSource(options)
    return { root, source }
  } catch (error) {
    return error.code === DESK_ROOT_NOT_FOUND ? { root: null } : { root: null, error: error.message }
  }
}

// `bound` is what the Desk server binds without an overlay; `sessionDesk` is
// the session folder when it is itself a desk and only an overlay binds it.
export function deskStartupDirection(bound, { sessionDesk = null } = {}) {
  const root = bound?.root ?? null
  if (bound?.error) {
    const overlay = sessionDesk
      ? ` This session's folder ${sessionDesk} is a desk; an overlay that launches Desk in this folder binds it.`
      : ""
    return `Desk startup: Desk's root configuration could not be read (${bound.error}), so this hook cannot say which desk is bound. desk_status reports the actual state.${overlay} ${START}`
  }
  if (sessionDesk && sessionDesk !== root) {
    const plain = root
      ? `binds ${root} (${sourceLabel(bound.source)})`
      : "has no desk bound and starts in setup mode"
    return `Desk startup: this session's folder ${sessionDesk} is a desk, but Desk without an overlay ${plain}; an overlay that launches Desk in this folder binds ${sessionDesk} instead. desk_status reports the root Desk actually bound, and it wins. ${START}`
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

// Copilot: resolve what the plain server binds (no project folder), then say
// separately whether the session folder is a desk that only an overlay binds.
export function copilotStartupDirection({ env, sessionFolder, homeDir }) {
  const bound = resolveStartupRoot({ activationConfigPath: resolveActivationConfigPath({ env }), env, homeDir })
  const sessionDesk = isDeskWorkspace(sessionFolder) ? path.resolve(sessionFolder) : null
  return deskStartupDirection(bound, { sessionDesk })
}
