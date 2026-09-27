// What Git may do in a protected checkout (Desk 3.2 ruling for task A3b, narrowed on 2026-09-27).
// The guard denies only what moves a protected checkout's HEAD off its state branch, rewrites
// pushed history, or discards work; everything else passes: status, log, diff, fetch, add, rm,
// mv, commit, path-limited unstaging, non-force pushes, merges, pulls and rebases onto the
// branch's own upstream, and worktree add. `classifyGit` needs no Git reads; it returns
// null (allowed anywhere), or a check that reads the target checkout through `ctx`.
// Rules that trust Git's configuration (push, pull, rebase, fetch, merge) are denied when a
// command-line or environment override changes that configuration, and `git config` or
// `git branch -u` cannot rewrite it on the protected checkout first.
import { hasOption, parseGitOptions, SPECS } from "./git-guard-options.js"
import { WORKTREE_COMMAND } from "./guard-unknowns.js"

const WORKTREE = `use your own worktree: ${WORKTREE_COMMAND}`
export const MESSAGES = {
  leave: `this would move HEAD off the checkout's branch. To leave the state branch, ${WORKTREE}`,
  discard: `this would discard other sessions' uncommitted work. Commit your own changes instead, or ${WORKTREE}`,
  rewind: `this would move the checkout's branch to another commit. Add a new commit (for example git revert) instead, or ${WORKTREE}`,
  restore: `restoring from another commit or into the index overwrites other sessions' changes. Restore files in ${WORKTREE.replace("use ", "")}`,
  clean: "git clean deletes untracked files other sessions may own. Delete only files you created, by name",
  stash: "git stash hides other sessions' work; commit or leave it",
  branch: `this would force-move, rename or delete the checkout's current or state branch. Create a new branch instead, or ${WORKTREE}`,
  rebase: `a rebase onto anything but the branch's own upstream can rewrite pushed commits. Rebase onto the upstream (git rebase, or git pull --rebase), or for --onto, --root, --exec, --quit or another base, ${WORKTREE}`,
  pull: `git pull --rebase from anything but the branch's own upstream can rewrite pushed commits. Pull the upstream (git pull --rebase), merge the other branch instead (git pull --no-rebase <remote> <branch>), or ${WORKTREE}`,
  noUpstream: "this rebase has no upstream of the branch's own name (<remote>/<branch>) to replay onto, so it could rewrite pushed commits. If HEAD is detached, switch back first (git switch <state branch>); otherwise set the upstream (git branch -u <remote>/<branch>), or merge instead (git pull --no-rebase)",
  autostash: "--autostash stashes, which hides other sessions' work; commit or leave it",
  pushForce: "force, mirror, delete and prune pushes can discard work on the remote. Fetch, rebase onto the upstream (git pull --rebase) and push without them",
  amend: "the commit you would amend is already pushed; make a new commit instead",
  worktreeRemove: "git worktree remove --force would delete a protected checkout and its uncommitted work. Remove only worktrees you created, without --force",
  prune: "git worktree prune can drop other sessions' worktree records; leave them, or run it with --dry-run",
  unstage: `unstaging changes the shared index, which can hold other sessions' staged work. Unstage only your own paths (git restore --staged <paths>), or commit only your own paths (git commit <paths>)`,
  fetch: "fetching into the checkout's own branch rewrites it like a reset; fetch into remote-tracking refs (git fetch origin) instead",
  upstream: "this would point the checkout's branch at an upstream of another name, so a later git pull --rebase could rewrite pushed commits. Keep <remote>/<branch> (git branch -u <remote>/<branch>)",
  config: (key) => `this would change ${key}, which decides what push, pull, rebase, aliases or this guard do in the shared checkout. Leave it`,
  override: (key, operation) => `the configuration override ${key} changes what this git ${operation} does. Run it without the override`,
  variable: `Desk cannot tell what a PowerShell variable passes to this Git command, and a variable can hold options such as --force or several arguments. Write the value literally`,
}

