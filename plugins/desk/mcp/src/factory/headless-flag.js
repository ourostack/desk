// The one statement of the headless-session rule. A headless evaluator session (the plugin's own evaluator, started
// with DESK_FACTORY_HEADLESS set) is never captured, never starts the loop, gets no startup instructions and never
// changes desk state. Claude's print mode also sets CLAUDE_CODE_ENTRYPOINT=sdk-cli, which `isNoninteractive` already
// reads; this flag is the explicit, stronger mark. The hooks require the same rule from mcp/src/factory/headless-flag.cjs; the
// start hook's shell script repeats the test in one line, and a test holds the two together on every value.

import { createRequire } from "node:module"

export const HEADLESS_CODE = "headless_session"

// The only tools a headless session may call: the ones that read. Anything not named here, including a tool added
// later, is refused by default, so a new writing tool is covered without anyone remembering to list it.
export const READ_ONLY_TOOLS = Object.freeze(["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread", "desk_status", "desk_doctor", "desk_skill"])

/** True when `env.DESK_FACTORY_HEADLESS` is set and is not empty or `0`; the rule itself is `mcp/src/factory/headless-flag.cjs`. */
export const isHeadlessFactorySession = createRequire(import.meta.url)("./headless-flag.cjs").isHeadlessFactorySession

/** The refusal payload for `name` under the flag, or null when the call may go ahead. Carries no input text. */
export function headlessRefusal(name, env) {
  if (!isHeadlessFactorySession(env) || READ_ONLY_TOOLS.includes(name)) return null
  return { status: "refused", code: HEADLESS_CODE, tool: name, message: "This is a headless evaluator session: it never changes desk state. Only read tools are available." }
}
