import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { applyResource, dueResources, readResources } from "../../../../../plugins/desk/mcp/src/desk/resources.js"
import { task_archive, task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot } from "./_helpers.js"

const HEADER = "| Exact resource / generation identity | Owning task / attempt / generation | Active writers / consumers | Intended disposition | Evidence pointer | Terminal disposition details |"
const MAPPING = { identity: "Resource", owner: "Owner", writers: null, intended: "Plan", evidence: "Proof", terminal: "Disposition" }
const LEGACY = [
  "## Outcome", "", "Recover inventory.", "",
  "## Resources", "", "Keep this prose and `escaped\\|text`.", "",
  "| Resource | Owner | Plan | Proof | Disposition | Notes |",
  "|---|---|---|---|---|---|",
  "| branch:o/r#old | task original/attempt-2 | keep | proof.md | retained-with-trigger: ari; review ends | old\\|note |",
  "| process:123 | host owner | stop | log.txt | removed-and-absent: exited |  verbatim spacing  |",
  "| branch:o/r#open | step api | remove | pr.md | | extra |",
  "", "After the inventory.", "", "## Other", "", "Untouched.", "",
].join("\n")
const migrate = (body, extra = {}) => applyResource(body, { identity: "branch:o/r#old", migrate: MAPPING, ...extra }, "task_update", "t/c")

test("legacy recovery preserves inventory, ownership, dispositions, extra cells and prose, and repeats without another migration", () => {
  const out = migrate(LEGACY)
  assert.ok(out.body.includes(`${HEADER} Notes |`))
  assert.equal(out.created, false)
  assert.deepEqual(out.row, { identity: "branch:o/r#old", owner: "task original/attempt-2", intended: "keep", disposition: "retained-with-trigger: ari; review ends" })
  assert.ok(out.body.includes("| process:123 | host owner |  | stop | log.txt | removed-and-absent: exited |  verbatim spacing  |"))
  assert.ok(out.body.includes("Keep this prose and `escaped\\|text`."))
  assert.ok(out.body.endsWith("\nAfter the inventory.\n\n## Other\n\nUntouched.\n"))
  assert.ok(out.body.includes("| old\\|note |"))
  assert.deepEqual(readResources(out.body).rows.map(({ identity, owner, terminal }) => [identity, owner, terminal]), [
    ["branch:o/r#old", "task original/attempt-2", "retained-with-trigger: ari; review ends"],
    ["process:123", "host owner", "removed-and-absent: exited"],
    ["branch:o/r#open", "step api", ""],
  ])
  assert.deepEqual(dueResources(out.body, { status: "done" }).map(({ identity }) => identity), ["branch:o/r#open"])
  assert.equal(migrate(out.body).body, out.body)
  assert.equal(applyResource(out.body, { identity: "branch:o/r#open", disposition: "removed-and-absent", details: "deleted and absent" }, "task_update", "t/c").row.disposition, "removed-and-absent: deleted and absent")
})

test("recovery keeps CRLF, fenced examples, empty tables and already canonical columns", () => {
  const partial = `\`\`\`md\n## Resources\n| not | inventory |\n\`\`\`\n\n## Resources\n\n| Resource | Owner | Plan | Proof | Disposition | Active writers / consumers |\n|---|---|---|---|---|---|\n`
  const out = migrate(partial.replaceAll("\n", "\r\n"), { migrate: { ...MAPPING, writers: "Active writers / consumers" } })
  assert.equal(out.created, true)
  assert.equal(out.body.replaceAll("\r\n", "").includes("\n"), false)
  assert.ok(out.body.startsWith("```md\r\n## Resources\r\n| not | inventory |\r\n```\r\n"))
  assert.equal(readResources(out.body).rows.length, 1)
  assert.equal(migrate(out.body, { migrate: { ...MAPPING, writers: "Active writers / consumers" } }).body, out.body)
})

test("a recovered row update keeps its untouched legacy cells byte for byte", () => {
  const body = LEGACY.replace("| branch:o/r#old | task original/attempt-2 |", "| branch:o/r#old |   task original/attempt-2   |")
    .replace("| old\\|note |", "|   old\\|note   |")
  const out = migrate(body, { intended: "remove after review" })
  assert.ok(out.body.includes("| branch:o/r#old |   task original/attempt-2   |  | remove after review | proof.md | retained-with-trigger: ari; review ends |   old\\|note   |"))
  assert.equal(migrate(out.body, { intended: "remove after review" }).body, out.body)
})

test("a partial canonical table adds only explicitly absent columns without inventing ownership", () => {
  const body = "## Resources\n\n| Exact resource / generation identity | Notes |\n|---|---|\n| branch:o/r#old | keep every word |\n"
  const out = migrate(body, { migrate: { identity: "Exact resource / generation identity", owner: null, writers: null, intended: null, evidence: null, terminal: null } })
  assert.deepEqual(out.row, { identity: "branch:o/r#old", owner: "", intended: "", disposition: "" })
  assert.ok(out.body.includes("| branch:o/r#old |  |  |  |  |  | keep every word |"))
  assert.equal(readResources(out.body).rows.length, 1)
  assert.throws(() => migrate(body), /keep the existing/u)
})

