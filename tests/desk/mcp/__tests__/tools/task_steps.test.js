// task_update's `step` and task_create's `steps`: the only way an agent writes a card's `## Steps` table.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { readSteps } from "../../../../../plugins/desk/mcp/src/desk/steps.js"
import { mkTempDeskRoot } from "./_helpers.js"

const REPOS = [{ name: "widgets" }, { name: "gadgets" }]
const PR = "https://github.com/o/widgets/pull/7"
const HEAD = "| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|"

async function newCard(body = "## Outcome\n\nShip it.\n\n## Progress log\n\n- 2026-10-01: began\n", extra = {}) {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "chain", title: "T", body, repos: REPOS, ...extra } })
  return { root, file: path.join(root, "t", "chain", "task.md") }
}
const update = (root, step, more = {}) => task_update({ deskRoot: root, input: { track: "t", slug: "chain", step, ...more } })
const rows = async (file) => readSteps((await fs.readFile(file, "utf8")).replace(/^---[\s\S]*?\n---\n/u, "")).rows.map(({ line, ...row }) => row)

test("the first step creates the table right after the Outcome section, and later steps add rows", async () => {
  const { root, file } = await newCard()
  const first = await update(root, { id: "api", depends_on: [], repo: "widgets" })
  assert.deepEqual(first.step, { id: "api", depends_on: [], repo: "widgets", state: "pending", evidence: "" })
  assert.equal(first.step_note, "now ready: api")
  const second = await update(root, { id: "ui", depends_on: ["api"], repo: "gadgets" })
  assert.equal(second.step_note, undefined)
  const text = await fs.readFile(file, "utf8")
  assert.match(text, new RegExp(`Ship it\\.\\n\\n## Steps\\n\\n${HEAD.replaceAll("|", "\\|")}\\n\\| api \\| — \\| widgets \\| pending \\| — \\|\\n\\| ui \\| api \\| gadgets \\| pending \\| — \\|\\n\\n## Progress log`, "u"))
})

