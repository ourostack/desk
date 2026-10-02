import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { inspectShell } from "./shell-commands.js"
import { rewritePowerShell } from "./powershell-rewrite.js"
import { runGit } from "./state-branch.js"
import { readInspectionGit } from "./git-inspection.js"
import { existingDirectory, gitDirectory, processDirectory } from "./shell-paths.js"
import { BUILTINS, canonicalKey, classifyGit, hasRule, MESSAGES } from "./git-guard-policy.js"
import { GuardDenial, inspectionBudget, protectedDenial, UNKNOWN, unresolved, WORKTREE_COMMAND } from "./guard-unknowns.js"

export { WORKTREE_COMMAND }

// Windows paths from Git (C:/Users/name/...) and from the shell or %TEMP% (C:\Users\NAME~1\...) name one folder in different forms. The native
// realpath expands 8.3 short names; the comparison also folds separators and case, as Windows does. Other platforms keep exact comparison.
export function pathForms(platform) {
  const windows = platform === "win32"
  const realPath = windows ? realpathSync.native : realpathSync
  function canonical(file) {
    try { return realPath(file) } catch (error) { if (error.code === "ENOENT") return file; throw error }
  }
  const fold = (file) => path.win32.normalize(canonical(file)).toLowerCase()
  /** Whether a path `git worktree list` printed names the same folder as an already-canonical path. */
  const sameFolder = windows ? (listed, resolved) => fold(listed) === path.win32.normalize(resolved).toLowerCase() : (listed, resolved) => listed === resolved
  return { realPath, canonical, sameFolder }
}
const { realPath, canonical: canonicalPath, sameFolder } = pathForms(process.platform)

// Git copies config.worktree to new worktrees. An exact gitdir conditional include
// keeps this local marker on the bound checkout without changing Git's extensions.
// The state branch, when the host names one, is recorded beside the marker.
export async function protectCheckout({ root, stateBranch = null, git = runGit }) {
  const location = await git({ cwd: root, args: ["rev-parse", "--absolute-git-dir"] })
  if (!location.ok) return { protected: false }
  const gitDir = location.stdout.replaceAll("\\", "/")
  async function write(args) {
    const result = await git({ cwd: root, args })
    if (!result.ok) throw new Error(`could not protect checkout ${root}: ${result.stderr}`)
  }
  const marker = path.join(gitDir, "desk-protected.config")
  const pattern = gitDir.replace(/[*?[\]]/gu, "\\$&")
  await write(["config", "--file", marker, "desk.protected", "true"])
  if (stateBranch) await write(["config", "--file", marker, "desk.stateBranch", stateBranch])
  else await git({ cwd: root, args: ["config", "--file", marker, "--unset-all", "desk.stateBranch"] })
  await write(["config", "--local", `includeIf.gitdir:${pattern}.path`, marker])
  return { protected: true }
}

// The hosts stop a PreToolUse hook at its declared timeout (10 s for both). One command's Git reads share this
// budget, so a loaded machine's slow reads can still decide, and the guard always answers, failing closed, first.
export const GUARD_INSPECTION_BUDGET_MS = 7000
// One read answers protection, the state branch, upstreams and push configuration.
const POLICY_KEYS = "^(desk\\.(protected|statebranch)|branch\\..+\\.(remote|merge|rebase)|remote\\..+\\.(mirror|push)|pull\\.rebase)$"

function gitBoolean(value) {
  if (value === undefined || /^(?:true|yes|on)$/iu.test(value)) return true
  if (value === "" || /^(?:false|no|off)$/iu.test(value)) return false
  if (/^-?\d+$/u.test(value)) return Number(value) !== 0
  throw new Error(`cannot read checkout protection: bad boolean config value '${value}' for 'desk.protected'`)
}

