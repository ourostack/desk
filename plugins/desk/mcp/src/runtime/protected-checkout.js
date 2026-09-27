import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { inspectShell } from "./shell-commands.js"
import { runGit } from "./state-branch.js"
import { readInspectionGit } from "./git-inspection.js"
import { existingDirectory, physicalDirectory } from "./shell-paths.js"
import { BUILTINS, canonicalKey, classifyGit, createdTag, hasRule, MESSAGES } from "./git-guard-policy.js"
import { GuardDenial, mayInvokeGit, UNKNOWN, unresolved, WORKTREE_COMMAND } from "./guard-unknowns.js"

export { WORKTREE_COMMAND }

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
const POLICY_KEYS = "^(desk\\.(protected|statebranch)|branch\\..+\\.(remote|merge)|remote\\..+\\.(mirror|push)|push\\.default)$"

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
function checkoutContext(read, cwd, options, env, policy, branch, created) {
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
    // A tag an earlier `git tag <name>` in the same command creates in this checkout counts as a tag.
    tag: async (name) => created.has(`${cwd}\0${name}`) || await value(`tag ${name}`, ["rev-parse", "--verify", "--quiet", `refs/tags/${name}`]) !== null,
    remoteBranch: async (name) => await value(`remote ${name}`, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/*/${name}`]) !== null,
    pushed: async () => await value("pushed", ["for-each-ref", "--count=1", "--contains=HEAD", "--format=%(refname)", "refs/remotes"]) !== null,
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
        cwd = physicalDirectory(cwd, dir)
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
  return { cwd, location, overrides: [...overrides, ...commandLine], commandLine, global: args.slice(0, i), name: args[i], args: args.slice(i + 1) }
}

// Git aliases are configuration variables, so their section and name are case-insensitive.
function aliasFrom(overrides, name) {
  return overrides.filter(([key]) => canonicalKey(key) === `alias.${name}`).at(-1)?.[1]
}

const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`
const GIT_LIKE = /^(?:-C|-c|--git-dir|--work-tree|--config-env)/u

export async function guardShellCommand({ command, cwd, env = process.env, powershell = false, budgetMs = GUARD_INSPECTION_BUDGET_MS, readGit = readInspectionGit, now = Date.now }) {
  const inspected = new Set(), created = new Set()
  const deadline = now() + budgetMs
  // Each read gets what is left of the budget; a spent budget, like a read that timed out, is ETIMEDOUT.
  async function read(dir, args, variables) {
    const timeoutMs = deadline - now()
    if (timeoutMs <= 0) throw Object.assign(new Error(`protected-checkout inspection budget of ${budgetMs} ms is spent`), { code: "ETIMEDOUT" })
    return readGit(dir, args, variables, { timeoutMs })
  }
  async function visit({ name, args, cwd: directory, env: variables, computed = false }) {
    if (name !== "git") return
    const invocation = gitInvocation(args, directory, variables)
    if (!invocation || invocation.name === undefined) return
    const { location, overrides, name: operation, args: operands } = invocation
    // A computed program is judged as Git only when its arguments read like a Git command the policy checks.
    if (computed && !GIT_LIKE.test(args[0]) && !hasRule(operation)) return
    if (operation.includes(UNKNOWN)) throw unresolved("which Git command this runs")
    const target = invocation.cwd === UNKNOWN ? null : existingDirectory(invocation.cwd)
    const where = "which checkout this Git command runs in"
    if (target !== null && !existsSync(target)) return
    const key = JSON.stringify([invocation, variables])
    if (inspected.has(key)) return
    inspected.add(key)
    if (!BUILTINS.has(operation)) {
      const lower = operation.toLowerCase()
      let alias = aliasFrom(overrides, lower)
      if (alias === undefined) {
        if (target === null) throw unresolved(where)
        alias = (await read(target, [...location, "config", "--get", `alias.${lower}`], variables)).stdout
      }
      if (!alias) return
      if (alias.includes(UNKNOWN)) throw unresolved("a Git alias")
      const builtins = await read(target ?? tmpdir(), ["--list-cmds=builtins"], variables)
      if (builtins.stdout.split(/\r?\n/u).includes(operation)) return
      const rest = operands.map(quote).join(" ")
      if (!alias.startsWith("!")) {
        // Git expands a plain alias in the same process, with the issuing command's options.
        await inspectShell({ command: `git ${invocation.global.map(quote).join(" ")} ${alias} ${rest}`, cwd: directory, env: variables, powershell: false, visit })
        return
      }
      if (target === null) throw unresolved(where)
      // A shell alias runs at the top level with the location and -c settings Git exports to it.
      const top = await read(target, [...location, "rev-parse", "--show-toplevel"], variables)
      const exported = { ...variables }
      for (let i = 0; i < location.length; i++) {
        const [option, value] = location[i].includes("=") ? location[i].split(/=(.*)/su) : [location[i], location[++i]]
        const variable = { "--git-dir": "GIT_DIR", "--work-tree": "GIT_WORK_TREE", "--namespace": "GIT_NAMESPACE" }[option]
        exported[variable] = option === "--namespace" ? value : path.resolve(target, value)
      }
      exported.GIT_CONFIG_PARAMETERS = [variables.GIT_CONFIG_PARAMETERS, ...invocation.commandLine.map(([k, v]) => `'${k}'='${v}'`)].filter(Boolean).join(" ")
      await inspectShell({ command: `${alias.slice(1)} ${rest}`, cwd: top.ok ? top.stdout : target, env: exported, powershell: false, visit })
      return
    }
    const tag = operation === "tag" && target !== null ? createdTag(operands) : undefined
    if (tag !== undefined) created.add(`${target}\0${tag}`)
    const rule = classifyGit(operation, operands, overrides)
    if (!rule) return
    if (target === null || location.some((option) => option.includes(UNKNOWN))) throw unresolved(where)
    if (rule.victim !== undefined) {
      // Force-removal checks the removed checkout with its own identity, not the issuer's overrides.
      const worktrees = await read(target, [...location, "worktree", "list", "--porcelain"], variables)
      const paths = worktrees.stdout.split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9))
      const victim = rule.victim
      if (victim.includes(UNKNOWN)) throw unresolved("which worktree this removes")
      let resolved = path.resolve(target, victim)
      try { resolved = realpathSync(resolved) } catch (error) { if (error.code !== "ENOENT") throw error }
      const found = paths.find((p) => p === resolved) ?? paths.find((p) => path.basename(p) === victim)
      if (found && (await readPolicy(read, found, [], {})).protected) throw new GuardDenial(`Desk protected checkout ${found}: ${MESSAGES.worktreeRemove}`)
      return
    }
    // The policy and the current branch are read together, so most checks take one round of reads.
    const [policy, head] = await Promise.all([
      readPolicy(read, target, location, variables),
      read(target, [...location, "symbolic-ref", "--quiet", "--short", "HEAD"], variables),
    ])
    if (!policy.protected) return
    const reason = await rule(checkoutContext(read, target, location, variables, policy, head.ok && head.stdout ? head.stdout : null, created))
    if (reason) throw new GuardDenial(`Desk protected checkout ${target}: ${reason}`)
  }
  async function guardedVisit(call) {
    try { await visit(call) } catch (error) {
      if (error instanceof GuardDenial) throw error
      if (error.code === "ETIMEDOUT") throw new GuardDenial(`Desk could not finish checking this command within its ${budgetMs / 1000} s budget because Git answered too slowly, so it is denied to keep a protected checkout safe. Retry it, or work in your own worktree: ${WORKTREE_COMMAND}`)
      throw new GuardDenial(`Desk could not inspect a Git command in this shell command (${error.message}), and it could change a protected checkout. Retry it, or work in your own worktree: ${WORKTREE_COMMAND}`)
    }
  }
  try {
    await inspectShell({ command, cwd, env, powershell, visit: guardedVisit })
  } catch (error) {
    if (error instanceof GuardDenial) return { deny: true, reason: error.reason }
    // Text Desk cannot parse is allowed unless it could reach Git (guard-unknowns.js).
    if (!mayInvokeGit(command)) return { deny: false }
    return { deny: true, reason: `Desk could not inspect this shell command (${error.message}), and it could run Git in a protected checkout. Split it into simpler commands, or work in your own worktree: ${WORKTREE_COMMAND}` }
  }
  return { deny: false }
}

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
