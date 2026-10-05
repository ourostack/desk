// Desk's process-kill guard: a PreToolUse hook on shell tools that denies the commands that kill the operator's other work.
//
// Incident (2026-10-02). An agent ran `pkill -f "cat" -U $(id -u) -n` to stop one hung process. macOS/BSD pkill stops
// reading options at the first non-option argument, so `-U`, the user id and `-n` became extra PATTERNS, and `-n` never
// applied. It killed about 100 of the operator's processes whose command line held "cat", "-U", "502" or "-n", among them
// 8 Claude Code sessions, 2 Copilot sessions and the browser. This guard denies:
//   1. pkill, pgrep or killall with an option after the first non-option argument (the BSD parsing trap);
//   2. pkill (or a pgrep that feeds a kill) with a pattern shorter than 8 characters or a single common word, and
//      killall of a common name;
//   3. kill of -1, 0 or a negative process-group id (kill -9 -1, kill 0);
//   4. on Windows, Stop-Process -Name or taskkill /IM with a common name, and Get-Process with a wildcard (or no
//      name) piped to Stop-Process.
// It reads Bash through the same inspector the protected-checkout guard uses, so compound commands, `bash -c`, pipelines
// and substitutions are judged command by command; PowerShell is read by text. It never runs anything, and any error
// fails open (the hook entry point allows the call).
import { inspectShell } from "./shell-commands.js"
import { copilotDeny, copilotToolCalls } from "./copilot-hook-payload.js"

const FIX = "Stop it by exact PID instead: find it with `ps -axo pid,command | grep <specific>` and run `kill <pid>`."
const WINDOWS_FIX = "Stop it by exact PID instead: find it with `Get-Process <specific>*` and run `Stop-Process -Id <pid>`."
export const MESSAGES = {
  trap: `${FIX} On macOS/BSD, pkill, pgrep and killall stop reading options at the first pattern, so a later option such as -U or -n becomes another pattern and kills every process that matches it, including the operator's other sessions.`,
  broad: `${FIX} A short or generic name such as cat, node or git matches many processes, including the operator's other Claude and Copilot sessions, and kills them all.`,
  group: `${FIX} kill with -1, 0 or a negative id signals a whole process group or every process you may signal, including the operator's other sessions.`,
  windows: `${WINDOWS_FIX} A common or wildcard name matches many processes, including the operator's other Claude and Copilot sessions, and stops them all.`,
}

const COMMON = new Set([
  "cat", "node", "git", "python", "python3", "claude", "copilot", "ssh", "bash", "zsh", "sh", "sleep", "npm", "npx", "make", "java", "ruby", "perl",
  "code", "chrome", "firefox", "safari", "docker", "tmux", "vim", "grep", "curl", "cmux", "go", "cargo", "deno", "bun", "pnpm", "yarn", "tsc",
  "pwsh", "powershell", "dotnet", "explorer", "msedge", "edge", "teams", "cmd", "conhost", "ghostty", "terminal", "ps", "ls", "swift", "xcodebuild",
])
const name = (text) => text.toLowerCase().replace(/\.exe$/u, "").replace(/^[\^'"]+|[$'"]+$/gu, "")
const isCommon = (text) => COMMON.has(name(text))
const isBroad = (pattern) => name(pattern).length < 8 || isCommon(pattern)

// Options that take a value, per command (a cluster such as -fU 502 or -U502 ends in one).
const TAKES_VALUE = { pkill: "uUgGPstFTjd", pgrep: "uUgGPstFTjd", killall: "utcoy" }
const LONG_VALUE = /^--(?:uid|euid|group|pgroup|parent|session|terminal|signal|pidfile|ns|nslist|delimiter|cgroup)$/u
const SIGNAL = /^-(?:\d+|[A-Z]{2,}\d*)$/u
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "nohup", "exec", "time", "nice", "xargs", "builtin"])

/** The options and operands of a pkill, pgrep or killall call, and whether an option comes after the first operand. */
function parseArguments(command, args) {
  const operands = []
  let late = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") { operands.push(...args.slice(i + 1)); break }
    if (!arg.startsWith("-")) { operands.push(arg); continue }
    if (operands.length > 0) late = true
    if (arg.startsWith("--")) { if (LONG_VALUE.test(arg)) i++; continue }
    if (SIGNAL.test(arg)) continue
    const at = [...arg.slice(1)].findIndex((letter) => TAKES_VALUE[command].includes(letter))
    if (at >= 0 && at === arg.length - 2) i++
  }
  return { operands, late }
}

