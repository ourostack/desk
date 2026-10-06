// task_update's `resource`: worktrees and branches recorded as rows of the card's `## Resources` table, and the cleanup reminder in the answer.
// Desk only records and reminds; nothing here is removed by it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as os from "node:os"
import * as path from "node:path"
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs"
import { promises as fs } from "node:fs"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { applyResource, canonicalIdentity, dueResources, readResources } from "../../../../../plugins/desk/mcp/src/desk/resources.js"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { mkTempDeskRoot } from "./_helpers.js"

const REPOS = [{ name: "widgets" }]
const PR = "https://github.com/o/widgets/pull/7"
const HEADER = "| Exact resource / generation identity | Owning task / attempt / generation | Active writers / consumers | Intended disposition | Evidence pointer | Terminal disposition details |"
const SEP = "|---|---|---|---|---|---|"
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "desk-resources-")))
const worktree = (name) => {
  const where = path.join(scratch, name)
  mkdirSync(where, { recursive: true })
  return where
}

async function newCard(body = "## Outcome\n\nShip it.\n\n## Progress log\n\n- 2026-10-01: began\n", repos = REPOS) {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "chain", title: "T", body, repos } })
  const file = path.join(root, "t", "chain", "task.md")
  await task_update({ deskRoot: root, input: { track: "t", slug: "chain", step: { id: "api", depends_on: [], repo: repos.length > 0 ? "widgets" : "—" } } })
  return { root, file }
}
const update = (root, input) => task_update({ deskRoot: root, input: { track: "t", slug: "chain", ...input } })
const text = (file) => fs.readFile(file, "utf8")

test("the first resource creates the section right after Steps, and the same identity updates its row", async () => {
  const { root, file } = await newCard()
  const where = worktree("api")
  const first = await update(root, { resource: { identity: `worktree:${where}/`, step: "api", intended: "remove after merge" } })
  assert.deepEqual(first.resource, { identity: `worktree:${where}`, owner: "step api", intended: "remove after merge", disposition: "" })
  assert.equal(first.cleanup_due, undefined)
  assert.match(await text(file), new RegExp(`\\| api \\| — \\| widgets \\| pending \\| — \\|\\n\\n## Resources\\n\\n${HEADER.replaceAll("|", "\\|").replaceAll("/", "\\/")}\\n${SEP.replaceAll("|", "\\|")}\\n\\| worktree:${where.replaceAll("/", "\\/")} \\| step api \\| — \\| remove after merge \\| — \\|  \\|\\n\\n## Progress log`, "u"))
  await update(root, { resource: { identity: `branch:o/widgets#feat/api` } })
  const again = await update(root, { resource: { identity: `worktree:${where}`, intended: "keep for review" } })
  assert.equal(again.resource.intended, "keep for review")
  assert.equal(again.resource.owner, "step api")
  const read = readResources((await text(file)).replace(/^---[\s\S]*?\n---\n/u, ""))
  assert.deepEqual(read.rows.map((row) => [row.identity, row.owner, row.intended]), [[`worktree:${where}`, "step api", "keep for review"], ["branch:o/widgets#feat/api", "task t/chain", "—"]])
})

