// Desk's credential-probe guard: a PreToolUse hook on shell tools that denies the commands that expose or probe a GitHub credential.
//
// Incident (boot-acceptance round AK, 2026-10-06). A Copilot agent (claude-haiku-4.5) was told "never print, count or test it on
// its own", then ran `ls -la ~/.config/gh/hosts.yml`, `GH_TOKEN=$(gh auth token --user X 2>&1) && echo "Token retrieved
// (${#GH_TOKEN} chars)" || echo "Failed: $GH_TOKEN"` (the failure branch prints the token or its error) and `gh api -H
// "Authorization: token $GH_TOKEN"`. The text rule did not hold, so the call is denied.
//
// This is a poka-yoke for an honest agent's clumsy probes, not a security boundary. It stops accidental exposure of the token; it
// does not try to beat an agent that is working around it, and a shell deny-list could not. Known limits (left out on purpose):
// `${!v}` indirection, gh aliases, GIT_* and GH_* environment variables that name a program, globbed or interpreter file reads,
// inline interpreter code beyond naming the variable, wrappers that run a command from text (xargs, find -exec, ssh, docker) and
// PowerShell reflection.
//
// Deny by default for `gh auth token` that is executed. The token may be read in exactly these ways:
//   1. A real assignment of GH_TOKEN or GITHUB_TOKEN whose whole value is one `gh auth token [--user X] [--hostname H]`
//      substitution (stderr may go to /dev/null), as a prefix to a command (`GH_TOKEN=$(...) git push`), exported
//      (`export GH_TOKEN=$(...)`) or declared (`declare -x`, `local`). Child processes may inherit it, but nothing may print it,
//      dump the environment, trace it (`set -x`, `bash -x`) or name it in inline code.
//   2. Inside a git credential helper passed with -c, in the one shape Desk gives:
//      `credential.helper='!f(){ echo username=x-access-token; echo password=$(gh auth token --user X); };f'`.
// Denied: printing, counting or testing the token variable; `gh auth token` with its output going anywhere else (stdout, a file,
// a pipe, another variable, a URL or an Authorization header); `gh auth status --show-token`; an environment dump that can show
// the token (`env`, `printenv`, `set`, `export -p`, `declare -x`, `/proc/*/environ`, `ps e`, jq or awk reading the environment)
// unless it is filtered to something that is no secret; reading gh's or git's credential stores (`hosts.yml`, `.git-credentials`,
// `security find-*-password`, `git credential fill`, `gh auth git-credential`). A mention of `gh auth token` in an argument
// (a commit message, a test name, a file name) is never denied. It reads Bash through the same inspector as the other guards, so
// compound commands, `bash -c`, `eval`, pipelines and substitutions are judged command by command; PowerShell is read by text.
// It never runs anything, and any error fails open (the hook entry point allows the call), except that a command the inspector
// cannot read and that names `gh auth token` is denied.
import * as path from "node:path"
import { inspectShell, tokenizeShell } from "./shell-commands.js"
import { copilotDeny, copilotToolCalls } from "./copilot-hook-payload.js"

const DESK = "Desk already resolved the push route; if a gh or git call fails, report its error as it is."
const WHY = "`gh auth token` may only fill GH_TOKEN or GITHUB_TOKEN for one git or gh command, or sit in a git credential helper, because any other use prints, stores or sends the GitHub token."
export const MESSAGES = {
  token: `Use \`GH_TOKEN=$(gh auth token --user <account>) git ...\` or \`gh ...\` directly; never run \`gh auth token\` alone. ${DESK} ${WHY}`,
  print: `Use \`GH_TOKEN=$(gh auth token --user <account>) gh ...\` and leave the token variable alone. ${DESK} Never print, count, test or list the token, or put $GH_TOKEN or $GITHUB_TOKEN in a URL, a header or another command's arguments.`,
  store: `Use \`gh auth status\` to check a sign-in, and never read gh's or git's credential stores. ${DESK} hosts.yml, .git-credentials, keychain dumps, \`git credential fill\` and \`gh auth git-credential\` print stored tokens.`,
  helper: `Use only the credential helper Desk gives, in exactly its shape, and no other helper or git setting that runs a program. ${DESK} The shape: \`git -c credential.helper='!f(){ echo username=x-access-token; echo password=$(gh auth token --user <account>); };f' push ...\`.`,
  unreadable: `Use \`GH_TOKEN=$(gh auth token --user <account>) git ...\` as one plain command. ${DESK} Desk could not read this command, and it names \`gh auth token\`.`,
}

