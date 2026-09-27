// What Git may do in a protected checkout (Desk 3.2 ruling for task A3b). The guard keeps a
// shared checkout's HEAD on its state branch and keeps other sessions' work in place, and
// otherwise leaves the desk's normal write protocol alone: status, log, diff, fetch, add,
// rm, mv, commit, push of the current branch, pull and upstream rebase on the state branch,
// merge --ff-only and worktree add all pass. `classifyGit` needs no Git reads; it returns
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
  rebaseBranch: `git rebase is allowed here only on the state branch. To rebase another branch, ${WORKTREE}`,
  rebase: `git rebase here may only replay the state branch onto its own upstream (git rebase, or git rebase @{upstream}). For --onto, --root, --exec, --quit or another base, ${WORKTREE}`,
  pullBranch: `git pull is allowed here only on the state branch. To pull another branch, ${WORKTREE}`,
  pull: `git pull here may only merge the state branch's own upstream. To merge another branch, ${WORKTREE}`,
  autostash: "--autostash stashes, which hides other sessions' work; commit or leave it",
  merge: `only git merge --ff-only is allowed here. For other merges, ${WORKTREE}`,
  pushForce: "force, mirror, delete and prune pushes can discard work on the remote. Fetch, rebase onto the upstream and push without them",
  pushTarget: `this checkout pushes only its own branch (and tags). To push another branch, ${WORKTREE}`,
  amend: "the commit you would amend is already pushed; make a new commit instead",
  worktreeRemove: "git worktree remove --force would delete a protected checkout and its uncommitted work. Remove only worktrees you created, without --force",
  prune: "git worktree prune can drop other sessions' worktree records; leave them, or run it with --dry-run",
  unstage: `unstaging changes the shared index, which can hold other sessions' staged work. Commit only your own paths (git commit <paths>), or ${WORKTREE}`,
  fetch: "fetching into the checkout's own branch rewrites it like a reset; fetch into remote-tracking refs (git fetch origin) instead",
  upstream: `this would point the checkout's branch at a different upstream. Keep <remote>/<state branch>, or ${WORKTREE}`,
  config: (key) => `this would change ${key}, which decides what push, pull, rebase, aliases or this guard do in the shared checkout. Leave it, or ${WORKTREE}`,
  override: (key, operation) => `the configuration override ${key} changes what this git ${operation} does. Run it without the override, or ${WORKTREE}`,
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
const lastOf = (parsed, names) => parsed.sequence.filter((entry) => names.includes(entry.name)).at(-1)
const beforeDashDash = (parsed) => parsed.dashdash < 0 ? parsed.operands : parsed.operands.slice(0, parsed.dashdash)

// The checkout's current branch or its state branch. Switching to either keeps HEAD where it belongs.
async function ownBranch(ctx, name) {
  return name === await ctx.branch() || name === await ctx.stateBranch()
}

