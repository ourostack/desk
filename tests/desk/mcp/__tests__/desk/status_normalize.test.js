import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { runStatusNormalizeCli, statusFindings } from "../../../../../plugins/desk/mcp/src/desk/status-normalize.js"
import { runMigrationCli, readMigrations } from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk")

function card(root, rel, status) {
  const file = path.join(root, rel, "task.md")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, status === undefined ? "---\ntitle: T\n---\nbody\n" : `---\ntitle: T\nstatus: ${status}\n---\nbody\n`)
}

async function desk() {
  const root = await mkTempRoot("desk-status-")
  card(root, "a/valid-one", "processing")
  card(root, "a/done-one", "done")
  card(root, "a/ghost-active", "Active")
  card(root, "a/ghost-wait", '"needs_review"')
  card(root, "b/odd-value", "on hold")
  card(root, "b/no-status", undefined)
  card(root, "b/numeric", "3")
  card(root, "_archive/old/archived-ghost", "doing")
  card(root, "_archive/old/archived-odd", "wip")
  card(root, "_meta/not-a-track", "active")
  card(root, "desks/bob/t/bobs-ghost", "backlog")
  mkdirSync(path.join(root, "a", "no-card"), { recursive: true })
  mkdirSync(path.join(root, "a", "bad-card", "task.md"), { recursive: true })
  mkdirSync(path.join(root, "c", "dup"), { recursive: true })
  writeFileSync(path.join(root, "c", "dup", "task.md"), "---\nstatus: a\nstatus: b\n---\n")
  writeFileSync(path.join(root, "loose.md"), "x")
  return root
}

function run(argv, opts = {}) {
  let stdout = ""
  let stderr = ""
  const code = runStatusNormalizeCli({ argv, env: { DESK_ROOT: "/nonexistent" }, io: { stdout: { write: (t) => { stdout += t } }, stderr: { write: (t) => { stderr += t } } }, ...opts })
  return { code, stdout, stderr }
}

test("statusFindings reads live and archived cards and skips valid, missing and unreadable ones", async () => {
  const root = await desk()
  const found = statusFindings(root, { skipDesks: true }).map((f) => `${f.archived ? "_archive/" : ""}${f.track}/${f.slug}=${f.value}->${f.mapped}`)
  assert.deepEqual(found, [
    "a/ghost-active=Active->processing",
    "a/ghost-wait=needs_review->collaborating",
    "b/numeric=3->null",
    "b/odd-value=on hold->null",
    "_archive/old/archived-ghost=doing->processing",
    "_archive/old/archived-odd=wip->null",
  ])
  assert.deepEqual(statusFindings(path.join(root, "nope")), [])
})

test("detect is pending only when a card has an invalid status, and per person only scans that person's desk", async () => {
  const root = await desk()
  assert.equal(run(["--detect", "--root", root]).code, 0)
  assert.equal(run(["--detect", "--root", root, "--person", "bob"]).code, 0)
  assert.equal(run(["--detect", "--root", root, "--person", "alice"]).code, 1)
  const clean = await mkTempRoot("desk-clean-")
  card(clean, "a/x", "paused")
  assert.equal(run(["--detect", "--root", clean]).code, 1)
  assert.equal(run(["--detect", "--root", clean]).stdout, "")
})

test("plan prints one task_update per mappable live card and lists the rest separately", async () => {
  const root = await desk()
  const { code, stdout } = run(["--plan", "--root", root])
  assert.equal(code, 0)
  assert.match(stdout, /^Desk: .*\n6 cards hold a status outside drafting/u)
  assert.ok(stdout.includes('task_update {"track":"a","slug":"ghost-active","frontmatter":{"status":"processing"}}  # was "Active"'))
  assert.ok(stdout.includes('task_update {"track":"a","slug":"ghost-wait","frontmatter":{"status":"collaborating"}}  # was "needs_review"'))
  assert.equal((stdout.match(/^task_update /gmu) ?? []).length, 2)
  assert.ok(stdout.includes('_archive/old/archived-ghost: "doing" -> processing'))
  assert.ok(stdout.includes('b/odd-value: "on hold"'))
  assert.ok(stdout.includes('_archive/old/archived-odd: "wip"'))
  const bob = run(["--plan", "--root", root, "--person", "bob"]).stdout
  assert.match(bob, /^Desk: .* as bob\n1 card hold/u)
  assert.ok(bob.includes('"slug":"bobs-ghost","frontmatter":{"status":"drafting"}'))
})