/** Whether a `kill` call names -1, 0 or a negative process-group id taken from a pattern (kill -9 -1, kill 0, kill -- -1). */
function killsGroup(args) {
  let signal = false, rest = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (rest) { if (/^(?:0|-\d+)$/u.test(arg)) return true; continue }
    if (arg === "--") rest = true
    else if (arg === "-s" || arg === "-n") { i++; signal = true }
    else if (arg === "-l" || arg === "-L") return false
    else if (arg.startsWith("-")) { if (signal && /^-\d+$/u.test(arg)) return true; signal = true }
    else if (arg === "0") return true
  }
  return false
}

/** The reason to deny one Bash call (a program and its already-expanded arguments), or null. */
export function judgeCall(program, args, { feedsKill = false } = {}) {
  const base = program.split("/").at(-1)
  if (WRAPPERS.has(base)) {
    const at = args.findIndex((arg) => { const next = arg.split("/").at(-1); return next === "kill" || WRAPPERS.has(next) || Object.hasOwn(TAKES_VALUE, next) })
    return at < 0 ? null : judgeCall(args[at], args.slice(at + 1), { feedsKill })
  }
  if (base === "kill") return killsGroup(args) ? MESSAGES.group : null
  if (!Object.hasOwn(TAKES_VALUE, base)) return null
  const { operands, late } = parseArguments(base, args)
  if (late) return MESSAGES.trap
  if (base === "killall" ? operands.some(isCommon) : (base === "pkill" || feedsKill) && operands.some(isBroad)) return MESSAGES.broad
  return null
}

const WINDOWS_WORD = /stop-process|taskkill|\bspps\b|get-process|\bgps\b/iu
const names = (text) => text.split(",").map((part) => part.trim().replace(/^['"]|['"]$/gu, "")).filter(Boolean)
const broadWindows = (value) => isCommon(value) || (/[*?]/u.test(value) && (isCommon(value.replace(/[*?]/gu, "")) || value.replace(/[*?]/gu, "").length < 4))

/** The reason to deny a PowerShell (or Windows-from-Bash) command, read by text, or null. */
export function judgeWindows(command) {
  for (const statement of command.split(/[;\n]|&&|\|\|/u)) {
    const stop = /(?:^|[\s(|&])(?:stop-process|spps)\b[^|]*?(?:\s-n(?:ame)?[\s:=]+)(\S+(?:\s*,\s*\S+)*)/iu.exec(statement)
    if (stop && names(stop[1]).some((value) => broadWindows(value))) return MESSAGES.windows
    const kill = /\btaskkill(?:\.exe)?\b.*?[/-]im\s+(\S+)/iu.exec(statement)
    if (kill && names(kill[1]).some((value) => broadWindows(value))) return MESSAGES.windows
    const [first, second] = statement.split("|").map((part) => part.trim())
    if (second && /^(?:stop-process|spps|kill)\b/iu.test(second) && /^(?:get-process|gps|ps)\b/iu.test(first)) {
      const values = first.split(/\s+/u).slice(1).filter((word) => !word.startsWith("-"))
      if (values.length === 0 || values.some((value) => names(value).some((one) => one.includes("*") || isCommon(one)))) return MESSAGES.windows
    }
  }
  return null
}

/** The reason to deny a shell command, or null. Never throws: anything it cannot read is allowed. */
export async function judgeProcessKill(command, { powershell = false, cwd = process.cwd() } = {}) {
  if (typeof command !== "string") return null
  try {
    let reason = WINDOWS_WORD.test(command) ? judgeWindows(command) : null
    if (reason !== null || powershell) return reason
    const feedsKill = /\bkill\b/u.test(command)
    await inspectShell({
      command, cwd, env: {}, powershell: false,
      visit: ({ name: program, args }) => { reason ??= judgeCall(program, args, { feedsKill }) },
    })
    return reason
  } catch {
    return null
  }
}

/** The PreToolUse hook: `{}` to allow, or a deny in the host's shape. `input` is the hook's JSON stdin. */
export async function processKillGuardHook(input, host) {
  const calls = host === "copilot" ? copilotToolCalls(input) : [{ toolName: input?.tool_name, args: input?.tool_input }]
  for (const { toolName, args } of calls) {
    if (toolName !== "Bash" && toolName !== "PowerShell") continue
    const reason = await judgeProcessKill(args?.command, { powershell: toolName === "PowerShell", cwd: input?.cwd ?? process.cwd() })
    if (reason !== null) {
      const output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
      return host === "copilot" ? copilotDeny(output) : output
    }
  }
  return {}
}
