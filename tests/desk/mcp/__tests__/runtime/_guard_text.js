// Helpers for tests that read a guard denial: its first sentence, and the reason without a suggested rewrite.

/** A denial's reason without the rewrite lines the guard puts in front of it, when it could name the exact command to run. */
export const REWRITE_LINES = /^(?:Run this instead: [^\n]*|Run the rewritten command below instead\.\nRewrite: [^\n]*)\n/u

/** The first sentence of a denial: up to its first line break, or its first sentence end (a period then a space, or the end of the text). */
export function firstSentence(reason) {
  const line = reason.split("\n")[0]
  const end = /\.(?:\s|$)/u.exec(line)
  return end === null ? line : line.slice(0, end.index + 1)
}

const VERBS = /^(?:Use|Run|Write|Split|Retry|Call|Commit|Restore|Delete|Create|Rebase|Pull|Fetch|Make|Add|Leave|Unstage|Remove|Set|Keep|Converse|Record|Restate|Report|Resolve|Say|Quote)\b/u
const COMMANDS = /^(?:git |task_update|mcp__|desk-|\$)/u

/**
 * The rule every Desk denial follows: its first sentence is at most 120 characters, and starts with an imperative verb or with the
 * command to run. Hosts cut a denial at about one line, so that sentence is the fix the agent sees.
 */
export function assertActionable(assert, reason, label = reason) {
  assert.equal(typeof reason, "string", `${label}: a denial is text`)
  const first = firstSentence(reason)
  assert.ok(first.length <= 120, `${label}: the first sentence is ${first.length} characters, over 120: ${first}`)
  assert.ok(VERBS.test(first) || COMMANDS.test(first), `${label}: the first sentence must start with an imperative verb or the command to run: ${first}`)
}
