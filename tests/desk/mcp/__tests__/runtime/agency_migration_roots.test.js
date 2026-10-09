import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { agencyMigrationRoots, runMigrationCli } from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"

const deskPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk")

// A synthetic Agency cache: `fixtures` is [{ spec, dir, name, fetched_at, migrations }].
async function agencyHome(fixtures, { index = true } = {}) {
  const home = await mkTempRoot("desk-agency-roots-")
  const cache = path.join(home, ".local", "agency", "plugins", "cache")
  mkdirSync(path.join(cache, "entries"), { recursive: true })
  const entries = {}
  for (const { spec, dir, name, fetched_at, migrations = ["01-a.md"], plugin = true } of fixtures) {
    const folder = path.join(cache, "entries", dir)
    mkdirSync(folder, { recursive: true })
    if (plugin) writeFileSync(path.join(folder, "plugin.json"), JSON.stringify({ name }))
    if (migrations) {
      mkdirSync(path.join(folder, "migrations"), { recursive: true })
      for (const file of migrations) writeFileSync(path.join(folder, "migrations", file), `---\nid: ${file.replace(/\.md$/u, "")}\n---\n`)
    }
    entries[spec] = { spec, dir_name: dir, fetched_at }
  }
  if (index) writeFileSync(path.join(cache, "cache_index.json"), JSON.stringify({ entries }))
  return { home, folder: (dir) => path.join(cache, "entries", dir) }
}

test("one root per plugin: the newest fetch, never Desk's own, only the running engine's specs", async () => {
  const fixture = await agencyHome([
    { spec: "copilot:github:ourostack/desk:plugins/desk@main", dir: "desk-old", name: "desk", fetched_at: 1, migrations: ["01-a.md", "02-b.md"] },
    { spec: "copilot:github:ourostack/desk:plugins/desk@v2", dir: "desk-new", name: "desk", fetched_at: 2, migrations: ["01-a.md", "02-b.md", "03-c.md"] },
    { spec: "copilot:github:org/ms:plugins/ms-desk@v2-alpha", dir: "ms-old", name: "ms-desk", fetched_at: 10 },
    { spec: "copilot:github:org/ms:plugins/ms-desk@main", dir: "ms-new", name: "ms-desk", fetched_at: 20 },
    { spec: "copilot:github:org/ms:plugins/ms-desk@other", dir: "ms-older", name: "ms-desk", fetched_at: 5 },
    { spec: "claude:github:org/other:plugins/other@main", dir: "other", name: "other", fetched_at: 99 },
    { spec: "copilot:github:org/nomig:plugins/nomig@main", dir: "nomig", name: "nomig", fetched_at: 1, migrations: null },
    { spec: "copilot:github:org/noplugin:plugins/np@main", dir: "noplugin", name: "np", fetched_at: 1, plugin: false },
    { spec: "copilot:github:org/nofetch:plugins/nf@main", dir: "nofetch", name: "nf" },
    { spec: "copilot:github:org/bad:plugins/bad@main", dir: "../escape", name: "bad", fetched_at: 3 },
  ])
  const roots = agencyMigrationRoots({ home: fixture.home })
  assert.deepEqual(roots, [fixture.folder("ms-new"), fixture.folder("nofetch")], "sorted by plugin name: ms-desk, then nf")
})

test("no two migrations with the same id are found across the roots", async () => {
  const fixture = await agencyHome([
    { spec: "copilot:github:ourostack/desk:plugins/desk@main", dir: "desk-old", name: "desk", fetched_at: 1, migrations: ["01-move-to-ourostack-desk.md", "02-tidy-desk.md"] },
    { spec: "copilot:github:ourostack/desk:plugins/desk@v2", dir: "desk-new", name: "desk", fetched_at: 2, migrations: ["01-move-to-ourostack-desk.md", "02-tidy-desk.md", "03-normalize-task-status.md"] },
    { spec: "copilot:github:org/ms:plugins/ms-desk@a", dir: "ms-a", name: "ms-desk", fetched_at: 1, migrations: ["04-ms.md"] },
    { spec: "copilot:github:org/ms:plugins/ms-desk@b", dir: "ms-b", name: "ms-desk", fetched_at: 2, migrations: ["04-ms.md"] },
  ])
  const ids = []
  // The two ms-desk copies hold the same migration under different file names: only the front matter id shows they collide.
  writeFileSync(path.join(fixture.folder("ms-b"), "migrations", "04-ms.md"), "---\nid: 04-ms\n---\n")
  for (const root of [deskPluginRoot, ...agencyMigrationRoots({ home: fixture.home })]) {
    // readMigrations reads only well-formed migrations, so list the files by name through the same folder.
    ids.push(...readMigrationNames(root))
  }
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], "a migration id found twice would run twice")
})

// The `id:` front matter of every migration file in a plugin's folder.
function readMigrationNames(root) {
  const dir = path.join(root, "migrations")
  return readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => /^id: (.+)$/mu.exec(readFileSync(path.join(dir, name), "utf8"))[1])
}

test("roots come out sorted by plugin name whatever order the index lists them in", async () => {
  const fixture = await agencyHome([
    { spec: "copilot:github:org/z:plugins/zed@main", dir: "zed", name: "zed", fetched_at: 1 },
    { spec: "copilot:github:org/a:plugins/alpha@main", dir: "alpha", name: "alpha", fetched_at: 1 },
  ])
  assert.deepEqual(agencyMigrationRoots({ home: fixture.home }), [fixture.folder("alpha"), fixture.folder("zed")])
})

