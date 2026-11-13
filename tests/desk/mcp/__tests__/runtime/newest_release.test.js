// Desk's tools load the newest release at session start: how the copy is fetched and kept, when the step stands down, and what a cached fallback says.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { gzipSync } from "node:zlib"
import { main } from "../../../../../plugins/desk/mcp/index.js"
import { checkStaleDesk } from "../../../../../plugins/desk/mcp/src/runtime/stale-desk.js"
import { ensureNewestRelease, extractRelease, newestReleaseLine, tarFiles } from "../../../../../plugins/desk/mcp/src/runtime/newest-release.js"
import { resolveAdmissionInputs } from "../../../../../plugins/desk/mcp/src/runtime/admission-worker.js"
import { mkTempRoot } from "../_temp_roots.js"
import { idleSearchEngine } from "./_in_process_desk.js"
import { osEnv } from "../_os_env.js"

// A tar with ustar headers; a name over 100 characters goes in a pax header the way git archive writes it, and `prefix` fills the ustar prefix field.
function tarOf(files, { end = true, types = {}, prefixes = {} } = {}) {
  const blocks = []
  const header = (name, size, type, prefix = "") => {
    const block = Buffer.alloc(512)
    block.write(name.slice(0, 100), 0)
    block.write("0000644\0", 100)
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124)
    block.write(type, 156)
    block.write("ustar\0", 257)
    block.write(prefix, 345)
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
    blocks.push(header(name, data.length, types[name] ?? "0", prefixes[name]), body(data))
  }
  if (end) blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const top = "ourostack-desk-abc123"