// A stand-in for the operator's own GH_TOKEN, so that any expansion of $GH_TOKEN or $GITHUB_TOKEN is visible in an argument.
const SENTINEL = "\u0002token\u0002"
const UNKNOWN = "\0"
const TOKEN_VARIABLES = new Set(["GH_TOKEN", "GITHUB_TOKEN"])

const ACCOUNT = "[A-Za-z0-9][A-Za-z0-9_.-]*"
const GH_CALL = `gh auth token(?: (?:--user|-u)[ =]${ACCOUNT})?(?: (?:--hostname|-h)[ =]${ACCOUNT})?`
// An account name, an unset variable's empty value, or a default the shell has not expanded (`"${GH_USER:-x}"`).
const ACCOUNT_VALUE = new RegExp(`^(?:${ACCOUNT}|\\$\\{[A-Za-z_]\\w*:-${ACCOUNT}\\}|)$`, "u")
const IDENTITY = "echo username=[A-Za-z0-9_.@-]+"
// The one credential-helper text Desk gives, in the two orders git accepts, written with `gh auth token` or with the exported variable.
const HELPER_VALUES = [
  new RegExp(`^!f\\(\\)\\s*\\{\\s*(?:${IDENTITY};\\s*echo password=\\$\\(${GH_CALL}\\)|echo password=\\$\\(${GH_CALL}\\);\\s*${IDENTITY});?\\s*\\};\\s*f$`, "u"),
  new RegExp(`^!(?:${IDENTITY};\\s*echo password=\\$\\{?(?:GH|GITHUB)_TOKEN\\}?|echo password=\\$\\{?(?:GH|GITHUB)_TOKEN\\}?;\\s*${IDENTITY})$`, "u"),
]
const HELPER_KEY = /^credential(?:\.[^\s=]+)?\.helper$/iu
const TOKEN_TEXT = /\bgh(?:\.exe)?\s+auth\s+token\b|(?:GH|GITHUB)_TOKEN/u

/** Whether a git `-c` argument (or a `git config` value) that mentions the token is the helper Desk gives. */
function isHelper(arg) {
  const at = arg.indexOf("=")
  const value = at > 0 && HELPER_KEY.test(arg.slice(0, at)) ? arg.slice(at + 1) : arg
  return HELPER_VALUES.some((expression) => expression.test(value))
}

