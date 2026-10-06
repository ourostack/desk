// The `## Steps` table on a task card: reading it (hand-written tables, fenced copies, tables Desk leaves as prose),
// the summary boot and desk_status show, and the active-task listing that carries it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { readSteps, readyOf, summarizeSteps } from "../../../../../plugins/desk/mcp/src/desk/steps.js"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

const HAND_WRITTEN = [
  "## Outcome",
  "",
  "Ship it.",
  "",
  "## Steps",
  "",
  "Some prose the author left under the heading.",
  "",
  "| Owner | State | Step | Evidence | Repo | Depends on |",
  "|:--|:-:|---|---|---|---|",
  "| ari | DELIVERED | api | https://github.com/o/r/pull/1 | widgets | — |",
  "| ari | In Progress | ui | | widgets | api |",
  "| ari | pending | docs |",
  "| ari | Blocked | rollout | waits on infra | - | ui, docs |",
  "",
  "After the table.",
].join("\n")

test("a hand-written table reads: extra columns, any column order, prose under the heading, states in any case, dashes and short rows", () => {
  const read = readSteps(HAND_WRITTEN)
  assert.equal(read.reason, undefined)
  assert.deepEqual(read.rows.map(({ line, ...row }) => row), [
    { id: "api", depends_on: [], repo: "widgets", state: "delivered", evidence: "https://github.com/o/r/pull/1" },
    { id: "ui", depends_on: ["api"], repo: "widgets", state: "in progress", evidence: "" },
    { id: "docs", depends_on: [], repo: null, state: "pending", evidence: "" },
    { id: "rollout", depends_on: ["ui", "docs"], repo: null, state: "blocked", evidence: "waits on infra" },
  ])
  assert.deepEqual(readyOf(read.rows), ["docs"])
  assert.deepEqual(summarizeSteps(read.rows), { total: 4, delivered: 1, ready: ["docs"], blocked: [{ id: "rollout", reason: "waits on infra" }] })
})

test("a copy of the table inside a code fence is ignored, and a card with only a fenced copy has no table", () => {
  const table = "| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n| real | — | — | pending | — |"
  const fenced = "```md\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n| fake | — | — | delivered | — |\n```\n"
  assert.deepEqual(readSteps(`${fenced}\n## Steps\n\n${table}\n`).rows.map((row) => row.id), ["real"])
  assert.equal(readSteps(fenced).found, false)
})

test("a table Desk cannot read is left as prose, with the reason", () => {
  const head = "| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n"
  const cases = [
    ["## Steps\n\nJust words.\n", /no table under the heading/u],
    ["## Steps\n\n| Step | State |\n|---|---|\n| a | pending |\n", /no Depends on, Repo, Evidence column/u],
    ["## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n| a | — | — | pending | — |\n", /no separator row/u],
    ["## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n", /no separator row/u],
    [`## Steps\n\n${head}| Bad_Name | — | — | pending | — |\n`, /step "Bad_Name" needs a short kebab-case name/u],
    [`## Steps\n\n${head}| a | — | — | pending | — |\n| a | — | — | pending | — |\n`, /step "a" appears twice/u],
    [`## Steps\n\n${head}| a | — | — | started | — |\n`, /step "a" has state "started"/u],
    [`## Steps\n\n${head}| a | ghost | — | pending | — |\n`, /step "a" depends on "ghost", which is not a step/u],
    [`## Steps\n\n${head}| a | b | — | pending | — |\n| b | c | — | pending | — |\n| c | a | — | pending | — |\n`, /circle: a -> b -> c -> a/u],
    [`## Steps\n\n${head}| | — | — | pending | — |\n`, /row 1 needs a short kebab-case name/u],
  ]
  for (const [body, reason] of cases) {
    const read = readSteps(body)
    assert.equal(read.found, true)
    assert.equal(read.rows, undefined)
    assert.match(read.reason, reason)
  }
})

test("a diamond of dependencies is not a cycle, and a self-dependency is", () => {
  const head = "## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n"
  const diamond = `${head}| a | — | — | delivered | — |\n| b | a | — | pending | — |\n| c | a | — | pending | — |\n| d | b, c | — | pending | — |\n`
  assert.deepEqual(readyOf(readSteps(diamond).rows), ["b", "c"])
  assert.match(readSteps(`${head}| a | a | — | pending | — |\n`).reason, /circle: a -> a/u)
})

