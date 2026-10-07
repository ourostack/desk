// task_update's `resource`: worktrees and branches recorded as rows of the card's `## Resources` table, and the cleanup reminder in the answer.
// Desk only records and reminds; nothing here is removed by it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as os from "node:os"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs"
import { promises as fs } from "node:fs"
import { task_archive, task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { applyResource, canonicalIdentity, dueResources, openResources, readResources, shellQuote } from "../../../../../plugins/desk/mcp/src/desk/resources.js"
import { cleanupIndexPath, readCleanupIndex, recordCleanupCard } from "../../../../../plugins/desk/mcp/src/desk/cleanup-index.js"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { NO_POSIX_MODES } from "../_platform.js"

// A path as a regular expression that matches it literally, whatever separator or characters it holds.
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")
const REPOS = [{ name: "widgets" }]
const PR = "https://github.com/o/widgets/pull/7"
// A GitHub where pull request 7 is merged and released: Desk derives a step with that PR in Evidence as delivered.
const RELEASED = async (address) => {
  const answer = (status, body) => ({ status, text: async () => JSON.stringify(body) })
  if (address.includes("/contents/")) return answer(404, "")
  if (address.endsWith("/repos/o/widgets")) return answer(200, {})
  return answer(200, { state: "closed", merged_at: "2026-10-06T00:00:00Z", labels: [] })
}
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
const update = (root, input) => task_update({ deskRoot: root, input: { track: "t", slug: "chain", ...input }, fetchFn: RELEASED })
const text = (file) => fs.readFile(file, "utf8")

test("the first resource creates the section right after Steps, and the same identity updates its row", async () => {
  const { root, file } = await newCard()
  const where = worktree("api")
  const first = await update(root, { resource: { identity: `worktree:${where}/`, step: "api", intended: "remove after merge" } })
  assert.deepEqual(first.resource, { identity: `worktree:${where}`, owner: "step api", intended: "remove after merge", disposition: "" })
  assert.equal(first.cleanup_due, undefined)
  assert.match(await text(file), new RegExp(`\\| api \\| — \\| widgets \\| pending \\| — \\|\\n\\n## Resources\\n\\n${HEADER.replaceAll("|", "\\|").replaceAll("/", "\\/")}\\n${SEP.replaceAll("|", "\\|")}\\n\\| worktree:${literal(where)} \\| step api \\| — \\| remove after merge \\| — \\|  \\|\\n\\n## Progress log`, "u"))
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
  const answer = await update(root, { step: { id: "api", evidence: PR } })
  assert.deepEqual(answer.cleanup_due.map((item) => [item.identity, item.why]), [[`worktree:${where}`, "step api is delivered"], ["branch:o/widgets#feat/api", "step api is delivered"]])
  assert.match(answer.cleanup_due[0].action, new RegExp(`git worktree remove '${literal(where)}'`, "u"))
  assert.match(answer.cleanup_due[1].action, /git branch -d 'feat\/api'/u)
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
    const answer = await update(root, status === "done" ? { status, evidence: { kind: "steps" }, step: { id: "api", evidence: PR } } : { status })
    assert.deepEqual(answer.cleanup_due.map((item) => [item.identity, item.why, item.stale]), [[`worktree:${where}`, status === "done" ? "step api is delivered and the task is done" : `the task is ${status}`, true], ["branch:o/widgets#feat/end", `the task is ${status}`, undefined]])
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
  assert.equal("cleanup_due_count" in activeTasks(root).tracks[0].tasks[0], false)
  await update(root, { step: { id: "api", evidence: PR } })
  const [task] = activeTasks(root).tracks[0].tasks
  assert.equal(task.cleanup_due_count, 2)
  const out = formatBootText({ status: "ready", active_tasks: activeTasks(root) })
  assert.match(out, /- t\/chain[^\n]*\n[^\n]*next:[^\n]*\n  Steps: 1 of 1 delivered\n  cleanup due: 2\n/u)
  assert.match(out, /\nCleanup due: 2 items on 1 card \(see the task lines\)\n/u)
  assert.doesNotMatch(out, new RegExp(literal(where), "u"))
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

const unfinished = async (finish) => {
  const { root } = await newCard(undefined, [])
  const where = worktree(`idx-${Math.random().toString(16).slice(2)}`)
  await update(root, { resource: { identity: `worktree:${where}`, step: "api" } })
  await update(root, { resource: { identity: "branch:o/widgets#feat/idx" } })
  await finish(root)
  return { root, where }
}
const DONE = { status: "done", evidence: { kind: "steps" }, step: { id: "api", state: "dropped", reason: "not needed" } }

test("a finished card still reminds, whether it stays in its folder or is archived, until its rows are dealt with", async () => {
  const { root, where } = await unfinished((root) => update(root, DONE))
  const live = activeTasks(root)
  assert.deepEqual(live.cleanup, { items: 2, cards: 1, finished: [{ card: "t/chain", due: 2 }], more: 0 })
  assert.match(formatBootText({ status: "ready", active_tasks: live }), /\nCleanup due: 2 items on 1 card \(see the task lines\)\n- t\/chain \(finished\): 2 due\n/u)
  const archived = await task_archive({ deskRoot: root, input: { track: "t", slug: "chain" } })
  assert.deepEqual(archived.cleanup_due.map((item) => item.identity), [`worktree:${where}`, "branch:o/widgets#feat/idx"])
  assert.match(archived.cleanup_note, /Desk removes nothing/u)
  assert.deepEqual(activeTasks(root).cleanup.finished, [{ card: "t/chain", due: 2 }])
  // The reminder is closed by recording each row, which reaches the archived card.
  await update(root, { resource: { identity: `worktree:${where}`, disposition: "removed-and-absent", details: "gone" } })
  assert.equal(activeTasks(root).cleanup.items, 1)
  await update(root, { resource: { identity: "branch:o/widgets#feat/idx", disposition: "removed-and-absent", details: "deleted" } })
  assert.equal("cleanup" in activeTasks(root), false)
  assert.equal(JSON.parse(await fs.readFile(cleanupIndexPath(root), "utf8")).cards.length, 0)
  await assert.rejects(update(root, { note: "x" }), /task does not exist/u)
  await assert.rejects(update(root, { resource: { identity: "branch:o/widgets#feat/other" }, note: "x" }), /is archived, so a call can only record a disposition.*also has `note`/u)
})

test("a live card that is not finished is counted once, from the scan, though it is indexed", async () => {
  const { root } = await unfinished(() => {})
  await update(root, { step: { id: "api", state: "dropped", reason: "no" } })
  assert.deepEqual(activeTasks(root).cleanup, { items: 1, cards: 1, finished: [], more: 0 })
})

test("finishing the card lists every due row, not only the newly due ones", async () => {
  const { root, where } = await unfinished((root) => update(root, { step: { id: "api", state: "dropped", reason: "no" } }))
  const answer = await update(root, DONE)
  assert.equal(answer.cleanup_due.length, 2)
  assert.equal(answer.cleanup_due[0].identity, `worktree:${where}`)
})

test("the cleanup index is per desk root and per machine: only listed cards are read, odd entries and files are ignored, and a card with nothing open or gone is dropped", async () => {
  const { root } = await unfinished((root) => update(root, DONE))
  const file = cleanupIndexPath(root)
  assert.deepEqual(readCleanupIndex(root), ["t/chain"])
  await fs.writeFile(file, JSON.stringify({ cards: ["../x", "/abs", "", 7, "t/ghost", "t/chain"] }))
  assert.deepEqual(readCleanupIndex(root), ["t/ghost", "t/chain"])
  assert.deepEqual(activeTasks(root).cleanup.finished, [{ card: "t/chain", due: 2 }])
  for (const junk of ["not json", "{}", "null"]) {
    await fs.writeFile(file, junk)
    assert.deepEqual(readCleanupIndex(root), [])
  }
  await fs.rm(file)
  assert.equal("cleanup" in activeTasks(root, { env: { ...process.env, XDG_STATE_HOME: path.join(scratch, "other-state") } }), false)
  // A write starts again from a broken file, drops a gone card, and keeps the newest first.
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ cards: ["t/ghost", "t/chain"] }))
  await update(root, { resource: { identity: "branch:o/widgets#feat/more" } })
  assert.deepEqual(readCleanupIndex(root), ["t/chain"])
  await fs.writeFile(file, "garbage")
  await update(root, { resource: { identity: "branch:o/widgets#feat/more2" } })
  assert.deepEqual(readCleanupIndex(root), ["t/chain"])
})