test("a card with no Outcome or Steps gets the section at the end of the body, and nothing else changes", () => {
  const out = applyResource("Intro.\n", { identity: "branch:o/r#x" }, "task_update", "t/c")
  assert.equal(out.body, `Intro.\n\n## Resources\n\n${HEADER}\n${SEP}\n| branch:o/r#x | task t/c | — | — | — |  |\n`)
  assert.equal(out.created, true)
  assert.equal(applyResource("", { identity: "branch:o/r#x" }, "task_update", "t/c").body, `## Resources\n\n${HEADER}\n${SEP}\n| branch:o/r#x | task t/c | — | — | — |  |\n`)
  const short = applyResource(`## Resources\n\n${HEADER}\n${SEP}\n| branch:o/r#short |\n`, { identity: "branch:o/r#short", intended: "drop" }, "task_update", "t/c")
  assert.equal(short.row.owner, "")
  const afterOutcome = applyResource("## Outcome\n\nx\n\n## Other\n\ny\n", { identity: "branch:o/r#x" }, "task_update", "t/c")
  assert.match(afterOutcome.body, /x\n\n## Resources\n[\s\S]*\n\n## Other\n\ny\n$/u)
})

test("rows with escaped pipes, extra columns and untyped identities survive other writes byte for byte", async () => {
  const where = worktree("keep")
  const table = [
    `${HEADER.slice(0, -1)}| Extra |`,
    `${SEP.slice(0, -1)}|---|`,
    "| host:vm-3 \\| generation 2 | task a\\|b | none | retain | pointer | | note |",
    `| worktree:${where} | step api | — | remove | — | | mine |`,
    "| branch:o/widgets#odd\\|name-is-not-typed | step api | — | — | — | | |",
  ]
  const { root, file } = await newCard(`## Outcome\n\nx\n\n## Resources\n\nNotes.\n\n${table.join("\n")}\n\nAfter.\n`)
  const before = (await text(file)).split("\n")
  await update(root, { note: "other write", step: { id: "api", state: "in progress" } })
  await update(root, { resource: { identity: "branch:o/widgets#new" } })
  await update(root, { resource: { identity: `worktree:${where}`, disposition: "retained-with-trigger", details: "owner ari | trigger: PR 9 merges" } })
  const lines = (await text(file)).split("\n")
  for (const kept of [table[0], table[1], table[2], table[4], "After.", "Notes."]) assert.ok(lines.includes(kept), kept)
  assert.ok(lines.includes(`| worktree:${where} | step api | — | remove | — | retained-with-trigger: owner ari \\| trigger: PR 9 merges | mine |`))
  assert.ok(lines.includes("| branch:o/widgets#new | task t/chain | — | — | — |  |  |"))
  assert.ok(before.includes(table[2]))
  const read = readResources((await text(file)).replace(/^---[\s\S]*?\n---\n/u, ""))
  assert.equal(read.rows[0].identity, "host:vm-3 | generation 2")
  assert.equal(read.rows[0].owner, "task a|b")
  assert.equal(read.rows.at(-1).terminal, "")
})

test("a card with no Resources table is unchanged by every other write, and a resource refusal changes nothing", async () => {
  const { root, file } = await newCard()
  await update(root, { next_step: "keep going" })
  assert.doesNotMatch(await text(file), /Resources/u)
  const answer = await update(root, { step: { id: "api", state: "in progress" } })
  for (const key of ["resource", "cleanup_due", "cleanup_note"]) assert.equal(key in answer, false)
  assert.doesNotMatch(await text(file), /Resources/u)
  const snapshot = await text(file)
  await assert.rejects(update(root, { resource: { identity: "process:123" } }), /must be `worktree:<absolute path>` or `branch:/u)
  assert.equal(await text(file), snapshot)
})

test("a row is due when its step is delivered or dropped, the answer lists it with the safe action, and filling the disposition ends it", async () => {
  const { root, file } = await newCard()
  const where = worktree("due")
  await task_update({ deskRoot: root, input: { track: "t", slug: "chain", step: { id: "ui", depends_on: ["api"], repo: "widgets" } } })
  await update(root, { resource: { identity: `worktree:${where}`, step: "api" } })
  await update(root, { resource: { identity: "branch:o/widgets#feat/api", step: "api" } })
  await update(root, { resource: { identity: "branch:o/widgets#feat/ui", step: "ui" } })
  const answer = await update(root, { step: { id: "api", state: "delivered", evidence: PR } })
  assert.deepEqual(answer.cleanup_due.map((item) => [item.identity, item.why]), [[`worktree:${where}`, "step api is delivered"], ["branch:o/widgets#feat/api", "step api is delivered"]])
  assert.match(answer.cleanup_due[0].action, new RegExp(`git worktree remove ${where.replaceAll("/", "\\/")}`, "u"))
  assert.match(answer.cleanup_due[1].action, /git branch -d feat\/api/u)
  assert.match(answer.cleanup_note, /Desk removes nothing/u)
  assert.equal(existsSync(where), true)
  // The same rows are not announced again by a call that makes nothing new due.
  assert.equal("cleanup_due" in (await update(root, { note: "again" })), false)
  const filled = await update(root, { resource: { identity: `worktree:${where}`, disposition: "removed-and-absent", details: "git worktree list no longer shows it" } })
  assert.equal(filled.resource.disposition, "removed-and-absent: git worktree list no longer shows it")
  assert.equal("cleanup_due" in filled, false)
  const tail = await update(root, { step: { id: "ui", state: "dropped", reason: "not needed" } })
  assert.deepEqual(tail.cleanup_due.map((item) => item.identity), ["branch:o/widgets#feat/api", "branch:o/widgets#feat/ui"])
  const body = (await text(file)).replace(/^---[\s\S]*?\n---\n/u, "")
  assert.deepEqual(dueResources(body, { status: "processing" }).map((item) => item.identity), ["branch:o/widgets#feat/api", "branch:o/widgets#feat/ui"])
})

test("a card moving to done or cancelled lists its due rows, and a deleted worktree path reads stale row", async () => {
  for (const status of ["cancelled", "done"]) {
    const { root } = await newCard(undefined, [])
    const where = worktree(`end-${status}`)
    await update(root, { resource: { identity: `worktree:${where}`, step: "api" } })
    await update(root, { resource: { identity: "branch:o/widgets#feat/end" } })
    assert.equal("cleanup_due" in (await update(root, { note: "working" })), false)
    rmSync(where, { recursive: true })
    const answer = await update(root, status === "done" ? { status, evidence: { kind: "non_code", ref: "https://example.com/proof" } } : { status })
    assert.deepEqual(answer.cleanup_due.map((item) => [item.identity, item.why, item.stale]), [[`worktree:${where}`, `the task is ${status}`, true], ["branch:o/widgets#feat/end", `the task is ${status}`, undefined]])
    assert.match(answer.cleanup_due[0].action, /^stale row: .* is not on this machine/u)
    assert.match(answer.cleanup_due[0].action, /removed-and-absent/u)
  }
})

test("boot counts due rows from the cards it reads, prints one line, and prints nothing when none are due", async () => {
  const { root } = await newCard()
  const where = worktree("boot")
  await update(root, { resource: { identity: `worktree:${where}`, step: "api" } })
  await update(root, { resource: { identity: "branch:o/widgets#feat/boot", step: "api" } })
  const quiet = formatBootText({ status: "ready", active_tasks: activeTasks(root) })
  assert.doesNotMatch(quiet, /Cleanup due|cleanup due/u)
  assert.equal("cleanup_due" in activeTasks(root).tracks[0].tasks[0], false)
  await update(root, { step: { id: "api", state: "delivered", evidence: PR } })
  const [task] = activeTasks(root).tracks[0].tasks
  assert.equal(task.cleanup_due, 2)
  const out = formatBootText({ status: "ready", active_tasks: activeTasks(root) })
  assert.match(out, /- t\/chain[^\n]*\n[^\n]*next:[^\n]*\n  Steps: 1 of 1 delivered\n  cleanup due: 2\n/u)
  assert.match(out, /\nCleanup due: 2 items on 1 cards\n/u)
  assert.doesNotMatch(out, new RegExp(where.replaceAll("/", "\\/"), "u"))
  await update(root, { resource: { identity: `worktree:${where}`, disposition: "removed-and-absent", details: "gone" } })
  await update(root, { resource: { identity: "branch:o/widgets#feat/boot", disposition: "named transfer", details: "ari took it, acknowledged" } })
  assert.doesNotMatch(formatBootText({ status: "ready", active_tasks: activeTasks(root) }), /Cleanup due/u)
})

test("the input is validated: identity forms, step on the card, disposition with details, unknown fields, an unreadable table", async () => {
  const { root, file } = await newCard()
  const bad = (resource, pattern) => assert.rejects(update(root, { resource }), pattern)
  await bad({ identity: "worktree:relative/path" }, /must be `worktree:<absolute path>`/u)
  await bad({ identity: "worktree:/" }, /must be `worktree:<absolute path>`/u)
  await bad({ identity: 7 }, /must be `worktree:<absolute path>`/u)
  await bad({ identity: "branch:justaname" }, /must be `worktree:<absolute path>`/u)
  await bad({ identity: "branch:o/r#x", extra: 1 }, /unknown field `extra`/u)
  await bad({ identity: "branch:o/r#x", extra: 1, more: 2 }, /unknown fields `extra`, `more`/u)
  await bad({ identity: "branch:o/r#x", step: "nope" }, /not a step of this card/u)
  assert.throws(() => applyResource("## Outcome\n\nx\n", { identity: "branch:o/r#x", step: "api" }, "task_update", "t/c"), /not a step of this card/u)
  await bad({ identity: "branch:o/r#x", step: 5 }, /`step` must be text/u)
  await bad({ identity: "branch:o/r#x", disposition: "gone", details: "x" }, /must be one of removed-and-absent/u)
  await bad({ identity: "branch:o/r#x", disposition: "removed-and-absent" }, /go together/u)
  await bad({ identity: "branch:o/r#x", details: "x" }, /go together/u)
  await bad({ identity: "branch:o/r#x", disposition: "named transfer", details: "  " }, /cannot be empty/u)
  await bad("{not json", /resource/u)
  assert.doesNotMatch(await text(file), /Resources/u)
  const prose = await newCard("## Outcome\n\nx\n\n## Resources\n\nJust words.\n")
  await assert.rejects(update(prose.root, { resource: { identity: "branch:o/r#x" } }), /left as prose because there is no table under the heading/u)
  assert.equal(canonicalIdentity("worktree:C:\\work\\a\\"), "worktree:C:\\work\\a")
})

test("a table Desk cannot read is not reminded about, and fenced copies and cut cards are ignored", () => {
  assert.equal(readResources("## Resources\n\n| Identity | State |\n|---|---|\n").reason, 'the table has no "Exact resource / generation identity", "Owning task / attempt / generation", "Active writers / consumers", "Intended disposition", "Evidence pointer", "Terminal disposition details" column')
  assert.match(readResources(`## Resources\n\n${HEADER}\n| a |\n`).reason, /no separator row/u)
  assert.match(readResources(`## Resources\n\n${HEADER}\n${SEP}\n| branch:o/r#x | step a | — | — | — |  |\n`, { truncated: true }).reason, /cut at the read limit/u)
  const fenced = `\`\`\`md\n## Resources\n\n${HEADER}\n${SEP}\n| branch:o/r#x | task t/c | — | — | — |  |\n\`\`\`\n`
  assert.equal(readResources(fenced).found, false)
  assert.deepEqual(dueResources(fenced, { status: "done" }), [])
  assert.deepEqual(dueResources("## Resources\n\nwords\n", { status: "done" }), [])
  // Rows with a disposition, an untyped identity or no due reason are skipped; a step the card does not have is not a reason.
  const rows = [
    "| branch:o/r#a | step a | — | — | — | removed-and-absent: gone |",
    "| process:9 | task t/c | — | — | — |  |",
    "| branch:o/r#b | step ghost | — | — | — |  |",
    "| branch:o/r#c | step a | — | — | — |  |",
  ].join("\n")
  const steps = "## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n| a | — | — | in progress | — |\n"
  const body = `${steps}\n## Resources\n\n${HEADER}\n${SEP}\n${rows}\n`
  assert.deepEqual(dueResources(body, { status: "processing" }), [])
  assert.deepEqual(dueResources(body, { status: "done" }).map((item) => item.identity), ["branch:o/r#b", "branch:o/r#c"])
})
