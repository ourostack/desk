// Whether a session has an operator in the conversation. The one rule the one-call boot and the session-start hooks
// both read, so a noninteractive session hears nothing the improvement loop would say to a person.

import { isHeadlessFactorySession } from "./headless-flag.js"

/**
 * True when no operator is in the conversation: a headless factory session, a headless Claude Code run
 * (`claude -p` sets `CLAUDE_CODE_ENTRYPOINT` to an `sdk-*` value, and `CLAUDE_CODE_SESSION_ATTENDED=0` marks an
 * unattended one) or a CI runner. A host that sets none of these is treated as interactive.
 */
export function isNoninteractive(env) {
  if (isHeadlessFactorySession(env)) return true
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT ?? "")
  const flagged = (name) => /^(1|true)$/iu.test(String(env[name] ?? ""))
  return entry.startsWith("sdk") || env.CLAUDE_CODE_SESSION_ATTENDED === "0" || flagged("CI") || flagged("GITHUB_ACTIONS")
}
