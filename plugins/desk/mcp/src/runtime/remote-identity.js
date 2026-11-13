// Which GitHub account Desk's own fetch, pull and push use for a desk's remote.
//
// The Copilot app starts every process with command-line Git config that resets the host's credential helpers and
// installs its own, which answers with the session's account. That outranks the repository's own pinned helper and
// any route in the user's global Git config, so a session signed in as one account got "Repository not found" from
// a desk whose remote another account owns. The account is the signed-in `gh` account that can reach the remote: the
// user named in `https://<login>@github.com/...`, the repository's owner, or any other account `gh` holds. Organizations
// own many desks, so the owner is not always a login; Desk asks `gh` whether each account can read (or push to) the
// repository. When the environment carries such an override and an account can reach the remote, the credential config
// appended here comes last and wins. Anything less certain (no override, a remote that is not HTTPS, no account that can
// reach it) leaves the environment untouched.

const NETWORK_COMMANDS = new Set(["fetch", "pull", "push"])
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u
const REPO = /^[A-Za-z0-9._-]+$/u
const HOST = /^[a-z0-9][a-z0-9.-]*$/iu
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]
const LOOKUP_TIMEOUT_MS = 3000
const ACCESS_TIMEOUT_MS = 5000
const CACHE_MS = 5 * 60_000

const lookupCache = new Map()

/** `{ origin, host, user, owner, repo }` for an HTTPS repository URL with no embedded password, else `null`. */
export function parseHttpsRemote(url) {
  let parsed
  try { parsed = new URL(String(url).trim()) } catch { return null }
  if (parsed.protocol !== "https:" || parsed.password !== "" || parsed.port !== "" || !HOST.test(parsed.hostname)) return null
  const [owner, name] = parsed.pathname.split("/").filter((part) => part !== "")
  const repo = name?.replace(/\.git$/u, "")
  if (!LOGIN.test(owner ?? "") || !REPO.test(repo ?? "")) return null
  const user = parsed.username === "" ? null : parsed.username
  return { origin: `https://${parsed.hostname}`, host: parsed.hostname, user, owner, repo }
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

function cleanEnv(env) {
  const clean = { ...env }
  for (const name of TOKEN_VARIABLES) delete clean[name]
  return clean
}

// Answers from `cache` for CACHE_MS, so a Desk process asks gh once per account rather than once per Git command.
function remembered(cache, now, key, compute) {
  const cached = cache.get(key)
  if (cached !== undefined && now() - cached.at < CACHE_MS) return cached.value
  const value = compute()
  cache.set(key, { value, at: now() })
  return value
}

function signedInLogins({ host, env, spawn, cache, now }) {
  return remembered(cache, now, `logins\0${host}`, () => {
    const result = spawn("gh", ["auth", "status", "--hostname", host], { windowsHide: true, encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, env: cleanEnv(env) })
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    return [...new Set([...text.matchAll(/Logged in to \S+ account (\S+)/gu)].map((match) => match[1]))].filter((login) => LOGIN.test(login))
  })
}

function tokenFor({ host, login, env, spawn }) {
  const result = spawn("gh", ["auth", "token", "--hostname", host, "--user", login], { windowsHide: true, encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, env: cleanEnv(env) })
  return result.status === 0 ? result.stdout.trim() : ""
}

// Whether gh's account for `login` can read the repository, or push to it when `push` is set.
function canUse({ host, login, owner, repo, push, env, spawn, cache, now }) {
  return remembered(cache, now, [host, login, owner, repo, push].join("\0"), () => {
    const token = tokenFor({ host, login, env, spawn })
    if (token === "") return false
    const field = push ? "push" : "pull"
    const result = spawn("gh", ["api", `repos/${owner}/${repo}`, "--hostname", host, "--jq", `.permissions.${field}`], { windowsHide: true, encoding: "utf8", timeout: ACCESS_TIMEOUT_MS, env: { ...cleanEnv(env), GH_TOKEN: token } })
    return result.status === 0 && result.stdout.trim() === "true"
  })
}

function gitText(spawn, root, args, env) {
  const result = spawn("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, env })
  return result.status === 0 ? result.stdout.trim() : ""
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
 * `env` for one Git command. For a fetch, pull or push whose remote is an HTTPS repository, and only when `env` already
 * overrides credential helpers, the result ends with a helper for the first signed-in `gh` account that can reach the
 * repository (the account named in the URL first, then its owner, then the rest). Any other command or situation returns
 * `env` itself. `spawn` runs both `git` and `gh`.
 */
export function remoteIdentityEnv({ root, args, env, spawn, cache = lookupCache, now = Date.now }) {
  if (!NETWORK_COMMANDS.has(args[0]) || !hasCredentialOverride(env)) return env
  const remote = parseHttpsRemote(remoteUrl({ spawn, root, args, env }))
  if (remote === null) return env
  const push = args[0] === "push"
  const named = [remote.user, remote.owner, ...signedInLogins({ host: remote.host, env, spawn, cache, now })]
  const candidates = [...new Set(named)].filter((login) => login !== null && LOGIN.test(login))
  const login = candidates.find((candidate) => canUse({ ...remote, login: candidate, push, env, spawn, cache, now }))
  if (login === undefined) return env
  const key = `credential.${remote.origin}.helper`
  return appendConfig(env, [[key, ""], [key, credentialHelperFor({ host: remote.host, login })]])
}
