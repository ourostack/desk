// Values the shell inspectors cannot compute without running something. An unknown value
// contains UNKNOWN; one computed by text that could itself run Git also carries
// UNKNOWN_GIT. The guard fails closed on an unknown value only where it could decide a Git
// operation: an unknown program whose text could be Git, an unknown eval/source/shell -c
// script, or an unknown directory or operand of a Git operation the guard must check.
export const UNKNOWN = "\0"
export const UNKNOWN_GIT = "\0\x01"
export const WORKTREE_COMMAND = 'git worktree add --detach "$(mktemp -d)" <ref>'

/** A decided denial: inspection stops and the hook reports `reason`. */
export class GuardDenial extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

const GIT_WORD = /(?<![\w.-])git(?!\w)/iu
const CODE_RUNNERS = /(?<![\w.-])(?:eval|source|iex|invoke-expression)(?![\w-])|(?:^|[;&|({\n])\s*\.\s/iu

/** Whether shell text could reach Git: it names `git` (quotes and escapes removed), or evaluates or sources code. */
export function mayInvokeGit(text) {
  const plain = text.replace(/[`'"\\]/gu, "")
  return GIT_WORD.test(plain) || CODE_RUNNERS.test(plain)
}

/** The marker for output computed by `text`. */
export function unknownOutput(text) {
  return mayInvokeGit(text) ? UNKNOWN_GIT : UNKNOWN
}

export function unresolved(what) {
  return new GuardDenial(`Desk could not resolve ${what}, and it could run Git in a protected checkout. Resolve the value in a separate command first, or work in your own worktree: ${WORKTREE_COMMAND}`)
}