// Credential stores, as normalized paths: a file, or the directory that holds them (which only a program that reads contents may name).
export const STORE_FILE = /(?:^|\/)(?:gh\/hosts\.yml|\.git-credentials|\.netrc|\.config\/git\/credentials|\.copilot\/(?:config|settings)\.json|\.claude\/\.credentials\.json)$|^\/hosts\.yml$/u
const STORE_DIRECTORY = /(?:^|\/)\.config\/gh(?:\/\*)?$/u
const READERS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "cp", "strings", "xxd", "od", "base64", "bat", "tar", "zip"])
const STORE_REDIRECT = /<\s*["']?[^\s"'<>;&|]*(?:gh\/hosts\.yml|\.git-credentials|\.netrc|\.config\/git\/credentials)/u
// A reference to the token variable (`$GH_TOKEN`, `${#GH_TOKEN}`, `${GH_TOKEN:-x}`) in text the shell expands: unquoted or double-quoted,
// in an argument, a redirection target or a here-string. Single-quoted text is data, so the credential helper's `$GH_TOKEN` passes.
const TOKEN_REFERENCE = /\$\{?[#!]?\s*(?:GH|GITHUB)_TOKEN(?!\w)/u
function referencesToken(command) {
  return tokenizeShell(command).some((token) => (token.heredoc !== undefined && !token.literal && TOKEN_REFERENCE.test(token.heredoc)) || token.parts?.some((part) => part.expand && TOKEN_REFERENCE.test(part.text)))
}
const KEYCHAIN = /^(?:find-[a-z]*-?password|dump-keychain|export)$/u
const INTERPRETERS = new Set(["node", "nodejs", "deno", "bun", "python", "python2", "python3", "perl", "ruby", "php", "lua", "awk", "gawk", "osascript"])
const INLINE_TOKEN = /(?:GH|GITHUB)_TOKEN|%ENV\b|os\.environ\s*[,)]|process\.env\s*[,)]/u
// A statement that lists every variable: `env`, `printenv`, `set`, `export -p`, `declare -x` with no name after it. The inspector does not
// visit builtins, so this reads the text. A dump piped to `grep PATH` shows no secret unless the token is set in the same command.
const ENV_DUMP = /(?:^|[;&|(\n]\s*)(?:env|printenv|set|export\s+-p|(?:declare|typeset)(?:\s+-[A-Za-z]+)*)[ \t]*(?=$|[;&|)\n])/gu
const DUMP_FILTER = /^[ \t]*\|[ \t]*(?:grep|egrep|fgrep|rg)[ \t]+(?:-\S+[ \t]+)*(\S+)/u
const DUMP_COUNT = /^[ \t]*\|[ \t]*wc[ \t]+-[lcw]\b/u
const SECRETISH = /token|secret|key|pass|gh_|github|auth|cred|copilot|\*|\./iu
const TRACE = /(?:^|[;&|(\n]\s*)set\s+(?:-[A-Za-z]*x|-o\s+xtrace)|\b(?:bash|sh|zsh|dash|ksh)\s+(?:-\S+\s+)*-[A-Za-z]*x\b/u
const SHELL_CODE = /\b(?:bash|sh|zsh|dash|ksh)\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+("(?:[^"\\]|\\.)*"|'[^']*')/gu
const CODE_READS_TOKEN = /\$\{?[#!]?\s*(?:GH|GITHUB)_TOKEN|(?:^|[;&|(\s])(?:set|env|printenv|export\s+-p)\s*(?:$|[;&|)])/u
const GIT_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"])

/** The subcommand of a git call (`git -c k=v -C dir credential fill` is `credential`), or "". */
function gitSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (GIT_VALUE_OPTIONS.has(args[i])) i++
    else if (!args[i].startsWith("-")) return args[i]
  }
  return ""
}

/** The reason to deny one `gh` call that names `auth`, or null. `via` says what a `$(...)` it sits in is the value of. */
function judgeGhAuth(args, via, seen) {
  const rest = args.slice(args.indexOf("auth") + 1)
  if (rest[0] === "git-credential") return MESSAGES.store
  if (rest[0] === "status") return rest.some((arg) => arg === "--show-token" || /^-[A-Za-z]*t[A-Za-z]*$/u.test(arg)) ? MESSAGES.token : null
  if (rest[0] !== "token") return null
  // Asking for help prints no token.
  if (rest.includes("--help")) return null
  // Only `--user X` and `--hostname H` (or -u, -h, and the `--user=X` form) with plain values may follow.
  const options = rest.slice(1).flatMap((arg) => (/^--?[a-z]+=/u.test(arg) ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg]))
  for (let i = 0; i < options.length; i += 2) {
    if (!["--user", "-u", "--hostname", "-h"].includes(options[i]) || !ACCOUNT_VALUE.test(options[i + 1] ?? "")) return MESSAGES.token
  }
  if (!via?.real || !TOKEN_VARIABLES.has(via.name)) return MESSAGES.token
  // The assignment's whole value is this one substitution, which holds one plain command (stderr may go to /dev/null).
  if (via.word.parts.map((part) => part.text).join("") !== `${via.name}=$(${via.text})`) return MESSAGES.token
  const tokens = tokenizeShell(via.text)
  for (const [index, token] of tokens.entries()) {
    if (typeof token === "string") return MESSAGES.token
    if (token.redirect === undefined) continue
    const target = tokens[index + 1]?.parts?.map((part) => part.text).join("")
    if (target !== "/dev/null") return MESSAGES.token
  }
  seen.token = true
  return null
}

// `ps` options that take a value (`-o user`, `-p 123`, `-u me`, `-C node`): the value is not a flag.
const PS_VALUE_LETTERS = new Set("oOpPuUCGgtsqU")
/** Whether `ps` is asked to show each process's environment: `-E`, or the BSD `e` flag word (`e`, `eww`, `aux e`) before any dashed option. */
function psEnvironment(args) {
  let leading = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("-")) {
      if (leading && /^[A-Za-z]+$/u.test(arg) && arg.includes("e")) return true
      continue
    }
    leading = false
    if (/^-[A-Za-z]*E/u.test(arg)) return true
    if (/^-[A-Za-z]+$/u.test(arg) && PS_VALUE_LETTERS.has(arg.at(-1))) i++
  }
  return false
}

