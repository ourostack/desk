// Values the shell inspectors cannot compute without running something. An unknown value
// contains UNKNOWN; one computed by text that could itself run Git also carries
// UNKNOWN_GIT. The guard fails closed on an unknown value only where it could decide a Git
// operation: an unknown program whose text could be Git, an unknown eval/source/shell -c
// script, or an unknown directory or operand of a Git operation the guard must check.
export const UNKNOWN = "\0"
export const UNKNOWN_GIT = "\0\x01"
// The own-worktree form denials name. It runs as written in Bash and in PowerShell, and both guards allow it.
// Only denials of real HEAD moves, rewrites or discards name it; the desk's ordinary writes are never sent to a worktree.
export const WORKTREE_COMMAND = 'git worktree add --detach "$HOME/<new directory>" <ref>'

/** A decided denial: inspection stops and the hook reports `reason`. */
export class GuardDenial extends Error {
  /** `rewritable` marks a denial whose command a PowerShell rewrite may fix (see `powershell-rewrite.js`). */
  constructor(reason, { rewritable = false } = {}) {
    super(reason)
    this.reason = reason
    this.rewritable = rewritable
  }
}

/** A denial for a rule of a protected checkout: the message opens with the fix, and the checkout comes last. */
export function protectedDenial(target, message) {
  return `${message} Desk protects this checkout: ${target}`
}

const GIT_WORD = /(?<![\w.-])git(?!\w)/iu
const CODE_RUNNERS = /(?<![\w.-])(?:eval|source|iex|invoke-expression)(?![\w-])|(?:^|[;&|({\n])\s*\.\s/iu

/** Whether shell text could reach Git: it names `git` (quotes and escapes removed), or evaluates or sources code. */
export function mayInvokeGit(text) {
  const plain = text.replace(/[`'"\\]/gu, "")
  return GIT_WORD.test(plain) || CODE_RUNNERS.test(plain)
}

/** Whether PowerShell text names `git` as a word (`git`, `git.exe`, a path ending in either), ignoring quotes and backticks. */
export function namesGit(text) {
  return GIT_WORD.test(text.replace(/[`'"]/gu, ""))
}

// One command's inspection shares a step budget and the deadline its Git reads use. Running out of either
// denies the command with a reason that names the budget; inspection yields every few hundred steps so the
// hook's own 9 s answer can always fire.
export const INSPECTION_STEPS = 20000

export function inspectionBudget({ steps = INSPECTION_STEPS, deadline = Infinity, now = Date.now, budgetMs = 0 } = {}) {
  let used = 0
  return {
    async step() {
      used++
      if (used > steps) throw new GuardDenial(`Split the command into shorter commands. Desk stopped inspecting it after ${steps} steps, so it is denied to keep a protected checkout safe.`)
      if (now() > deadline) throw new GuardDenial(`Split the command into shorter commands. Desk could not finish inspecting it within its ${budgetMs / 1000} s budget, so it is denied to keep a protected checkout safe.`)
      if (used % 256 === 0) await new Promise((resolve) => { setImmediate(resolve) })
    },
  }
}

/** A value that differs between reachable states: unknown, and could-be-Git when any candidate could run Git. */
export function mergedValue(...values) {
  return values.some((value) => value !== undefined && (value.includes(UNKNOWN_GIT) || mayInvokeGit(value))) ? UNKNOWN_GIT : UNKNOWN
}

/** The marker for output computed by `text`. */
export function unknownOutput(text) {
  return mayInvokeGit(text) ? UNKNOWN_GIT : UNKNOWN
}

/** `fix` is the first sentence: what to write instead, with the agent's own operation where there is one. */
export function unresolved(what, fix = "Write the value literally, or set it in a separate command first.") {
  return new GuardDenial(`${fix} Desk could not resolve ${what}, and it could run Git in a protected checkout; plain read-only Git (status, log, diff, fetch into remote-tracking refs) is not blocked.`)
}
