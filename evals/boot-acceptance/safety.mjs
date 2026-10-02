// What keeps a harness run from writing anywhere real.
//
// A run gives the agent `bypassPermissions`, the real login keychain and a
// copy of the real `gh` account list, so isolation cannot rest on the agent
// behaving. Three layers, each independent:
//
//   1. `buildChildEnv`: the `claude` child gets an allowlisted environment,
//      never a copy of the parent's. Every location Desk or Claude Code
//      resolves from the environment points inside the run's temp HOME.
//   2. `gh` shim first on PATH: `classifyGh` allows read-only subcommands and
//      the shim exits 97 on anything else, logging the attempt. Tokens are
//      not passed through the environment.
//   3. A `git clone`, `fetch` or `push` to any GitHub URL is rewritten to a dead local path by a
//      run-private global git config (`insteadOf` and `pushInsteadOf`), so it fails at once
//      with no network traffic. The fixture's local bare origin works.
//
// The transcript check (`ghWriteAttempts`) then fails any run whose commands
// show a write attempt, in case something bypassed the shim (for example by
// calling the real binary by path).

import { chmodSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import * as process from "node:process"

// ---------------------------------------------------------------------------
// Layer 2: which `gh` invocations are read-only.
// ---------------------------------------------------------------------------

const READ_VERBS = {
  // `auth token` is read-only and the boot script needs it to resolve each account's push route. The shim prints the raw token only to that script (the one `session-boot.js` of the plugin under test; see `isBootScriptCommand`); to any other caller its output is redacted.
  auth: ["status", "token"],
  pr: ["list", "view", "status", "diff", "checks"],
  issue: ["list", "view", "status"],
  repo: ["view", "list", "clone"],
  run: ["list", "view"],
  release: ["list", "view"],
  gist: ["list", "view"],
  label: ["list"],
  workflow: ["list", "view"],
  ruleset: ["list", "view", "check"],
  config: ["get", "list"],
  cache: ["list"],
  secret: [],
  variable: ["list", "get"],
}
const READ_ONLY_GROUPS = new Set(["search", "status", "version", "completion", "help"])
const WRITE_API_FLAGS = /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/

/**
 * `{ allowed, reason }` for one `gh` argument list. Unknown commands are
 * denied: only what is listed as read-only passes.
 */
export function classifyGh(args) {
  const words = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--version" || a === "-h" || a === "--help") return { allowed: true, reason: "informational" }
    // A global `-R/--repo` takes a value; skip it so it is not read as the command.
    if ((a === "-R" || a === "--repo") && words.length === 0) { i++; continue }
    if (a.startsWith("-") && words.length === 0) continue
    words.push(a)
  }
  const [group, verb] = words
  if (!group) return { allowed: true, reason: "no subcommand" }
  if (READ_ONLY_GROUPS.has(group)) return { allowed: true, reason: `gh ${group} is read-only` }
  if (group === "auth" && verb === "status" && args.some((a) => a === "--show-token" || /^-[A-Za-z]*t[A-Za-z]*$/.test(a))) return { allowed: false, reason: "gh auth status -t/--show-token prints a token" }
  if (group === "api") {
    const rest = args.slice(args.indexOf("api") + 1)
    for (let i = 0; i < rest.length; i++) {
      if (WRITE_API_FLAGS.test(rest[i])) {
        const method = rest[i] === "-X" || rest[i] === "--method" ? String(rest[i + 1] ?? "").toUpperCase() : rest[i].startsWith("--method=") ? rest[i].slice(9).toUpperCase() : null
        if (method === "GET" || method === "HEAD") continue
        return { allowed: false, reason: `gh api with ${rest[i]} can write` }
      }
    }
    if (words[1] === "graphql") return { allowed: false, reason: "gh api graphql is a POST" }
    return { allowed: true, reason: "gh api GET" }
  }
  const verbs = READ_VERBS[group]
  if (verbs && verbs.includes(verb)) return { allowed: true, reason: `gh ${group} ${verb} is read-only` }
  return { allowed: false, reason: `gh ${group}${verb ? ` ${verb}` : ""} is not on the read-only list` }
}

