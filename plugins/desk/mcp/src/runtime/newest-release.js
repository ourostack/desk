// The newest release at session start. An Agency install of `plugins/desk@release` is served from Agency's cache, which refreshes
// in the background, so the first session after a release runs the release before it. Desk's own tools do not have to: when the
// `release` branch holds a newer Desk than the copy that launched this server, the server loads the newer `plugins/desk/mcp` from
// a copy it keeps under its cache folder, and the runtime pack, source mirror and everything else restore from there as usual.
// Hooks, skills and agents are read from Agency's copy and cannot change under a running host, so those stay on the older release.
//
// The whole step has a time budget (`BUDGET_MS`). A check or download that cannot finish in it, an offline machine, a copy that
// fails to load: the server keeps running the cached copy and says which version that is and why (`newest_release` in
// desk_status, and the stale-Desk line boot prints). Nothing here sends credentials or runs fetched code outside the pack
// verification the runtime already applies; the copy is `ourostack/desk`'s own release branch over HTTPS, as Agency fetches it.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { gunzip } from "node:zlib"
import { resolveDeskChannel } from "./desk-channel.js"
import { compareVersions, latestPluginUrl, parseVersion } from "./stale-desk.js"
import { renameWithRetry } from "../util/rename-retry.js"
import { looksLikeNodeTestRunner } from "./test-state-guard.js"

const gunzipAsync = promisify(gunzip)

const RELEASE_TARBALL_URL = "https://codeload.github.com/ourostack/desk/tar.gz/refs/heads/release"
/** Everything this step may spend before it falls back to the cached copy. */
const BUDGET_MS = 8000
const VERSION_BUDGET_MS = 1500
const MAX_TARBALL_BYTES = 40 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 60 * 1024 * 1024
const KEEP_COPIES = 3
const COMPLETE_FILE = ".complete.json"
const SWITCH = "DESK_NEWEST_RELEASE"
// What a copy keeps from the release: the plugin manifest and the MCP server with its runtime packs.
const WANTED = /^(?:plugin\.json|mcp\/.+)$/u

/** Where the copies live: next to the runtime caches, `<cache>/ouroboros-skills/desk/release-copies`. */
function releaseCopiesDir({ env, homeDir }) {
  const cacheHome = typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME.trim() !== "" ? env.XDG_CACHE_HOME : path.join(env.HOME || homeDir, ".cache")
  return path.join(cacheHome, "ouroboros-skills", "desk", "release-copies")
}

/** The `mcp` folder of a complete copy of `version`, or null. */
function copyMcpRoot({ copiesDir, version }) {
  const dir = path.join(copiesDir, version)
  return existsSync(path.join(dir, COMPLETE_FILE)) ? path.join(dir, "mcp") : null
}

