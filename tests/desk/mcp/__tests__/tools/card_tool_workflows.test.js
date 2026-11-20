// Card tool workflows: a card in a sibling desk (#1394), many resource rows in one commit (#1393), a signoff refusal that names the next call (#1391),
// and no hash quoted from a hosted desk's unpushed commit (#1389). Every desk here is a synthetic temp folder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { task_archive, task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { taskSignoff } from "../../../../../plugins/desk/mcp/src/tools/task-signoff.js"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { mkTempDeskRoot } from "./_helpers.js"

const git = (cwd, ...args) => {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`)
  return run.stdout.trim()
}
const gitDesk = async () => {
  const root = realpathSync(await mkTempDeskRoot())
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  await fs.writeFile(path.join(root, "README.md"), "desk\n")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "init")
  return root
}
const count = (root) => Number(git(root, "rev-list", "--count", "HEAD"))
const card = (root, input) => task_create({ deskRoot: root, input: { track: "t", slug: "work", title: "Work", ...input }, schedulePush() {} })
const noPush = { schedulePush() {} }

async function registry(...desks) {
  const home = realpathSync(await mkTempDeskRoot())
  const file = path.join(home, "desks.md")
  const rows = desks.map(([name, where]) => `| ${name} | ${where} | sample/${name} |`).join("\n")
  await fs.writeFile(file, `| desk | local path | repo |\n|---|---|---|\n${rows}\n`)
  return { home, env: { ...process.env, HOME: home, DESK_REGISTRY: file } }
}
const call = (root, name, input, env) => callTool({ deskRoot: root, name, input, env })
const answer = (res) => JSON.parse(res.content[0].text)

test("task_update writes a card in a second registered desk, by name or path, and refuses an unregistered root", async () => {
  const bound = await gitDesk()
  const sibling = await gitDesk()
  const stranger = await gitDesk()
  await card(sibling, {})
  const { env } = await registry(["bound", bound], ["sibling", sibling])

  const byName = answer(await call(bound, "task_update", { desk: "sibling", track: "t", slug: "work", note: "from the other desk" }, env))
  assert.equal(byName.status, "updated")
  assert.equal(byName.desk_root, sibling)
  assert.match(await fs.readFile(path.join(sibling, "t", "work", "task.md"), "utf8"), /from the other desk/u)
  assert.deepEqual(await fs.readdir(bound), [".git", "README.md"])

  const byPath = answer(await call(bound, "task_update", { desk: sibling, track: "t", slug: "work", note: "by folder" }, env))
  assert.equal(byPath.status, "updated")

  for (const desk of [stranger, "nobody"]) {
    const refused = await call(bound, "task_update", { desk, track: "t", slug: "work", note: "no" }, env)
    assert.equal(refused.isError, true)
    assert.match(answer(refused).message, /registered/u)
  }
  assert.doesNotMatch(await fs.readFile(path.join(sibling, "t", "work", "task.md"), "utf8"), /\bno\b\s*$/mu)
})

test("a person-scoped session and a Crew desk are refused a sibling write", async () => {
  const bound = await gitDesk()
  const sibling = await gitDesk()
  const home = realpathSync(await mkTempDeskRoot())
  const file = path.join(home, "desks.md")
  await fs.writeFile(file, `| crew | local path | repo |\n|---|---|---|\n| team | ${sibling} | sample/team |\n`)
  const env = { ...process.env, HOME: home, DESK_REGISTRY: file }
  const crew = await call(bound, "task_update", { desk: "team", track: "t", slug: "work", note: "x" }, env)
  assert.match(answer(crew).message, /Crew desk/u)
  const person = await callTool({ deskRoot: bound, name: "task_update", input: { desk: "team", track: "t", slug: "work", note: "x" }, person: "ari", env })
  assert.match(answer(person).message, /person-scoped/u)
})

test("task_update records many resource rows in one commit", async () => {
  const root = await gitDesk()
  await card(root, {})
  const before = count(root)
  const rows = ["a", "b", "c"].map((n) => ({ identity: `branch:sample/widgets#feat/${n}`, intended: "remove after merge" }))
  const written = await task_update({ deskRoot: root, input: { track: "t", slug: "work", resources: rows }, ...noPush })
  assert.equal(count(root), before + 1)
  assert.equal(written.resources.length, 3)
  const closed = await task_update({ deskRoot: root, input: { track: "t", slug: "work", resources: rows.map((row) => ({ identity: row.identity, disposition: "removed-and-absent", details: "git branch no longer lists it" })) }, ...noPush })
  assert.equal(count(root), before + 2)
  assert.ok(closed.resources.every((row) => row.disposition.startsWith("removed-and-absent")))
  const text = await fs.readFile(path.join(root, "t", "work", "task.md"), "utf8")
  assert.equal((text.match(/removed-and-absent/gu) ?? []).length, 3)
})