// Keys whose value changes what the configuration-trusting rules decide, or what the guard reads.
const OVERRIDDEN = /^(?:remote\..+\.(?:mirror|push|fetch|url|pushurl|tagopt)|push\..+|branch\..+\.(?:merge|remote|rebase|pushremote)|rebase\..+|pull\..+|merge\..+|fetch\..+|url\..+\.(?:insteadof|pushinsteadof))$/u
const CONFIG_SECTIONS = new Set(["desk", "alias", "include", "includeif", "remote", "push", "branch", "rebase", "pull", "merge", "fetch", "url"])
const OVERRIDE_OPERATIONS = new Set(["push", "pull", "rebase", "fetch", "merge"])

/** Git's canonical form of a configuration key: section and variable lowercased, subsection kept. */
export function canonicalKey(key) {
  const first = key.indexOf("."), last = key.lastIndexOf(".")
  if (first < 0) return key.toLowerCase()
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`
}

export function isTrue(value) {
  return value !== undefined && /^(?:|true|yes|on|1)$/iu.test(value)
}

const ALLOWED_BISECT = new Set(["log", "view", "visualize", "help", "terms"])
const any = (parsed, names) => names.some((name) => hasOption(parsed, name))
const fixed = (reason) => async () => reason
// A check that is safe in any checkout, even a protected one on its state branch: an unknown target does not deny it.
const anywhere = (check) => Object.assign(check, { anywhere: true })
const lastOf = (parsed, names) => parsed.sequence.filter((entry) => names.includes(entry.name)).at(-1)
const beforeDashDash = (parsed) => parsed.dashdash < 0 ? parsed.operands : parsed.operands.slice(0, parsed.dashdash)

// The checkout's current branch or its state branch. Switching to either keeps HEAD where it belongs.
async function ownBranch(ctx, name) {
  return name === await ctx.branch() || name === await ctx.stateBranch()
}

function protectedBranch(ctx, name) {
  return ownBranch(ctx, ctx.known(name, "a branch name").replace(/^refs\/heads\//u, ""))
}

// The current branch's configured upstream, only when it is <remote>/<the same name>: replaying onto it rewrites only
// commits that are not pushed there yet.
async function ownUpstream(ctx) {
  const own = await ctx.upstream()
  return own !== null && own.merge === `refs/heads/${await ctx.branch()}` ? own : null
}

function checkout(args) {
  const parsed = parseGitOptions(SPECS.checkout, args)
  if (any(parsed, ["-b", "-B", "orphan", "detach"])) return fixed(MESSAGES.leave)
  const refs = beforeDashDash(parsed), force = hasOption(parsed, "force")
  // `checkout -- <paths>` restores from the index like plain `git restore`.
  if (parsed.dashdash >= 0 || hasOption(parsed, "pathspec-from-file")) return refs.length ? fixed(MESSAGES.restore) : null
  if (!refs.length) return force ? fixed(MESSAGES.discard) : null
  return async (ctx) => {
    const [target] = refs
    if (refs.length === 1 && await ownBranch(ctx, target)) return force ? MESSAGES.discard : null
    // Git takes the first operand as a commit when it names one, or a remote branch it can guess.
    if (target === "-" || await ctx.commit(target) || await ctx.remoteBranch(target)) return refs.length > 1 ? MESSAGES.restore : MESSAGES.leave
    return null
  }
}

function switchBranch(args) {
  const parsed = parseGitOptions(SPECS.switch, args)
  if (any(parsed, ["create", "force-create", "orphan", "detach"])) return fixed(MESSAGES.leave)
  const [target] = parsed.operands
  if (target === undefined) return null
  const discard = any(parsed, ["force", "discard-changes"])
  return async (ctx) => await ownBranch(ctx, target) ? (discard ? MESSAGES.discard : null) : MESSAGES.leave
}

function reset(args) {
  const parsed = parseGitOptions(SPECS.reset, args)
  const mode = lastOf(parsed, ["mixed", "soft", "hard", "merge", "keep"])?.name
  if (["hard", "merge", "keep"].includes(mode)) return fixed(MESSAGES.discard)
  const refs = beforeDashDash(parsed)
  // Path-limited unstaging (`git reset [<commit>] -- <paths>`) changes only those index entries and leaves HEAD alone.
  if (hasOption(parsed, "pathspec-from-file") || parsed.operands.length > refs.length) return null
  // A whole mixed reset rewrites the shared index, which can hold other sessions' staged work; a soft reset to HEAD changes nothing.
  const unstage = mode !== "soft"
  if (hasOption(parsed, "patch") || !refs.length) return unstage ? fixed(MESSAGES.unstage) : null
  return async (ctx) => {
    const commit = await ctx.commit(refs[0])
    // Without --, Git reads the first operand as a commit when it names one, and the rest as paths.
    if (!commit || refs.length > 1) return null
    if (commit !== await ctx.head()) return MESSAGES.rewind
    return unstage ? MESSAGES.unstage : null
  }
}

function branch(args) {
  const parsed = parseGitOptions(SPECS.branch, args)
  const names = parsed.operands
  let touched = []
  if (any(parsed, ["delete", "-D"])) touched = hasOption(parsed, "remotes") ? [] : names
  else if (any(parsed, ["move", "-M"])) touched = names.length > 1 ? names.slice(0, 2) : names.length ? [null, names[0]] : []
  else if (any(parsed, ["copy", "-C"])) touched = names.slice(0, 2).slice(-1)
  else if (hasOption(parsed, "force")) touched = names.slice(0, 1)
  const upstream = parsed.set.get("set-upstream-to")
  if (upstream && !upstream.negated) return async (ctx) => {
    const target = names[0] ?? await ctx.branch()
    if (target === null || !await protectedBranch(ctx, target)) return null
    // Only <remote>/<the same name> keeps pull and rebase on the branch's own history.
    return ctx.known(upstream.value, "an upstream name").endsWith(`/${target.replace(/^refs\/heads\//u, "")}`) ? null : MESSAGES.upstream
  }
  if (!touched.length) return null
  return async (ctx) => {
    for (const name of touched) {
      if (name === null || await protectedBranch(ctx, name)) return MESSAGES.branch
    }
    return null
  }
}

function rebase(args) {
  const parsed = parseGitOptions(SPECS.rebase, args)
  if (any(parsed, ["continue", "skip", "abort", "edit-todo", "show-current-patch"])) return null
  if (any(parsed, ["onto", "root", "exec", "quit"])) return fixed(MESSAGES.rebase)
  if (hasOption(parsed, "autostash")) return fixed(MESSAGES.autostash)
  const [upstream, other] = parsed.operands
  const check = async (ctx) => {
    // `git rebase <upstream> <branch>` switches to <branch> first.
    if (other !== undefined && other !== await ctx.branch()) return MESSAGES.leave
    const own = await ownUpstream(ctx)
    if (own === null) return MESSAGES.noUpstream
    return upstream === undefined || await ctx.fullName(upstream) === own.ref ? null : MESSAGES.rebase
  }
  return upstream === undefined ? anywhere(check) : check
}

// Whether a pull rebases: --rebase, or else the branch's or pull's saved setting, unless --no-rebase or =false.
function pullRebases(parsed, ctx, branch) {
  const option = parsed.set.get("rebase")
  if (option) return !option.negated && option.value !== "false"
  const setting = ctx.config(`branch.${branch}.rebase`) ?? ctx.config("pull.rebase")
  return setting !== undefined && setting !== "false"
}

function pull(args) {
  const parsed = parseGitOptions(SPECS.pull, args)
  if (hasOption(parsed, "autostash")) return fixed(MESSAGES.autostash)
  const [remote, ...refspecs] = parsed.operands
  const check = async (ctx) => {
    // A merge adds history and moves nothing off the branch; only a rebase onto another base rewrites pushed commits.
    const branch = await ctx.branch()
    if (!pullRebases(parsed, ctx, branch)) return null
    const own = await ownUpstream(ctx)
    if (own === null) return MESSAGES.noUpstream
    // A repository operand (a remote name, path or URL) must be the upstream's own remote.
    if (remote !== undefined && ctx.known(remote, "a pull repository") !== own.remote) return MESSAGES.pull
    const names = [own.merge, own.merge.replace(/^refs\/heads\//u, "")]
    return refspecs.every((spec) => names.includes(spec.replace(/^\+/u, ""))) ? null : MESSAGES.pull
  }
  return remote === undefined ? anywhere(check) : check
}

function merge(args) {
  const parsed = parseGitOptions(SPECS.merge, args)
  if (any(parsed, ["abort", "continue", "quit"])) return null
  // A merge adds history and moves nothing off the branch; Git refuses to overwrite uncommitted work.
  return hasOption(parsed, "autostash") ? fixed(MESSAGES.autostash) : null
}

// A non-force push only fast-forwards the remote, so it rewrites and discards nothing. A leading "+" forces, and an
// empty source (":" or ":<ref>") deletes.
const forcedRefspec = (spec) => spec.startsWith("+") || spec.startsWith(":")

function push(args) {
  const parsed = parseGitOptions(SPECS.push, args)
  if (any(parsed, ["force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune"])) return fixed(MESSAGES.pushForce)
  const [remote, ...refspecs] = parsed.operands
  if (refspecs.some(forcedRefspec)) return fixed(MESSAGES.pushForce)
  // A refspec whose start Desk cannot compute could force (+) or delete (:), in any checkout.
  const unknown = refspecs.find((spec) => spec.startsWith("\0"))
  if (unknown !== undefined) return async (ctx) => ctx.known(unknown, "a push refspec")
  // Saved configuration can turn a plain push into a mirror or forced push; a target Desk cannot read is not checked.
  return anywhere(async (ctx) => {
    const name = remote === undefined ? (await ctx.upstream())?.remote ?? "origin" : ctx.known(remote, "a push repository")
    if (isTrue(ctx.config(`remote.${name}.mirror`))) return MESSAGES.pushForce
    return !refspecs.length && ctx.configAll(`remote.${name}.push`).some(forcedRefspec) ? MESSAGES.pushForce : null
  })
}

function fetch(args) {
  const parsed = parseGitOptions(SPECS.fetch, args)
  if (hasOption(parsed, "update-head-ok")) return fixed(MESSAGES.fetch)
  const destinations = parsed.operands.slice(1).filter((spec) => spec.includes(":")).map((spec) => spec.slice(spec.indexOf(":") + 1).replace(/^refs\/heads\//u, ""))
  if (!destinations.length) return null
  return async (ctx) => {
    for (const destination of destinations) {
      if (await protectedBranch(ctx, destination)) return MESSAGES.fetch
    }
    return null
  }
}

// `git config` writes of keys the guard or the configuration-trusting rules rely on.
const CONFIG_VALUES = new Set(["-f", "--file", "--blob", "--type", "-t", "--default", "--comment", "--value", "--url"])
const CONFIG_WRITES = new Set(["--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "--edit", "-e"])
function config(args) {
  const operands = []
  let read = false, write = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (CONFIG_VALUES.has(arg)) i++
    else if (CONFIG_WRITES.has(arg)) write = true
    else if (/^--(?:get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list)$|^-l$/u.test(arg)) read = true
    else if (!arg.startsWith("-")) operands.push(arg)
  }
  let [key, ...rest] = operands
  if (["get", "list"].includes(key)) return null
  if (["set", "unset", "rename-section", "remove-section", "edit"].includes(key)) { write = true; key = rest[0] }
  if ((read && !write) || (!write && operands.length < 2)) return null
  if (key === undefined) return fixed(MESSAGES.config("the configuration file"))
  // Whole sections are judged, so section renames and removals are covered too.
  return async (ctx) => CONFIG_SECTIONS.has(ctx.known(key, "a configuration key").split(".")[0].toLowerCase()) ? MESSAGES.config(key) : null
}

function commit(args) {
  if (!hasOption(parseGitOptions(SPECS.commit, args), "amend")) return null
  return async (ctx) => await ctx.pushed() ? MESSAGES.amend : null
}

function worktree([subcommand, ...args]) {
  if (subcommand === "remove") {
    const parsed = parseGitOptions(SPECS["worktree remove"], args)
    return hasOption(parsed, "force") && parsed.operands.length ? { victim: parsed.operands[0] } : null
  }
  if (subcommand === "prune") return hasOption(parseGitOptions(SPECS["worktree prune"], args), "dry-run") ? null : fixed(MESSAGES.prune)
  if (subcommand !== "add") return null
  const reset = parseGitOptions(SPECS["worktree add"], args).set.get("-B")?.value
  return reset === undefined ? null : async (ctx) => await protectedBranch(ctx, reset) ? MESSAGES.branch : null
}

const RULES = {
  checkout,
  switch: switchBranch,
  reset,
  // `restore --staged <paths>` only unstages those paths; restoring from another commit, or the index and the files
  // together, overwrites work.
  restore: (args) => {
    const parsed = parseGitOptions(SPECS.restore, args)
    return hasOption(parsed, "source") || (hasOption(parsed, "staged") && hasOption(parsed, "worktree")) ? fixed(MESSAGES.restore) : null
  },
  clean: () => fixed(MESSAGES.clean),
  stash: ([subcommand]) => ["list", "show"].includes(subcommand) ? null : fixed(MESSAGES.stash),
  branch,
  rebase,
  pull,
  merge,
  push,
  fetch,
  config,
  commit,
  worktree,
  bisect: ([subcommand]) => ALLOWED_BISECT.has(subcommand) ? null : fixed(MESSAGES.leave),
}

// Git never lets an alias replace one of its own commands, so these names need no alias lookup.
export const BUILTINS = new Set([
  ...Object.keys(RULES), "add", "am", "apply", "archive", "blame", "bundle", "cat-file", "check-attr", "check-ignore",
  "cherry", "cherry-pick", "clone", "count-objects", "describe", "diff", "diff-files", "diff-index",
  "diff-tree", "for-each-ref", "format-patch", "fsck", "gc", "grep", "hash-object", "help", "init", "log",
  "ls-files", "ls-remote", "ls-tree", "maintenance", "merge-base", "mv", "notes", "range-diff", "reflog", "remote",
  "repack", "rerere", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-branch", "show-ref",
  "sparse-checkout", "status", "submodule", "symbolic-ref", "tag", "update-index", "update-ref", "var",
  "verify-commit", "verify-tag", "version", "write-tree",
])

/** Whether `git <operation>` has a rule; an unknown program whose first operand is one could be Git. */
export function hasRule(operation) {
  return Object.hasOwn(RULES, operation)
}

// Whether an unknown argument (UNKNOWN, "\0") sits where Git would read an operand or an option name, so it
// could be any options or several arguments. An unknown value of an option (`-m $msg`) or a path after `--` cannot.
function unknownArgument(operation, args) {
  const unknown = (arg) => arg.includes("\0")
  if (!args.some(unknown)) return false
  const spec = operation === "worktree" ? SPECS[`worktree ${args[0]}`] : SPECS[operation]
  const list = operation === "worktree" ? args.slice(1) : args
  if (!spec) return true
  const parsed = parseGitOptions(spec, list)
  const options = parsed.dashdash < 0 ? parsed.operands : parsed.operands.slice(0, parsed.dashdash)
  return options.some(unknown) || list.some((arg) => arg.startsWith("-") && unknown(arg.split("=")[0]))
}

/**
 * null when `git <operation> <args>` is allowed in any checkout; otherwise a check of the target checkout.
 * `overrides` are the command's -c, --config-env and GIT_CONFIG_* entries as [key, value] pairs. With `variables`
 * (PowerShell), an unknown argument takes its most dangerous reading: any options or arguments.
 */
export function classifyGit(operation, args, overrides = [], { variables = false } = {}) {
  const end = args.indexOf("--")
  // `-h` and `--help` print usage and change nothing.
  if ((end < 0 ? args : args.slice(0, end)).some((arg) => arg === "-h" || arg === "--help")) return null
  if (!hasRule(operation)) return null
  if (variables && unknownArgument(operation, args)) {
    // A worktree command could force-remove any worktree; others are checked against the target checkout.
    return operation === "worktree" && !["add", "list"].includes(args[0]) ? { victim: "\0" } : fixed(MESSAGES.variable)
  }
  if (OVERRIDE_OPERATIONS.has(operation)) {
    const override = overrides.find(([key]) => OVERRIDDEN.test(canonicalKey(key)))
    if (override) return fixed(MESSAGES.override(override[0], operation))
  }
  return RULES[operation](args)
}
