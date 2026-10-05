// Desk's process-kill guard: a PreToolUse hook on shell tools that denies the commands that kill the operator's other work.
//
// Incident (2026-10-02). An agent ran `pkill -f "cat" -U $(id -u) -n` to stop one hung process. macOS/BSD pkill stops
// reading options at the first non-option argument, so `-U`, the user id and `-n` became extra PATTERNS, and `-n` never
// applied. It killed about 100 of the operator's processes whose command line held "cat", "-U", "502" or "-n", among them
// 8 Claude Code sessions, 2 Copilot sessions and the browser.
//
// Deny by default (review of #155, the same model as the PowerShell guard): a command that kills processes is denied
// unless it has one of these safe shapes.
//   1. `kill` [signal] followed only by literal positive PIDs or a job spec (`kill -9 123 456`, `kill %1`).
//   2. `pkill` or `pgrep ... | kill` with options before ONE pattern that holds a full path whose basename is not a
//      common name (`pkill -f /Users/x/code/app/server.js`), or `pkill -P <pid>`.
//   3. A port-targeted kill: `lsof -t -i :<port> | xargs kill`, `kill $(lsof -t -i :<port>)`.
//   4. Listing (`pgrep`, `ps`, `lsof`, `grep`) with no kill in the command.
//   5. PowerShell `Stop-Process -Id <ints>` and `taskkill /PID <ints> [/F] [/T]`.
// Everything else that kills is denied: killall and killall5, pkill by user, group, session or terminal or with any
// other pattern, kill targets taken from a substitution or pipe, negative or computed process-group ids, a program name
// from a substitution, Stop-Process without -Id, Get-Process piped to Stop-Process, taskkill without /PID, wmic delete,
// CIM Terminate, `os.kill(-1)` and `process.kill(-1)` one-liners, and osascript quit. It reads Bash through the same inspector the protected-checkout guard uses, so compound commands, `bash -c`, pipelines
// and substitutions are judged command by command; PowerShell is read by text. It never runs anything, and any error
// fails open (the hook entry point allows the call).
import { inspectShell } from "./shell-commands.js"
import { copilotDeny, copilotToolCalls } from "./copilot-hook-payload.js"

const PRINCIPLE = " Stop only processes you started, by their exact PID, and ask the operator before stopping anything else on their machine, such as their terminals, sessions, apps or services."
const FIX = `Stop it by exact PID instead: find it with \`ps -axo pid,command | grep <specific>\` and run \`kill <pid>\`.${PRINCIPLE}`
const WINDOWS_FIX = `Stop it by exact PID instead: find it with \`Get-Process <specific>*\` and run \`Stop-Process -Id <pid>\`.${PRINCIPLE}`
const SAFE = "A pkill pattern is allowed only as one full path with options first, such as `pkill -f /Users/me/code/app/server.js`."
export const MESSAGES = {
  trap: `${FIX} On macOS/BSD, pkill, pgrep and killall stop reading options at the first pattern, so a later option such as -U or -n becomes another pattern and kills every process that matches it, including the operator's other sessions. ${SAFE}`,
  broad: `${FIX} A short, generic, regex or user-wide pattern (cat, node, claude.*, -u 502) matches many processes, including the operator's other Claude and Copilot sessions, and kills them all. ${SAFE}`,
  killall: `${FIX} killall kills every process with that name, including the operator's other Claude and Copilot sessions, terminals and browser. ${SAFE}`,
  source: `${FIX} Targets taken from a substitution or pipe (a grep, awk or pgrep result) can match the operator's other sessions. Only literal PIDs, a full-path pkill pattern or a port (\`lsof -t -i :<port>\`) are allowed.`,
  group: `${FIX} kill with -1, 0, a negative or computed id signals a whole process group or every process you may signal, including the operator's other sessions.`,
  script: `${FIX} A one-line script that calls os.kill, os.killpg or process.kill with -1, 0 or a negative id signals a whole process group, including the operator's other sessions.`,
  quit: `${FIX} Quitting an application by name through osascript closes the operator's own terminal, browser or Finder windows.`,
  windows: `${WINDOWS_FIX} Only Stop-Process -Id and taskkill /PID with literal ids are allowed; a name, wildcard or pipe matches many processes, including the operator's other Claude and Copilot sessions.`,
}

const COMMON = new Set([
  "cat", "node", "git", "python", "python3", "claude", "copilot", "ssh", "bash", "zsh", "sh", "sleep", "npm", "npx", "make", "java", "ruby", "perl",
  "code", "chrome", "firefox", "safari", "docker", "tmux", "vim", "grep", "curl", "cmux", "go", "cargo", "deno", "bun", "pnpm", "yarn", "tsc",
  "pwsh", "powershell", "dotnet", "explorer", "msedge", "edge", "teams", "cmd", "conhost", "ghostty", "terminal", "ps", "ls", "swift", "xcodebuild",
  "finder", "dock", "iterm", "iterm2", "ghostty", "kitty", "alacritty", "wezterm", "warp",
])
const lower = (text) => text.toLowerCase().replace(/\.exe$/u, "")
const isCommon = (text) => COMMON.has(lower(text)) || COMMON.has(lower(text.replace(/\.[a-z0-9]+$/iu, "")))