test("recording a card keeps the desk spelling with `/` on every platform: an archived card is listed by its live folder, and a backslash spelling is never rewritten as the same card", () => {
  const root = mkdtempSync(path.join(scratch, "cleanup-spelling-"))
  recordCleanupCard(root, "t/_archive/chain", true)
  assert.deepEqual(readCleanupIndex(root), ["t/chain"])
  // A folder spelled with `\` is not the `/` card: a posix split would have to treat it as one name, so it is listed as written, never merged into or replaced by `t/chain`.
  recordCleanupCard(root, "t\\_archive\\other", true)
  assert.deepEqual(readCleanupIndex(root), ["t\\_archive\\other"])
})

test("a state folder that cannot be written never fails the card write", async () => {
  const { root } = await newCard()
  const blocked = path.join(scratch, "blocked-state")
  await fs.writeFile(blocked, "a file, not a folder")
  const saved = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = blocked
  try {
    const answer = await task_update({ deskRoot: root, input: { track: "t", slug: "chain", resource: { identity: "branch:o/widgets#feat/x" } }, env: { ...process.env, XDG_STATE_HOME: blocked } })
    assert.equal(answer.resource.identity, "branch:o/widgets#feat/x")
  } finally {
    process.env.XDG_STATE_HOME = saved
  }
})