test("null or incomplete index entries are skipped, not a crash", async () => {
  const fixture = await agencyHome([{ spec: "copilot:github:org/ok:plugins/ok@main", dir: "ok", name: "ok", fetched_at: 1 }], { index: false })
  const index = path.join(fixture.home, ".local", "agency", "plugins", "cache", "cache_index.json")
  const cases = [
    { "copilot:x": null },
    { "copilot:x": {} },
    { "copilot:x": { dir_name: 7 } },
    { "copilot:x": { dir_name: ".." } },
    { "copilot:x": "text" },
  ]
  for (const entries of cases) {
    writeFileSync(index, JSON.stringify({ entries }))
    assert.deepEqual(agencyMigrationRoots({ home: fixture.home }), [], JSON.stringify(entries))
    let out = ""
    const code = await runMigrationCli({ argv: ["roots"], home: fixture.home, io: { stdout: { write: (text) => { out += text } }, stderr: { write() {} } }, pluginRoot: deskPluginRoot, cwd: fixture.home })
    assert.deepEqual([code, out], [0, ""])
  }
  writeFileSync(index, JSON.stringify({ entries: null }))
  assert.deepEqual(agencyMigrationRoots({ home: fixture.home }), [])
})

test("fetched_at accepts epoch seconds, numeric strings and ISO dates, and bad values count as the oldest", async () => {
  const fixture = await agencyHome([
    { spec: "copilot:github:org/a:plugins/p@1", dir: "p-iso-old", name: "p", fetched_at: "2026-10-01T00:00:00Z" },
    { spec: "copilot:github:org/a:plugins/p@2", dir: "p-iso-new", name: "p", fetched_at: "2026-10-02T00:00:00Z" },
    { spec: "copilot:github:org/a:plugins/p@3", dir: "p-garbage", name: "p", fetched_at: "not a date" },
    { spec: "copilot:github:org/a:plugins/q@1", dir: "q-epoch", name: "q", fetched_at: 1791494521 },
    { spec: "copilot:github:org/a:plugins/q@2", dir: "q-string", name: "q", fetched_at: "1791494000" },
  ])
  assert.deepEqual(agencyMigrationRoots({ home: fixture.home }), [fixture.folder("p-iso-new"), fixture.folder("q-epoch")])
})

test("a plugin named only in agency.json is found, and one with no readable name is skipped", async () => {
  const fixture = await agencyHome([
    { spec: "copilot:github:org/a:plugins/a@main", dir: "agency-only", name: "agency-only", fetched_at: 1, plugin: false },
    { spec: "copilot:github:org/b:plugins/b@main", dir: "unnamed", name: "unnamed", fetched_at: 1, plugin: false },
    { spec: "copilot:github:org/c:plugins/c@main", dir: "nameless-plugin", name: "x", fetched_at: 1 },
  ])
  writeFileSync(path.join(fixture.folder("agency-only"), "agency.json"), JSON.stringify({ name: "agency-only" }))
  writeFileSync(path.join(fixture.folder("unnamed"), "agency.json"), "{ not json")
  writeFileSync(path.join(fixture.folder("nameless-plugin"), "plugin.json"), JSON.stringify({ version: "1" }))
  assert.deepEqual(agencyMigrationRoots({ home: fixture.home }), [fixture.folder("agency-only")])
})

test("a missing or unreadable index has no roots, and another engine prefix selects its own specs", async () => {
  assert.deepEqual(agencyMigrationRoots({ home: (await agencyHome([], { index: false })).home }), [])
  const fixture = await agencyHome([{ spec: "claude:github:org/x:plugins/x@main", dir: "x", name: "x", fetched_at: 1 }])
  assert.deepEqual(agencyMigrationRoots({ home: fixture.home }), [])
  assert.deepEqual(agencyMigrationRoots({ home: fixture.home, engine: "claude" }), [fixture.folder("x")])
})

test("migrations.js roots prints one root per line, honours --engine, and defaults the home", async () => {
  const fixture = await agencyHome([
    { spec: "copilot:github:org/a:plugins/a@main", dir: "a", name: "a", fetched_at: 1 },
    { spec: "claude:github:org/b:plugins/b@main", dir: "b", name: "b", fetched_at: 1 },
  ])
  const run = async (argv, extra = {}) => {
    let out = ""
    const code = await runMigrationCli({ argv, io: { stdout: { write: (text) => { out += text } }, stderr: { write() {} } }, pluginRoot: deskPluginRoot, cwd: fixture.home, ...extra })
    return { code, out }
  }
  assert.deepEqual(await run(["roots"], { home: fixture.home }), { code: 0, out: `${fixture.folder("a")}\n` })
  assert.deepEqual(await run(["roots", "--engine", "claude"], { home: fixture.home }), { code: 0, out: `${fixture.folder("b")}\n` })
  assert.deepEqual(await run(["roots", "--engine"], { home: fixture.home }), { code: 0, out: `${fixture.folder("a")}\n` })
  assert.deepEqual(await run(["roots"], { env: { HOME: fixture.home } }), { code: 0, out: `${fixture.folder("a")}\n` })
  const fallback = await run(["roots"], { env: {} })
  assert.equal(fallback.code, 0)
})