// The jq words that read the environment, outside string literals: `env`, `env.X`, `env | keys`, `{env, x}` and `$ENV`.
const readsEnvironment = (filter) => /(?:^|[^.\w$])env(?=\s*(?:$|[.|),}\][]))|\$ENV\b/u.test(filter.replace(/"(?:[^"\\]|\\.)*"/gu, '""'))

/** The reason to deny one visited command, or null. `seen` records that an allowed `gh auth token` ran. */
function judgeCall({ name, args, env, cwd, via, computed }, seen) {
  if (name === "security" && args.some((arg) => KEYCHAIN.test(arg))) return MESSAGES.store
  if (name.startsWith("git-credential")) return MESSAGES.store
  const paths = args.map((arg) => path.posix.normalize(arg))
  // `test -f ~/.config/gh/hosts.yml` and `[ -e ... ]` ask whether the file exists, and read none of it.
  const exists = (name === "test" || name === "[" || name === "[[") && /^-[a-zA-Z]$/u.test(args[0])
  const bareHosts = /(?:^|\/)\.config\/gh$/u.test(cwd) && args.includes("hosts.yml")
  if (!exists && (bareHosts || paths.some((arg) => STORE_FILE.test(arg) || (READERS.has(name) && STORE_DIRECTORY.test(arg))))) return MESSAGES.store
  const sub = name === "git" ? gitSubcommand(args) : ""
  if (sub === "credential" || sub.startsWith("credential-")) return MESSAGES.store
  if (name === "gh" && args.includes("auth")) {
    const reason = judgeGhAuth(args, via, seen)
    if (reason !== null) return reason
  }
  // Any expansion of the operator's own token variable, in the arguments of any program, prints or sends it.
  if (args.some((arg) => arg.includes(SENTINEL) || /^\/proc\/(?:self|\d+)\/environ$/u.test(arg))) return MESSAGES.print
  // A program Desk could not name that is given `auth token` is `gh auth token` by another name.
  if (computed && args.includes("auth") && args.includes("token")) return MESSAGES.token
  // The environment, token included: `printenv NAME`, `ps e`, `awk ENVIRON`, jq or gh --jq reading `env`, `declare -p GH_TOKEN`.
  const jq = name === "jq" ? args : name === "gh" ? args.filter((arg, i) => args[i - 1] === "--jq" || args[i - 1] === "-q" || arg.startsWith("--jq=")) : []
  if (jq.some(readsEnvironment) || (name === "printenv" && args.some((arg) => /TOKEN/iu.test(arg))) || (name === "ps" && psEnvironment(args)) || ((name === "awk" || name === "gawk") && args.some((arg) => arg.includes("ENVIRON")))) return MESSAGES.print
  if ((name === "declare" || name === "typeset") && args.some((arg) => !arg.includes("=") && /TOKEN/iu.test(arg))) return MESSAGES.print
  // `env` with no command (the inspector reports it with an empty name) and `printenv` list the environment: denied here while the
  // token is set in the same command, and otherwise by the text check, which lets a filtered listing through.
  const holds = seen.token && [...TOKEN_VARIABLES].some((variable) => env[variable] !== undefined && env[variable] !== SENTINEL && env[variable].includes(UNKNOWN))
  if (holds && (name === "" || name === "printenv")) return MESSAGES.print
  if (name === "git") {
    // A mention of the token in a `-c` option or a `git config` value is allowed only as the helper Desk gives.
    const inConfig = sub === "config" ? args : args.filter((arg, i) => args[i - 1] === "-c")
    if (inConfig.some((arg) => TOKEN_TEXT.test(arg) && !isHelper(arg))) return MESSAGES.helper
  }
  // Inline interpreter code that names the token variable (`node -e`, `python -c`, `perl -e`, `ruby -e`) reads and can print it.
  if (INTERPRETERS.has(name) && args.some((arg) => /^-[A-Za-z]*[ecpE]$|^--(?:eval|print)$/u.test(arg)) && args.some((arg) => INLINE_TOKEN.test(arg))) return MESSAGES.print
  // A child process that only inherits the variable is no exposure, but a script that is handed the variable by name
  // (`eval 'echo $GH_TOKEN'`) is.
  if (holds && name !== "git" && name !== "gh" && seen.mentions && args.some((arg) => arg.includes(UNKNOWN))) return MESSAGES.print
  return null
}