// A pkill pattern is safe when it has no regex syntax and at least one word is a full path whose basename is specific.
const REGEX_SYNTAX = /[*?[\](){}|^$\\+]/u
const PATH_WORD = /^[\w.@~-]*(?:\/[\w.@~ -]+)+$/u
function specificPath(pattern) {
  if (REGEX_SYNTAX.test(pattern)) return false
  return pattern.split(/\s+/u).some((word) => {
    const base = PATH_WORD.test(word) ? word.split("/").at(-1) : ""
    return base.length >= 3 && !isCommon(base)
  })
}

// Options that take a value, for pkill and pgrep (a cluster such as -fU 502 or -U502 ends in one).
const TAKES_VALUE = "uUgGPstFTjd"
const BLOCKED = "uUgGts"
const LONG_BLOCKED = /^--(?:uid|euid|group|pgroup|session|terminal)(?:=|$)/u
const LONG_VALUE = /^--(?:uid|euid|group|pgroup|parent|session|terminal|signal|pidfile|ns|nslist|delimiter|cgroup)$/u
const SIGNAL = /^-(?:\d+|[A-Z]{2,}\d*)$/u
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "nohup", "exec", "time", "nice", "xargs", "builtin"])
const DEFER = Symbol("deferred")

/** The options, operands and late-option flag of a pkill or pgrep call. */
function parseArguments(args) {
  const options = [], operands = []
  let late = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") { operands.push(...args.slice(i + 1)); break }
    if (!arg.startsWith("-")) { operands.push(arg); continue }
    if (operands.length > 0) late = true
    if (arg.startsWith("--")) { options.push({ long: arg, value: LONG_VALUE.test(arg) ? args[++i] : undefined }); continue }
    if (SIGNAL.test(arg)) continue
    const letters = [...arg.slice(1)]
    const at = letters.findIndex((letter) => TAKES_VALUE.includes(letter))
    for (const [index, letter] of letters.entries()) {
      if (index !== at) { options.push({ letter }); continue }
      options.push({ letter, value: index === letters.length - 1 ? args[++i] : letters.slice(index + 1).join("") })
      break
    }
  }
  return { options, operands, late }
}

/** The reason to deny a pkill-style call (and the pgrep that feeds a kill), or null when it has the safe shape. */
function judgePattern(args) {
  const { options, operands, late } = parseArguments(args)
  if (late) return MESSAGES.trap
  if (options.some((option) => (option.letter ? BLOCKED.includes(option.letter) : LONG_BLOCKED.test(option.long)))) return MESSAGES.broad
  const parent = options.find((option) => option.letter === "P")
  if (parent && /^\d+$/u.test(parent.value ?? "") && operands.length === 0) return null
  return operands.length === 1 && specificPath(operands[0]) ? null : MESSAGES.broad
}

/** What a `kill` call does: a deny reason, DEFER when its targets come from a substitution or pipe, or null. */
function judgeKill(args, viaXargs) {
  let signal = false, rest = false, literal = 0, unknown = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!rest && (arg === "-l" || arg === "-L")) return null
    if (!rest && arg === "--") rest = true
    else if (!rest && (arg === "-s" || arg === "-n")) { i++; signal = true }
    else if (!rest && !signal && /^-(?:\d+|[A-Za-z][A-Za-z0-9]*)$/u.test(arg)) signal = true
    else if (/^(?:[1-9]\d*|%(?:\d+|[+-])?|\$!)$/u.test(arg)) literal++
    else if (arg === "0" || arg.startsWith("-")) return MESSAGES.group
    else if (arg.includes("\0")) unknown = true
    else return MESSAGES.source
  }
  return unknown || (viaXargs && literal === 0) ? DEFER : null
}

/**
 * The verdict on one Bash call (a program and its already-expanded arguments): a deny reason, DEFER when a `kill` takes
 * its targets from a substitution or pipe (the whole command decides), or null. `context.pgrep` records a safe pgrep.
 */
export function judgeCall(program, args, { feedsKill = false, viaXargs = false, context = {} } = {}) {
  const base = program.split("/").at(-1)
  if (WRAPPERS.has(base)) {
    const at = args.findIndex((arg) => { const next = arg.split("/").at(-1); return next === "kill" || WRAPPERS.has(next) || /^(?:pkill|pgrep|killall5?)$/u.test(next) })
    return at < 0 ? null : judgeCall(args[at], args.slice(at + 1), { feedsKill, viaXargs: viaXargs || base === "xargs", context })
  }
  if (base === "kill") return judgeKill(args, viaXargs)
  if (base === "killall" || base === "killall5") return MESSAGES.killall
  if (base === "pkill") return judgePattern(args)
  if (base !== "pgrep") return null
  if (!feedsKill) return parseArguments(args).late ? MESSAGES.trap : null
  const reason = judgePattern(args)
  if (reason === null) context.pgrep = true
  return reason
}