test("suggested commands quote paths and branch names, and a branch's action names its clone", () => {
  assert.equal(shellQuote("a b'c"), "'a b'\\''c'")
  const body = applyResource("", { identity: "worktree:/tmp/it's here" }, "task_update", "t/c").body
  const [item] = dueResources(applyResource(body, { identity: "branch:o/r#feat/it's" }, "task_update", "t/c").body, { status: "done", exists: () => true })
  assert.match(item.action, /git worktree remove '\/tmp\/it'\\''s here'/u)
  const [, branch] = dueResources(applyResource(body, { identity: "branch:o/r#feat/it's" }, "task_update", "t/c").body, { status: "done", exists: () => true })
  assert.match(branch.action, /^in your clone of o\/r: .*git branch -d 'feat\/it'\\''s'.*git push origin --delete 'feat\/it'\\''s'/u)
})

test("identities match on their trimmed, trailing-separator-free form, and a branch may name an Azure DevOps org/project/repo", () => {
  const hand = `## Resources\n\n${HEADER}\n${SEP}\n|  worktree:/x/y/  | step a | — | keep | — |  |\n`
  const out = applyResource(hand, { identity: "worktree:/x/y", intended: "now" }, "task_update", "t/c")
  assert.equal(out.created, false)
  assert.match(out.body, /\| worktree:\/x\/y \| step a \| — \| now \| — \|  \|\n$/u)
  assert.deepEqual(openResources(hand), ["worktree:/x/y"])
  assert.equal(canonicalIdentity("branch:org/project/repo#feat/x"), "branch:org/project/repo#feat/x")
  assert.equal(canonicalIdentity("branch:a/b/c/d#x"), null)
  const [item] = dueResources(applyResource("", { identity: "branch:org/project/repo#feat" }, "task_update", "t/c").body, { status: "done" })
  assert.match(item.action, /in your clone of org\/project\/repo/u)
})

test("a write drops listed cards whose rows are all closed or that have no Resources table", async () => {
  const { root, where } = await unfinished(() => {})
  await task_create({ deskRoot: root, input: { track: "t", slug: "plain", title: "P", body: "Nothing.\n" } })
  await task_create({ deskRoot: root, input: { track: "t", slug: "other", title: "O", body: "Nothing.\n" } })
  await update(root, { resource: { identity: `worktree:${where}`, disposition: "removed-and-absent", details: "gone" } })
  await update(root, { resource: { identity: "branch:o/widgets#feat/idx", disposition: "named transfer", details: "ari, acknowledged" } })
  await fs.writeFile(cleanupIndexPath(root), JSON.stringify({ cards: ["t/chain", "t/plain"] }))
  await task_update({ deskRoot: root, input: { track: "t", slug: "other", resource: { identity: "branch:o/widgets#feat/o" } } })
  assert.deepEqual(readCleanupIndex(root), ["t/other"])
})

test("a listed finished card with nothing due adds nothing, and a resource call for a card that is nowhere is refused", async () => {
  const { root, where } = await unfinished((root) => update(root, DONE))
  await update(root, { resource: { identity: `worktree:${where}`, disposition: "removed-and-absent", details: "gone" } })
  await update(root, { resource: { identity: "branch:o/widgets#feat/idx", disposition: "removed-and-absent", details: "gone" } })
  await fs.writeFile(cleanupIndexPath(root), JSON.stringify({ cards: ["t/chain"] }))
  assert.equal("cleanup" in activeTasks(root), false)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "ghost", resource: { identity: "branch:o/widgets#x" } } }), /task does not exist at t\/ghost/u)
})