async function readPolicy(read, cwd, options, env) {
  // -z keeps an empty value ("key\n\0", false) apart from a key with no value ("key\0", true).
  const result = await read(cwd, [...options, "config", "-z", "--show-scope", "--get-regexp", POLICY_KEYS], env)
  // Outside a checkout, or with a location that is not one, Git reports no value (exit 1) and there is no local policy.
  // A directory Git cannot open as a repository at all (a removed worktree's leftover .git file) runs no Git either.
  if (!result.ok && result.code === 128 && /not a git repository/iu.test(result.stderr)) return { protected: false, entries: [] }
  if (!result.ok && result.code !== 1) throw new Error(`cannot read checkout protection: ${result.stderr}`)
  const entries = [], fields = result.stdout.split("\0")
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const at = fields[i + 1].indexOf("\n")
    entries.push({ scope: fields[i], key: at < 0 ? fields[i + 1] : fields[i + 1].slice(0, at), value: at < 0 ? undefined : fields[i + 1].slice(at + 1) })
  }
  // Only the checkout's own saved configuration can protect it; global and command scopes cannot opt in or out.
  const marker = entries.filter((entry) => entry.key === "desk.protected" && /^(?:local|worktree)$/u.test(entry.scope)).at(-1)
  return { protected: marker !== undefined && gitBoolean(marker.value), entries }
}

