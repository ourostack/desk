// A step's in review, merged and delivered states come from its PR (or its delegated card), and a card with steps closes only on its steps.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { readSteps } from "../../../../../plugins/desk/mcp/src/desk/steps.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

const REPOS = [{ name: "widgets" }]
const POLICY = { schema_version: 1, rules: [{ paths: ["src/**"], delivered_at: { kind: "github_label", name: "released" } }] }
const url = (number) => `https://github.com/o/widgets/pull/${number}`

// A fake GitHub keyed by pull request number: `{ merged, state, labels }`; a number it does not know answers 404; `down` makes every request fail.
function github(prs, { down = false } = {}) {
  const calls = []
  const answer = (status, body) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) })
  const fetchFn = async (address) => {
    calls.push(address)
    if (down) throw new Error("offline")
    if (address.includes("/contents/")) return answer(200, POLICY)
    if (address.includes("/files?")) return answer(200, [{ filename: "src/a.js" }])
    const number = Number(/\/pulls\/(\d+)/u.exec(address)[1])
    const pr = prs[number]
    return pr === undefined ? answer(404, "") : answer(200, { state: pr.state ?? (pr.merged ? "closed" : "open"), merged_at: pr.merged ? "2026-10-06T00:00:00Z" : null, labels: (pr.labels ?? []).map((name) => ({ name })) })
  }
  return { fetchFn, calls }
}

async function newCard(rowsText, extra = {}, slug = "chain") {
  const root = await mkTempDeskRoot()
  const body = `## Outcome\n\nShip it.\n\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n${rowsText}\n\n## Progress log\n\n- 2026-10-01: began\n`
  await task_create({ deskRoot: root, input: { track: "t", slug, title: "T", body, repos: REPOS, ...extra } })
  return { root, file: path.join(root, "t", slug, "task.md") }
}
const update = (root, input, fake, slug = "chain") => task_update({ deskRoot: root, input: { track: "t", slug, ...input }, fetchFn: fake?.fetchFn })
const rows = async (file) => Object.fromEntries(readSteps((await fs.readFile(file, "utf8")).replace(/^---[\s\S]*?\n---\n/u, "")).rows.map((row) => [row.id, row.state]))
const note = { note: "checked" }

test("a step's state follows its PR: open is in review, merged but unlabeled is merged, labeled is delivered", async () => {
  const { root, file } = await newCard(`| a | — | widgets | pending | ${url(1)} |\n| b | — | widgets | in progress | ${url(2)} |\n| c | — | widgets | merged | ${url(3)} |\n| d | — | widgets | pending | — |`)
  const fake = github({ 1: {}, 2: { merged: true }, 3: { merged: true, labels: ["released"] } })
  const result = await update(root, note, fake)
  assert.deepEqual(await rows(file), { a: "in review", b: "merged", c: "delivered", d: "pending" })
  assert.deepEqual(result.steps_refreshed, ["a: pending -> in review", "b: in progress -> merged", "c: merged -> delivered"])
  assert.equal(result.steps_notes, undefined)
  assert.match(await fs.readFile(file, "utf8"), /- \d{4}-\d\d-\d\d: checked/u, "the note and the refreshed cells are one write")
})

test("a delivered step makes its dependent ready, and the answer says so", async () => {
  const { root } = await newCard(`| a | — | widgets | in review | ${url(1)} |\n| b | a | widgets | pending | — |`)
  const result = await update(root, note, github({ 1: { merged: true, labels: ["released"] } }))
  assert.equal(result.step_note, "now ready: b")
  const again = await update(root, note, github({ 1: { merged: true, labels: ["released"] } }))
  assert.equal(again.step_note, undefined)
  assert.equal(again.steps_refreshed, undefined)
})

test("a PR closed without merge leaves the declared state and says so", async () => {
  const { root, file } = await newCard(`| a | — | widgets | in progress | ${url(1)} |`)
  const result = await update(root, note, github({ 1: { state: "closed" } }))
  assert.deepEqual(await rows(file), { a: "in progress" })
  assert.deepEqual(result.steps_notes, [`step a: PR closed without merge (o/widgets#1); its state is left as in progress`])
})

test("an answer GitHub cannot give leaves the cell and says it was not verified; a PR it does not know says so too", async () => {
  const { root, file } = await newCard(`| a | — | widgets | in review | ${url(1)} |\n| b | — | widgets | in progress | ${url(9)} |`)
  const down = await update(root, note, github({}, { down: true }))
  assert.deepEqual(await rows(file), { a: "in review", b: "in progress" })
  assert.equal(down.steps_notes.length, 2)
  assert.match(down.steps_notes[0], /^step a: not verified \(.*unreachable.*\), so its state is left as in review$/u)
  const unknown = await update(root, note, github({ 1: {} }))
  assert.deepEqual(unknown.steps_notes, ["step b: GitHub does not know o/widgets#9, so its state is left as it is"])
})

