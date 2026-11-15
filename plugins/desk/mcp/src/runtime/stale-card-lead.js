// Desk's own fallback for a session an always-on runtime does not watch (docs/stalled-nudges.md): a desk_status call made while the
// session's focused task card is unfinished and has gone quiet leads with the nudge, once per session. The session's focus is the one it
// declared in this process, else the last `task_focus` in its own history (a session resumed after an app restart has declared nothing
// yet). Each call starts the check in the background and reads the answer of the one before it, so desk_status never waits for a
// history that can run to hundreds of MB.
import * as path from "node:path"
import { personPrefix } from "../util/paths.js"
import { staleCardLead } from "./focused-card.js"
import { findFocus, sessionStateDir } from "./session-activity.js"

/** `{ lead() }`: the nudge text the first time a finished check had one, else null. `root()` and `person()` give the desk this session writes to now. */
export function createStaleCardLead({ env, focus, root, person, now = Date.now }) {
  let running = false
  let delivered = false
  let text = null
  let history = null
  const declared = async () => {
    const held = focus.get()
    if (held !== null || focus.declared()) return held
    const id = env.COPILOT_AGENT_SESSION_ID
    if (typeof id !== "string" || id === "") return null
    history ??= findFocus(path.join(sessionStateDir(env), id, "events.jsonl")).then((found) => found.focus)
    return history
  }
  const check = async () => {
    const task = await declared()
    if (task === null) return null
    const desk = root()
    return staleCardLead({ bases: [...new Set([personPrefix(desk, person()), desk])], focus: task, now: now() })
  }
  return {
    lead() {
      if (delivered) return null
      if (!running) {
        running = true
        check().then((found) => {
          text = found
        }, () => {
          text = null
        }).finally(() => {
          running = false
        })
      }
      if (text === null) return null
      delivered = true
      return text
    },
  }
}

/** The status answer with the nudge first, when there is one. */
export const withStaleCardLead = (answer, lead) => (lead === null ? answer : { nudge: lead, ...answer })
