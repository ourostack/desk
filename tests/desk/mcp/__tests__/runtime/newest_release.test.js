// Desk's tools load the newest release at session start: how the copy is fetched and kept, when the step stands down, and what a cached fallback says.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { gzipSync } from "node:zlib"
import { main } from "../../../../../plugins/desk/mcp/index.js"
import { checkStaleDesk } from "../../../../../plugins/desk/mcp/src/runtime/stale-desk.js"
import { ensureNewestRelease, extractRelease, newestReleaseLine, tarFiles } from "../../../../../plugins/desk/mcp/src/runtime/newest-release.js"
import { mkTempRoot } from "../_temp_roots.js"
import { idleSearchEngine } from "./_in_process_desk.js"
import { osEnv } from "../_os_env.js"

// A tar with ustar headers; a name over 100 characters goes in a pax header the way git archive writes it.
function tarOf(files) {
  const blocks = []
  const header = (name, size, type) => {
    const block = Buffer.alloc(512)
    block.write(name.slice(0, 100), 0)
    block.write("0000644\0", 100)
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124)
    block.write(type, 156)
    block.write("ustar\0", 257)
    return block
  }
  const body = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    if (name.length > 100) {
      const rest = ` path=${name}\n`
      let length = rest.length + 1
      while (String(length).length + rest.length !== length) length = String(length).length + rest.length
      const pax = Buffer.from(`${length}${rest}`)
      blocks.push(header("pax", pax.length, "x"), body(pax))
    }
    blocks.push(header(name, data.length, "0"), body(data))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const top = "ourostack-desk-abc123"
function release(version, extra = {}) {
  return {
    [`${top}/plugins/desk/plugin.json`]: JSON.stringify({ name: "desk", version }),
    [`${top}/plugins/desk/mcp/index.js`]: "// server\n",
    [`${top}/plugins/desk/mcp/src/${"deep/".repeat(22)}file.js`]: "// long path\n",
    [`${top}/plugins/desk/skills/x/SKILL.md`]: "skill",
    [`${top}/README.md`]: "readme",
    [`${top}/plugins/desk/mcp/../../escape.txt`]: "escape",
    ...extra,
  }
}

// An Agency session on the release channel, with its caches under one temp root.
async function install(prefix) {
  const base = await mkTempRoot(prefix)
  const pluginRoot = path.join(base, ".local", "agency", "plugins", "sessions", "agency-plugin-x", "desk")
  mkdirSync(pluginRoot, { recursive: true })
  const env = osEnv({ HOME: base, XDG_CACHE_HOME: path.join(base, "cache"), XDG_STATE_HOME: path.join(base, "state"), AGENCY_ENGINE: "copilot", AGENCY_SESSION_ID: "s" })
  return { base, pluginRoot, env, copiesDir: path.join(base, "cache", "ouroboros-skills", "desk", "release-copies") }
}

// A GitHub that serves the release branch's plugin.json and tarball.
function github(version, { tarball = () => gzipSync(tarOf(release(version))), manifest = () => JSON.stringify({ version }) } = {}) {
  const seen = []
  const fetchFn = async (url, { signal } = {}) => {
    seen.push(url)
    const answer = url.endsWith("plugin.json") ? manifest() : tarball(signal)
    if (answer instanceof Promise) return answer
    return { ok: true, status: 200, text: async () => answer, arrayBuffer: async () => answer.buffer.slice(answer.byteOffset, answer.byteOffset + answer.length) }
  }
  return { fetchFn, seen, tarballs: () => seen.filter((url) => !url.endsWith("plugin.json")).length }
}

test("a release tarball extracts the plugin manifest and the server, and nothing outside them", async () => {
  const dir = path.join(await mkTempRoot("newest-extract-"), "copy")
  mkdirSync(dir)
  const version = extractRelease({ tar: tarOf(release("3.2.117")), dir })
  assert.equal(version, "3.2.117")
  assert.equal(readFileSync(path.join(dir, "mcp", "src", ...Array(22).fill("deep"), "file.js"), "utf8"), "// long path\n", "a pax long name is read")
  assert.equal(existsSync(path.join(dir, "skills")), false)
  assert.equal(existsSync(path.join(path.dirname(dir), "escape.txt")), false, "a path that climbs out is never written")
  assert.equal(existsSync(path.join(dir, "README.md")), false)
})

test("an install on the release channel loads the newer release's copy, once", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-loaded-")
  const gh = github("3.2.117")
  const options = { env, pluginRoot, running: "3.2.116", fetchFn: gh.fetchFn, copiesDir }
  const first = await ensureNewestRelease(options)
  assert.equal(first.state, "loaded")
  assert.equal(first.latest, "3.2.117")
  assert.equal(first.mcpRoot, path.join(copiesDir, "3.2.117", "mcp"))
  assert.equal(readFileSync(path.join(first.mcpRoot, "index.js"), "utf8"), "// server\n")
  assert.equal(existsSync(path.join(copiesDir, "3.2.117", "skills")), false, "only the manifest and the server are kept")
  assert.equal(existsSync(path.join(copiesDir, "escape.txt")), false)
  assert.equal(existsSync(path.join(path.dirname(copiesDir), "escape.txt")), false)
  assert.equal(readdirSync(copiesDir).filter((name) => name.startsWith(".stage") || name.endsWith(".fetching")).length, 0, "no staging left behind")
  const second = await ensureNewestRelease(options)
  assert.equal(second.state, "loaded")
  assert.equal(gh.tarballs(), 1, "the second start reuses the copy and downloads nothing")
  assert.match(newestReleaseLine(first), /^Desk's tools run 3\.2\.117, the newest release; this session's hooks and skills come from the 3\.2\.116 copy/u)
})