test("a delegated step follows its card: done is delivered, blocked is blocked, anything else is in progress, an archived card counts, a missing one is noted", async () => {
  const { root, file } = await newCard(["done", "stuck", "going", "gone", "ghost"].map((name) => `| ${name} | — | widgets | pending | task:t/${name === "done" ? "card-done" : name === "stuck" ? "card-stuck" : name === "going" ? "card-going" : name === "gone" ? "card-gone" : "card-none"} |`).join("\n"))
  for (const [slug, status] of [["card-done", "done"], ["card-stuck", "blocked"], ["card-going", "drafting"], ["card-gone", "done"]]) {
    await task_create({ deskRoot: root, input: { track: "t", slug, title: slug, status } })
  }
  await task_archive({ deskRoot: root, input: { track: "t", slug: "card-gone" } })
  const result = await update(root, note)
  assert.deepEqual(await rows(file), { done: "delivered", stuck: "blocked", going: "in progress", gone: "delivered", ghost: "pending" })
  assert.deepEqual(result.steps_notes, ["step ghost: the card t/card-none was not found, so its state is left as it is"])
  assert.match((await fs.readFile(file, "utf8")), /\| stuck \| — \| widgets \| blocked \| task:t\/card-stuck \|/u)
  // A delegated card moving on moves the step after it, including back out of blocked.
  await update(root, { track: "t", slug: "card-stuck", frontmatter: { status: "processing" } }, undefined, "card-stuck")
  await update(root, note)
  assert.equal((await rows(file)).stuck, "in progress")
})

test("dropped steps and blocked steps that point at a PR are left alone", async () => {
  const { root, file } = await newCard(`| a | — | widgets | dropped | no longer needed (was: ${url(1)}) |\n| b | — | widgets | blocked | waits on infra (was: ${url(2)}) |\n| c | — | widgets | dropped | task:t/anything |`)
  const fake = github({ 1: { merged: true, labels: ["released"] }, 2: { merged: true, labels: ["released"] } })
  await update(root, note, fake)
  assert.deepEqual(await rows(file), { a: "dropped", b: "blocked", c: "dropped" })
  assert.equal(fake.calls.length, 0)
})

test("a step given with its PR in the same call is derived in that call's write, and one PR on two steps is asked about once", async () => {
  const { root, file } = await newCard(`| b | — | widgets | pending | ${url(1)} |`)
  const fake = github({ 1: {}, 2: {} })
  const result = await update(root, { step: { id: "a", depends_on: [], repo: "widgets", evidence: url(2) } }, fake)
  assert.deepEqual(await rows(file), { b: "in review", a: "in review" })
  assert.deepEqual(result.steps_refreshed, ["b: pending -> in review", "a: pending -> in review"])
  const twice = await newCard(`| a | — | widgets | pending | ${url(1)} |\n| b | — | widgets | pending | ${url(1)} |`, {}, "twice")
  const other = github({ 1: {} })
  await update(twice.root, note, other, "twice")
  assert.equal(other.calls.filter((address) => address.endsWith("/pulls/1")).length, 1)
})

test("a card with no steps, an unreadable table, and a call under the test runner make no network call", async () => {
  const plain = await mkTempDeskRoot()
  await task_create({ deskRoot: plain, input: { track: "t", slug: "plain", title: "P", body: "## Outcome\n\nx\n" } })
  const fake = github({})
  assert.equal((await update(plain, note, fake, "plain")).steps_refreshed, undefined)
  const broken = await newCard(`| a | nobody | widgets | pending | ${url(1)} |`, {}, "broken")
  await update(broken.root, note, fake, "broken")
  assert.equal(fake.calls.length, 0)
  const { root, file } = await newCard(`| a | — | widgets | pending | ${url(1)} |`, {}, "runner")
  const result = await update(root, note, undefined, "runner")
  assert.equal(result.steps_notes, undefined)
  assert.deepEqual(await rows(file), { a: "pending" })
})

const DONE = { frontmatter: { status: "done" } }

