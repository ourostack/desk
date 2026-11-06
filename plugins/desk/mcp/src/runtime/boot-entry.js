import os from "node:os"
import { claudeBindingPath, DESK_ROOT_NOT_FOUND } from "../util/paths.js"
import { readSmallText } from "../factory/marker.js"
import { isHeadlessFactorySession } from "../factory/headless-flag.js"
import { resolveStartupDeskRoot } from "./startup-resolve.js"
import { readAgentsMd } from "./agents-md.js"
import { startOrJoinRecovery, recoverySummary } from "./recovery-state.js"
import { syncDegradation } from "./health.js"

export const BOOT_HOSTS = Object.freeze(["claude", "copilot"])
const HOST_ENV = Object.freeze({
  claude: ["CLAUDECODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR"],
  copilot: ["COPILOT_AGENT_SESSION_ID", "COPILOT_CLI", "GITHUB_COPILOT_CLI"],
})

export function resolveBootRoot({
  env = process.env, cwd = process.cwd(), homeDir = env.HOME || os.homedir(),
  readActivationConfig = (file) => readSmallText(file),
} = {}) {
  const bindingPath = claudeBindingPath(env)
  try {
    const resolved = resolveStartupDeskRoot({ args: {}, env, cwd, homeDir, readActivationConfig })
    return { status: "ready", path: resolved.root, source: resolved.source, binding_path: bindingPath }
  } catch (error) {
    return {
      status: error.code === DESK_ROOT_NOT_FOUND ? "setup_required" : "degraded",
      path: error.path ?? null, source: error.source ?? null, binding_path: bindingPath,
      tried: error.tried ?? [], reason: error.code, message: error.message,
    }
  }
}

export function probeHost({
  env = process.env, hostname = os.hostname, userInfo = os.userInfo, cwd = process.cwd,
  platform = os.platform, release = os.release, now = Date.now,
} = {}) {
  const envUser = typeof env.USER === "string" && env.USER !== "" ? env.USER : env.USERNAME
  let user = typeof envUser === "string" && envUser !== "" ? envUser : null
  if (user === null) {
    try { user = userInfo().username } catch { user = null }
  }
  let host
  try { host = hostname() } catch { host = null }
  return { hostname: host, user, cwd: cwd(), platform: platform(), release: release(), probed_at: new Date(now()).toISOString() }
}

export function detectAgentHost(env) {
  if (env.COPILOT_AGENT_SESSION_ID) return "copilot"
  return Object.entries(HOST_ENV).find(([, names]) => names.some((name) => Boolean(env[name])))?.[0] ?? "unknown"
}

export function parseBootArgs(argv) {
  const index = argv.indexOf("--task")
  const value = index === -1 ? undefined : argv[index + 1]
  return {
    taskQuery: typeof value === "string" && value.trim() !== "" && !value.startsWith("--") ? value : null,
    json: argv.includes("--json"), taskOnly: argv.includes("--task-only"),
  }
}

export function bootResult({ status, degraded, pending, instructions = [], root, host }) {
  return {
    boot_complete: true, status, degraded, pending, instructions, covers_hosts: BOOT_HOSTS, root, host,
    migrations: [], prereqs: null, sync: null, sync_summary: null, needs_operator: null,
    agents_md: null, person_agents_md: null, lessons_shelf: null, active_tasks: null, card_parser: "deferred",
    card_validation: [], push_accounts: [], repo_states: [], open_prs: [], task: null, factory: null,
    stale_desk: null, release_alert: null, desk_problems: null,
  }
}

export async function foregroundBoot({ env = process.env, cwd = process.cwd(), taskQuery = null, taskOnly = false } = {}) {
  const host = { ...probeHost({ env }), agent: detectAgentHost(env) }
  const root = resolveBootRoot({ env, cwd })
  const result = bootResult({ status: root.status, degraded: [], pending: [], root, host })
  if (root.status !== "ready") {
    result.instructions = [root.status === "setup_required"
      ? "No desk is bound. Use the existing onboarding path; continue independent authorized work."
      : "The bound desk is unavailable. Preserve the binding; do not substitute another desk. Continue independent authorized work."]
    return result
  }
  const sync = isHeadlessFactorySession(env) ? { state: "skipped", nothingToSync: "headless" }
    : await startOrJoinRecovery({ root: root.path, env, waitMs: 0, bootChecks: true, taskQuery, taskOnly })
  const problem = syncDegradation(sync)
  const checksProblem = sync.operation?.priorChecks && !["ready", "pending", "running"].includes(sync.operation.priorChecks.state)
    ? `background checks: ${sync.operation.priorChecks.reason ?? sync.operation.priorChecks.state}` : null
  result.sync = sync
  result.sync_summary = recoverySummary(sync)
  result.degraded = [problem, checksProblem].filter(Boolean)
  result.status = result.degraded.length > 0 ? "degraded" : "ready"
  result.agents_md = readAgentsMd(root.path)
  result.background = { state: "pending", operationId: sync.operation?.id ?? null }
  if (taskOnly) result.task_only = true
  result.instructions = [
    "Continue the authorized task now. Background checks are pending, not a startup failure or proof of synchronization. Read desk_status before work that depends on remote freshness. Existing root, admission, identity and write-authority gates still apply.",
    ...(sync.state === "unresolved" ? [`Desk sync is unresolved (${sync.reason ?? "unknown outcome"}). Preserve pending files and the index. Inspect the captured operation before another attempt; never rebase or resend an unknown mutation.`] : []),
  ]
  return result
}

export function formatForegroundBootText(result) {
  const lines = [`Desk boot: ${result.status}${result.root?.path ? ` | desk ${result.root.path}${result.root.source ? ` (bound by ${result.root.source})` : ""}` : ""}${result.host ? ` | host ${result.host.hostname ?? "unknown"} / ${result.host.user ?? "unknown"} / ${result.host.agent ?? "unknown"}` : ""}${result.sync_summary ? ` | ${result.sync_summary}` : ""}`]
  for (const reason of result.degraded) lines.push(`- degraded: ${reason}`)
  if (result.instructions.length > 0) lines.push("", "Instructions, in order:", ...result.instructions.map((text, index) => `${index + 1}. ${text}`))
  if (result.agents_md) lines.push("", `## The desk's AGENTS.md (${result.agents_md.path})`, "", result.agents_md.text,
    ...(result.agents_md.truncated ? [`Read the remaining instructions in ${result.agents_md.path}.`] : []))
  return `${lines.join("\n")}\n`
}

export async function runForegroundBootCli({ argv = [], env = process.env, io = process } = {}) {
  let result
  try {
    result = await foregroundBoot({ env, ...parseBootArgs(argv) })
  } catch (error) {
    result = bootResult({ status: "degraded", degraded: [`boot: ${error.message}`], pending: [], root: null, host: null,
      instructions: ["Startup could not establish its result. Preserve the diagnostic and continue independent authorized work; dependent Desk operations still require admission."] })
  }
  io.stdout.write(argv.includes("--json") ? `${JSON.stringify(result)}\n` : formatForegroundBootText(result))
  return 0
}