test("an archived card takes only a disposition on an existing row: its frontmatter stays byte for byte and no report or sync is asked for", async () => {
  const { root } = await unfinished((root) => update(root, DONE))
  await task_archive({ deskRoot: root, input: { track: "t", slug: "chain" } })
  const file = path.join(root, "t", "_archive", "chain", "task.md")
  const front = (raw) => raw.slice(0, raw.indexOf("\n---\n", 4))
  const before = await text(file)
  let finalized = 0
  const call = (resource, more = {}) => task_update({ deskRoot: root, input: { track: "t", slug: "chain", resource, ...more }, finalize: () => { finalized += 1 } })
  const refused = async (resource, pattern, more) => {
    await assert.rejects(call(resource, more), pattern)
    assert.equal(await text(file), before)
  }
  await refused({ identity: "branch:o/widgets#feat/new" }, /no `disposition`/u)
  await refused({ identity: "branch:o/widgets#feat/new", disposition: "removed-and-absent", details: "x" }, /not a row of its Resources table/u)
  await refused({ identity: "branch:o/widgets#feat/idx", disposition: "removed-and-absent", details: "x", intended: "y" }, /the resource has `intended`/u)
  await refused({ identity: "branch:o/widgets#feat/idx", disposition: "removed-and-absent", details: "x", step: "api" }, /the resource has `step`/u)
  await refused({ identity: "branch:o/widgets#feat/idx", disposition: "removed-and-absent", details: "x" }, /also has `next_step`/u, { next_step: "z" })
  const answer = await call({ identity: "branch:o/widgets#feat/idx", disposition: "removed-and-absent", details: "deleted" })
  assert.deepEqual(answer, { status: "updated", path: "t/_archive/chain/task.md", resource: { identity: "branch:o/widgets#feat/idx", owner: "task t/chain", intended: "—", disposition: "removed-and-absent: deleted" } })
  const after = await text(file)
  assert.equal(front(after), front(before))
  assert.deepEqual(after.split("\n").filter((line, index) => line !== before.split("\n")[index]), ["| branch:o/widgets#feat/idx | task t/chain | — | — | — | removed-and-absent: deleted |"])
  assert.equal(finalized, 0)
})

test("every indexed card with an open row is kept, unfinished cards are skipped before the cap, and finished cards past the cap are counted", async () => {
  const root = await mkTempDeskRoot()
  const row = "| branch:o/r#x | task t/c | — | — | — |  |"
  const card = (status) => `---\nstatus: ${status}\ntitle: c\n---\n\n## Resources\n\n${HEADER}\n${SEP}\n${row}\n`
  const names = []
  for (let index = 0; index < 25; index += 1) {
    await fs.mkdir(path.join(root, "t", `live-${index}`), { recursive: true })
    await fs.writeFile(path.join(root, "t", `live-${index}`, "task.md"), card("processing"))
    names.push(`t/live-${index}`)
  }
  for (let index = 0; index < 22; index += 1) {
    await fs.mkdir(path.join(root, "t", `fin-${index}`), { recursive: true })
    await fs.writeFile(path.join(root, "t", `fin-${index}`, "task.md"), card("done"))
    names.push(`t/fin-${index}`)
  }
  await fs.mkdir(path.dirname(cleanupIndexPath(root)), { recursive: true })
  await fs.writeFile(cleanupIndexPath(root), JSON.stringify({ cards: names }))
  assert.equal(readCleanupIndex(root).length, 47)
  const { cleanup } = activeTasks(root)
  assert.equal(cleanup.items, 22)
  assert.equal(cleanup.cards, 22)
  assert.equal(cleanup.finished.length, 20)
  assert.equal(cleanup.more, 2)
  assert.match(formatBootText({ status: "ready", active_tasks: activeTasks(root) }), /\n- t\/fin-19 \(finished\): 1 due\n- and 2 more finished cards\n/u)
  await fs.rm(path.join(root, "t", "fin-0"), { recursive: true })
  assert.match(formatBootText({ status: "ready", active_tasks: activeTasks(root) }), /\n- and 1 more finished card\n/u)
  // A write keeps every card that still has an open row, however many there are.
  await task_create({ deskRoot: root, input: { track: "t", slug: "new", title: "N", body: "x\n" } })
  await task_update({ deskRoot: root, input: { track: "t", slug: "new", resource: { identity: "branch:o/r#new" } } })
  assert.equal(readCleanupIndex(root).length, 47)
})

