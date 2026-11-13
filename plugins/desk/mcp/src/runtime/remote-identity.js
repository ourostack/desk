// Which GitHub account Desk's own fetch, pull and push use for a desk's remote.
//
// The Copilot app starts every process with command-line Git config that resets the host's credential helpers and
// installs its own, which answers with the session's account. That outranks the repository's own pinned helper and
// any route in the user's global Git config, so a session signed in as one account got "Repository not found" from
// a desk whose remote another account owns. The remote's own URL names that account: the user in
// `https://<login>@github.com/...`, or else the owner of a user-owned repository. When the environment carries such an
// override and `gh` holds a token for that login, the credential config appended here comes last and wins. Anything
// less certain (no override, a remote that is not HTTPS, no token for the login) leaves the environment untouched.

import { spawnSync } from "node:child_process"

const NETWORK_COMMANDS = new Set(["fetch", "pull", "push"])
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u
const HOST = /^[a-z0-9][a-z0-9.-]*$/iu
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]
const LOOKUP_TIMEOUT_MS = 3000
const TOKEN_CACHE_MS = 5 * 60_000

const tokenCache = new Map()

/** `{ origin, host, user, owner }` for an HTTPS remote URL with no embedded password, else `null`. */
export function parseHttpsRemote(url) {
  let parsed
  try { parsed = new URL(String(url).trim()) } catch { return null }
  if (parsed.protocol !== "https:" || parsed.password !== "" || parsed.port !== "" || !HOST.test(parsed.hostname)) return null
  const user = parsed.username === "" ? null : decodeURIComponent(parsed.username)
  const owner = parsed.pathname.split("/").filter((part) => part !== "")[0] ?? null
  return { origin: `https://${parsed.hostname}`, host: parsed.hostname, user, owner }
}

/** Whether the environment's command-line Git config sets a credential helper, as the Copilot app's does. */
export function hasCredentialOverride(env) {
  if (/\bcredential\.[^='\s]*helper'?=/u.test(env.GIT_CONFIG_PARAMETERS ?? "")) return true
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10)
  for (let index = 0; index < (Number.isInteger(count) ? count : 0); index += 1) if (/^credential\.(?:.*\.)?helper$/iu.test(env[`GIT_CONFIG_KEY_${index}`] ?? "")) return true
  return false
}

/** A helper that asks `gh` for the login's token when Git asks, so no secret appears in a command line or in config. */
export function credentialHelperFor({ host, login }) {
  const unset = TOKEN_VARIABLES.map((name) => `-u ${name}`).join(" ")
  return `!f() { test "$1" = get || exit 0; t=$(env ${unset} gh auth token --hostname ${host} --user ${login} 2>/dev/null); if test -n "$t"; then echo username=${login}; echo "password=$t"; else echo quit=1; fi; }; f`
}

// Git reads GIT_CONFIG_PARAMETERS after GIT_CONFIG_COUNT's entries, and the app's override lives in one or both, so
// only an entry appended to GIT_CONFIG_PARAMETERS is certain to come last.
const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`

function appendConfig(env, pairs) {
  const existing = (env.GIT_CONFIG_PARAMETERS ?? "").trim()
  const added = pairs.map(([key, value]) => quoted(`${key}=${value}`))
  return { ...env, GIT_CONFIG_PARAMETERS: [existing, ...added].filter((part) => part !== "").join(" ") }
}

function hasToken({ host, login, env, spawn, cache, now }) {
  const key = `${host}\0${login}`
  const cached = cache.get(key)
  if (cached !== undefined && now() - cached.at < TOKEN_CACHE_MS) return cached.ok
  const clean = { ...env }
  for (const name of TOKEN_VARIABLES) delete clean[name]
  const result = spawn("gh", ["auth", "token", "--hostname", host, "--user", login], { windowsHide: true, encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, env: clean })
  const ok = result?.status === 0 && typeof result.stdout === "string" && result.stdout.trim() !== ""
  cache.set(key, { ok, at: now() })
  return ok
}

function gitText(spawn, root, args, env) {
  const result = spawn("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, env })
  return result?.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : ""
}

// The URL this command talks to: a URL or remote named in its arguments, else the current branch's upstream remote.
function remoteUrl({ spawn, root, args, env }) {
  const named = args.slice(1).find((arg) => !arg.startsWith("-"))
  if (named !== undefined && /^https:\/\//u.test(named)) return named
  const urlKeys = (name) => (args[0] === "push" ? [`remote.${name}.pushurl`, `remote.${name}.url`] : [`remote.${name}.url`])
  const read = (name) => urlKeys(name).map((key) => gitText(spawn, root, ["config", "--get", key], env)).find((text) => text !== "") ?? ""
  if (named !== undefined) {
    const url = read(named)
    if (url !== "") return url
  }
  const branch = gitText(spawn, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], env)
  const upstream = branch === "" ? "" : gitText(spawn, root, ["config", "--get", `branch.${branch}.remote`], env)
  return read(upstream === "" ? "origin" : upstream)
}

/**
 * `env` for one Git command. For a fetch, pull or push whose remote is an HTTPS URL naming a login that `gh` holds a
 * token for, and only when `env` already overrides credential helpers, the result ends with a helper for that login.
 * Any other command or situation returns `env` itself. `spawn` runs both `git` and `gh` (tests only).
 */
export function remoteIdentityEnv({ root, args, env, spawn = spawnSync, cache = tokenCache, now = Date.now }) {
  if (!NETWORK_COMMANDS.has(args[0]) || !hasCredentialOverride(env)) return env
  const remote = parseHttpsRemote(remoteUrl({ spawn, root, args, env }))
  if (remote === null) return env
  const logins = [...new Set([remote.user, remote.owner])].filter((login) => login !== null && LOGIN.test(login))
  const login = logins.find((candidate) => hasToken({ host: remote.host, login: candidate, env, spawn, cache, now }))
  if (login === undefined) return env
  const key = `credential.${remote.origin}.helper`
  return appendConfig(env, [[key, ""], [key, credentialHelperFor({ host: remote.host, login })]])
}