test("six existing columns map case-insensitively without losing writers or evidence", () => {
  const body = "## Resources\n\n| Proof | Disposition | Resource | Owner | Writers | Plan |\n|---|---|---|---|---|---|\n| proof\\|1.md | named transfer: sam acknowledged | branch:o/r#old | original owner | sam and agent-2 | keep |\n"
  const out = migrate(body, { migrate: { ...MAPPING, identity: "resource", writers: "WRITERS" } })
  assert.ok(out.body.includes(HEADER))
  assert.ok(out.body.includes("| branch:o/r#old | original owner | sam and agent-2 | keep | proof\\|1.md | named transfer: sam acknowledged |"))
  assert.equal(out.row.owner, "original owner")
  assert.equal(out.row.disposition, "named transfer: sam acknowledged")
})

test("ambiguous or malformed legacy recovery refuses without guessing a column or dropping a cell", () => {
  for (const [body, mapping, error] of [
    [LEGACY, { ...MAPPING, owner: "Missing" }, /Missing.*not.*column/u],
    [LEGACY, { ...MAPPING, owner: "Resource" }, /more than one/u],
    [LEGACY, { ...MAPPING, identity: null }, /identity.*existing column/u],
    [LEGACY, { ...MAPPING, writers: "" }, /writers/u],
    [LEGACY, { ...MAPPING, extra: "Notes" }, /unknown.*extra/u],
    [LEGACY, { identity: "Resource" }, /all six/u],
    [LEGACY, null, /migrate.*object/u],
    [LEGACY, [], /migrate.*object/u],
    [LEGACY.replace("| Notes |", "| Owner |"), MAPPING, /duplicate.*Owner/iu],
    [LEGACY.replace("|---|---|---|---|---|---|", "|---|---|"), MAPPING, /separator/u],
    [LEGACY.replace("| old\\|note |", "| old\\|note | orphan |"), MAPPING, /row.*cells/u],
    [LEGACY.replace("| extra |", "|"), MAPPING, /row.*cells/u],
    [LEGACY.replace("| branch:o/r#open |", "| branch:o/r#old |"), MAPPING, /identity.*more than once/u],
    [LEGACY.replace("| branch:o/r#old |", "| |"), MAPPING, /no resource identity/u],
    [LEGACY.replace("| Owner |", "| |"), MAPPING, /empty.*column/u],
    [`${LEGACY}\n## Resources\n\n${HEADER}\n|---|---|---|---|---|---|\n`, MAPPING, /more than one.*Resources/u],
    [LEGACY.replace("After the inventory.", "| Another | table |\n|---|---|"), MAPPING, /more than one.*table/u],
    [LEGACY.replace("| branch:o/r#open | step api | remove | pr.md | | extra |", "| Resource | Owner | Plan | Proof | Disposition | Notes |\n|---|---|---|---|---|---|"), MAPPING, /more than one.*table/u],
    ["## Resources\n\nJust prose.\n", MAPPING, /no table/u],
    ["## Outcome\n\nNo inventory.\n", MAPPING, /no.*Resources/u],
  ]) {
    assert.throws(() => migrate(body, { migrate: mapping }), error)
  }
})

test("a refusal names checked recovery instead of directing a forbidden manual card edit", () => {
  assert.throws(() => applyResource(LEGACY, { identity: "branch:o/r#old" }, "task_update", "t/c"), (error) => {
    assert.match(error.message, /resource\.migrate/u)
    assert.doesNotMatch(error.message, /[Ff]ix.*by hand|leave this resource out/u)
    return true
  })
})

test("the checked task update recovers legacy rows atomically and still refuses section replacement and missing completion evidence", async () => {
  const root = await mkTempDeskRoot()
  const file = path.join(root, "t", "recover-inventory", "task.md")
  console.log(`migration fixture root: ${root}; card: ${file}`)
  await task_create({ deskRoot: root, input: { track: "t", slug: "recover-inventory", title: "Recover", body: LEGACY } })
  const update = (extra) => task_update({ deskRoot: root, input: { track: "t", slug: "recover-inventory", ...extra } })
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(update({ replace_section: { heading: "Resources", markdown: "replacement" } }), /cannot replace/u)
  await assert.rejects(update({ status: "done", resource: { identity: "branch:o/r#old", migrate: MAPPING } }), /evidence/u)
  await assert.rejects(update({ resource: { identity: "branch:o/r#old", step: "missing", migrate: MAPPING } }), /not a step/u)
  await assert.rejects(update({ resource: { identity: "branch:o/r#old", migrate: { ...MAPPING, owner: "Missing" } }, note: "must not appear" }), /Missing/u)
  await assert.rejects(task_update({ deskRoot: root, person: "someone", input: { track: "t", slug: "recover-inventory", resource: { identity: "branch:o/r#old", migrate: MAPPING } } }), /task does not exist/u)
  assert.equal(await fs.readFile(file, "utf8"), before)
  const answer = await update({ resource: { identity: "branch:o/r#old", migrate: MAPPING } })
  assert.equal(answer.resource.owner, "task original/attempt-2")
  assert.equal(answer.resource.disposition, "retained-with-trigger: ari; review ends")
  assert.equal(readResources(await fs.readFile(file, "utf8")).rows.length, 3)
  await task_archive({ deskRoot: root, input: { track: "t", slug: "recover-inventory", outcome: "cancelled" } })
  const archived = path.join(root, "t", "_archive", "recover-inventory", "task.md")
  console.log(`migration fixture archived card: ${archived}`)
  const history = await fs.readFile(archived, "utf8")
  await assert.rejects(update({ resource: { identity: "branch:o/r#old", disposition: "retained-with-trigger", details: "owner; trigger", migrate: MAPPING } }), /archived.*migrate/u)
  assert.equal(await fs.readFile(archived, "utf8"), history)
})