test("nothing is fetched when the running copy is the newest, or when this is not Agency's release channel", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-current-")
  const gh = github("3.2.116")
  assert.deepEqual(await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: gh.fetchFn, copiesDir }), { state: "current", running: "3.2.116", latest: "3.2.116" })
  assert.equal(gh.tarballs(), 0)
  const plain = await ensureNewestRelease({ env: osEnv({ HOME: env.HOME }), pluginRoot: path.join(env.HOME, "plugin"), running: "3.2.100", fetchFn: github("3.2.117").fetchFn, copiesDir })
  assert.equal(plain.state, "not_applicable")
  const off = await ensureNewestRelease({ env: { ...env, DESK_NEWEST_RELEASE: "0" }, pluginRoot, running: "3.2.100", fetchFn: github("3.2.117").fetchFn, copiesDir })
  assert.equal(off.state, "not_applicable")
})

test("a download that outlasts the budget falls back to the cached copy and says which version that is", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-slow-")
  const gh = github("3.2.117", {
    tarball: (signal) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
  })
  const result = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: gh.fetchFn, copiesDir, budgetMs: 300 })
  assert.equal(result.state, "fell_back")
  assert.equal(result.latest, "3.2.117")
  assert.match(newestReleaseLine(result), /^Desk's tools run 3\.2\.116 from the cached copy, though the newest release is 3\.2\.117: the download did not finish within \d+ s\. The next session start tries again\.$/u)
  assert.equal(existsSync(path.join(copiesDir, "3.2.117")), false)
})

test("an offline machine keeps the cached copy, or the newest copy it already holds", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-offline-")
  const offline = async () => { throw new Error("getaddrinfo ENOTFOUND") }
  const bare = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: offline, copiesDir })
  assert.equal(bare.state, "fell_back")
  assert.equal(bare.latest, null)
  assert.match(newestReleaseLine(bare), /^Desk's tools run 3\.2\.116 from the cached copy: it could not read the release channel's version/u)
  await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117").fetchFn, copiesDir })
  const held = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: offline, copiesDir })
  assert.equal(held.state, "loaded")
  assert.equal(held.latest, "3.2.117")
})

test("a download that is not a Desk release is refused", async () => {
  const dir = path.join(await mkTempRoot("newest-refuse-"), "copy")
  mkdirSync(dir)
  assert.throws(() => extractRelease({ tar: tarOf({ [`${top}/plugins/desk/plugin.json`]: JSON.stringify({ version: "3.2.117" }) }), dir }), /not a Desk release/u)
})

test("boot's stale-Desk line names the version the tools run", async () => {
  const { pluginRoot, env } = await install("newest-boot-line-")
  writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "desk", version: "3.2.116" }))
  const result = { state: "loaded", running: "3.2.116", latest: "3.2.117", mcpRoot: "/copy/mcp" }
  const finding = await checkStaleDesk({
    env, pluginRoot, agentHost: "copilot", homeDir: env.HOME, stateDir: path.join(env.HOME, "state"),
    fetchFn: github("3.2.117").fetchFn, newestReleaseFn: async () => result,
  })
  assert.equal(finding.latest, "3.2.117")
  assert.equal(finding.line, newestReleaseLine(result))
  const current = await checkStaleDesk({
    env, pluginRoot, agentHost: "copilot", homeDir: env.HOME, stateDir: path.join(env.HOME, "state2"),
    fetchFn: github("3.2.117").fetchFn, newestReleaseFn: async () => ({ state: "current", running: "3.2.116", latest: "3.2.116" }),
  })
  assert.equal(current, null)
})

// main with the shipped wiring but a stand-in importer, to see which `mcp` folder the runtime is loaded from.
async function startWith({ newestRelease, importer }) {
  const root = await mkTempRoot("newest-main-")
  const input = new PassThrough()
  const handle = await main({
    argv: ["--root", root], env: osEnv({ HOME: root }), cwd: root, homeDir: root, stateHome: path.join(root, "state"),
    input, output: new PassThrough(), stderr: { write() { return true } },
    admissionKickoffMs: 0, runtimeInspector: null, readinessPolicy: { semantic: "unsupported" },
    newestRelease, runtimeImporter: importer,
  })
  const deadline = Date.now() + 5000
  while (handle.admission.snapshot().state === "admitting" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  return { handle, finish: async () => { input.end(); await handle.closed } }
}

test("the server loads the newer copy and falls back to its own when that copy will not load", async () => {
  const roots = []
  const { handle, finish } = await startWith({
    newestRelease: async () => ({ state: "loaded", running: "3.2.116", latest: "3.2.117", mcpRoot: "/copy/3.2.117/mcp" }),
    importer: async ({ mcpRoot }) => {
      roots.push(mcpRoot)
      if (mcpRoot === "/copy/3.2.117/mcp") throw new Error("the copy is broken")
      return { createSearchEngine: () => idleSearchEngine() }
    },
  })
  assert.equal(handle.admission.snapshot().state, "ready")
  assert.equal(roots[0], "/copy/3.2.117/mcp")
  assert.notEqual(roots[1], undefined, "the cached copy loads after the newer one fails")
  assert.notEqual(roots[1], "/copy/3.2.117/mcp")
  await finish()
})

test("the server keeps its own copy when the newest release could not be fetched", async () => {
  const roots = []
  const { handle, finish } = await startWith({
    newestRelease: async () => ({ state: "fell_back", running: "3.2.116", latest: "3.2.117", reason: "the download did not finish within 8 s" }),
    importer: async ({ mcpRoot }) => {
      roots.push(mcpRoot)
      return { createSearchEngine: () => idleSearchEngine() }
    },
  })
  assert.equal(handle.admission.snapshot().state, "ready")
  assert.equal(roots.length, 1)
  assert.ok(!roots[0].includes("/copy/"))
  await finish()
})