test("a bad row in resources refuses the whole call and writes nothing", async () => {
  const root = await gitDesk()
  await card(root, {})
  const before = count(root)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "work", resources: [{ identity: "branch:sample/widgets#ok" }, { identity: "nonsense" }] }, ...noPush }))
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "work", resources: "x" }, ...noPush }), /array/u)
  assert.equal(count(root), before)
  assert.doesNotMatch(await fs.readFile(path.join(root, "t", "work", "task.md"), "utf8"), /sample\/widgets#ok/u)
})

test("task_signoff at validating names the exact task_update call, for a card with and without steps", async () => {
  const root = await gitDesk()
  await card(root, { status: "validating" })
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: "work", outcome: "accepted" }, ...noPush }), (error) => {
    assert.match(error.message, /task_update \{"track":"t","slug":"work","status":"done","evidence":\{"kind":"pr","ref":"<pull request URL>"\}\}/u)
    return true
  })
  await card(root, { slug: "stepped", status: "validating", steps: [{ id: "one", repo: "—", depends_on: [] }] })
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: "stepped", outcome: "accepted" }, ...noPush }), /"evidence":\{"kind":"steps"\}/u)
})

test("a hosted desk's answers carry no commit hash, only that the push is pending; a local desk's still do", async () => {
  const root = await gitDesk()
  await card(root, {})
  const hosted = { ...process.env, DESK_HOSTED: "1" }
  const updated = await task_update({ deskRoot: root, input: { track: "t", slug: "work", note: "hosted" }, env: hosted, ...noPush })
  assert.equal(updated.desk_commit, undefined)
  assert.equal(updated.desk_commit_note, undefined)
  assert.match(updated.desk_commit_pending, /push is pending/u)
  await fs.writeFile(path.join(root, "notes.md"), "n\n")
  const saved = await desk_save({ deskRoot: root, input: { paths: ["notes.md"], message: "save notes" }, env: hosted, ...noPush })
  assert.equal(saved.status, "committed")
  assert.equal(saved.desk_commit, undefined)
  assert.match(saved.desk_commit_pending, /push is pending/u)
  const local = await task_update({ deskRoot: root, input: { track: "t", slug: "work", note: "local" }, env: { ...process.env, DESK_HOSTED: "" }, ...noPush })
  assert.match(local.desk_commit, /^[0-9a-f]{7,}$/u)
})

test("a registry row the session wrote in its own desk does not make another folder writable", async () => {
  const bound = await gitDesk()
  const stranger = await gitDesk()
  await card(stranger, {})
  await fs.mkdir(path.join(bound, "_meta"), { recursive: true })
  await fs.writeFile(path.join(bound, "_meta", "desks.md"), `| desk | local path | repo |\n|---|---|---|\n| sneaky | ${stranger} | sample/sneaky |\n`)
  const home = realpathSync(await mkTempDeskRoot())
  const refused = await call(bound, "task_update", { desk: "sneaky", track: "t", slug: "work", note: "no" }, { ...process.env, HOME: home })
  assert.equal(refused.isError, true)
  assert.doesNotMatch(await fs.readFile(path.join(stranger, "t", "work", "task.md"), "utf8"), /\bno\b\s*$/mu)
})

test("resources must be a non-empty list, even as a JSON string, and an archived card takes several rows at once", async () => {
  const root = await gitDesk()
  await card(root, {})
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "work", resources: [] }, ...noPush }), /at least one row/u)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "work", resources: "not json" }, ...noPush }), /array/u)
  const rows = ["a", "b"].map((n) => ({ identity: `branch:sample/widgets#feat/${n}`, intended: "remove after merge" }))
  await task_update({ deskRoot: root, input: { track: "t", slug: "work", resources: JSON.stringify(rows) }, ...noPush })
  await task_update({ deskRoot: root, input: { track: "t", slug: "work", status: "cancelled", note: "not needed" }, ...noPush })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "work" }, ...noPush })
  const closed = await task_update({ deskRoot: root, input: { track: "t", slug: "work", resources: rows.map((row) => ({ identity: row.identity, disposition: "removed-and-absent", details: "gone" })) }, ...noPush })
  assert.equal(closed.resources.length, 2)
})

test("an absolute path that is not on this machine is refused as unregistered", async () => {
  const bound = await gitDesk()
  const { env } = await registry(["bound", bound])
  const refused = await call(bound, "task_update", { desk: path.join(bound, "does", "not", "exist"), track: "t", slug: "work", note: "no" }, env)
  assert.equal(refused.isError, true)
})

test("a desk registered at a folder this machine does not have is refused by name and by path", async () => {
  const bound = await gitDesk()
  const gone = path.join(bound, "missing-desk")
  const { env } = await registry(["bound", bound], ["gone", gone])
  for (const desk of [gone, "gone"]) {
    const refused = await call(bound, "task_update", { desk, track: "t", slug: "work", note: "no" }, env)
    assert.equal(refused.isError, true)
    assert.match(answer(refused).message, /not on this machine|registered/u)
  }
})

test("an empty or non-text desk is refused", async () => {
  const bound = await gitDesk()
  const { env } = await registry(["bound", bound])
  for (const desk of ["  ", 7]) {
    assert.equal((await call(bound, "task_update", { desk, track: "t", slug: "work", note: "no" }, env)).isError, true)
  }
})