/** Splits a shell command line into the `gh ...` argument lists it runs (naive, and deliberately over-inclusive). */
export function ghInvocations(command) {
  const out = []
  for (const segment of String(command).split(/&&|\|\||;|\||\n|\$\(|`/)) {
    const m = segment.trim().match(/^(?:\w+=\S+\s+)*(?:\S*\/)?gh(?:\s+(.*))?$/)
    if (m) out.push(tokenize(m[1] ?? ""))
  }
  return out
}

function tokenize(text) {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}

/**
 * True when `commandLine` is `node [flags] <absolute path> ...` and that path, resolved with `realpath`, is exactly `bootScript` (the realpath of the plugin under test's `mcp/scripts/session-boot.js`, fixed when the shim is installed). A relative path is refused (the shim cannot know the parent's cwd), as is a lookalike script anywhere else, a script reached through a symlink to somewhere else, and a shell whose command text only mentions the script. Anything unparseable, such as a path with a space in it, fails closed.
 */
export function isBootScriptCommand(commandLine, bootScript, resolve = realpathSync) {
  if (!bootScript) return false
  const m = String(commandLine).trim().match(/^(?:\S*\/)?node(?:\.exe)?(?:\s+--?\S+)*\s+(\S+)(?:\s|$)/)
  if (!m || !path.isAbsolute(m[1])) return false
  try {
    return resolve(m[1]) === bootScript
  } catch {
    return false
  }
}

/** The command line of process `pid` (`ps`), or "" when it cannot be read. */
export function processCommand(pid) {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : ""
}

/** Every `gh` write the transcript's Bash commands attempted, plus any call to a `gh` binary by path (which skips the shim). */
export function ghWriteAttempts(commands) {
  const found = []
  for (const command of commands) {
    if (/(^|[\s;&|(])(?:\/\S*\/)gh(\s|$)/.test(command)) found.push(`called gh by path: ${command.slice(0, 120)}`)
    for (const args of ghInvocations(command)) {
      const verdict = classifyGh(args)
      if (!verdict.allowed) found.push(`${verdict.reason}: gh ${args.join(" ").slice(0, 100)}`)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Token-shaped strings. `gh auth token` is allowed (to the boot script only;
// the shim redacts it for every other caller), and a transcript check fails
// any run in which a token-shaped string still shows up, as a second layer.
// ---------------------------------------------------------------------------

export const REDACTION_MARKER = "[REDACTED-TOKEN]"
// No boundary in front: a token after a JSON-escaped newline (`\nghp_...`) or glued to a prefix (`x_ghp_...`) must still be found.
const TOKEN_SHAPE = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g

/** Every token-shaped string (gh[pousr]_..., github_pat_...) in `text`. */
export function findTokens(text) {
  return String(text).match(TOKEN_SHAPE) ?? []
}

/** `text` with every token-shaped string replaced by the redaction marker, so a leak never reaches a saved file. */
export function redactTokens(text) {
  return String(text).replace(TOKEN_SHAPE, REDACTION_MARKER)
}

/** `text` with every token-shaped string and every exact value in `secrets` (a credential the run was given, whatever it looks like) replaced by the redaction marker. */
export function redactSecrets(text, secrets = []) {
  let out = redactTokens(text)
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join(REDACTION_MARKER)
  return out
}

/** How many token-shaped strings or redaction markers `text` holds: a leak that was seen, or one already redacted when the text was saved. */
export function countTokenLeaks(text) {
  const t = String(text)
  return findTokens(t).length + t.split(REDACTION_MARKER).length - 1
}

// ---------------------------------------------------------------------------
// Shim installation.
// ---------------------------------------------------------------------------

/**
 * `realEnv` (`{ set, unset }`, optional) changes the environment the shim gives the real `gh`: the harness uses it to run `gh` against the operator's real login while the agent's own HOME holds no keychain link and no `gh` account list, so a model that calls `gh` by path, or reads its HOME, finds no credential.
 *
 * Writes `<shimDir>/gh`, a script that classifies its arguments with
 * `classifyGh`, runs the real `gh` for read-only calls and otherwise exits 97
 * after appending the attempt to `logFile`. `realGh` is the real binary.
 */
export function installGhShim({ shimDir, realGh, logFile, bootScript = null, realEnv = null }) {
  mkdirSync(shimDir, { recursive: true })
  const policy = new URL("./safety.mjs", import.meta.url).href
  // Who gets a raw token: only the plugin under test's own boot script (an exact realpath match, baked in at install time), found by the shim's parent process (`ps`), never by an environment variable the model's shell could also set. The boot script spawns `gh` with a piped stdout, so its token goes to the script and not into the transcript. Everyone else (the model's shell, a hook) gets the child's output captured and passed through `redactTokens`, with the exit code kept.
  const script = `#!${process.execPath}
import { classifyGh, isBootScriptCommand, processCommand, redactTokens } from ${JSON.stringify(policy)}
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"
const realEnv = ${JSON.stringify(realEnv)}
const ghEnv = { ...process.env }
if (realEnv) {
  for (const name of realEnv.unset ?? []) delete ghEnv[name]
  Object.assign(ghEnv, realEnv.set ?? {})
}
const args = process.argv.slice(2)
const verdict = classifyGh(args)
if (!verdict.allowed) {
  try { appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, reason: verdict.reason }) + "\\n") } catch {}
  process.stderr.write("gh blocked by the boot-acceptance harness: " + verdict.reason + ". Runs may only read from GitHub.\\n")
  process.exit(97)
}
if (isBootScriptCommand(processCommand(process.ppid), ${JSON.stringify(bootScript)})) {
  const raw = spawnSync(${JSON.stringify(realGh)}, args, { stdio: "inherit", env: ghEnv })
  process.exit(raw.status ?? 1)
}
const r = spawnSync(${JSON.stringify(realGh)}, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: ghEnv })
process.stdout.write(redactTokens(r.stdout ?? ""))
process.stderr.write(redactTokens(r.stderr ?? ""))
process.exit(r.status ?? 1)
`
  const file = path.join(shimDir, "gh.mjs")
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  // The entry point has no extension so `gh` resolves on PATH.
  writeFileSync(path.join(shimDir, "gh"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(file)} "$@"\n`)
  chmodSync(path.join(shimDir, "gh"), 0o755)
  return path.join(shimDir, "gh")
}

