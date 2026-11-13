// The move of an explicit Agency entry for Desk on main to the release channel: which entries move, give way or wait, and
// that agency.toml is rewritten in place, once backed up, without a session ever selecting Desk under two specs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, promises as fsPromises, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { readMigrations } from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"
import { holdLock } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import {
  BACKUP_SUFFIX,
  MAIN_SPEC,
  RELEASE_SPEC,
  LOCK_SUFFIX,
  apply,
  cachedDependencies,
  cachedEngines,
  plan,
  reachesDesk,
  readBlocks,
  replaceIfUnchanged,
  runAgencyDeskChannelCli,
} from "../../../../../plugins/desk/mcp/src/runtime/agency-desk-channel.js"

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp")
const MS_DESK = "github:shared-internal-tools/ms-desk:plugins/ms-desk@main"
const CIT = "github:gim-home/CIT-tooling:plugins/cit@main"
const SUPERPOWERS = "github:ourostack/desk:plugins/superpowers@main"
const CREW = "github:ourostack/desk:plugins/crew@main"

const entry = (spec, extra = "") => `[[plugins.default]]\nplugin = "${spec}"\n${extra}cache_policy = "auto"\n`
const copilotOnly = 'engines = ["copilot"]\n'

// An Agency data folder: agency.toml and a cache whose entries hold the given manifests. A cached value is the dependencies a
// copy declares (`null` for a copy without agency.json), or `{ dependencies, engines, claude }`: `engines` is written into
// agency.json when given, and `claude` adds `.claude-plugin/plugin.json` to the copy.
async function agencyHome(toml, cached = {}) {
  const home = realpathSync(await mkTempRoot("desk-agency-channel-"))
  const dir = path.join(home, ".local", "agency")
  const entries = {}
  let n = 0
  for (const [spec, value] of Object.entries(cached)) {
    const { dependencies, engines, claude = false } = Array.isArray(value) || value === null ? { dependencies: value } : value
    n += 1
    const folder = path.join(dir, "plugins", "cache", "entries", `e${n}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, "plugin.json"), "{}")
    if (claude) {
      mkdirSync(path.join(folder, ".claude-plugin"))
      writeFileSync(path.join(folder, ".claude-plugin", "plugin.json"), "{}")
    }
    if (dependencies !== null) writeFileSync(path.join(folder, "agency.json"), JSON.stringify(engines === undefined ? { dependencies } : { dependencies, engines }))
    entries[`copilot:${spec}`] = { dir_name: `e${n}` }
  }
  mkdirSync(path.join(dir, "plugins", "cache"), { recursive: true })
  writeFileSync(path.join(dir, "plugins", "cache", "cache_index.json"), JSON.stringify({ entries }))
  const file = path.join(dir, "agency.toml")
  writeFileSync(file, toml)
  return { home, file, cacheDir: path.join(dir, "plugins", "cache") }
}

const io = () => {
  const out = { stdout: "", stderr: "" }
  return { out, io: { stdout: { write: (text) => { out.stdout += text } }, stderr: { write: (text) => { out.stderr += text } } } }
}

async function run(argv, fixture) {
  const sink = io()
  const status = await runAgencyDeskChannelCli({ argv, env: { AGENCY_TOML: fixture.file }, io: sink.io })
  return { status, ...sink.out }
}

// The Desk specs one engine would load from a plugin list: every Desk spec reachable from its entries through the whole cached
// dependency graph (CIT -> MS Desk -> Desk), as Agency resolves it. `manifests` stands in for the cache when given.
function deskSpecs(text, cacheDir, engine, manifests = null) {
  const dependenciesOf = (spec) => (manifests !== null && spec in manifests ? manifests[spec] : cachedDependencies(cacheDir, spec))
  const specs = new Set()
  const walk = (spec, seen) => {
    if (seen.has(spec)) return
    seen.add(spec)
    if (spec.startsWith("github:ourostack/desk:plugins/desk@")) return void specs.add(spec)
    for (const next of dependenciesOf(spec) ?? []) walk(next, seen)
  }
  for (const block of readBlocks(text.split("\n")).filter((b) => b.table === "plugins.default" && b.plugin !== null)) {
    if (block.engines === null || block.engines.includes(engine)) walk(block.plugin, new Set())
  }
  return [...specs].sort()
}

test("the machine as it is today: Desk on main for every engine, MS Desk and CIT bringing it on Copilot", async () => {
  const toml = [entry(SUPERPOWERS), entry(CREW), entry(MS_DESK, copilotOnly), entry(CIT, copilotOnly), entry(MAIN_SPEC), "[profiles.pinned.plugins]\n", "[[profiles.pinned.plugins.default]]\nplugin = \"github:ourostack/desk:plugins/desk@b997bfec\"\n"].join("\n")
  // Published CIT (c740129d) declares MS Desk and no Desk; MS Desk declares Desk on main until it moves to the release channel.
  const fixture = await agencyHome(toml, { [SUPERPOWERS]: null, [CREW]: null, [MS_DESK]: [MAIN_SPEC, SUPERPOWERS], [CIT]: [MS_DESK, SUPERPOWERS, CREW] })
  assert.deepEqual(deskSpecs(toml, fixture.cacheDir, "copilot"), [MAIN_SPEC])

  assert.equal((await run(["--detect"], fixture)).status, 0)
  const moved = await run(["--migrate"], fixture)
  assert.equal(moved.status, 0)
  assert.match(moved.stdout, /plugins\.default now selects github:ourostack\/desk:plugins\/desk@release for claude; another plugin there brings Desk on the other engines\. The original file is kept as .*agency\.toml\.pre-desk-release\.\n$/u)
  const after = readFileSync(fixture.file, "utf8")
  assert.equal(readFileSync(`${fixture.file}${BACKUP_SUFFIX}`, "utf8"), toml)
  assert.ok(after.includes(`plugin = "${RELEASE_SPEC}"\nengines = ["claude"]\ncache_policy = "auto"\n`))
  assert.ok(after.includes('plugin = "github:ourostack/desk:plugins/desk@b997bfec"'), "a pinned profile is not this migration's")
  // Copilot still loads exactly one Desk, from MS Desk and CIT; Claude loads the release channel.
  assert.deepEqual(deskSpecs(after, fixture.cacheDir, "copilot"), [MAIN_SPEC])
  assert.deepEqual(deskSpecs(after, fixture.cacheDir, "claude"), [RELEASE_SPEC])
  // Once MS Desk and CIT declare the release channel, Copilot loads one Desk again, on release.
  assert.deepEqual(deskSpecs(after, fixture.cacheDir, "copilot", { [MS_DESK]: [RELEASE_SPEC], [CIT]: [MS_DESK] }), [RELEASE_SPEC])
  assert.deepEqual(deskSpecs(after, fixture.cacheDir, "copilot", { [MS_DESK]: [RELEASE_SPEC], [CIT]: [MS_DESK, RELEASE_SPEC] }), [RELEASE_SPEC], "CIT's restored direct Desk on release adds no root")
  assert.equal((await run(["--detect"], fixture)).status, 1, "nothing is left to move")
})

test("CIT alone, which brings Desk only through MS Desk, makes the explicit entry give way, never a second Desk", async () => {
  const toml = [entry(CIT, copilotOnly), entry(MAIN_SPEC, copilotOnly)].join("\n")
  const fixture = await agencyHome(toml, { [CIT]: [MS_DESK, SUPERPOWERS], [MS_DESK]: [MAIN_SPEC, SUPERPOWERS], [SUPERPOWERS]: null })
  assert.deepEqual(deskSpecs(toml, fixture.cacheDir, "copilot"), [MAIN_SPEC])
  assert.match((await run(["--migrate"], fixture)).stdout, /removed the plugins\.default entry/u)
  const after = readFileSync(fixture.file, "utf8")
  assert.equal(after, entry(CIT, copilotOnly))
  assert.deepEqual(deskSpecs(after, fixture.cacheDir, "copilot"), [MAIN_SPEC], "the same one Desk, now through CIT and MS Desk")
  assert.deepEqual(deskSpecs(after, fixture.cacheDir, "copilot", { [MS_DESK]: [RELEASE_SPEC] }), [RELEASE_SPEC], "and one Desk once MS Desk declares release")

  // An MS Desk that is not cached under CIT holds the entry unchanged.
  const partial = await agencyHome(toml, { [CIT]: [MS_DESK] })
  const held = await run(["--detect"], partial)
  assert.equal(held.status, 1)
  assert.match(held.stdout, /^held: .*github:gim-home\/CIT-tooling:plugins\/cit@main \(not cached: github:shared-internal-tools\/ms-desk:plugins\/ms-desk@main\)/u)
  await run(["--migrate"], partial)
  assert.equal(readFileSync(partial.file, "utf8"), toml)
})

test("the graph walk is cycle-safe and reports every uncached spec it reaches", () => {
  const graph = { a: ["b"], b: ["a", "c"], c: null, d: ["e"], e: [MAIN_SPEC, "a"] }
  assert.deepEqual(reachesDesk("a", (spec) => graph[spec]), { desk: false, missing: ["c"] })
  assert.deepEqual(reachesDesk("d", (spec) => graph[spec]), { desk: true, missing: ["c"] })
  assert.deepEqual(reachesDesk(RELEASE_SPEC, () => { throw new Error("a Desk spec is not expanded") }), { desk: true, missing: [] })
})

test("the file is replaced only under the lock and only if nobody changed it meanwhile", async () => {
  const fixture = await agencyHome(entry(MAIN_SPEC))
  const backup = `${fixture.file}${BACKUP_SUFFIX}`
  const args = { target: fixture.file, seen: entry(MAIN_SPEC), next: entry(RELEASE_SPEC), backup, holdLock }
  // Another session holds the lock: nothing is written, and the command says so and fails.
  mkdirSync(`${fixture.file}${LOCK_SUFFIX}/other`, { recursive: true })
  assert.equal(await replaceIfUnchanged({ ...args, lockWaitMs: 30 }), "busy")
  const busy = io()
  assert.equal(await runAgencyDeskChannelCli({ argv: ["--migrate"], env: { AGENCY_TOML: fixture.file }, io: busy.io, replace: (a) => replaceIfUnchanged({ ...a, lockWaitMs: 30 }) }), 1)
  assert.match(busy.out.stdout, /was not changed: another Desk session is moving it now/u)
  assert.equal(readFileSync(fixture.file, "utf8"), entry(MAIN_SPEC))
  spawnSync("rm", ["-r", `${fixture.file}${LOCK_SUFFIX}`])
  // Changed before the lock was taken, or while the new file was being prepared: nothing written, no temporary file left.
  assert.equal(await replaceIfUnchanged({ ...args, seen: "something else\n" }), "changed")
  let reads = 0
  const racing = { ...fsPromises, readFile: async (file, encoding) => (reads++ === 0 ? entry(MAIN_SPEC) : `${entry(MAIN_SPEC)}# added by Agency\n`) }
  assert.equal(await replaceIfUnchanged({ ...args, fsp: racing }), "changed")
  const changed = io()
  assert.equal(await runAgencyDeskChannelCli({ argv: ["--migrate"], env: { AGENCY_TOML: fixture.file }, io: changed.io, replace: async () => "changed" }), 1)
  assert.match(changed.out.stdout, /was not changed: it changed while this ran/u)
  assert.equal(readFileSync(fixture.file, "utf8"), entry(MAIN_SPEC))
  assert.deepEqual(readdirSync(path.dirname(fixture.file)).filter((name) => name.endsWith(".tmp")), [])
  // A failed backup other than "already there" stops the write and leaves no temporary file.
  const failing = { ...fsPromises, writeFile: async (file, data, options) => (file === backup ? Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" })) : fsPromises.writeFile(file, data, options)) }
  await assert.rejects(replaceIfUnchanged({ ...args, fsp: failing }), /disk full/u)
  assert.equal(readFileSync(fixture.file, "utf8"), entry(MAIN_SPEC))
  assert.deepEqual(readdirSync(path.dirname(fixture.file)).filter((name) => name.endsWith(".tmp")), [])
  // Unchanged: replaced whole, with the file's own mode, and the lock is gone afterwards.
  assert.equal(await replaceIfUnchanged(args), "written")
  assert.equal(readFileSync(fixture.file, "utf8"), entry(RELEASE_SPEC))
  assert.equal(readFileSync(backup, "utf8"), entry(MAIN_SPEC))
  assert.equal(existsSync(`${fixture.file}${LOCK_SUFFIX}`), false)
})

test("Desk alone moves to release; an entry another plugin covers on every engine gives way", async () => {
  const alone = await agencyHome([entry(SUPERPOWERS), entry(MAIN_SPEC, copilotOnly)].join("\n"), { [SUPERPOWERS]: null })
  await run(["--migrate"], alone)
  assert.equal(readFileSync(alone.file, "utf8"), [entry(SUPERPOWERS), entry(RELEASE_SPEC, copilotOnly)].join("\n"))

  const covered = await agencyHome([entry(MAIN_SPEC, copilotOnly), entry(MS_DESK, copilotOnly)].join("\n"), { [MS_DESK]: [MAIN_SPEC] })
  const removed = await run(["--migrate"], covered)
  assert.match(removed.stdout, /removed the plugins\.default entry for github:ourostack\/desk:plugins\/desk@main/u)
  assert.equal(readFileSync(covered.file, "utf8"), entry(MS_DESK, copilotOnly))
  assert.deepEqual(deskSpecs(readFileSync(covered.file, "utf8"), covered.cacheDir, "copilot"), [MAIN_SPEC])

  // An explicit release entry beside it covers it too.
  const both = await agencyHome([entry(MAIN_SPEC), entry(RELEASE_SPEC)].join("\n"))
  await run(["--migrate"], both)
  assert.equal(readFileSync(both.file, "utf8"), entry(RELEASE_SPEC))
})

test("cached engines follow the engines field, or the manifests a copy holds, and are null when unreadable", async () => {
  const fixture = await agencyHome("", {
    [MS_DESK]: { dependencies: [], engines: ["copilot", "codex"] },
    [CREW]: { dependencies: [], claude: true },
    [CIT]: { dependencies: null },
    [SUPERPOWERS]: { dependencies: [], engines: "copilot" },
  })
  assert.deepEqual(cachedEngines(fixture.cacheDir, MS_DESK), ["copilot"])
  assert.deepEqual(cachedEngines(fixture.cacheDir, CREW), ["claude", "copilot"])
  assert.deepEqual(cachedEngines(fixture.cacheDir, CIT), ["copilot"])
  assert.equal(cachedEngines(fixture.cacheDir, SUPERPOWERS), null)
  assert.equal(cachedEngines(fixture.cacheDir, "github:example/none:plugins/x@main"), null)
  const reader = (files) => (file) => {
    const name = path.relative(fixture.cacheDir, file).split(path.sep).join("/")
    if (name in files) return files[name]
    throw new Error("ENOENT")
  }
  const index = JSON.stringify({ entries: { [`claude:${CIT}`]: { dir_name: "a" }, [`copilot:${CIT}`]: { dir_name: "b" } } })
  // A copy whose agency.json holds no manifest is no usable copy, so the next engine's copy answers; a broken agency.json holds.
  assert.deepEqual(cachedEngines(fixture.cacheDir, CIT, reader({ "cache_index.json": index, "entries/a/agency.json": "{}", "entries/b/plugin.json": "{}" })), ["copilot"])
  assert.equal(cachedEngines(fixture.cacheDir, CIT, reader({ "cache_index.json": index, "entries/a/agency.json": "{broken", "entries/b/plugin.json": "{}" })), null)
})

test("an entry waits while a plugin that might bring Desk is not cached, or names engines this cannot read", async () => {
  const uncached = await agencyHome([entry(MAIN_SPEC), entry(MS_DESK)].join("\n"))
  const detect = await run(["--detect"], uncached)
  assert.equal(detect.status, 1)
  assert.match(detect.stdout, /^held: in plugins\.default, Desk cannot yet tell on which engines github:shared-internal-tools\/ms-desk:plugins\/ms-desk@main brings Desk/u)
  const migrate = await run(["--migrate"], uncached)
  assert.equal(migrate.status, 0)
  assert.match(migrate.stdout, /^Agency: left as it is: in plugins\.default/u)
  assert.equal(readFileSync(uncached.file, "utf8"), [entry(MAIN_SPEC), entry(MS_DESK)].join("\n"))

  const odd = await agencyHome([entry(MAIN_SPEC), entry(MS_DESK, 'engines = ["codex"]\n')].join("\n"), { [MS_DESK]: [MAIN_SPEC] })
  assert.equal((await run(["--detect"], odd)).status, 1)
  // A plugin with unreadable engines that does not bring Desk changes nothing.
  const plain = await agencyHome([entry(MAIN_SPEC), entry(CREW, "engines = [\n")].join("\n"), { [CREW]: null })
  assert.equal((await run(["--detect"], plain)).status, 0)

  const target = await agencyHome(entry(MAIN_SPEC, 'engines = ["copilot",\n'))
  assert.match((await run(["--detect"], target)).stdout, /has an engines value this migration cannot read/u)
})

test("a plugin with no engines line covers only the engines its cached manifest supports", async () => {
  // MS Desk's cached agency.json supports copilot only, so Claude still needs Desk from the main entry's release channel.
  const narrowed = await agencyHome([entry(MAIN_SPEC), entry(MS_DESK)].join("\n"), { [MS_DESK]: { dependencies: [MAIN_SPEC], engines: ["copilot"] } })
  assert.deepEqual(plan({ text: readFileSync(narrowed.file, "utf8"), cacheDir: narrowed.cacheDir }).actions.map((action) => [action.action, action.engines]), [["release", ["claude"]]])
  assert.match((await run(["--migrate"], narrowed)).stdout, /plugins\.default now selects github:ourostack\/desk:plugins\/desk@release for claude; another plugin there brings Desk on the other engines/u)
  assert.equal(readFileSync(narrowed.file, "utf8"), [entry(RELEASE_SPEC, 'engines = ["claude"]\n'), entry(MS_DESK)].join("\n"))

  // A cached plugin in two lists gives each list the same answer, read from the cache once.
  const lists = [entry(MAIN_SPEC), entry(MS_DESK), "[profiles.p.plugins]\n", `[[profiles.p.plugins.default]]\nplugin = "${MAIN_SPEC}"\n`, `[[profiles.p.plugins.default]]\nplugin = "${MS_DESK}"\n`].join("\n")
  const twoLists = await agencyHome(lists, { [MS_DESK]: { dependencies: [MAIN_SPEC], engines: ["copilot"] } })
  assert.deepEqual(plan({ text: lists, cacheDir: twoLists.cacheDir }).actions.map((action) => [action.block.table, action.engines]), [["plugins.default", ["claude"]], ["profiles.p.plugins.default", ["claude"]]])

  // A cached copy with no engines field that holds both manifests supports both engines, so the entry gives way.
  const both = await agencyHome([entry(MAIN_SPEC), entry(MS_DESK)].join("\n"), { [MS_DESK]: { dependencies: [MAIN_SPEC], claude: true } })
  assert.match((await run(["--migrate"], both)).stdout, /removed the plugins\.default entry/u)
  assert.equal(readFileSync(both.file, "utf8"), entry(MS_DESK))
})

test("another plugin whose cached engines value is not an array of strings holds the entry", async () => {
  const fixture = await agencyHome([entry(MAIN_SPEC), entry(MS_DESK)].join("\n"), { [MS_DESK]: { dependencies: [MAIN_SPEC], engines: "copilot" } })
  const detect = await run(["--detect"], fixture)
  assert.equal(detect.status, 1)
  assert.match(detect.stdout, /^held: in plugins\.default, Desk cannot yet tell on which engines github:shared-internal-tools\/ms-desk:plugins\/ms-desk@main brings Desk/u)
  await run(["--migrate"], fixture)
  assert.equal(readFileSync(fixture.file, "utf8"), [entry(MAIN_SPEC), entry(MS_DESK)].join("\n"))
})

test("only the same list and overlapping engines count, and each list is its own", async () => {
  const toml = [
    entry(MAIN_SPEC, copilotOnly),
    entry(MS_DESK, "engines = ['claude']\n"),
    entry(MAIN_SPEC),
    "[profiles.p.plugins]\n",
    "[[profiles.p.plugins.default]]\nplugin = 'github:ourostack/desk:plugins/desk@main' # mine\n",
    "[[profiles.p.plugins.default]]\nplugin = \"github:example/other:plugins/x@main\"\n",
  ].join("\n")
  const fixture = await agencyHome(toml, { [MS_DESK]: [MAIN_SPEC], "github:example/other:plugins/x@main": [] })
  const { actions } = plan({ text: toml, cacheDir: fixture.cacheDir })
  assert.deepEqual(actions.map((a) => [a.block.table, a.action, a.engines]), [
    ["plugins.default", "release", null],
    ["plugins.default", "release", ["copilot"]],
    ["profiles.p.plugins.default", "release", null],
  ])
  const after = apply(toml.split("\n"), actions)
  assert.ok(after.includes(`plugin = "${RELEASE_SPEC}" # mine`), "a trailing comment stays")
  assert.ok(after.includes(`plugin = "${RELEASE_SPEC}"\nengines = ["copilot"]\n`))
})

test("an existing engines line is rewritten in place", () => {
  const text = entry(MAIN_SPEC, 'engines = ["claude", "copilot"]\n')
  const lines = text.split("\n")
  const [block] = readBlocks(lines)
  assert.equal(apply(lines, [{ block, action: "release", engines: ["claude"] }]), entry(RELEASE_SPEC, 'engines = ["claude"]\n'))
})

test("cached dependencies come only from a readable cached copy", async () => {
  const fixture = await agencyHome("", { [MS_DESK]: [MAIN_SPEC, 7], [CREW]: null })
  assert.deepEqual(cachedDependencies(fixture.cacheDir, MS_DESK), [MAIN_SPEC])
  assert.deepEqual(cachedDependencies(fixture.cacheDir, CREW), [])
  assert.equal(cachedDependencies(fixture.cacheDir, CIT), null)
  assert.equal(cachedDependencies(path.join(fixture.cacheDir, "missing"), MS_DESK), null)
  const index = (entries) => JSON.stringify({ entries })
  const reader = (files) => (file) => {
    const name = path.relative(fixture.cacheDir, file).split(path.sep).join("/")
    if (name in files) return files[name]
    throw new Error("ENOENT")
  }
  for (const dir_name of ["..", ".", "a/b", null, ""]) assert.equal(cachedDependencies(fixture.cacheDir, CIT, reader({ "cache_index.json": index({ [`copilot:${CIT}`]: { dir_name } }) })), null, String(dir_name))
  assert.equal(cachedDependencies(fixture.cacheDir, CIT, reader({ "cache_index.json": JSON.stringify({}) })), null)
  // A broken manifest under one engine falls through to the other; a manifest without a dependency list declares none.
  const files = { "cache_index.json": index({ [`claude:${CIT}`]: { dir_name: "c" }, [`copilot:${CIT}`]: { dir_name: "d" } }), "entries/c/agency.json": "{broken", "entries/d/agency.json": "{}" }
  assert.deepEqual(cachedDependencies(fixture.cacheDir, CIT, reader(files)), [])
  // A cache entry whose folder is gone is no copy at all.
  assert.equal(cachedDependencies(fixture.cacheDir, CIT, reader({ "cache_index.json": index({ [`copilot:${CIT}`]: { dir_name: "gone" } }) })), null)
})

test("the command: usage, a missing agency.toml, the home default, one backup and a symlink kept a symlink", async () => {
  const sink = io()
  assert.equal(await runAgencyDeskChannelCli({ argv: [], env: {}, io: sink.io }), 2)
  assert.match(sink.out.stderr, /^usage:/u)
  const missing = { file: path.join(await mkTempRoot("desk-agency-none-"), "agency.toml") }
  assert.equal((await run(["--detect"], missing)).status, 1)
  assert.equal((await run(["--migrate"], missing)).status, 0)
  assert.equal((await run(["--migrate"], (await agencyHome(entry(CREW))))).stdout, "")

  const fixture = await agencyHome(entry(MAIN_SPEC))
  assert.equal(await runAgencyDeskChannelCli({ argv: ["--detect"], env: { AGENCY_TOML: "" }, io: io().io, homeDir: fixture.home }), 0)

  // agency.toml kept elsewhere and linked in: the link stays and its target changes; an earlier backup is never overwritten.
  const real = path.join(await mkTempRoot("desk-agency-dotfiles-"), "agency.toml")
  writeFileSync(real, entry(MAIN_SPEC))
  writeFileSync(`${real}${BACKUP_SUFFIX}`, "the first backup\n")
  const linked = await agencyHome("")
  const link = linked.file
  spawnSync("rm", [link])
  symlinkSync(real, link)
  assert.equal((await run(["--migrate"], { file: link })).status, 0)
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readFileSync(real, "utf8"), entry(RELEASE_SPEC))
  assert.equal(readFileSync(`${real}${BACKUP_SUFFIX}`, "utf8"), "the first backup\n")
})

test("the 03 migration is safe, needs no restart, and runs through scripts/migrations.js", async () => {
  const migration = readMigrations(path.resolve(mcpRoot, "..")).find((m) => m.id === "03-desk-release-channel")
  assert.equal(migration.safety, "safe")
  assert.equal(migration.needsRestart, false)
  assert.doesNotMatch(migration.blocks.Announce, /agency\.toml|Claude Code/u, "Announce is shown on every machine")
  const fixture = await agencyHome([entry(SUPERPOWERS), entry(MAIN_SPEC)].join("\n"), { [SUPERPOWERS]: null })
  const env = { ...process.env, AGENCY_TOML: fixture.file }
  const script = path.join(mcpRoot, "scripts", "migrations.js")
  const first = spawnSync(process.execPath, [script, "run", "03-desk-release-channel"], { env, cwd: fixture.home, encoding: "utf8" })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.match(first.stdout, /plugins\.default now selects github:ourostack\/desk:plugins\/desk@release/u)
  assert.equal(readFileSync(fixture.file, "utf8"), [entry(SUPERPOWERS), entry(RELEASE_SPEC)].join("\n"))
  const second = spawnSync(process.execPath, [script, "run", "03-desk-release-channel"], { env, cwd: fixture.home, encoding: "utf8" })
  assert.deepEqual([second.status, second.stdout], [0, "Migration 03-desk-release-channel is not needed; nothing to do.\n"])
})