const longDir = `${"deep/".repeat(22)}file.js`
function release(version, extra = {}) {
  return {
    [`${top}/plugins/desk/plugin.json`]: JSON.stringify({ name: "desk", version }),
    [`${top}/plugins/desk/mcp/index.js`]: "// server\n",
    [`${top}/plugins/desk/mcp/src/${longDir}`]: "// long path\n",
    [`${top}/plugins/desk/skills/x/SKILL.md`]: "skill",
    [`${top}/README.md`]: "readme",
    [`${top}/plugins/desk/mcp/../../escape.txt`]: "escape",
    [`${top}/plugins/desk/mcp/c:/drive.txt`]: "drive",
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

const bytes = (buffer) => ({ ok: true, status: 200, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) })

// A GitHub that serves the release branch's plugin.json and tarball.
function github(version, { tarball = () => gzipSync(tarOf(release(version))), manifest = () => JSON.stringify({ version }) } = {}) {
  const seen = []
  const fetchFn = async (url, { signal } = {}) => {
    seen.push(url)
    if (url.endsWith("plugin.json")) return { ok: true, status: 200, text: async () => manifest() }
    const answer = await tarball(signal)
    return answer.ok === undefined ? bytes(answer) : answer
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

test("the tar reader joins a ustar prefix, skips what is not a regular file and a pax record with no path, and refuses a damaged archive", () => {
  const exact = "n".repeat(100)
  const files = { "a.txt": "a", "dir/": "", "b.txt": "b", "c.txt": "c", [exact]: "e" }
  const names = [...tarFiles(tarOf(files, { prefixes: { "a.txt": "pre/fix" }, types: { "dir/": "5" } }))].map(({ name }) => name)
  assert.deepEqual(names, ["pre/fix/a.txt", "b.txt", "c.txt", exact])
  const noEnd = [...tarFiles(tarOf({ "x.txt": "x" }, { end: false }))].map(({ name }) => name)
  assert.deepEqual(noEnd, ["x.txt"], "an archive with no end marker ends where its data does")
  const odd = [...tarFiles(tarOf({ [`${"p/".repeat(60)}odd.txt`]: "odd" }, {}))]
  assert.equal(odd.length, 1)
  const noPath = tarOf({ pax: "no path here\n" }, { types: { pax: "x" } })
  assert.deepEqual([...tarFiles(noPath)], [])
  const truncated = tarOf({ "a.txt": "a".repeat(2000) }).subarray(0, 1100)
  assert.throws(() => [...tarFiles(truncated)], /the archive is damaged/u)
  const badSize = Buffer.alloc(1024)
  badSize.write("zzzzzzzzzzz\0", 124)
  badSize.write("0", 156)
  assert.throws(() => [...tarFiles(badSize)], /the archive is damaged/u)
})

test("a download that is not a Desk release, or is larger than a copy may be, is refused", async () => {
  const dir = path.join(await mkTempRoot("newest-refuse-"), "copy")
  mkdirSync(dir)
  assert.throws(() => extractRelease({ tar: tarOf({ [`${top}/plugins/desk/plugin.json`]: JSON.stringify({ version: "3.2.117" }) }), dir }), /not a Desk release/u)
  assert.throws(() => extractRelease({ tar: tarOf({ [`${top}/plugins/desk/plugin.json`]: JSON.stringify({ version: "latest" }), [`${top}/plugins/desk/mcp/index.js`]: "x" }), dir }), /not a Desk release/u)
  assert.throws(() => extractRelease({ tar: tarOf({ [`${top}/plugins/desk/mcp/big.bin`]: Buffer.alloc(61 * 1024 * 1024) }), dir }), /larger than a copy may be/u)
})

test("an install on the release channel loads the newer release's copy once, keeps only the newest few and cleans up", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-loaded-")
  const gh = github("3.2.117")
  const options = { env, pluginRoot, running: "3.2.116", fetchFn: gh.fetchFn, copiesDir }
  for (const old of ["3.2.100", "3.2.101", "3.2.102"]) {
    mkdirSync(path.join(copiesDir, old), { recursive: true })
    const when = new Date(Date.now() - 1000 * (200 - Number(old.slice(-1))))
    utimesSync(path.join(copiesDir, old), when, when)
  }
  const first = await ensureNewestRelease(options)
  assert.equal(first.state, "loaded")
  assert.equal(first.latest, "3.2.117")
  assert.equal(first.mcpRoot, path.join(copiesDir, "3.2.117", "mcp"))
  assert.equal(readFileSync(path.join(first.mcpRoot, "index.js"), "utf8"), "// server\n")
  assert.equal(existsSync(path.join(copiesDir, "3.2.117", "skills")), false, "only the manifest and the server are kept")
  assert.deepEqual(readdirSync(copiesDir).sort(), ["3.2.101", "3.2.102", "3.2.117"].filter((name) => name !== "3.2.101" || true).slice(0, 3).sort(), "the oldest copy is pruned and no staging is left")
  const second = await ensureNewestRelease(options)
  assert.equal(second.state, "loaded")
  assert.equal(gh.tarballs(), 1, "the second start reuses the copy and downloads nothing")
  assert.match(newestReleaseLine(first), /^Desk's tools run 3\.2\.117, the newest release; this session's hooks and skills come from the 3\.2\.116 copy/u)
})

test("pruning tolerates a copy it cannot read", async (t) => {
  if (process.platform === "win32") return t.skip("a dangling link needs privileges on Windows")
  const { pluginRoot, env, copiesDir } = await install("newest-prune-")
  mkdirSync(copiesDir, { recursive: true })
  symlinkSync(path.join(copiesDir, "nowhere"), path.join(copiesDir, "3.2.50"))
  const result = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117").fetchFn, copiesDir })
  assert.equal(result.state, "loaded", "the copy is complete even though pruning could not finish")
})

test("without a copies folder named, the cache folder from the environment, or the home folder, is used", async () => {
  const { pluginRoot, env, base } = await install("newest-default-dir-")
  const viaXdg = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117").fetchFn, homeDir: base })
  assert.equal(viaXdg.mcpRoot, path.join(base, "cache", "ouroboros-skills", "desk", "release-copies", "3.2.117", "mcp"))
  const { XDG_CACHE_HOME: _x, HOME: _h, ...bare } = env
  const viaHome = await ensureNewestRelease({ env: bare, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117").fetchFn, homeDir: base })
  assert.equal(viaHome.mcpRoot, path.join(base, ".cache", "ouroboros-skills", "desk", "release-copies", "3.2.117", "mcp"))
  const viaEnvHome = await ensureNewestRelease({ env: { ...bare, HOME: base }, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117").fetchFn })
  assert.equal(viaEnvHome.state, "loaded")
})

test("nothing is fetched when the running copy is the newest, or when this is not Agency's release channel", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-current-")
  const gh = github("3.2.116")
  assert.deepEqual(await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: gh.fetchFn, copiesDir }), { state: "current", running: "3.2.116", latest: "3.2.116" })
  assert.equal(gh.tarballs(), 0)
  const others = [
    [osEnv({ HOME: env.HOME }), path.join(env.HOME, "plugin"), "not an Agency install on the release channel"],
    [{ ...env, DESK_NEWEST_RELEASE: "0" }, pluginRoot, "DESK_NEWEST_RELEASE=0"],
    [{ ...env, DESK_FACTORY_HEADLESS: "1" }, pluginRoot, "a headless evaluator"],
  ]
  for (const [otherEnv, root, reason] of others) {
    assert.deepEqual(await ensureNewestRelease({ env: otherEnv, pluginRoot: root, running: "3.2.100", fetchFn: github("3.2.117").fetchFn, copiesDir }), { state: "not_applicable", reason })
  }
  assert.deepEqual(await ensureNewestRelease({ env, pluginRoot, running: "3.2.100", copiesDir }), { state: "not_applicable", reason: "a test run" })
  assert.equal((await ensureNewestRelease({ env: { ...env, DESK_FACTORY_HEADLESS: "0" }, pluginRoot, running: "3.2.116", fetchFn: gh.fetchFn, copiesDir })).state, "current")
})

test("a download that outlasts the budget, fails, or is not a release falls back to the cached copy and says which version that is", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-slow-")
  const hangs = github("3.2.117", {
    tarball: (signal) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
  })
  const slow = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: hangs.fetchFn, copiesDir, budgetMs: 300 })
  assert.equal(slow.state, "fell_back")
  assert.equal(slow.latest, "3.2.117")
  assert.match(newestReleaseLine(slow), /^Desk's tools run 3\.2\.116 from the cached copy, though the newest release is 3\.2\.117: the download did not finish within \d+ s\. The next session start tries again\.$/u)
  assert.equal(existsSync(path.join(copiesDir, "3.2.117")), false)
  const broken = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117", { tarball: () => ({ ok: false, status: 503 }) }).fetchFn, copiesDir })
  assert.equal(broken.reason, "the download failed (HTTP 503)")
  const huge = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117", { tarball: () => bytes(Buffer.alloc(41 * 1024 * 1024)) }).fetchFn, copiesDir })
  assert.equal(huge.reason, "the download failed (the release download is too large)")
  const notRelease = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117", { tarball: () => gzipSync(tarOf({ "x/README.md": "hi" })) }).fetchFn, copiesDir })
  assert.match(notRelease.reason, /^the download failed \(/u)
  assert.deepEqual(readdirSync(copiesDir), [], "no staging is left behind")
})

test("an offline machine, or a release channel that answers nonsense, keeps the cached copy", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-offline-")
  const offline = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: async () => { throw new Error("getaddrinfo ENOTFOUND") }, copiesDir })
  assert.equal(offline.state, "fell_back")
  assert.equal(offline.latest, undefined)
  assert.match(newestReleaseLine(offline), /^Desk's tools run 3\.2\.116 from the cached copy: it could not read the release channel's version \(getaddrinfo ENOTFOUND\)\. The next session start tries again\.$/u)
  const nonsense = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: github("banana").fetchFn, copiesDir })
  assert.equal(nonsense.reason, "the release channel's version was not readable")
  const refused = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: async () => ({ ok: false, status: 404 }), copiesDir })
  assert.match(refused.reason, /HTTP 404/u)
})