const POWERSHELL_ASSIGNMENT = new RegExp(`(?:^|[;\\n])\\s*\\$env:(?:GH|GITHUB)_TOKEN\\s*=\\s*(?:\\$?\\(\\s*)?${GH_CALL.replace("gh auth", "gh(?:\\.exe)? auth")}\\s*\\)?\\s*(?=[;\\n]|$)`, "giu")

/** The reason to deny a PowerShell command, read by text, or null. */
export function judgePowerShell(command) {
  // The one allowed read: `$env:GH_TOKEN = gh auth token --user X` (or in parentheses or `$(...)`) on its own, then git or gh.
  const rest = command.replace(POWERSHELL_ASSIGNMENT, ";")
  if (/\bgh(?:\.exe)?\s+auth\s+(?:token|git-credential)\b|--show-token|\bgh(?:\.exe)?\s+auth\s+status\b[^;\n|]*\s-t\b/iu.test(rest)) return MESSAGES.token
  if (/\$\{?env:(?:GH|GITHUB)_TOKEN\b|\[(?:System\.)?Environment\]::GetEnvironmentVariable\(\s*['"](?:GH|GITHUB)_TOKEN|\b(?:gci|ls|dir|Get-ChildItem|gi|Get-Item)\s+env:|\bGet-Content\s+env:/iu.test(rest)) return MESSAGES.print
  if (/(?:^|[\\/\s'"])(?:gh[\\/]hosts\.yml|GitHub CLI[\\/]hosts\.yml|\.git-credentials|\.netrc)\b|\bcmdkey\b[^;\n]*\/list|\bgit(?:\.exe)?\s+credential\b|git-credential-/iu.test(rest)) return MESSAGES.store
  return null
}

/** The reason to deny a command that, once inspected, set the token in this command, or null: tracing it, a shell script that reads it, a dump of the environment. */
function judgeHeld(command, seen) {
  if (seen.token) {
    if (TRACE.test(command)) return MESSAGES.print
    for (const match of command.matchAll(SHELL_CODE)) if (CODE_READS_TOKEN.test(match[1].slice(1, -1))) return MESSAGES.print
  }
  // An environment dump is denied when the token is set in the same command or when nothing filters it, and allowed when it is piped to a grep for something that is no secret.
  for (const match of command.matchAll(ENV_DUMP)) {
    const filter = DUMP_FILTER.exec(command.slice(match.index + match[0].length))
    if (!seen.token && DUMP_COUNT.test(command.slice(match.index + match[0].length))) continue
    if (seen.token || filter === null || SECRETISH.test(filter[1])) return MESSAGES.print
  }
  return null
}

/** The reason to deny a Bash command, or null. */
async function judgeBash(command, cwd) {
  const seen = {}
  let reason = STORE_REDIRECT.test(command) ? MESSAGES.store : null
  seen.mentions = TOKEN_REFERENCE.test(command)
  try {
    if (referencesToken(command)) return MESSAGES.print
    const env = { HOME: process.env.HOME, ...Object.fromEntries([...TOKEN_VARIABLES].map((variable) => [variable, SENTINEL])) }
    await inspectShell({ command, cwd, env, powershell: false, visit: (event) => { reason ??= judgeCall(event, seen) } })
  } catch {
    // A command the inspector cannot read is allowed, unless it names `gh auth token`.
    reason ??= /\bgh\b[^\n]*\bauth\b[^\n]*\btoken\b|--show-token/u.test(command) ? MESSAGES.unreadable : null
  }
  return reason ?? judgeHeld(command, seen)
}

/** The reason to deny a shell command, or null. A command it cannot read is allowed unless it names `gh auth token`; the hook entry point allows the call on any other error. */
export async function judgeCredentialProbe(command, { cwd = process.cwd(), powershell = false } = {}) {
  if (typeof command !== "string") return null
  return powershell ? judgePowerShell(command) : judgeBash(command, cwd)
}

/** The PreToolUse hook: `{}` to allow, or a deny in the host's shape. `input` is the hook's JSON stdin. */
export async function credentialProbeGuardHook(input, host) {
  const calls = host === "copilot" ? copilotToolCalls(input) : [{ toolName: input?.tool_name, args: input?.tool_input }]
  for (const { toolName, args } of calls) {
    if (toolName !== "Bash" && toolName !== "PowerShell") continue
    const reason = await judgeCredentialProbe(args?.command, { cwd: input?.cwd ?? process.cwd(), powershell: toolName === "PowerShell" })
    if (reason !== null) {
      const output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
      return host === "copilot" ? copilotDeny(output) : output
    }
  }
  return {}
}