test("a card with steps closes only with evidence kind steps, and refuses while any step is not delivered or dropped, naming each", async () => {
  const { root, file } = await newCard(`| a | — | widgets | in progress | ${url(1)} |\n| b | — | widgets | pending | — |\n| c | — | widgets | blocked | waits on infra |\n| d | — | widgets | pending | ${url(4)} |\n| e | — | widgets | dropped | not needed |`)
  const fake = github({ 1: { merged: true }, 4: { state: "closed" } })
  await assert.rejects(update(root, { ...DONE, evidence: { kind: "pr", ref: url(1) } }, fake), /has a `## Steps` table, so it closes only with `evidence: \{ kind: "steps" \}`/u)
  await assert.rejects(update(root, DONE, fake), /Got no evidence/u)
  await assert.rejects(update(root, { ...DONE, evidence: { kind: "steps" } }, fake), (error) => {
    assert.match(error.message, /^task_update: not done: 4 steps are not delivered or dropped: /u)
    assert.match(error.message, /a is merged \(o\/widgets#1 is merged but not delivered: it must carry the `released` label\)/u)
    assert.match(error.message, /b is pending/u)
    assert.match(error.message, /c is blocked \(waits on infra\)/u)
    assert.match(error.message, /d is pending \(PR closed without merge \(o\/widgets#4\)\)/u)
    assert.doesNotMatch(error.message, /e is/u)
    return true
  })
  assert.equal(((await readFront(file)).data).status, "drafting", "a refusal leaves the card alone")
})

test("when every step is delivered or dropped the card closes on its steps, with the refreshed cells in the same write", async () => {
  const { root, file } = await newCard(`| a | — | widgets | in review | ${url(1)} |\n| b | — | widgets | dropped | not needed |`)
  const result = await update(root, { ...DONE, evidence: { kind: "steps" } }, github({ 1: { merged: true, labels: ["released"] } }))
  const front = (await readFront(file)).data
  assert.equal(front.status, "done")
  assert.equal(front.evidence.kind, "steps")
  assert.equal(front.evidence.ref, "all 2 steps settled: 1 delivered, 1 dropped")
  assert.deepEqual(await rows(file), { a: "delivered", b: "dropped" })
  assert.deepEqual(result.steps_refreshed, ["a: in review -> delivered"])
})

test("offline, a step already delivered still counts and the answer says it was not verified", async () => {
  const { root, file } = await newCard(`| a | — | widgets | delivered | ${url(1)} |`)
  const result = await update(root, { ...DONE, evidence: { kind: "steps" } }, github({}, { down: true }))
  assert.equal(((await readFront(file)).data).status, "done")
  assert.match(result.steps_notes[0], /^step a: not verified/u)
})

test("kind steps is refused on a card with no readable steps table, which keeps today's gate", async () => {
  const plain = await mkTempDeskRoot()
  await task_create({ deskRoot: plain, input: { track: "t", slug: "plain", title: "P", body: "## Outcome\n\nx\n" } })
  await assert.rejects(update(plain, { ...DONE, evidence: { kind: "steps" } }, undefined, "plain"), /needs a card with a readable `## Steps` table, and this card has none/u)
  await update(plain, { ...DONE, evidence: { kind: "non_code", ref: "https://example.com/proof" } }, undefined, "plain")
  const broken = await newCard(`| a | nobody | — | pending | — |`, { repos: [] }, "broken")
  await assert.rejects(update(broken.root, { ...DONE, evidence: { kind: "steps" } }, undefined, "broken"), /has none/u)
  await update(broken.root, { ...DONE, evidence: { kind: "non_code", ref: "https://example.com/proof" } }, undefined, "broken")
  assert.equal(((await readFront(broken.file)).data).status, "done")
})

test("task_archive closes a card with steps the same way: steps evidence, every step delivered or dropped", async () => {
  const { root } = await newCard(`| a | — | widgets | in review | ${url(1)} |`)
  const open = github({ 1: {} })
  const archive = (input, fake) => task_archive({ deskRoot: root, input: { track: "t", slug: "chain", ...input }, fetchFn: fake?.fetchFn })
  await assert.rejects(archive({ evidence: { kind: "pr", ref: url(1) } }, open), /closes only with `evidence: \{ kind: "steps" \}`/u)
  await assert.rejects(archive({ evidence: { kind: "steps" } }, open), /a is in review \(o\/widgets#1 is open\)/u)
  await archive({ evidence: { kind: "steps" } }, github({ 1: { merged: true, labels: ["released"] } }))
  const archived = (await readFront(path.join(root, "t", "_archive", "chain", "task.md"))).data
  assert.equal(archived.status, "done")
  assert.equal(archived.evidence.kind, "steps")
})

test("cancelling a card with steps needs no steps evidence", async () => {
  const { root, file } = await newCard(`| a | — | widgets | pending | — |`)
  await update(root, { frontmatter: { status: "cancelled" } })
  assert.equal(((await readFront(file)).data).status, "cancelled")
})