test("a tarball that is older than the running copy, or a copy another start finished first, is handled", async () => {
  const { pluginRoot, env, copiesDir } = await install("newest-race-")
  const older = await ensureNewestRelease({ env, pluginRoot, running: "3.2.116", fetchFn: github("3.2.117", { tarball: () => gzipSync(tarOf(release("3.2.115"))) }).fetchFn, copiesDir })
  assert.deepEqual(older, { state: "current", running: "3.2.116", latest: "3.2.115" })
  const raced = await ensureNewestRelease({
    env, pluginRoot, running: "3.2.116", copiesDir,
    fetchFn: github("3.2.117", {
      tarball: () => {
        mkdirSync(path.join(copiesDir, "3.2.117", "mcp"), { recursive: true })
        writeFileSync(path.join(copiesDir, "3.2.117", ".complete.json"), "{}")
        return gzipSync(tarOf(release("3.2.117")))
      },
    }).fetchFn,
  })
  assert.equal(raced.state, "loaded")
  assert.equal(existsSync(path.join(copiesDir, "3.2.117", "mcp", "index.js")), false, "the copy that was already there is kept")
})

test("the outcome sentence is empty for a state with nothing to say", () => {
  assert.equal(newestReleaseLine({ state: "current" }), "")
})

test("boot's stale-Desk line names the version the tools run, and says nothing when the running copy is the newest", async () => {
  const { pluginRoot, env } = await install("newest-boot-line-")
  writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "desk", version: "3.2.116" }))
  const result = { state: "loaded", running: "3.2.116", latest: "3.2.117", mcpRoot: "/copy/mcp" }
  const common = { env, pluginRoot, agentHost: "copilot", homeDir: env.HOME, stateDir: path.join(env.HOME, "state"), fetchFn: github("3.2.117").fetchFn }
  const finding = await checkStaleDesk({ ...common, newestReleaseFn: async () => result })
  assert.equal(finding.latest, "3.2.117")
  assert.equal(finding.line, newestReleaseLine(result))
  assert.equal(await checkStaleDesk({ ...common, newestReleaseFn: async () => ({ state: "current", running: "3.2.116", latest: "3.2.116" }) }), null)
  // A step that has no version to report leaves boot's older checks in charge.
  const none = await checkStaleDesk({ ...common, newestReleaseFn: async () => ({ state: "not_applicable", reason: "off" }) })
  assert.equal(none.latest, "3.2.117")
  assert.notEqual(none.line, newestReleaseLine(result))
})