test("dropped steps do not count, and a dropped dependency does not hold a step back", () => {
  const body = "## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n| a | — | — | dropped | no longer needed |\n| b | a | — | pending | — |\n"
  const { rows } = readSteps(body)
  assert.deepEqual(readyOf(rows), ["b"])
  assert.deepEqual(summarizeSteps(rows), { total: 1, delivered: 0, ready: ["b"], blocked: [] })
})

function desk(files) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-steps-")))
  for (const [slug, body] of Object.entries(files)) {
    mkdirSync(path.join(root, "t", slug), { recursive: true })
    writeFileSync(path.join(root, "t", slug, "task.md"), `---\ntitle: ${slug}\nstatus: processing\nupdated: "2026-10-01T00:00:00Z"\n---\n${body}`)
  }
  return root
}

test("activeTasks carries a steps summary only for a card with a readable table that has rows", () => {
  const empty = "## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n"
  const root = desk({
    chain: HAND_WRITTEN.replace("waits on infra", "set pw hunter2"),
    plain: "Nothing here.\n",
    prose: "## Steps\n\nwords\n",
    empty,
  })
  const tasks = Object.fromEntries(activeTasks(root).tracks[0].tasks.map((task) => [task.slug, task]))
  assert.deepEqual(tasks.chain.steps.ready, ["docs"])
  assert.equal(tasks.chain.steps.total, 4)
  assert.doesNotMatch(JSON.stringify(tasks.chain.steps), /hunter2/u)
  for (const slug of ["plain", "prose", "empty"]) assert.equal("steps" in tasks[slug], false, slug)
})

test("a card past 64 KiB below its steps still shows them", () => {
  const body = `## Outcome\n\nShip.\n\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n|---|---|---|---|---|\n| a | — | — | delivered | — |\n| b | a | — | pending | — |\n\n## Progress log\n\n${"- 2026-10-01: a long line of progress.\n".repeat(2500)}`
  assert.ok(body.length > 64 * 1024)
  const [task] = activeTasks(desk({ big: body })).tracks[0].tasks
  assert.deepEqual(task.steps, { total: 2, delivered: 1, ready: ["b"], blocked: [] })
})

test("boot text shows the steps line, and ranks a card with no ready step and a blocked step with the blocked work", () => {
  const task = (slug, status, steps, updated) => ({ slug, handle: "h", title: slug, status, updated, repos: [], next_step: "go", blocker: null, ...(steps ? { steps } : {}) })
  const text = formatBootText({
    status: "ready",
    active_tasks: {
      task_count: 4,
      tracks: [{
        track: "t",
        tasks: [
          task("moving", "processing", { total: 5, delivered: 3, ready: ["x", "y"], blocked: [] }, "2026-10-02"),
          task("stuck", "processing", { total: 2, delivered: 0, ready: [], blocked: [{ id: "s", reason: "waits on review" }] }, "2026-10-01"),
          task("flagged", "blocked", { total: 1, delivered: 0, ready: [], blocked: [] }, "2026-10-03"),
          task("blocker-known", "blocked", null, "2026-10-04"),
        ],
      }],
    },
  })
  assert.match(text, /- t\/moving[^\n]*\n  next: go\n  Steps: 3 of 5 delivered; ready: x, y/u)
  assert.match(text, /BLOCKED \(3\)[\s\S]*- t\/stuck[^\n]*\n  blocker: s: waits on review\n  next: go\n  Steps: 0 of 2 delivered\n/u)
  assert.match(text, /- t\/flagged[^\n]*\n  blocker: no blocker recorded; next: go\n  Steps: 0 of 1 delivered\n/u)
  assert.match(text, /\nprocessing \(1\)\n- t\/moving/u)
  const withBlocker = formatBootText({ status: "ready", active_tasks: { task_count: 1, tracks: [{ track: "t", tasks: [{ ...task("x", "blocked", { total: 1, delivered: 0, ready: [], blocked: [] }, "2026-10-04"), blocker: "infra" }] }] } })
  assert.match(withBlocker, /blocker: infra\n  next: go\n  Steps: 0 of 1 delivered/u)
})