test("a card with no Outcome section gets the table at the top, an empty body gets only the table, and an Outcome last in the body is followed by it", async () => {
  for (const [body, pattern] of [
    ["\n\nIntro.\n", /^---[\s\S]*?---\n\n## Steps\n\n\| Step[^\n]*\n\|---[^\n]*\n\| a \| — \| — \| pending \| — \|\n\nIntro\.\n$/u],
    ["", /---\n\n?## Steps\n\n\| Step[^\n]*\n\|---[^\n]*\n\| a \| — \| — \| pending \| — \|\n$/u],
    ["## Outcome\n\nShip it.", /Ship it\.\n\n## Steps\n\n\| Step[^\n]*\n\|---[^\n]*\n\| a \| — \| — \| pending \| — \|\n$/u],
    ["```\n## Outcome\n```\n\n## Outcome\n\nReal.\n\n## Other\n\nx\n", /Real\.\n\n## Steps\n[\s\S]*\| a \|[^\n]*\n\n## Other\n\nx\n$/u],
  ]) {
    const { root, file } = await newCard(body)
    await update(root, { id: "a", depends_on: [], repo: "—" })
    assert.match(await fs.readFile(file, "utf8"), pattern)
  }
})

test("a step write keeps a hand-written table's extra columns and column order, and body_append never touches the table", async () => {
  const table = "| Owner | State | Step | Evidence | Repo | Depends on |\n|--|--|--|--|--|--|\n| ari | pending | api | | widgets | — |\n| ari | pending | ui | | widgets | api |"
  const { root, file } = await newCard(`## Outcome\n\nx\n\n## Steps\n\nNotes.\n\n${table}\n\nAfter.\n`)
  await update(root, { id: "api", state: "in progress" }, { body_append: "## Steps\n\nstray text" })
  await update(root, { id: "docs", depends_on: [], repo: "—" })
  const text = await fs.readFile(file, "utf8")
  assert.match(text, /\| ari \| in progress \| api \| — \| widgets \| — \|\n\| ari \| pending \| ui \| \| widgets \| api \|\n\|  \| pending \| docs \| — \| — \| — \|\n\nAfter\./u)
  assert.match(text, /After\.\n+## Steps\n\nstray text\n?$/u)
  assert.deepEqual((await rows(file)).map((row) => row.id), ["api", "ui", "docs"])
})

test("two updates to different rows both stay, and a stale expect is refused with the current row", async () => {
  const { root, file } = await newCard()
  await update(root, { id: "a", depends_on: [], repo: "widgets" })
  await update(root, { id: "b", depends_on: [], repo: "gadgets" })
  await update(root, { id: "a", state: "in progress", expect: "pending" })
  await update(root, { id: "b", state: "In Progress", expect: "pending" })
  assert.deepEqual((await rows(file)).map((row) => [row.id, row.state]), [["a", "in progress"], ["b", "in progress"]])
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(update(root, { id: "a", state: "blocked", reason: "x", expect: "pending" }), /step "a" is not as you last saw it \(expect "pending"\); now a: state in progress, depends on nothing, repo widgets, evidence none; no step was changed\./u)
  await assert.rejects(update(root, { id: "zzz", state: "pending", expect: "pending" }), /there is no such step/u)
  assert.equal(await fs.readFile(file, "utf8"), before)
})

test("adding a step needs its repo and depends_on, and a repo must be one of the card's", async () => {
  const { root } = await newCard()
  await assert.rejects(update(root, { id: "a" }), /step "a" is new, so it needs `repo`[^;]*and `depends_on`/u)
  await assert.rejects(update(root, { id: "a", repo: "widgets" }), /is new/u)
  await assert.rejects(update(root, { id: "a", depends_on: [] }), /is new/u)
  await assert.rejects(update(root, { id: "a", depends_on: [], repo: "other" }), /step "a" names repo "other", which is not one of the card's repos \(widgets, gadgets\)/u)
  await assert.rejects(update(root, { id: "", depends_on: [], repo: "—" }), /row 1 needs a short kebab-case name/u)
  await assert.rejects(update(root, { id: "Bad Name", depends_on: [], repo: "—" }), /step "Bad Name" needs a short kebab-case name/u)
  await assert.rejects(update(root, { id: "a", depends_on: ["ghost"], repo: "—" }), /depends on "ghost", which is not a step/u)
  await assert.rejects(update(root, { id: "a", depends_on: "x", repo: "—" }), /`depends_on` must be a list of step names/u)
  await assert.rejects(update(root, { id: "a", depends_on: [], repo: "—", color: "red" }), /unknown field `color`/u)
  await assert.rejects(update(root, { id: "a", depends_on: [], repo: "—", state: "started" }), /step "a" has state "started"/u)
  await assert.rejects(update(root, { id: "a", depends_on: ["a"], repo: "—" }), /circle: a -> a/u)
  await update(root, { id: "a", depends_on: [], repo: "—" })
  await assert.rejects(update(root, { id: "b", depends_on: ["a"], repo: "—" }).then(() => update(root, { id: "a", state: "pending", depends_on: ["b"] })), /circle: a -> b -> a/u)
})

test("depends_on and repo change only while the step is pending", async () => {
  const { root, file } = await newCard()
  await update(root, { id: "a", depends_on: [], repo: "widgets" })
  await update(root, { id: "b", depends_on: [], repo: "widgets" })
  await update(root, { id: "b", depends_on: ["a"] })
  await update(root, { id: "b", state: "in progress" })
  await assert.rejects(update(root, { id: "b", repo: "gadgets" }), /step "b" is in progress; its `depends_on` and `repo` change only while it is pending/u)
  await assert.rejects(update(root, { id: "b", depends_on: [] }), /change only while it is pending/u)
  await update(root, { id: "b", state: "pending", repo: "gadgets" })
  assert.equal((await rows(file))[1].repo, "gadgets")
})

test("blocked and dropped need a reason, which is written into Evidence and cleared when the state moves on", async () => {
  const { root, file } = await newCard()
  await update(root, { id: "a", depends_on: [], repo: "widgets" })
  await assert.rejects(update(root, { id: "a", state: "blocked" }), /cannot become blocked without a `reason`/u)
  await assert.rejects(update(root, { id: "a", state: "dropped", reason: "  " }), /cannot become dropped without a `reason`/u)
  await update(root, { id: "a", state: "blocked", reason: "waits on | infra\nteam" })
  assert.match(await fs.readFile(file, "utf8"), /\| a \| — \| widgets \| blocked \| waits on \\\| infra team \|/u)
  assert.equal((await rows(file))[0].evidence, "waits on | infra team")
  await update(root, { id: "a", state: "blocked", evidence: "still waiting" })
  assert.equal((await rows(file))[0].evidence, "still waiting")
  await update(root, { id: "a", state: "in progress" })
  assert.equal((await rows(file))[0].evidence, "")
  await update(root, { id: "a", evidence: "branch up" })
  assert.equal((await rows(file))[0].evidence, "branch up")
  await update(root, { id: "a", state: "pending" })
  await update(root, { id: "a", state: "pending" })
  assert.equal((await rows(file))[0].evidence, "")
})

test("merged and delivered can be set by hand with a PR or commit in Evidence", async () => {
  const { root, file } = await newCard()
  await update(root, { id: "a", depends_on: [], repo: "widgets" })
  await update(root, { id: "b", depends_on: ["a"], repo: "widgets" })
  await update(root, { id: "c", depends_on: ["a"], repo: "gadgets" })
  await assert.rejects(update(root, { id: "a", state: "merged" }), /cannot be set to merged without a PR URL or commit in `evidence`/u)
  await assert.rejects(update(root, { id: "a", state: "delivered", evidence: "shipped" }), /cannot be set to delivered without a PR URL or commit/u)
  await update(root, { id: "a", state: "merged", evidence: PR })
  const delivered = await update(root, { id: "a", state: "delivered", evidence: "a1b2c3d4 on origin/main" })
  assert.equal(delivered.step_note, "now ready: b, c")
  assert.equal((await rows(file))[0].state, "delivered")
  assert.deepEqual((await update(root, { id: "a", state: "delivered", evidence: "kept" })).step_note, undefined)
  const viaReason = await update(root, { id: "b", state: "delivered", reason: "https://github.com/o/widgets/commit/abcdef1" })
  assert.equal(viaReason.step.state, "delivered")
})

test("dropping a step blocks its live dependents unless the call names them as still valid", async () => {
  const { root, file } = await newCard()
  await update(root, { id: "a", depends_on: [], repo: "widgets" })
  for (const id of ["b", "c", "d", "e"]) await update(root, { id: id, depends_on: ["a"], repo: "widgets" })
  await update(root, { id: "c", state: "in progress" })
  await update(root, { id: "d", state: "blocked", reason: "other reason" })
  await update(root, { id: "a", state: "in progress" })
  await assert.rejects(update(root, { id: "a", state: "dropped", reason: "x", dependents_ok: "b" }), /`dependents_ok` must be a list/u)
  const answer = await update(root, { id: "a", state: "dropped", reason: "not needed", dependents_ok: ["e"] })
  assert.deepEqual(answer.blocked_dependents, ["b", "c"])
  assert.equal(answer.step_note, "now ready: e")
  assert.deepEqual((await rows(file)).map((row) => [row.id, row.state, row.evidence]), [
    ["a", "dropped", "not needed"],
    ["b", "blocked", "depends on a, which was dropped"],
    ["c", "blocked", "depends on a, which was dropped"],
    ["d", "blocked", "other reason"],
    ["e", "pending", ""],
  ])
  const again = await update(root, { id: "a", state: "dropped", reason: "still not needed" })
  assert.equal(again.blocked_dependents, undefined)
})

test("a table Desk cannot read is left as prose and step writes are refused with the reason, while the rest of the card still updates", async () => {
  const { root, file } = await newCard("## Steps\n\n| Step | State |\n|---|---|\n| a | pending |\n")
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(update(root, { id: "b", depends_on: [], repo: "—" }), /left as prose because the table has no Depends on, Repo, Evidence column, so step "b" cannot be written there/u)
  assert.equal(await fs.readFile(file, "utf8"), before)
  await task_update({ deskRoot: root, input: { track: "t", slug: "chain", note: "still works", body_append: "More." } })
  assert.match(await fs.readFile(file, "utf8"), /- \d{4}-\d{2}-\d{2}: still works/u)
})

test("a step can arrive as a JSON string, and a bad one is refused before the card changes", async () => {
  const { root, file } = await newCard()
  const before = await fs.readFile(file, "utf8")
  await task_update({ deskRoot: root, input: { track: "t", slug: "chain", step: '{"id": "a", "depends_on": [], "repo": "widgets"}' } })
  assert.deepEqual((await rows(file)).map((row) => row.id), ["a"])
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "chain", step: "nope" } }), /`step` must be an object/u)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "chain", note: "n", step: { id: "a", state: "blocked" } } }), /without a `reason`/u)
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /\n- [\d-]+: n\n/u)
  assert.notEqual(before, await fs.readFile(file, "utf8"))
})