// Reads of the target checkout for the policy's checks: the prefetched policy and branch, and lazy reads.
function checkoutContext(read, cwd, options, env, policy, branch) {
  const value = async (key, args) => {
    const result = await read(cwd, [...options, ...args], env)
    return result.ok && result.stdout ? result.stdout : null
  }
  const known = (text, what) => {
    if (text.includes(UNKNOWN)) throw unresolved(what)
    return text
  }
  const configAll = (key) => policy.entries.filter((entry) => entry.key === key).map((entry) => entry.value ?? "true")
  const context = {
    known,
    config: (key) => configAll(key).at(-1),
    configAll,
    branch: async () => branch,
    stateBranch: async () => context.config("desk.statebranch") ?? branch,
    head: () => value("head", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    commit: (rev) => value(`commit ${known(rev, "a Git revision")}`, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]),
    fullName: (rev) => value(`name ${known(rev, "a Git revision")}`, ["rev-parse", "--symbolic-full-name", rev.startsWith("-") ? "--" : rev]),
    remoteBranch: async (name) => await value(`remote ${name}`, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/*/${name}`]) !== null,
    pushed: async () => await value("pushed", ["for-each-ref", "--count=1", "--contains=HEAD", "--format=%(refname)", "refs/remotes"]) !== null,
    // An absolute path relative to the checkout's top level: "" for the top level or an ancestor of it, null outside it.
    async rootRelative(spec) {
      const top = await value("top", ["rev-parse", "--show-toplevel"])
      if (top === null) return null
      const real = (file) => {
        try { return realPath(file) } catch { return path.join(real(path.dirname(file)), path.basename(file)) }
      }
      const relative = path.relative(real(top), real(path.resolve(spec)))
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/")
      return (real(top) + path.sep).startsWith(real(path.resolve(spec)).replace(/[\\/]*$/u, path.sep)) ? "" : null
    },
    // The upstream from saved configuration, with its remote-tracking ref under the default fetch layout.
    async upstream() {
      const remote = context.config(`branch.${branch}.remote`), merge = context.config(`branch.${branch}.merge`)
      if (branch === null || !remote || !merge) return null
      return { remote, merge, ref: remote === "." ? merge : `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//u, "")}` }
    },
  }
  return context
}

// Configuration a command inherits from its environment, in the order Git applies it.
function environmentOverrides(variables) {
  const overrides = []
  for (const match of (variables.GIT_CONFIG_PARAMETERS ?? "").matchAll(/'([^']*)'(?:='([^']*)')?/gu)) overrides.push([match[1], match[2] ?? "true"])
  const count = Number(variables.GIT_CONFIG_COUNT)
  for (let i = 0; Number.isInteger(count) && i < count; i++) {
    if (variables[`GIT_CONFIG_KEY_${i}`] !== undefined) overrides.push([variables[`GIT_CONFIG_KEY_${i}`], variables[`GIT_CONFIG_VALUE_${i}`] ?? ""])
  }
  return overrides
}

function gitInvocation(args, cwd, variables) {
  const location = [], overrides = environmentOverrides(variables), commandLine = []
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("-")) break
    if (arg === "-C" || arg.startsWith("-C")) {
      const dir = arg === "-C" ? args[++i] : arg.slice(2)
      if (dir === undefined) return null
      if (dir) {
        cwd = processDirectory(cwd, dir)
        if (cwd === null) return null
      }
    } else if (arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      if (args[i + 1] === undefined) return null
      location.push(arg, args[++i])
    } else if (/^--(?:git-dir|work-tree|namespace)=/u.test(arg)) location.push(arg)
    else if (arg === "-c" || arg.startsWith("-c")) {
      const config = arg === "-c" ? args[++i] : arg.slice(2)
      if (config === undefined) return null
      const at = config.indexOf("=")
      commandLine.push(at < 0 ? [config, "true"] : [config.slice(0, at), config.slice(at + 1)])
    } else if (arg === "--config-env" || arg.startsWith("--config-env=")) {
      const spec = arg === "--config-env" ? args[++i] : arg.slice(13)
      const at = spec?.indexOf("=") ?? -1
      if (at > 0) commandLine.push([spec.slice(0, at), variables[spec.slice(at + 1)] ?? UNKNOWN])
    } else if (arg === "--") { i++; break }
    else if (arg === "--help" || arg === "--version") return null
  }
  // The `-C` chain moves the way the process does; Git then works from the folder it resolves to.
  return { cwd: gitDirectory(cwd), location, overrides: [...overrides, ...commandLine], commandLine, global: args.slice(0, i), name: args[i], args: args.slice(i + 1) }
}

// Git aliases are configuration variables, so their section and name are case-insensitive.
function aliasFrom(overrides, name) {
  return overrides.filter(([key]) => canonicalKey(key) === `alias.${name}`).at(-1)?.[1]
}

// Only Git's own environment (GIT_DIR and its siblings, GIT_CONFIG_* overrides) can change what a Git call does;
// `gitInvocation` already folds those into `invocation.location`/`invocation.overrides`. A shell loop's own
// variables (a loop counter, an unrelated export) never reach Git and must not be part of the guard's cache key,
// or an identical, already-decided Git call spends a fresh Git read on every iteration instead of reusing the
// answer for its one distinct target (ourostack/factory#39).
function gitRelevantEnv(variables) {
  return Object.fromEntries(Object.entries(variables).filter(([key]) => /^GIT_/u.test(key)))
}

// GIT_WORK_TREE, or the parent directory of a plain ".git" GIT_DIR, is the checkout Git will actually act in
// when the command line does not already say so with -C, --git-dir or --work-tree; `readGit` already forwards
// both variables to the real Git process (git-inspection.js's LOCATION_KEYS). The target the guard checks for
// existence and reads policy from must follow them too, or a checkout reachable only through the environment
// is invisible to that check, and an unrelated or nonexistent modeled directory hides it - a false allow found
// in review of the fix for ourostack/factory#39, independent of the cache-key defect that issue named.
function gitEnvTarget(location, variables) {
  if (location.length > 0) return undefined
  const workTree = variables.GIT_WORK_TREE
  if (workTree !== undefined) return workTree
  const gitDir = variables.GIT_DIR
  if (gitDir === undefined) return undefined
  if (gitDir.includes(UNKNOWN)) return gitDir
  return path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir
}

// Words that could run Git somewhere other than the statement's own directory.
const RELOCATES = /(?<![\w-])(?:set-location|sl|cd|chdir|push-location|pushd|pop-location|popd|start-process|saps|start|invoke-command|icm|start-job|sajb|start-threadjob|enter-pssession|ssh|wsl|docker|worktree|submodule)(?![\w-])|--git-dir|--work-tree|git_dir|git_work_tree|git_common_dir|currentdirectory|-workingdirectory|(?<![\w-])-wd(?![\w-])/iu

// A suggested rewrite longer than this is left out: it would bury the denial it is meant to shorten.
const REWRITE_LIMIT = 600

const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`
const GIT_LIKE = /^(?:-C|-c|--git-dir|--work-tree|--config-env)/u

export async function guardShellCommand({ command, cwd, env = process.env, powershell = false, budgetMs = GUARD_INSPECTION_BUDGET_MS, readGit = readInspectionGit, now = Date.now, rewrite = true }) {
  const inspected = new Set()
  const deadline = now() + budgetMs
  // Inspection steps share this deadline with the Git reads, across Bash, PowerShell and nested scripts.
  const budget = inspectionBudget({ deadline, now, budgetMs })
  // Each read gets what is left of the budget; a spent budget, like a read that timed out, is ETIMEDOUT.
  async function read(dir, args, variables) {
    const timeoutMs = deadline - now()
    if (timeoutMs <= 0) throw Object.assign(new Error(`protected-checkout inspection budget of ${budgetMs} ms is spent`), { code: "ETIMEDOUT" })
    return readGit(dir, args, variables, { timeoutMs })
  }
  async function visit({ name, args, cwd: directory, env: variables, computed = false, powershell: fromPowerShell = false }) {
    if (name !== "git") return
    const invocation = gitInvocation(args, directory, variables)
    if (!invocation || invocation.name === undefined) return
    const { location, overrides, name: operation, args: operands } = invocation
    // A computed program is judged as Git only when its arguments read like a Git command the policy checks.
    if (computed && !GIT_LIKE.test(args[0]) && !hasRule(operation)) return
    if (operation.includes(UNKNOWN)) throw unresolved("which Git command this runs")
    // An environment value the guard cannot compute (GIT_DIR="$(pick)") is left for the real Git read to reject:
    // `readGit` already forwards it (git-inspection.js's LOCATION_KEYS) and fails closed there. Resolving it into
    // `target` here instead would let an operation safe in any checkout, or the wrong denial message, bypass that.
    const envTarget = gitEnvTarget(location, variables)
    const knownEnvTarget = envTarget !== undefined && !envTarget.includes(UNKNOWN) ? envTarget : undefined
    // A relative GIT_WORK_TREE/GIT_DIR is relative to the directory Git runs in, never to the hook's own process.
    const target = invocation.cwd === UNKNOWN ? null : existingDirectory(knownEnvTarget === undefined ? invocation.cwd : path.resolve(invocation.cwd, knownEnvTarget))
    const where = "which checkout this Git command runs in"
    // The agent's own operation and operands, as long as they are literal and short, make the example its own command.
    const literal = [operation, ...operands].join(" ")
    const example = literal.includes(UNKNOWN) || literal.length > 40 ? operation.slice(0, 40) : literal
    const unresolvedCheckout = () => unresolved(where, `Write the checkout path literally: git -C <path> ${example}. Or cd there in a separate command first.`)
    if (target !== null && !existsSync(target)) return
    const key = JSON.stringify([invocation, gitRelevantEnv(variables)])
    if (inspected.has(key)) return
    inspected.add(key)
    if (!BUILTINS.has(operation)) {
      const lower = operation.toLowerCase()
      let alias = aliasFrom(overrides, lower)
      if (alias === undefined) {
        if (target === null) throw unresolvedCheckout()
        alias = (await read(target, [...location, "config", "--get", `alias.${lower}`], variables)).stdout
      }
      if (!alias) return
      if (alias.includes(UNKNOWN)) throw unresolved("a Git alias")
      const builtins = await read(target ?? tmpdir(), ["--list-cmds=builtins"], variables)
      if (builtins.stdout.split(/\r?\n/u).includes(operation)) return
      const rest = operands.map(quote).join(" ")
      if (!alias.startsWith("!")) {
        // Git expands a plain alias in the same process, with the issuing command's options.
        await inspectShell({ command: `git ${invocation.global.map(quote).join(" ")} ${alias} ${rest}`, cwd: directory, env: variables, powershell: false, visit, budget })
        return
      }
      if (target === null) throw unresolvedCheckout()
      // A shell alias runs at the top level with the location and -c settings Git exports to it.
      const top = await read(target, [...location, "rev-parse", "--show-toplevel"], variables)
      const exported = { ...variables }
      for (let i = 0; i < location.length; i++) {
        const [option, value] = location[i].includes("=") ? location[i].split(/=(.*)/su) : [location[i], location[++i]]
        const variable = { "--git-dir": "GIT_DIR", "--work-tree": "GIT_WORK_TREE", "--namespace": "GIT_NAMESPACE" }[option]
        exported[variable] = option === "--namespace" ? value : path.resolve(target, value)
      }
      exported.GIT_CONFIG_PARAMETERS = [variables.GIT_CONFIG_PARAMETERS, ...invocation.commandLine.map(([k, v]) => `'${k}'='${v}'`)].filter(Boolean).join(" ")
      await inspectShell({ command: `${alias.slice(1)} ${rest}`, cwd: top.ok ? top.stdout : target, env: exported, powershell: false, visit, budget })
      return
    }
    const rule = classifyGit(operation, operands, overrides, { variables: fromPowerShell })
    if (!rule) return
    // Configuration from an environment variable Desk cannot compute could override what a rule trusts. (An unknown
    // GIT_DIR or GIT_WORK_TREE already stops the policy read.)
    if (Object.entries(variables).some(([key, value]) => /^GIT_CONFIG_/iu.test(key) && String(value).includes(UNKNOWN))) throw unresolved("the Git configuration this command inherits")
    if (target === null || location.some((option) => option.includes(UNKNOWN))) {
      // Adds, commits, pulls and rebases onto the upstream, and non-force pushes are safe in any checkout.
      if (rule.anywhere) return
      throw unresolvedCheckout()
    }
    if (rule.victim !== undefined) {
      // Force-removal checks the removed checkout with its own identity, not the issuer's overrides.
      const worktrees = await read(target, [...location, "worktree", "list", "--porcelain"], variables)
      const paths = worktrees.stdout.split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9))
      const victim = rule.victim
      if (victim.includes(UNKNOWN)) {
        // An unknown victim is checked against every worktree of the repository: it passes when none is protected.
        for (const candidate of paths) {
          if ((await readPolicy(read, candidate, [], {})).protected) throw new GuardDenial(protectedDenial(candidate, MESSAGES.worktreeRemove))
        }
        return
      }
      const resolved = canonicalPath(path.resolve(target, victim))
      const found = paths.find((p) => sameFolder(p, resolved)) ?? paths.find((p) => path.basename(p) === victim)
      if (found && (await readPolicy(read, found, [], {})).protected) throw new GuardDenial(protectedDenial(found, MESSAGES.worktreeRemove))
      return
    }
    // The policy and the current branch are read together, so most checks take one round of reads.
    const [policy, head] = await Promise.all([
      readPolicy(read, target, location, variables),
      read(target, [...location, "symbolic-ref", "--quiet", "--short", "HEAD"], variables),
    ])
    if (!policy.protected) return
    const reason = await rule(checkoutContext(read, target, location, variables, policy, head.ok && head.stdout ? head.stdout : null))
    if (reason) throw new GuardDenial(protectedDenial(target, reason))
  }
  async function guardedVisit(call) {
    try { await visit(call) } catch (error) {
      if (error instanceof GuardDenial) throw error
      // A single slow Git read and a loop over more distinct targets than the budget can check both end up here;
      // simply retrying either answers nothing when the command has too many distinct targets, so the guard also
      // names the fix: fewer targets per command, or a script file so each target's check gets its own budget.
      if (error.code === "ETIMEDOUT") throw new GuardDenial(`Retry the command, or split it into fewer Git targets or a script file. Desk could not finish checking it within its ${budgetMs / 1000} s budget because Git answered too slowly, so it is denied to keep a protected checkout safe; a script file gives each target's check its own budget.`)
      throw new GuardDenial(`Retry the command, or split it into simpler commands. Desk could not inspect a Git command in it (${error.message}), and it could change a protected checkout.`)
    }
  }
  // A PowerShell statement outside the Git allowlist is allowed when it can only reach a known checkout that is not
  // protected: it names nothing that changes the location or Git's directory, and the environment sets no Git directory.
  guardedVisit.unmodeled = async ({ text, cwd: directory, env: variables }) => {
    if (directory === UNKNOWN || RELOCATES.test(text) || /(?<![\w-])-C/u.test(text)) return false
    if (Object.keys(variables).some((key) => /^GIT_(?:DIR|WORK_TREE|COMMON_DIR)$/iu.test(key))) return false
    const target = existingDirectory(directory)
    try { return !(await readPolicy(read, target, [], variables)).protected } catch { return false }
  }
  // A suggested rewrite is offered only after the guard itself, with what is left of the budget, allows it.
  async function withRewrite(reason) {
    const candidate = rewritePowerShell(command)
    if (candidate === null || candidate.length > REWRITE_LIMIT) return reason
    const verdict = await guardShellCommand({ command: candidate, cwd, env, powershell, budgetMs: Math.max(0, deadline - now()), readGit, now, rewrite: false })
    if (verdict.deny) return reason
    // The first line is all some hosts show: the command itself when it fits there, else a pointer to it.
    const fits = candidate.length <= 100 && !candidate.includes("\n")
    return fits ? `Run this instead: ${candidate}\n${reason}` : `Run the rewritten command below instead.\nRewrite: ${candidate}\n${reason}`
  }
  try {
    await inspectShell({ command, cwd, env, powershell, visit: guardedVisit, budget })
  } catch (error) {
    if (error instanceof GuardDenial) return { deny: true, reason: redact(rewrite && error.rewritable && powershell ? await withRewrite(error.reason) : error.reason) }
    // Text Desk cannot parse is judged from its words: it is denied only when it names a Git operation that a rule
    // would check anywhere but in a known unprotected checkout (fallbackOperation).
    const operation = fallbackOperation(command)
    if (operation === null) return { deny: false }
    if (await guardedVisit.unmodeled({ text: command, cwd, env })) return { deny: false }
    return { deny: true, reason: redact(`Split the command into simpler commands. Desk could not inspect this shell command (${error.message}), and its git ${operation} could change a protected checkout.`) }
  }
  return { deny: false }
}

// The first Git operation named in shell text Desk could not parse that a rule could deny in a protected checkout,
// or null. Quotes are dropped and the words after `git <operation>` up to a separator are its arguments; an
// operation safe in any checkout (a plain commit, pull, push or rebase onto the upstream) does not count.
const FALLBACK_GIT = /(?<![\w.-])git(?:\.exe)?((?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+([A-Za-z][\w-]*)([^\n;&|()`]*)/gu
export function fallbackOperation(command) {
  for (const match of command.replace(/["']/gu, "").replaceAll("\\", "/").matchAll(FALLBACK_GIT)) {
    const operation = match[2]
    if (!hasRule(operation)) continue
    const rule = classifyGit(operation, match[3].split(/\s+/u).filter(Boolean))
    if (rule && !rule.anywhere) return operation
  }
  return null
}

// Credentials never reach a denial message: a URL's user information (https://user:token@host), the user information
// of any url.<base> configuration key, with or without a scheme (url.<token>@host:.insteadOf), an scp-style user that
// looks like a token (<token>@host:path), and an Authorization header value.
export function redact(text) {
  return text
    .replace(/([a-z][\w+.-]*:\/\/)[^\s/@'"]+@/giu, "$1<redacted>@")
    .replace(/(\burl\.)(?!<redacted>)([^\s/@'"=]+)@/giu, "$1<redacted>@")
    .replace(/([^\s'"]*)@(?=[\w.-]+:)/gu, (match, user) => user.endsWith("<redacted>") || /^[\w.-]{1,23}$/u.test(user) && !TOKEN_PREFIX.test(user) ? match : "<redacted>@")
    .replace(/((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)?\s*)[^\s'"]+/giu, "$1<redacted>")
    .replace(/(?<![\w.-])(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abpr]-)[\w-]{8,}/gu, "<redacted>")
}
const TOKEN_PREFIX = /^(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abpr]-)/u

export async function protectedCheckoutHook(input, host) {
  const name = String(input.tool_name ?? input.toolName).toLowerCase()
  if (!["bash", "powershell", "shell", "run_shell_command"].includes(name)) return {}
  let args = input.tool_input ?? input.toolArgs
  if (typeof args === "string") args = JSON.parse(args)
  if (typeof args?.command !== "string") return {}
  const result = await guardShellCommand({
    command: args.command, cwd: args.cwd ?? input.cwd ?? process.cwd(),
    powershell: name === "powershell", env: process.env,
  })
  if (!result.deny) return {}
  const decision = { permissionDecision: "deny", permissionDecisionReason: result.reason }
  return host === "claude" ? { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } } : decision
}
