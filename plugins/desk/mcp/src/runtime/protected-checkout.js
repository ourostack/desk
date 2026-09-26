import { existsSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { inspectShell } from "./shell-commands.js"
import { runGit } from "./state-branch.js"
import { readInspectionGit as readGit } from "./git-inspection.js"
import { physicalDirectory } from "./shell-paths.js"
import { inspectGitOptions } from "./git-guard-options.js"

export const WORKTREE_GUIDANCE = 'shared checkout: use git worktree add --detach "$(mktemp -d)" <ref>'
const OPERATIONS = new Set(["checkout", "switch", "reset", "rebase", "pull", "merge", "stash", "clean"])

// Git copies config.worktree to new worktrees. An exact gitdir conditional include
// keeps this local marker on the bound checkout without changing Git's extensions.
export async function protectCheckout({ root, git = runGit }) {
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
  await write(["config", "--local", `includeIf.gitdir:${pattern}.path`, marker])
  return { protected: true }
}

async function protectedTarget(cwd, options, env) {
  const location = await readGit(cwd, [...options, "rev-parse", "--absolute-git-dir"], env)
  if (!location.ok) return false
  const config = await readGit(cwd, [...options, "config", "--show-scope", "--type=bool", "--get-all", "desk.protected"], env)
  if (!config.ok && config.code !== 1) throw new Error(`cannot read checkout protection: ${config.stderr}`)
  const values = config.stdout.split(/\r?\n/u).filter((line) => /^(local|worktree)\s/u.test(line))
  return values.length > 0 && /\s+true$/u.test(values[values.length - 1])
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

function destructive(name, args) {
  if (OPERATIONS.has(name)) return true
  if (name === "restore" || name === "branch") return inspectGitOptions(name, args).enabled
  return name === "worktree" && args[0] === "remove" && inspectGitOptions("remove", args.slice(1)).enabled
}

export async function guardShellCommand({ command, cwd, env = process.env, powershell = false }) {
  let deny = false
  const inspected = new Set()
  async function visit({ name, args, cwd: directory, env: variables }) {
    if (name !== "git") return
    const invocation = gitInvocation(args, directory)
    if (!invocation || !existsSync(invocation.cwd)) return
    const { location, aliases } = invocation
    const operation = invocation.name, operands = invocation.args
    const key = JSON.stringify([invocation, [...aliases], variables])
    if (inspected.has(key)) return
    inspected.add(key)
    if (operation && !OPERATIONS.has(operation) && !["restore", "branch", "worktree"].includes(operation)) {
      const alias = aliases.get(operation) ?? (await readGit(invocation.cwd, [...location, "config", "--get", `alias.${operation}`], variables)).stdout
      if (alias) {
        const builtins = await readGit(invocation.cwd, ["--list-cmds=builtins"], variables)
        if (builtins.stdout.split(/\r?\n/u).includes(operation)) return
        const target = await readGit(invocation.cwd, [...location, "rev-parse", "--show-toplevel"], variables)
        // Git runs shell aliases at its top level. Quoted arguments remain arguments.
        const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`
        const text = `${alias.startsWith("!") ? alias.slice(1) : `git ${alias}`} ${operands.map(quote).join(" ")}`
        await inspectShell({ command: text, cwd: target.ok ? target.stdout : invocation.cwd, env: variables, powershell, visit })
        return
      }
    }
    if (!destructive(operation, operands)) return
    if (operation === "worktree") {
      const [target] = inspectGitOptions("remove", operands.slice(1)).operands
      if (target) {
        const worktrees = await readGit(invocation.cwd, [...location, "worktree", "list", "--porcelain"], variables)
        const paths = worktrees.stdout.split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9))
        let resolved = path.resolve(invocation.cwd, target)
        try { resolved = realpathSync(resolved) } catch (error) { if (error.code !== "ENOENT") throw error }
        const found = paths.find((p) => p === resolved) ?? paths.find((p) => path.basename(p) === target)
        if (found && await protectedTarget(found, [], {})) deny = true
      }
      return
    }
    if (await protectedTarget(invocation.cwd, location, variables)) deny = true
  }
  await inspectShell({ command, cwd, env, powershell, visit })
  return deny ? { deny: true, reason: WORKTREE_GUIDANCE } : { deny: false }
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
