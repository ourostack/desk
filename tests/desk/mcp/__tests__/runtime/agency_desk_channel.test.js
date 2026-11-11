// The move of an explicit Agency entry for Desk on main to the release channel: which entries move, give way or wait, and
// that agency.toml is rewritten in place, once backed up, without a session ever selecting Desk under two specs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { readMigrations } from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"
import {
  BACKUP_SUFFIX,
  MAIN_SPEC,
  RELEASE_SPEC,
  apply,
  cachedDependencies,
  plan,
  readBlocks,
  runAgencyDeskChannelCli,
} from "../../../../../plugins/desk/mcp/src/runtime/agency-desk-channel.js"

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp")
const MS_DESK = "github:shared-internal-tools/ms-desk:plugins/ms-desk@main"
const CIT = "github:gim-home/CIT-tooling:plugins/cit@main"
const SUPERPOWERS = "github:ourostack/desk:plugins/superpowers@main"
const CREW = "github:ourostack/desk:plugins/crew@main"

const entry = (spec, extra = "") => `[[plugins.default]]\nplugin = "${spec}"\n${extra}cache_policy = "auto"\n`
const copilotOnly = 'engines = ["copilot"]\n'

// An Agency data folder: agency.toml and a cache whose entries hold the given manifests (`null` for a copy without agency.json).
async function agencyHome(toml, cached = {}) {
  const home = realpathSync(await mkTempRoot("desk-agency-channel-"))
  const dir = path.join(home, ".local", "agency")
  const entries = {}
  let n = 0
  for (const [spec, dependencies] of Object.entries(cached)) {
    n += 1
    const folder = path.join(dir, "plugins", "cache", "entries", `e${n}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, "plugin.json"), "{}")
    if (dependencies !== null) writeFileSync(path.join(folder, "agency.json"), JSON.stringify({ dependencies }))
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

function run(argv, fixture) {
  const sink = io()
  const status = runAgencyDeskChannelCli({ argv, env: { AGENCY_TOML: fixture.file }, io: sink.io })
  return { status, ...sink.out }
}

// The graph each engine would load from one plugin list: the Desk specs it selects, explicitly or through a declared dependency.
function deskSpecs(text, cacheDir, engine) {
  const specs = new Set()
  for (const block of readBlocks(text.split("\n")).filter((b) => b.table === "plugins.default" && b.plugin !== null)) {
    if (block.engines !== null && !block.engines.includes(engine)) continue
    if (block.plugin.startsWith("github:ourostack/desk:plugins/desk@")) specs.add(block.plugin)
    for (const dependency of cachedDependencies(cacheDir, block.plugin) ?? []) if (dependency.startsWith("github:ourostack/desk:plugins/desk@")) specs.add(dependency)
  }
  return [...specs].sort()
}

test("the machine as it is today: Desk on main for every engine, MS Desk and CIT bringing it on Copilot", async () => {
  const toml = [entry(SUPERPOWERS), entry(CREW), entry(MS_DESK, copilotOnly), entry(CIT, copilotOnly), entry(MAIN_SPEC), "[profiles.pinned.plugins]\n", "[[profiles.pinned.plugins.default]]\nplugin = \"github:ourostack/desk:plugins/desk@b997bfec\"\n"].join("\n")
  const fixture = await agencyHome(toml, { [SUPERPOWERS]: null, [CREW]: null, [MS_DESK]: [MAIN_SPEC, SUPERPOWERS], [CIT]: [MS_DESK, MAIN_SPEC] })
  assert.deepEqual(deskSpecs(toml, fixture.cacheDir, "copilot"), [MAIN_SPEC])

  assert.equal(run(["--detect"], fixture).status, 0)
  const moved = run(["--migrate"], fixture)
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
  const released = await agencyHome(after, { [MS_DESK]: [RELEASE_SPEC], [CIT]: [MS_DESK, RELEASE_SPEC] })
  assert.deepEqual(deskSpecs(after, released.cacheDir, "copilot"), [RELEASE_SPEC])
  assert.equal(run(["--detect"], fixture).status, 1, "nothing is left to move")
})

test("Desk alone moves to release; an entry another plugin covers on every engine gives way", async () => {
  const alone = await agencyHome([entry(SUPERPOWERS), entry(MAIN_SPEC, copilotOnly)].join("\n"), { [SUPERPOWERS]: null })
  run(["--migrate"], alone)
  assert.equal(readFileSync(alone.file, "utf8"), [entry(SUPERPOWERS), entry(RELEASE_SPEC, copilotOnly)].join("\n"))

  const covered = await agencyHome([entry(MAIN_SPEC, copilotOnly), entry(MS_DESK, copilotOnly)].join("\n"), { [MS_DESK]: [MAIN_SPEC] })
  const removed = run(["--migrate"], covered)
  assert.match(removed.stdout, /removed the plugins\.default entry for github:ourostack\/desk:plugins\/desk@main/u)
  assert.equal(readFileSync(covered.file, "utf8"), entry(MS_DESK, copilotOnly))
  assert.deepEqual(deskSpecs(readFileSync(covered.file, "utf8"), covered.cacheDir, "copilot"), [MAIN_SPEC])

  // An explicit release entry beside it covers it too.
  const both = await agencyHome([entry(MAIN_SPEC), entry(RELEASE_SPEC)].join("\n"))
  run(["--migrate"], both)
  assert.equal(readFileSync(both.file, "utf8"), entry(RELEASE_SPEC))
})

test("an entry waits while a plugin that might bring Desk is not cached, or names engines this cannot read", async () => {
  const uncached = await agencyHome([entry(MAIN_SPEC), entry(MS_DESK)].join("\n"))
  const detect = run(["--detect"], uncached)
  assert.equal(detect.status, 1)
  assert.match(detect.stdout, /^held: in plugins\.default, Desk cannot yet tell on which engines github:shared-internal-tools\/ms-desk:plugins\/ms-desk@main brings Desk/u)
  const migrate = run(["--migrate"], uncached)
  assert.equal(migrate.status, 0)
  assert.match(migrate.stdout, /^Agency: left as it is: in plugins\.default/u)
  assert.equal(readFileSync(uncached.file, "utf8"), [entry(MAIN_SPEC), entry(MS_DESK)].join("\n"))

  const odd = await agencyHome([entry(MAIN_SPEC), entry(MS_DESK, 'engines = ["codex"]\n')].join("\n"), { [MS_DESK]: [MAIN_SPEC] })
  assert.equal(run(["--detect"], odd).status, 1)
  // A plugin with unreadable engines that does not bring Desk changes nothing.
  const plain = await agencyHome([entry(MAIN_SPEC), entry(CREW, "engines = [\n")].join("\n"), { [CREW]: null })
  assert.equal(run(["--detect"], plain).status, 0)

  const target = await agencyHome(entry(MAIN_SPEC, 'engines = ["copilot",\n'))
  assert.match(run(["--detect"], target).stdout, /has an engines value this migration cannot read/u)
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
  assert.equal(runAgencyDeskChannelCli({ argv: [], env: {}, io: sink.io }), 2)
  assert.match(sink.out.stderr, /^usage:/u)
  const missing = { file: path.join(await mkTempRoot("desk-agency-none-"), "agency.toml") }
  assert.equal(run(["--detect"], missing).status, 1)
  assert.equal(run(["--migrate"], missing).status, 0)
  assert.equal(run(["--migrate"], (await agencyHome(entry(CREW)))).stdout, "")

  const fixture = await agencyHome(entry(MAIN_SPEC))
  assert.equal(runAgencyDeskChannelCli({ argv: ["--detect"], env: { AGENCY_TOML: "" }, io: io().io, homeDir: fixture.home }), 0)

  // agency.toml kept elsewhere and linked in: the link stays and its target changes; an earlier backup is never overwritten.
  const real = path.join(await mkTempRoot("desk-agency-dotfiles-"), "agency.toml")
  writeFileSync(real, entry(MAIN_SPEC))
  const linked = await agencyHome("")
  writeFileSync(`${linked.file}${BACKUP_SUFFIX}`, "the first backup\n")
  const link = linked.file
  spawnSync("rm", [link])
  symlinkSync(real, link)
  assert.equal(run(["--migrate"], { file: link }).status, 0)
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readFileSync(real, "utf8"), entry(RELEASE_SPEC))
  assert.equal(readFileSync(`${link}${BACKUP_SUFFIX}`, "utf8"), "the first backup\n")
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
