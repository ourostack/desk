// Which desk the loop may write this machine's findings into.
//
// The route step opens a card for each open andon, failing store build and Desk problem (all read from GitHub for this
// machine's consenting accounts) and for this machine's own status; the measure step opens a card for each loop alarm.
// None of these belong to the desk a session happens to be bound to: before, a session opened in a project or
// throwaway desk received every one of them, one commit each, while the session was writing to the same desk.
//
// They go only to the person's own desk: the desk Desk binds from the person's own settings, without the session's
// project folder (an explicit saved binding, then $DESK, then the home-folder fallbacks; `util/paths.js`). A session
// bound to any other desk leaves these steps alone, and the person's desk gets the cards at its next loop run.
// A person with none of those settings has no own desk, and these cards wait until one exists.

import { realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { resolveActivationConfigPath, resolveDeskRootWithSource } from "../util/paths.js"

const canonical = (folder) => {
  try {
    return realpathSync(folder)
  } catch {
    return path.resolve(folder)
  }
}

/** The person's own desk for `env`, or null when their settings name none (or name one that cannot be used). Never throws. */
export function ownDesk(env, { homeDir = env?.HOME || os.homedir(), resolve = resolveDeskRootWithSource } = {}) {
  try {
    const { root } = resolve({ env, activationConfigPath: resolveActivationConfigPath({ env }), homeDir, deskPluginRoot: env?.DESK_PLUGIN_ROOT })
    return typeof root === "string" ? canonical(root) : null
  } catch {
    return null
  }
}

/** Whether `deskRoot` is the person's own desk, so the loop may write this machine's findings there. */
export function isOwnDesk(env, deskRoot, options) {
  const own = ownDesk(env, options)
  return own !== null && typeof deskRoot === "string" && own === canonical(deskRoot)
}