// main with the shipped wiring but a stand-in importer, to see which `mcp` folder the runtime is loaded from.
async function startWith({ newestRelease, importer, pin }) {
  const root = await mkTempRoot("newest-main-")
  const input = new PassThrough()
  const handle = await main({
    argv: ["--root", root], env: osEnv({ HOME: root }), cwd: root, homeDir: root, stateHome: path.join(root, "state"),
    input, output: new PassThrough(), stderr: { write() { return true } },
    admissionKickoffMs: 0, runtimeInspector: null, readinessPolicy: { semantic: "unsupported" },
    offload: async (job) => {
      const value = resolveAdmissionInputs(job.input)
      return pin === undefined || value.activation === undefined ? value : { ...value, activation: { ...value.activation, ...pin } }
    },
    newestRelease, runtimeImporter: importer,
  })
  const deadline = Date.now() + 5000
  while (handle.admission.snapshot().state === "admitting" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  return { handle, finish: async () => { input.end(); await handle.closed } }
}

const engine = async () => ({ createSearchEngine: () => idleSearchEngine() })

test("the server loads the newer copy and falls back to its own when that copy will not load", async () => {
  const roots = []
  const phases = []
  const { handle, finish } = await startWith({
    newestRelease: async () => ({ state: "loaded", running: "3.2.116", latest: "3.2.117", mcpRoot: "/copy/3.2.117/mcp" }),
    importer: async ({ mcpRoot }) => {
      roots.push(mcpRoot)
      if (mcpRoot === "/copy/3.2.117/mcp") throw new Error("the copy is broken")
      return engine()
    },
  })
  phases.push(handle.admission.snapshot().state)
  assert.equal(handle.admission.snapshot().state, "ready")
  assert.equal(roots[0], "/copy/3.2.117/mcp")
  assert.notEqual(roots[1], undefined, "the cached copy loads after the newer one fails")
  assert.notEqual(roots[1], "/copy/3.2.117/mcp")
  await finish()
})

test("the server runs the newer copy when it loads, and its own when the newest release could not be fetched, saying so either way", async () => {
  const roots = []
  const loaded = await startWith({
    newestRelease: async () => ({ state: "loaded", running: "3.2.116", latest: "3.2.117", mcpRoot: "/copy/3.2.117/mcp" }),
    importer: async ({ mcpRoot }) => { roots.push(mcpRoot); return engine() },
  })
  assert.deepEqual(roots, ["/copy/3.2.117/mcp"])
  await loaded.finish()
  roots.length = 0
  const { handle, finish } = await startWith({
    newestRelease: async () => ({ state: "fell_back", running: "3.2.116", latest: "3.2.117", reason: "the download did not finish within 8 s" }),
    importer: async ({ mcpRoot }) => { roots.push(mcpRoot); return engine() },
  })
  assert.equal(handle.admission.snapshot().state, "ready")
  assert.equal(roots.length, 1)
  assert.ok(!roots[0].includes("/copy/"))
  await finish()
})

test("a pinned activation, or a custom importer with no newest-release step, is never swapped for another copy", async () => {
  for (const pin of [{ sourceIdentity: "sha256:abc" }, { runtimeCacheDir: "/pinned" }]) {
    const roots = []
    const { finish } = await startWith({ pin, newestRelease: async () => assert.fail("not asked"), importer: async ({ mcpRoot }) => { roots.push(mcpRoot); return engine() } })
    assert.equal(roots.length, 1)
    await finish()
  }
  const { finish } = await startWith({ importer: engine })
  await finish()
})