const portTarget = (command) => /\blsof\b[^|;&)]*-\w*i\s*(?:tcp:|udp:|:)?\d+\b/u.test(command) && !/\b(?:pgrep|pkill|ps|grep|awk)\b/u.test(command)
const OTHER_SOURCES = /\b(?:ps|grep|egrep|awk|sed|cut|pidof|top|lsof|xargs\s+-\w*\s*\S*\s*pgrep)\b/u

const taskkillArguments = (text) => {
  const tokens = text.trim().split(/\s+/u).filter(Boolean)
  let pids = 0
  for (let i = 0; i < tokens.length; i++) {
    if (/^[/-][ft]$/iu.test(tokens[i])) continue
    if (/^[/-]pid$/iu.test(tokens[i]) && /^\d+$/u.test(tokens[i + 1] ?? "")) { pids++; i++; continue }
    return false
  }
  return pids > 0
}
const stopProcessArguments = (text) => {
  const rest = text.split("|")[0].replace(/[)}]\s*$/u, "").trim().split(/\s+/u).filter((token) => !/^-(?:force|passthru|whatif|confirm)(?::\S+)?$/iu.test(token)).join(" ")
  return /^(?:-id\s+)?\d+(?:\s*,\s*\d+)*$/iu.test(rest)
}

/** The reason to deny a PowerShell (or Windows-from-Bash) command, read by text, or null. */
export function judgeWindows(command) {
  if (/\bwmic\b[^|;\n]*\b(?:delete|terminate)\b/iu.test(command) || /\b(?:invoke-cimmethod|invoke-wmimethod)\b[^\n]*\bterminate\b/iu.test(command)) return MESSAGES.windows
  if (/(?:get-process|\bgps\b)/iu.test(command) && /\.kill\s*\(\s*\)|\|\s*kill\b/iu.test(command)) return MESSAGES.windows
  for (const statement of command.split(/[;\n]|&&|\|\|/u)) {
    const stop = /(^|[\s(|&{])(?:stop-process|spps)\b/iu.exec(statement)
    if (stop) {
      const piped = stop[1] === "|" || statement.slice(0, stop.index).includes("|")
      if (piped || !stopProcessArguments(statement.slice(stop.index + stop[0].length))) return MESSAGES.windows
    }
    const kill = /(?:^|[{(&|])\s*(?:cmd(?:\.exe)?\s+\/c\s+)?(?:\S*[\\/])?taskkill(?:\.exe)?\b([^|;\n)}]*)/iu.exec(statement)
    if (kill && !taskkillArguments(kill[1])) return MESSAGES.windows
  }
  return null
}

/** The reason to deny a one-line script or osascript call that kills a process group or quits an application, or null. */
export function judgeScript(command) {
  if (/\bkillpg\s*\(|\b(?:os|process)\.kill\s*\(\s*(?:-|0\b)/u.test(command)) return MESSAGES.script
  return /\bosascript\b[\s\S]*?\bquit\b/iu.test(command) ? MESSAGES.quit : null
}

/** The reason to deny a shell command, or null. Never throws: anything it cannot read is allowed. */
export async function judgeProcessKill(command, { cwd = process.cwd() } = {}) {
  if (typeof command !== "string") return null
  try {
    let reason = judgeWindows(command) ?? judgeScript(command)
    if (reason !== null) return reason
    // A program named by a substitution or variable is not visited, so its name cannot be judged.
    if (/kill/iu.test(command) && /(?:^|[;&|({]\s*)(?:sudo\s+)?(?:\$\([^)]*\)|`[^`]*`|\$\{?\w+\}?)\s+[^\s;&|]/u.test(command)) return MESSAGES.source
    const feedsKill = /\bkill\b/u.test(command), context = {}
    let deferred = false
    await inspectShell({
      command, cwd, env: {}, powershell: false,
      visit: ({ name: program, args }) => {
        if (reason !== null) return
        const verdict = judgeCall(program, args, { feedsKill, context })
        if (verdict === DEFER) deferred = true
        else reason ??= verdict
      },
    })
    if (reason === null && deferred && !portTarget(command) && !(context.pgrep && !OTHER_SOURCES.test(command))) reason = MESSAGES.source
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
    const reason = await judgeProcessKill(args?.command, { cwd: input?.cwd ?? process.cwd() })
    if (reason !== null) {
      const output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
      return host === "copilot" ? copilotDeny(output) : output
    }
  }
  return {}
}