/** The real `gh` on `searchPath`, ignoring `skipDir`. */
export function findRealGh(searchPath, skipDir = null) {
  for (const dir of String(searchPath ?? "").split(path.delimiter)) {
    if (!dir || dir === skipDir) continue
    const candidate = path.join(dir, "gh")
    if (existsSync(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Layers 1 and 3: the child environment and the run-private git config.
// ---------------------------------------------------------------------------

// Only these come from the parent. PATH is prefixed with the shim directory
// by the caller; HOME is always the run's temp HOME. Anthropic credentials
// are passed only if the parent has them (on macOS login is normally the
// keychain, reached through the HOME symlink).
const BASE_PASS_THROUGH = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "TZ", "USER", "LOGNAME", "SHELL", "TMPDIR"]
const CLAUDE_PASS_THROUGH = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "AWS_REGION", "AWS_PROFILE",
]
export const PASS_THROUGH = [...BASE_PASS_THROUGH, ...CLAUDE_PASS_THROUGH]
// The Copilot child gets none of the Anthropic or AWS credentials: its only credential is `extraEnv` (see copilot.mjs `resolveCopilotAuth`).
export const COPILOT_PASS_THROUGH = BASE_PASS_THROUGH

/** Writes the run's private global git config: no credential helper, and fetches and pushes to GitHub URLs rewritten to a dead local path, so a clone or fetch fails at once instead of downloading a real repository. */
export function writeGitConfig(homeDir) {
  const dead = "file:///nonexistent/offline-remotes/"
  // GitHub's spellings first, then every network scheme as a catch-all, so another host, `www.github.com` and a URL with embedded credentials are rewritten too.
  // `file://` and plain paths (the fixture's own origin) match none of these. Left open: an scp-style `user@host:path` on a host other than github.com.
  const prefixes = ["https://github.com/", "http://github.com/", "https://www.github.com/", "http://www.github.com/", "git://github.com/", "git@github.com:", "ssh://git@github.com/", "https://", "http://", "git://", "ssh://"]
  const body = [
    "[user]", "\tname = Desk Operator", "\temail = operator@example.com",
    "[commit]", "\tgpgsign = false",
    `[url "${dead}"]`, ...prefixes.flatMap((p) => [`\tinsteadOf = ${p}`, `\tpushInsteadOf = ${p}`]),
  ].join("\n") + "\n"
  const file = path.join(homeDir, ".gitconfig")
  writeFileSync(file, body)
  return file
}

/**
 * The allowlisted environment for the host's child (`claude` by default). `host: "copilot"` passes no Anthropic or AWS variable and instead gets `extraEnv`: the
 * explicit, named variables the host needs (its credential, its profile folder). Nothing else is inherited.
 */
export function buildChildEnv({ parentEnv, homeDir, shimDir, gitConfig, ghLog, host = "claude", extraEnv = {} }) {
  const env = {}
  for (const name of host === "copilot" ? COPILOT_PASS_THROUGH : PASS_THROUGH) if (parentEnv[name] !== undefined) env[name] = parentEnv[name]
  Object.assign(env, extraEnv)
  env.PATH = [shimDir, parentEnv.PATH ?? "/usr/bin:/bin"].join(path.delimiter)
  env.HOME = homeDir
  env.XDG_CONFIG_HOME = path.join(homeDir, ".config")
  env.XDG_STATE_HOME = path.join(homeDir, ".local", "state")
  env.XDG_CACHE_HOME = path.join(homeDir, ".cache")
  // DESK_RUNTIME_CACHE_DIR, DESK_*, GH_TOKEN, GITHUB_TOKEN and CLAUDE_CONFIG_DIR are never passed: absent, Desk and Claude Code use the paths below.
  env.XDG_DATA_HOME = path.join(homeDir, ".local", "share")
  env.GIT_CONFIG_GLOBAL = gitConfig
  env.GIT_CONFIG_NOSYSTEM = "1"
  env.GIT_TERMINAL_PROMPT = "0"
  env.GH_PROMPT_DISABLED = "1"
  env.GH_CONFIG_DIR = path.join(homeDir, ".config", "gh")
  env.GH_SHIM_LOG = ghLog
  // Desk's boot looks up the latest Desk version on the network; fixtures never do.
  env.DESK_BOOT_VERSION_CHECK = "0"
  env.DESK_BOOT_AUTO_REFRESH = "0"
  return env
}