/** Entries of a gzip-decompressed tar as `{ name, data }` for regular files, reading the pax long names git archive writes. Throws on a malformed archive. */
export function* tarFiles(buffer) {
  let offset = 0
  let paxName = null
  const field = (start, length) => {
    const raw = buffer.subarray(offset + start, offset + start + length)
    const end = raw.indexOf(0)
    return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8")
  }
  while (offset + 512 <= buffer.length) {
    if (buffer.subarray(offset, offset + 512).every((byte) => byte === 0)) return
    const size = Number.parseInt(field(124, 12).trim(), 8)
    const type = String.fromCharCode(buffer[offset + 156])
    const bodyStart = offset + 512
    if (!(size >= 0) || bodyStart + size > buffer.length) throw new Error("the archive is damaged")
    const body = buffer.subarray(bodyStart, bodyStart + size)
    if (type === "x") paxName = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(body.toString("utf8"))?.[1] ?? null
    else if (type === "0") {
      yield { name: paxName ?? `${field(345, 155)}${field(345, 155) === "" ? "" : "/"}${field(0, 100)}`, data: body }
      paxName = null
    }
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
}

// `<repo>-release/plugins/desk/<rest>` to `<rest>`, for the files a copy keeps; null for anything else or an unsafe path.
function copyPath(name) {
  const parts = name.split("/")
  const rest = parts.slice(3)
  const unsafe = rest.some((part) => part === "" || part === "." || part === ".." || part.includes("\\") || part.includes(":"))
  return parts[1] === "plugins" && parts[2] === "desk" && !unsafe && WANTED.test(rest.join("/")) ? rest.join("/") : null
}

/** Writes the wanted files of the release tarball into `dir`. Returns the version in its `plugin.json`. */
export function extractRelease({ tar, dir }) {
  let total = 0
  for (const { name, data } of tarFiles(tar)) {
    const rest = copyPath(name)
    if (rest === null) continue
    total += data.length
    if (total > MAX_EXTRACTED_BYTES) throw new Error("the release is larger than a copy may be")
    const target = path.join(dir, ...rest.split("/"))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
  const version = JSON.parse(readFileSync(path.join(dir, "plugin.json"), "utf8")).version
  if (parseVersion(version) === null || !existsSync(path.join(dir, "mcp", "index.js"))) throw new Error("the download is not a Desk release")
  return version
}

// One request with a hard abort at the budget, no headers beyond the default and no credentials.
async function fetchBody(fetchFn, url, budgetMs, read) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budgetMs)
  try {
    const response = await fetchFn(url, { signal: controller.signal, redirect: "follow", credentials: "omit" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await read(response)
  } finally {
    clearTimeout(timer)
  }
}

const readTarball = async (response) => {
  const packed = Buffer.from(await response.arrayBuffer())
  if (packed.length > MAX_TARBALL_BYTES) throw new Error("the release download is too large")
  return gunzipAsync(packed)
}

// Keeps the newest few copies; a copy that will not go stays for the next start.
function prune(copiesDir, keep) {
  try {
    const old = readdirSync(copiesDir)
      .filter((name) => name !== keep)
      .map((name) => ({ name, at: statSync(path.join(copiesDir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(KEEP_COPIES - 1)
    for (const { name } of old) rmSync(path.join(copiesDir, name), { recursive: true, force: true })
  } catch {
    // Nothing to prune.
  }
}

/** Why this step does not apply, or null when it does. */
function notApplicable({ env, pluginRoot, agentHost, running, homeDir, readFile, fetchFn }) {
  if (String(env[SWITCH] ?? "").trim() === "0") return `${SWITCH}=0`
  if (fetchFn === undefined && looksLikeNodeTestRunner(env)) return "a test run"
  const headless = String(env.DESK_FACTORY_HEADLESS ?? "")
  if (headless !== "" && headless !== "0") return "a headless evaluator"
  const { channel, agency } = resolveDeskChannel({ env, agentHost, pluginRoot, running, homeDir, readFile })
  return agency && channel === "release" ? null : "not an Agency install on the release channel"
}

const short = (error) => String(error.message).split("\n")[0].slice(0, 80)

/**
 * The newest release, as one of:
 * - `{ state: "not_applicable", reason }`: this install does not follow the release channel through Agency (or the step is off)
 * - `{ state: "current", running, latest }`: the running copy is the newest release
 * - `{ state: "loaded", running, latest, mcpRoot }`: `mcpRoot` is a complete copy of the newest release
 * - `{ state: "fell_back", running, latest, reason }`: the cached copy stays, and `reason` says why
 * Never rejects and never takes longer than `budgetMs`.
 */
export async function ensureNewestRelease({ env, pluginRoot, running, agentHost, homeDir = os.homedir(), readFile, fetchFn, budgetMs = BUDGET_MS, now = Date.now, copiesDir = releaseCopiesDir({ env, homeDir }) }) {
  const skip = notApplicable({ env, pluginRoot, agentHost, running, homeDir, readFile, fetchFn })
  if (skip !== null) return { state: "not_applicable", reason: skip }
  const started = now()
  // istanbul ignore next -- outside a node:test run the real fetch is used; every test hands its own.
  const doFetch = fetchFn ?? globalThis.fetch
  const fellBack = (latest, reason) => ({ state: "fell_back", running, latest, reason })
  let latest
  try {
    latest = JSON.parse(await fetchBody(doFetch, latestPluginUrl("release"), VERSION_BUDGET_MS, (response) => response.text())).version
  } catch (error) {
    return fellBack(undefined, `it could not read the release channel's version (${short(error)})`)
  }
  const order = compareVersions(running, latest)
  if (order === null) return fellBack(undefined, "the release channel's version was not readable")
  if (order >= 0) return { state: "current", running, latest }
  const ready = copyMcpRoot({ copiesDir, version: latest })
  if (ready !== null) return { state: "loaded", running, latest, mcpRoot: ready }
  const stage = path.join(copiesDir, `.stage-${process.pid}-${started}`)
  try {
    const tar = await fetchBody(doFetch, RELEASE_TARBALL_URL, Math.max(0, budgetMs - (now() - started)), readTarball)
    mkdirSync(stage, { recursive: true })
    const got = extractRelease({ tar, dir: stage })
    if (compareVersions(got, running) <= 0) return { state: "current", running, latest: got }
    writeFileSync(path.join(stage, COMPLETE_FILE), `${JSON.stringify({ version: got, fetched_at: new Date(now()).toISOString() })}\n`)
    // Another start may have finished the same copy first; its copy is as good.
    if (copyMcpRoot({ copiesDir, version: got }) === null) {
      rmSync(path.join(copiesDir, got), { recursive: true, force: true })
      renameWithRetry(stage, path.join(copiesDir, got))
    }
    prune(copiesDir, got)
    return { state: "loaded", running, latest: got, mcpRoot: copyMcpRoot({ copiesDir, version: got }) }
  } catch (error) {
    return fellBack(latest, error.name === "AbortError" ? `the download did not finish within ${Math.round(budgetMs / 1000)} s` : `the download failed (${short(error)})`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** One plain sentence about the outcome, for the agent: which version Desk's tools run and why. Empty when there is nothing to say. */
export function newestReleaseLine(result) {
  if (result.state === "loaded") return `Desk's tools run ${result.latest}, the newest release; this session's hooks and skills come from the ${result.running} copy Agency cached, and refresh when the Copilot app restarts.`
  if (result.state === "fell_back") return `Desk's tools run ${result.running} from the cached copy${result.latest === undefined ? "" : `, though the newest release is ${result.latest}`}: ${result.reason}. The next session start tries again.`
  return ""
}