test("an archived card without frontmatter or without the row is handled, a state folder that cannot be written does not fail it, and a git desk commits the one cell", async () => {
  const root = await mkTempDeskRoot()
  const row = "| branch:o/r#x | task t/c | — | — | — |  |"
  const archive = async (slug, raw) => {
    await fs.mkdir(path.join(root, "t", "_archive", slug), { recursive: true })
    await fs.writeFile(path.join(root, "t", "_archive", slug, "task.md"), raw)
  }
  await archive("bare", `## Resources\n\n${HEADER}\n${SEP}\n${row}\n`)
  await archive("none", "---\nstatus: done\n---\n\nNo table.\n")
  const call = (slug, extra = {}) => task_update({ deskRoot: root, input: { track: "t", slug, resource: { identity: "branch:o/r#x", disposition: "retained-with-trigger", details: "ari; PR 9" } }, ...extra })
  await assert.rejects(call("none"), /not a row of its Resources table/u)
  const blocked = path.join(scratch, "blocked-state-2")
  await fs.writeFile(blocked, "a file")
  const answer = await call("bare", { env: { ...process.env, XDG_STATE_HOME: blocked } })
  assert.equal(answer.resource.disposition, "retained-with-trigger: ari; PR 9")
  assert.match(await text(path.join(root, "t", "_archive", "bare", "task.md")), /^## Resources[\s\S]*\| retained-with-trigger: ari; PR 9 \|\n$/u)
  // On a git desk the one card is committed; a failed commit comes back in the answer and nothing is thrown.
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  await archive("tracked", `---\nstatus: done\n---\n\n## Resources\n\n${HEADER}\n${SEP}\n${row}\n`)
  git("add", "-A")
  git("commit", "-qm", "seed")
  let pushes = 0
  const committed = await call("tracked", { schedulePush: () => { pushes += 1 } })
  assert.equal(committed.commit, undefined)
  assert.equal(pushes, 1)
  assert.equal(git("log", "-1", "--format=%s").stdout.trim(), "task_update: t/tracked")
  const failing = (command, args, options) => (args.includes("commit") ? { status: 1, stdout: "", stderr: "no" } : spawnSync(command, args, options))
  await archive("tracked2", `---\nstatus: done\n---\n\n## Resources\n\n${HEADER}\n${SEP}\n${row}\n`)
  git("add", "-A")
  git("commit", "-qm", "seed2")
  assert.equal((await call("tracked2", { spawnGit: failing })).commit.status, "failed")
})

test("a step Desk derives as delivered from its PR on a later call makes its rows due, announced once, like one a caller settled", async () => {
  const { root } = await newCard()
  const where = worktree("derived")
  let merged = false
  const github = async (address) => (merged || address.includes("/contents/") || address.endsWith("/repos/o/widgets") ? RELEASED(address) : { status: 200, text: async () => JSON.stringify({ state: "open", merged_at: null, labels: [] }) })
  const later = (input) => task_update({ deskRoot: root, input: { track: "t", slug: "chain", ...input }, fetchFn: github })
  await later({ resource: { identity: `worktree:${where}`, step: "api" } })
  assert.equal("cleanup_due" in (await later({ step: { id: "api", evidence: PR } })), false, "in review: nothing due yet")
  merged = true
  const answer = await later({ note: "checked" })
  assert.deepEqual(answer.steps_refreshed, ["api: in review -> delivered"])
  assert.deepEqual(answer.cleanup_due.map((item) => [item.identity, item.why]), [[`worktree:${where}`, "step api is delivered"]])
  assert.equal("cleanup_due" in (await later({ note: "again" })), false)
})

test("an archived card's disposition is written through a temporary file: its mode stays and no temporary file is left", { skip: NO_POSIX_MODES }, async () => {
  const { root, where } = await unfinished((root) => update(root, DONE))
  await task_archive({ deskRoot: root, input: { track: "t", slug: "chain" } })
  const file = path.join(root, "t", "_archive", "chain", "task.md")
  await fs.chmod(file, 0o640)
  await update(root, { resource: { identity: `worktree:${where}`, disposition: "removed-and-absent", details: "gone" } })
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640)
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), [])
  assert.match(await fs.readFile(file, "utf8"), /removed-and-absent: gone/u)
})