function protectedBranch(ctx, name) {
  return ownBranch(ctx, ctx.known(name, "a branch name").replace(/^refs\/heads\//u, ""))
}

// The state branch's configured upstream, only when it is <remote>/<state branch>.
async function ownUpstream(ctx) {
  const own = await ctx.upstream()
  return own !== null && own.merge === `refs/heads/${await ctx.stateBranch()}` ? own : null
}

async function onStateBranch(ctx) {
  const branch = await ctx.branch()
  return branch !== null && branch === await ctx.stateBranch()
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
  // Every mixed reset rewrites the shared index, like the denied `restore --staged`; a soft reset to HEAD changes nothing.
  const unstage = mode !== "soft"
  if (any(parsed, ["patch", "pathspec-from-file"]) || refs.length !== 1 || parsed.operands.length > 1) return unstage ? fixed(MESSAGES.unstage) : null
  return async (ctx) => {
    const commit = await ctx.commit(refs[0])
    if (commit && commit !== await ctx.head()) return MESSAGES.rewind
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
    // Only <remote>/<state branch> keeps pull and rebase on the state branch's own history.
    return ctx.known(upstream.value, "an upstream name").endsWith(`/${await ctx.stateBranch()}`) ? null : MESSAGES.upstream
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
  return async (ctx) => {
    if (!await onStateBranch(ctx)) return MESSAGES.rebaseBranch
    // `git rebase <upstream> <branch>` switches to <branch> first.
    if (other !== undefined && other !== await ctx.branch()) return MESSAGES.leave
    const own = await ownUpstream(ctx)
    if (own === null) return MESSAGES.rebase
    return upstream === undefined || await ctx.fullName(upstream) === own.ref ? null : MESSAGES.rebase
  }
}

function pull(args) {
  const parsed = parseGitOptions(SPECS.pull, args)
  if (hasOption(parsed, "autostash")) return fixed(MESSAGES.autostash)
  const [remote, ...refspecs] = parsed.operands
  return async (ctx) => {
    if (!await onStateBranch(ctx)) return MESSAGES.pullBranch
    const own = await ownUpstream(ctx)
    // A repository operand (a remote name, path or URL) must be the upstream's own remote.
    if (own === null || (remote !== undefined && ctx.known(remote, "a pull repository") !== own.remote)) return MESSAGES.pull
    const names = [own.merge, own.merge.replace(/^refs\/heads\//u, "")]
    return refspecs.every((spec) => names.includes(spec.replace(/^\+/u, ""))) ? null : MESSAGES.pull
  }
}

function merge(args) {
  const parsed = parseGitOptions(SPECS.merge, args)
  if (any(parsed, ["abort", "continue", "quit"])) return null
  if (hasOption(parsed, "autostash")) return fixed(MESSAGES.autostash)
  const mode = lastOf(parsed, ["ff", "ff-only"])
  return mode?.name === "ff-only" ? null : fixed(MESSAGES.merge)
}

// Refspecs push may use: tags, HEAD and the current branch. A leading "+" forces; an empty source deletes.
function pushTargets(refspecs) {
  const targets = []
  for (let i = 0; i < refspecs.length; i++) {
    const spec = refspecs[i]
    if (spec === "tag") { i++; continue }
    if (spec === ":") return MESSAGES.pushTarget
    if (spec.startsWith("+") || spec.startsWith(":")) return MESSAGES.pushForce
    const colon = spec.indexOf(":")
    if (colon < 0 && ["HEAD", "@"].includes(spec)) continue
    const target = (colon < 0 ? spec : spec.slice(colon + 1)).replace(/^refs\/heads\//u, "")
    if (!target.startsWith("refs/tags/")) targets.push(target)
  }
  return targets
}

function push(args) {
  const parsed = parseGitOptions(SPECS.push, args)
  if (any(parsed, ["force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune"])) return fixed(MESSAGES.pushForce)
  if (any(parsed, ["all", "branches"])) return fixed(MESSAGES.pushTarget)
  const [remote, ...refspecs] = parsed.operands
  return async (ctx) => {
    // Saved configuration can turn a plain push into a mirror, forced or other-branch push.
    const name = remote === undefined ? (await ctx.upstream())?.remote ?? "origin" : ctx.known(remote, "a push repository")
    if (isTrue(ctx.config(`remote.${name}.mirror`))) return MESSAGES.pushForce
    const configured = refspecs.length ? refspecs : ctx.configAll(`remote.${name}.push`)
    if (!configured.length) return ctx.config("push.default") === "matching" ? MESSAGES.pushTarget : null
    const targets = pushTargets(configured)
    if (typeof targets === "string") return targets
    for (const target of targets) {
      if (target !== await ctx.branch() && !await ctx.tag(ctx.known(target, "a push refspec"))) return MESSAGES.pushTarget
    }
    return null
  }
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
  restore: (args) => any(parseGitOptions(SPECS.restore, args), ["source", "staged"]) ? fixed(MESSAGES.restore) : null,
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

/** The tag `git tag <args>` creates, or undefined when it lists, deletes or verifies tags instead. */
export function createdTag(args) {
  const parsed = parseGitOptions(SPECS.tag, args)
  const other = ["list", "delete", "verify", "contains", "no-contains", "with", "without", "merged", "no-merged", "points-at", "-n", "column", "sort", "format"]
  return other.some((name) => parsed.set.has(name)) ? undefined : parsed.operands[0]
}

/** Whether `git <operation>` has a rule; an unknown program whose first operand is one could be Git. */
export function hasRule(operation) {
  return Object.hasOwn(RULES, operation)
}

/**
 * null when `git <operation> <args>` is allowed in any checkout; otherwise a check of the target checkout.
 * `overrides` are the command's -c, --config-env and GIT_CONFIG_* entries as [key, value] pairs.
 */
export function classifyGit(operation, args, overrides = []) {
  const end = args.indexOf("--")
  // `-h` and `--help` print usage and change nothing.
  if ((end < 0 ? args : args.slice(0, end)).some((arg) => arg === "-h" || arg === "--help")) return null
  if (!hasRule(operation)) return null
  if (OVERRIDE_OPERATIONS.has(operation)) {
    const override = overrides.find(([key]) => OVERRIDDEN.test(canonicalKey(key)))
    if (override) return fixed(MESSAGES.override(override[0], operation))
  }
  return RULES[operation](args)
}