test("repos changed in the same call count: a step may name a repo the call adds", async () => {
  const { root, file } = await newCard()
  await task_update({ deskRoot: root, input: { track: "t", slug: "chain", frontmatter: { repos: [{ name: "widgets" }, { name: "newrepo" }] }, step: { id: "a", depends_on: [], repo: "newrepo" } } })
  assert.equal((await rows(file))[0].repo, "newrepo")
})

test("task_create writes its steps in order, each able to depend on the ones before it", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: {
      track: "t", slug: "made", title: "T", repos: REPOS, body: "## Outcome\n\nGo.\n",
      steps: [{ id: "api", depends_on: [], repo: "widgets" }, '{"id": "ui", "depends_on": ["api"], "repo": "gadgets"}'],
    },
  })
  const file = path.join(root, "t", "made", "task.md")
  assert.deepEqual((await rows(file)).map((row) => [row.id, row.depends_on]), [["api", []], ["ui", ["api"]]])
  await assert.rejects(task_create({ deskRoot: root, input: { track: "t", slug: "made-two", title: "T", steps: "api" } }), /`steps` must be a list/u)
  await assert.rejects(task_create({ deskRoot: root, input: { track: "t", slug: "made-two", title: "T", repos: REPOS, steps: [{ id: "a", depends_on: ["b"], repo: "—" }] } }), /task_create: step "a" depends on "b"/u)
  await assert.rejects(fs.access(path.join(root, "t", "made-two")))
  await task_create({ deskRoot: root, input: { track: "t", slug: "made-three", title: "T", steps: [{ id: "a", depends_on: [], repo: "—" }] } })
  assert.equal((await rows(path.join(root, "t", "made-three", "task.md")))[0].repo, null)
})

test("refusals name the row and the rule: several unknown fields, a missing or non-text id, a card with no repos, a stale row with dependencies", async () => {
  const { root } = await newCard("## Outcome\n\nx\n", { repos: undefined })
  await assert.rejects(update(root, { id: "a", depends_on: [], repo: "—", color: 1, size: 2 }), /unknown fields `color`, `size`; it takes `id`/u)
  await assert.rejects(update(root, { id: 5, depends_on: [], repo: "—" }), /row 1 needs a short kebab-case name/u)
  await assert.rejects(update(root, { id: "a", depends_on: [], repo: "widgets" }), /which is not one of the card's repos \(none\)/u)
  await update(root, { id: "a", depends_on: [], repo: "—" })
  await update(root, { id: "b", depends_on: ["a"], repo: "—" })
  await assert.rejects(update(root, { id: "b", expect: "delivered" }), /now b: state pending, depends on a, repo none, evidence none/u)
  const plain = await update(root, { id: "a", state: "dropped", reason: "no longer needed" })
  assert.deepEqual(plain.blocked_dependents, ["b"])
})