test("plan on a clean desk, with no desk bound, and with bad arguments", async () => {
  const clean = await mkTempRoot("desk-clean-")
  card(clean, "a/x", "paused")
  assert.match(run(["--plan", "--root", clean]).stdout, /Nothing to fix/u)
  const nowhere = run(["--plan"], { env: { DESK_ROOT: "/nonexistent" }, cwd: "/nonexistent-cwd", homeDir: "/nonexistent-home" })
  assert.equal(nowhere.code, 0)
  assert.match(nowhere.stdout, /No desk is bound/u)
  assert.equal(run(["--detect"], { env: {}, cwd: "/nonexistent-cwd", homeDir: "/nonexistent-home" }).code, 1)
  assert.equal(run(["--bogus"]).code, 2)
  assert.equal(run(["--root"]).code, 2)
  assert.deepEqual([run([]).code, run([]).stderr], [2, "status-normalize: pass --detect or --plan\n"])
})

test("a person alias that cannot be a desk name finds nothing", async () => {
  const root = await desk()
  assert.equal(run(["--detect", "--root", root, "--person", "../x"]).code, 1)
})

test("the resolved desk is used when no root is given", async () => {
  const root = await desk()
  const result = run(["--plan"], { env: { DESK_ROOT: root }, cwd: root })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /hold a status outside|Nothing to fix|No desk is bound/u)
})

test("the 03 migration parses, is agent work, and its blocks run end to end from the plugin", async () => {
  const migration = readMigrations(pluginRoot).find((m) => m.id === "03-normalize-task-status")
  assert.ok(migration, "03-normalize-task-status is found")
  assert.equal(migration.agentWork, true)
  assert.equal(migration.safety, "safe")
  assert.equal(migration.needsRestart, false)
  const root = await desk()
  const out = { stdout: "", stderr: "" }
  const code = await runMigrationCli({
    argv: ["run", "03-normalize-task-status", "--tools-root", root],
    env: { ...process.env },
    io: { stdout: { write: (t) => { out.stdout += t } }, stderr: { write: (t) => { out.stderr += t } } },
    pluginRoot,
    cwd: root,
  })
  assert.equal(code, 0, out.stderr)
  assert.ok(out.stdout.includes('task_update {"track":"a","slug":"ghost-active","frontmatter":{"status":"processing"}}'))
  assert.match(out.stdout, /Cards to look at by hand/u)
  assert.match(out.stdout, /I fixed task statuses in my desk/u)
  const clean = await mkTempRoot("desk-clean-")
  card(clean, "a/x", "blocked")
  const none = { stdout: "", stderr: "" }
  await runMigrationCli({ argv: ["run", "03-normalize-task-status", "--tools-root", clean], env: { ...process.env }, io: { stdout: { write: (t) => { none.stdout += t } }, stderr: { write: (t) => { none.stderr += t } } }, pluginRoot, cwd: clean })
  assert.match(none.stdout, /is not needed/u)
})

test("the script runs from the command line", async () => {
  const root = await desk()
  const result = spawnSync(process.execPath, [path.join(pluginRoot, "mcp/scripts/status-normalize.js"), "--detect", "--root", root], { encoding: "utf8" })
  assert.equal(result.status, 0)
})

test("plan with no live mappable card prints only the archived and hand-check lists", async () => {
  const root = await mkTempRoot("desk-only-")
  card(root, "_archive/old/archived-ghost", "backlog")
  card(root, "a/odd", "wip")
  const { stdout } = run(["--plan", "--root", root])
  assert.equal((stdout.match(/^task_update /gmu) ?? []).length, 0)
  assert.ok(stdout.includes("Archived cards"))
  assert.ok(stdout.includes('a/odd: "wip"'))
  const only = await mkTempRoot("desk-only-")
  card(only, "a/odd", "wip")
  const out = run(["--plan", "--root", only]).stdout
  assert.match(out, /^Desk: .*\n1 card hold/u)
  assert.ok(!out.includes("Archived cards"))
})
