import { existsSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { inspectShell } from "./shell-commands.js"
import { runGit } from "./state-branch.js"
import { readInspectionGit as readGit } from "./git-inspection.js"
import { existingDirectory, physicalDirectory } from "./shell-paths.js"
import { BUILTINS, classifyGit, MESSAGES } from "./git-guard-policy.js"
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

async function protectedTarget(cwd, options, env) {
  const config = await readGit(cwd, [...options, "config", "--show-scope", "--type=bool", "--get-all", "desk.protected"], env)
  // Outside a checkout, or with a location that is not one, Git reports no value (exit 1) and there is no local policy.
  if (!config.ok && config.code !== 1) throw new Error(`cannot read checkout protection: ${config.stderr}`)
  const values = config.stdout.split(/\r?\n/u).filter((line) => /^(local|worktree)\s/u.test(line))
  return values.length > 0 && /\s+true$/u.test(values[values.length - 1])
}

// Lazy, cached reads of the target checkout for the policy's checks.
function checkoutContext(cwd, options, env) {
  const cache = new Map()
  const read = (key, args) => {
    if (!cache.has(key)) cache.set(key, readGit(cwd, [...options, ...args], env))
    return cache.get(key)
  }
  const value = async (key, args) => { const result = await read(key, args); return result.ok && result.stdout ? result.stdout : null }
  const known = (text, what) => {
    if (text.includes(UNKNOWN)) throw unresolved(what)
    return text
  }
  const context = {
    known,
    branch: () => value("branch", ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    head: () => value("head", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    async stateBranch() { return await value("state", ["config", "--get", "desk.stateBranch"]) ?? context.branch() },
    commit: (rev) => value(`commit ${known(rev, "a Git revision")}`, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]),
    fullName: (rev) => value(`name ${known(rev, "a Git revision")}`, ["rev-parse", "--symbolic-full-name", rev.startsWith("-") ? "--" : rev]),
    tag: async (name) => await value(`tag ${name}`, ["rev-parse", "--verify", "--quiet", `refs/tags/${name}`]) !== null,
    remoteBranch: async (name) => await value(`remote ${name}`, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/*/${name}`]) !== null,
    pushed: async () => await value("pushed", ["for-each-ref", "--count=1", "--contains=HEAD", "--format=%(refname)", "refs/remotes"]) !== null,
    // Called only on the state branch, so HEAD names a branch.
    async upstream() {
      const branch = await context.branch()
      const [ref, remote, merge] = await Promise.all([
        value("upstream", ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
        value("upstream remote", ["config", "--get", `branch.${branch}.remote`]),
        value("upstream merge", ["config", "--get", `branch.${branch}.merge`]),
      ])
      return ref && remote && merge ? { ref, remote, merge } : null
    },
  }
  return context
}

function gitInvocation(args, cwd) {
  const location = [], aliases = new Map()
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
      const match = /^alias\.([^=]+)=(.*)$/su.exec(config ?? "")
      if (match) aliases.set(match[1], match[2])
    } else if (arg === "--config-env") i++
    else if (arg === "--") { i++; break }
    else if (arg === "--help" || arg === "--version") return null
  }
  return { cwd, location, aliases, name: args[i], args: args.slice(i + 1) }
}

export async function guardShellCommand({ command, cwd, env = process.env, powershell = false }) {
  const inspected = new Set()
  async function visit({ name, args, cwd: directory, env: variables }) {
    if (name !== "git") return
    const invocation = gitInvocation(args, directory)
    if (!invocation || invocation.name === undefined) return
    const { location, aliases, name: operation, args: operands } = invocation
    if (operation.includes(UNKNOWN)) throw unresolved("which Git command this runs")
    const target = invocation.cwd === UNKNOWN ? null : existingDirectory(invocation.cwd)
    const where = "which checkout this Git command runs in"
    if (target !== null && !existsSync(target)) return
    const key = JSON.stringify([invocation, [...aliases], variables])
    if (inspected.has(key)) return
    inspected.add(key)
    if (!BUILTINS.has(operation)) {
      if (target === null) throw unresolved(where)
      const alias = aliases.get(operation) ?? (await readGit(target, [...location, "config", "--get", `alias.${operation}`], variables)).stdout
      if (!alias) return
      const builtins = await readGit(target, ["--list-cmds=builtins"], variables)
      if (builtins.stdout.split(/\r?\n/u).includes(operation)) return
      const top = await readGit(target, [...location, "rev-parse", "--show-toplevel"], variables)
      // Git runs shell aliases at its top level. Quoted arguments remain arguments.
      const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`
      const text = `${alias.startsWith("!") ? alias.slice(1) : `git ${alias}`} ${operands.map(quote).join(" ")}`
      await inspectShell({ command: text, cwd: top.ok ? top.stdout : target, env: variables, powershell, visit })
      return
    }
    const rule = classifyGit(operation, operands)
    if (!rule) return
    if (target === null || location.some((option) => option.includes(UNKNOWN))) throw unresolved(where)
    if (rule.victim !== undefined) {
      // Force-removal checks the removed checkout with its own identity, not the issuer's overrides.
      const worktrees = await readGit(target, [...location, "worktree", "list", "--porcelain"], variables)
      const paths = worktrees.stdout.split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9))
      const victim = rule.victim
      if (victim.includes(UNKNOWN)) throw unresolved("which worktree this removes")
      let resolved = path.resolve(target, victim)
      try { resolved = realpathSync(resolved) } catch (error) { if (error.code !== "ENOENT") throw error }
      const found = paths.find((p) => p === resolved) ?? paths.find((p) => path.basename(p) === victim)
      if (found && await protectedTarget(found, [], {})) throw new GuardDenial(`Desk protected checkout ${found}: ${MESSAGES.worktreeRemove}`)
      return
    }
    if (!await protectedTarget(target, location, variables)) return
    const reason = await rule(checkoutContext(target, location, variables))
    if (reason) throw new GuardDenial(`Desk protected checkout ${target}: ${reason}`)
  }
  async function guardedVisit(call) {
    try { await visit(call) } catch (error) {
      if (error instanceof GuardDenial) throw error
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
