// The delivered tasks that still await the operator's sign-off: the scan over live and archived cards, the one instruction boot gives, and the counts written to status.json. Every desk here is a temp desk and every state folder a temp folder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { mkTempRoot } from "../_temp_roots.js"
import { scratch } from "../factory/_session_helpers.js"
import { readStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import {
  unsignedDeliveries,
  signoffStatus,
  refreshSignoffStatus,
  recordUnsigned,
  signoffInstructions,
  unsignedLines,
} from "../../../../../plugins/desk/mcp/src/desk/unsigned-deliveries.js"

const NOW = Date.parse("2026-10-05T12:00:00.000Z")
const DAY = 86_400_000
const ago = (days, extraMs = 0) => new Date(NOW - days * DAY - extraMs).toISOString()
const SENTINEL = "PRIVATE-SENTINEL-name"

function card({ title = "Example task", status = "done", signoff = "delivered_unsigned", deliveredAt = ago(3), evidence = { kind: "pr", ref: "https://example.test/pr/1", recordedAt: ago(3) }, extra = [] } = {}) {
  const lines = ["schema_version: 1", `title: ${title}`, `status: ${status}`, "created: '2026-01-01T00:00:00Z'", "updated: '2026-01-02T00:00:00Z'"]
  if (signoff !== null) {
    lines.push("signoff:", `  state: ${signoff}`, "  at: null", "  verified: null", "  reason: null")
    if (deliveredAt !== null) lines.push("flow:", "  since: created", "  rev: 1", "  reached: done", `  delivered_at: '${deliveredAt}'`, "  deliveries: 1")
  }
  if (evidence !== null) {
    lines.push("evidence:")
    if (evidence.kind !== null) lines.push(`  kind: ${evidence.kind}`)
    if (evidence.ref !== null) lines.push(`  ref: ${evidence.ref}`)
    lines.push(evidence.bare ? `  recorded_at: ${evidence.recordedAt}` : `  recorded_at: '${evidence.recordedAt}'`)
  }
  return `---\n${[...lines, ...extra].join("\n")}\n---\n\nThe body is never read for an archived card. ${SENTINEL}\n`
}

async function put(desk, where, text) {
  const file = path.join(desk, ...where, "task.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  return file
}

const withDesk = async (run) => run(await mkTempRoot("desk-unsigned-"))

test("a delivered unsigned live task is listed with its age and proof", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "ship-it"], card({ title: "Ship it", deliveredAt: ago(3, 1000) }))
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 1)
  assert.equal(found.at_least, false)
  assert.equal(found.oldest_age_days, 3)
  assert.deepEqual(found.tasks, [{ track: "alpha", slug: "ship-it", title: "Ship it", age_days: 3, overdue: false, proof: "pr https://example.test/pr/1" }])
  assert.deepEqual(unsignedLines(found), ["", "Delivered, awaiting sign-off:", "- alpha/ship-it, 3 days, pr https://example.test/pr/1"])
}))

test("a delivered unsigned archived task is listed", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "_archive", "old-one"], card({ deliveredAt: ago(10) }))
  await put(desk, ["_archive", "gone-track", "older"], card({ deliveredAt: ago(20) }))
  await put(desk, ["desks", "crew", "beta", "_archive", "crewed"], card({ deliveredAt: ago(2) }))
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 3)
  assert.deepEqual(found.tasks.map((task) => `${task.track}/${task.slug}`), ["gone-track/older", "alpha/old-one", "crew/beta/crewed"])
  assert.equal(found.oldest_age_days, 20)
}))

test("a legacy done task is counted as not recorded and never listed", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "legacy"], card({ signoff: null, evidence: null }))
  await put(desk, ["alpha", "_archive", "legacy-old"], card({ signoff: null, evidence: null }))
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 0)
  assert.equal(found.not_recorded, 2)
  assert.deepEqual(found.tasks, [])
  assert.deepEqual(unsignedLines(found), [])
}))

test("an accepted or refused task is not listed, and neither is a task that is not done", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "accepted"], card({ signoff: "accepted" }))
  await put(desk, ["alpha", "refused"], card({ signoff: "refused" }))
  await put(desk, ["alpha", "working"], card({ status: "processing" }))
  await put(desk, ["alpha", "cancelled"], card({ status: "cancelled" }))
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 0)
  assert.equal(found.not_recorded, 0)
}))

test("tasks are listed oldest first and only the first fifteen are shown, with the full count", () => withDesk(async (desk) => {
  for (let n = 1; n <= 17; n += 1) await put(desk, ["alpha", `task-${String(n).padStart(2, "0")}`], card({ deliveredAt: ago(n) }))
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 17)
  assert.equal(found.tasks.length, 15)
  assert.equal(found.tasks[0].slug, "task-17")
  assert.equal(found.tasks[0].age_days, 17)
  assert.equal(found.tasks[14].slug, "task-03")
  const lines = unsignedLines(found)
  assert.equal(lines.at(-1), "- ...and 2 more")
  assert.equal(unsignedDeliveries(desk, { now: NOW, shown: 2 }).tasks.length, 2)
}))

test("a task seven days old is marked overdue", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "late"], card({ deliveredAt: ago(7) }))
  await put(desk, ["alpha", "fine"], card({ deliveredAt: ago(6, DAY - 1000) }))
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.overdue, 1)
  assert.equal(found.tasks[0].overdue, true)
  assert.equal(found.tasks[1].overdue, false)
  const lines = unsignedLines(found)
  assert.match(lines[2], /^- alpha\/late, 7 days, .*, overdue$/u)
  assert.doesNotMatch(lines[3], /overdue/u)
}))

test("a scan cut by the archive cap says at least", () => withDesk(async (desk) => {
  for (let n = 1; n <= 4; n += 1) {
    const file = await put(desk, ["alpha", "_archive", `a-${n}`], card({ deliveredAt: ago(n) }))
    await fs.utimes(file, new Date(NOW - (10 - n) * 1000), new Date(NOW - (10 - n) * 1000))
  }
  const cut = unsignedDeliveries(desk, { now: NOW, archiveCap: 2 })
  assert.equal(cut.at_least, true)
  assert.equal(cut.count, 2)
  assert.deepEqual(cut.tasks.map((task) => task.slug).sort(), ["a-3", "a-4"], "the newest files by modification time are the ones read")
  const whole = unsignedDeliveries(desk, { now: NOW, archiveCap: 4 })
  assert.equal(whole.at_least, false)
  assert.equal(whole.count, 4)
}))

test("a card whose delivery time cannot be read is listed with age unknown, sorted last, and never feeds the oldest age", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "no-flow-time"], card({ deliveredAt: null, evidence: null }))
  await put(desk, ["alpha", "bad-time"], card({ deliveredAt: "not a time", evidence: { kind: "pr", ref: "r1", recordedAt: "also bad" } }))
  await put(desk, ["alpha", "known"], card({ deliveredAt: ago(1) }))
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 3)
  assert.deepEqual(found.tasks.map((task) => task.slug), ["known", "bad-time", "no-flow-time"])
  assert.equal(found.tasks[1].age_days, null)
  assert.equal(found.oldest_age_days, 1)
  assert.match(unsignedLines(found)[3], /^- alpha\/bad-time, age unknown, pr r1$/u)
  const onlyUnknown = await mkTempRoot("desk-unsigned-")
  await put(onlyUnknown, ["alpha", "x"], card({ deliveredAt: null, evidence: null }))
  assert.equal(unsignedDeliveries(onlyUnknown, { now: NOW }).oldest_age_days, null)
}))

test("the age falls back to the evidence time, and a delivery in the future is not negative", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "from-evidence"], card({ deliveredAt: null, evidence: { kind: "pr", ref: "r", recordedAt: ago(5) } }))
  await put(desk, ["alpha", "future"], card({ deliveredAt: new Date(NOW + DAY).toISOString() }))
  const found = unsignedDeliveries(desk, { now: NOW })
  const byslug = Object.fromEntries(found.tasks.map((task) => [task.slug, task]))
  assert.equal(byslug["from-evidence"].age_days, 5)
  assert.equal(byslug.future.age_days, 0)
}))

test("a card created already done has the record and no proof, and is listed as no proof recorded", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "bare"], card({ evidence: null }))
  await put(desk, ["alpha", "kindless"], card({ evidence: { kind: "note", ref: null, recordedAt: ago(1) } }))
  const lines = unsignedLines(unsignedDeliveries(desk, { now: NOW }))
  assert.match(lines[2], /^- alpha\/bare, 3 days, no proof recorded$/u)
  assert.match(lines[3], /^- alpha\/kindless, 3 days, no proof recorded$/u)
}))

test("a title is printed as the card holds it, on one line and at most 80 characters", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "long"], card({ title: `"${"w".repeat(120)}"` }))
  await put(desk, ["alpha", "lines"], card({ title: `"first\\nsecond\\u0007 bell"` }))
  await put(desk, ["alpha", "untitled"], card({ title: "''" }))
  const found = unsignedDeliveries(desk, { now: NOW })
  const byslug = Object.fromEntries(found.tasks.map((task) => [task.slug, task]))
  assert.equal(byslug.long.title.length, 80)
  assert.equal(byslug.lines.title, "first second bell")
  assert.equal(byslug.untitled.title, "")
}))

test("a very long proof is cut to one line of 80 characters", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "proof"], card({ evidence: { kind: "pr", ref: `"${"p".repeat(200)}"`, recordedAt: ago(1) } }))
  const [task] = unsignedDeliveries(desk, { now: NOW }).tasks
  assert.equal(task.proof.length, 80)
}))

test("a track or task name that carries a secret is redacted in the list", () => withDesk(async (desk) => {
  await put(desk, ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "fine"], card())
  const [task] = unsignedDeliveries(desk, { now: NOW }).tasks
  assert.doesNotMatch(JSON.stringify(task), /ghp_/u)
}))

test("a card the scan cannot read is counted as unreadable, never dropped silently; folders that are not cards are skipped", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "good"], card())
  await put(desk, ["alpha", "no-frontmatter"], "just text\n")
  await put(desk, ["alpha", "broken-yaml"], "---\ntitle: [unclosed\nstatus: done\n---\n")
  const locked = await put(desk, ["alpha", "locked"], card())
  await fs.chmod(locked, 0)
  await put(desk, ["alpha", "_hidden", "x"], card())
  await put(desk, [".dot", "x"], card())
  await fs.mkdir(path.join(desk, "alpha", "empty-folder"), { recursive: true })
  await fs.writeFile(path.join(desk, "alpha", "a-file.md"), "x")
  await fs.mkdir(path.join(desk, "_archive", "t", "no-card"), { recursive: true })
  await put(desk, ["alpha", "no-status"], "---\ntitle: x\n---\n")
  const found = unsignedDeliveries(desk, { now: NOW })
  await fs.chmod(locked, 0o644)
  assert.equal(found.count, 1)
  assert.equal(found.unreadable, 3)
  assert.equal(unsignedLines(found).at(-1), "3 task cards could not be read, so this list may be short.")
}))

test("a byte-order mark before the frontmatter is accepted and the card is read", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "bom"], `\uFEFF${card()}`)
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 1)
  assert.equal(found.unreadable, 0)
}))

test("a card whose frontmatter runs past the head of the file is unreadable, not not recorded", () => withDesk(async (desk) => {
  const padded = card({ signoff: null, evidence: null, extra: Array.from({ length: 1500 }, (_, n) => `note_${n}: ${"x".repeat(20)}`) })
  await put(desk, ["alpha", "long-frontmatter"], padded)
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.unreadable, 1)
  assert.equal(found.not_recorded, 0)
}))

test("unreadable cards make every status figure a lower bound, and the cap reason keeps first place", () => {
  const found = { count: 2, at_least: false, overdue: 1, oldest_age_days: 9, not_recorded: 3, unreadable: 2 }
  const status = signoffStatus(found, NOW)
  for (const key of ["unsigned", "overdue", "oldest_unsigned_age_days", "not_recorded"]) assert.equal(status[key].state, "partial", key)
  assert.deepEqual(status.unsigned, { state: "partial", value: 2, reason: "cards_unreadable" })
  assert.deepEqual(signoffStatus({ ...found, at_least: true }, NOW).unsigned, { state: "partial", value: 2, reason: "archive_cap" })
  const none = signoffStatus({ count: 0, at_least: false, overdue: 0, oldest_age_days: null, not_recorded: 0, unreadable: 1 }, NOW)
  assert.deepEqual(none.unsigned, { state: "partial", value: 0, reason: "cards_unreadable" })
  assert.deepEqual(none.oldest_unsigned_age_days, { state: "unavailable", reason: "cards_unreadable" })
  assert.equal(signoffStatus({ ...found, unreadable: 0 }, NOW).unsigned.state, "measured")
  assert.match(signoffInstructions(found, { noninteractive: false })[0], /^at least 2 delivered tasks await sign-off, the oldest for at least 9 days\./u)
  assert.deepEqual(unsignedLines({ ...found, tasks: [], unreadable: 2 }).slice(-1), ["2 task cards could not be read, so this list may be short."])
  assert.deepEqual(unsignedLines(null), [])
  assert.deepEqual(unsignedLines({ count: 0, unreadable: 1, tasks: [] }), ["", "1 task card could not be read, so this list may be short."])
})

test("a proof reference that carries a secret is redacted", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "p"], card({ evidence: { kind: "pr", ref: "https://example.test/x?token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", recordedAt: ago(1) } }))
  assert.doesNotMatch(unsignedDeliveries(desk, { now: NOW }).tasks[0].proof, /ghp_/u)
}))

test("a missing desk folder reads as nothing, and a bad time input throws", () => withDesk(async (desk) => {
  assert.equal(unsignedDeliveries(path.join(desk, "missing"), { now: NOW }).count, 0)
  assert.throws(() => unsignedDeliveries(desk, { now: "nonsense" }), /now/u)
  assert.equal(unsignedDeliveries(desk, { now: new Date(NOW) }).count, 0)
}))

test("a card in flow form and a long frontmatter are read from the head of the file", () => withDesk(async (desk) => {
  const flowCard = `---\ntitle: Flow\nstatus: done\nsignoff: { state: delivered_unsigned, at: null, verified: null, reason: null }\nflow: { since: created, rev: 1, reached: done, delivered_at: '${ago(4)}', deliveries: 1 }\nevidence: { kind: pr, ref: r2, recorded_at: '${ago(4)}' }\n---\n`
  await put(desk, ["alpha", "flow"], flowCard)
  const padded = card({ deliveredAt: ago(5), extra: Array.from({ length: 3000 }, (_, n) => `note_${n}: ${"x".repeat(20)}`) })
  await put(desk, ["alpha", "_archive", "padded"], padded)
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 2)
  assert.equal(found.tasks.find((task) => task.slug === "flow").proof, "pr r2")
}))

test("the boot instruction tells the agent to finish the request first and raise the tasks once, together", () => {
  const many = { count: 3, at_least: false, oldest_age_days: 9 }
  assert.deepEqual(signoffInstructions(many, { noninteractive: false }), ["3 delivered tasks await sign-off, the oldest for 9 days. Finish what the operator asked first. Then raise them together, once, each as three lines (asked, delivered with proof, accept or send back), and record each answer with task_signoff. Do not raise them in a noninteractive session."])
  const one = signoffInstructions({ count: 1, at_least: false, oldest_age_days: 1 }, { noninteractive: false })[0]
  assert.equal(one, "1 delivered task awaits sign-off, the oldest for 1 day. Finish what the operator asked first. Then raise it, once, as three lines (asked, delivered with proof, accept or send back), and record the answer with task_signoff. Do not raise it in a noninteractive session.")
  const cut = signoffInstructions({ count: 500, at_least: true, oldest_age_days: 30 }, { noninteractive: false })[0]
  assert.match(cut, /^at least 500 delivered tasks await sign-off, the oldest for at least 30 days\. /u)
  const cutOne = signoffInstructions({ count: 1, at_least: true, oldest_age_days: 2 }, { noninteractive: false })[0]
  assert.match(cutOne, /^at least 1 delivered task awaits sign-off, the oldest for at least 2 days\. /u)
  const unknown = signoffInstructions({ count: 2, at_least: false, oldest_age_days: null }, { noninteractive: false })[0]
  assert.match(unknown, /^2 delivered tasks await sign-off, of unknown age\. Finish/u)
})

test("a noninteractive session, or a desk with nothing unsigned, gets no sign-off instruction", () => {
  assert.deepEqual(signoffInstructions({ count: 3, at_least: false, oldest_age_days: 9 }, { noninteractive: true }), [])
  assert.deepEqual(signoffInstructions({ count: 0, at_least: false, oldest_age_days: null }, { noninteractive: false }), [])
  assert.deepEqual(signoffInstructions(null, { noninteractive: false }), [])
})

test("with nothing unsigned the oldest age is unavailable, not zero", () => {
  const status = signoffStatus({ count: 0, at_least: false, overdue: 0, oldest_age_days: null, not_recorded: 4 }, NOW)
  assert.deepEqual(status, {
    checked_at: new Date(NOW).toISOString(),
    unsigned: { state: "measured", value: 0 },
    overdue: { state: "measured", value: 0 },
    oldest_unsigned_age_days: { state: "unavailable", reason: "none_unsigned" },
    not_recorded: { state: "measured", value: 4 },
  })
})

test("the status carries measured counts, and a capped scan carries lower bounds", () => {
  const status = signoffStatus({ count: 3, at_least: false, overdue: 1, oldest_age_days: 9, not_recorded: 0 }, NOW)
  assert.deepEqual(status.unsigned, { state: "measured", value: 3 })
  assert.deepEqual(status.oldest_unsigned_age_days, { state: "measured", value: 9 })
  const cut = signoffStatus({ count: 500, at_least: true, overdue: 20, oldest_age_days: 30, not_recorded: 7 }, NOW)
  assert.deepEqual(cut.unsigned, { state: "partial", value: 500, reason: "archive_cap" })
  assert.deepEqual(cut.overdue, { state: "partial", value: 20, reason: "archive_cap" })
  assert.deepEqual(cut.oldest_unsigned_age_days, { state: "partial", value: 30, reason: "archive_cap" })
  assert.deepEqual(cut.not_recorded, { state: "partial", value: 7, reason: "archive_cap" })
  const unknownAge = signoffStatus({ count: 2, at_least: false, overdue: 0, oldest_age_days: null, not_recorded: 0 }, NOW)
  assert.deepEqual(unknownAge.oldest_unsigned_age_days, { state: "unavailable", reason: "age_unknown" })
  const cutNoAge = signoffStatus({ count: 2, at_least: true, overdue: 0, oldest_age_days: null, not_recorded: 0 }, NOW)
  assert.deepEqual(cutNoAge.oldest_unsigned_age_days, { state: "unavailable", reason: "age_unknown" })
  const cutNone = signoffStatus({ count: 0, at_least: true, overdue: 0, oldest_age_days: null, not_recorded: 0 }, NOW)
  assert.deepEqual(cutNone.oldest_unsigned_age_days, { state: "unavailable", reason: "none_unsigned" })
})

test("status.json.signoff holds counts and an age and no task name, and keeps every other key", () => scratch(async ({ desk, env }) => {
  await put(desk, [SENTINEL, SENTINEL], card({ title: SENTINEL, evidence: { kind: "pr", ref: SENTINEL, recordedAt: ago(1) } }))
  await put(desk, [SENTINEL, "_archive", `${SENTINEL}-old`], card({ title: SENTINEL, deliveredAt: ago(9) }))
  const { writeStatus } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  await writeStatus(env, { last_flush: { "example/store": { at: "2026-09-27T12:00:00.000Z", result: "delivered_pr_open" } } })
  const found = await refreshSignoffStatus(env, desk, { now: NOW })
  assert.equal(found.count, 2)
  const status = await readStatus(env)
  assert.deepEqual(Object.keys(status.signoff).sort(), ["checked_at", "not_recorded", "oldest_unsigned_age_days", "overdue", "unsigned"])
  assert.deepEqual(status.signoff.unsigned, { state: "measured", value: 2 })
  assert.deepEqual(status.signoff.oldest_unsigned_age_days, { state: "measured", value: 9 })
  assert.equal(status.last_flush["example/store"].result, "delivered_pr_open")
  const raw = await fs.readFile(path.join(env.XDG_STATE_HOME, "ouro", "desk-factory", "status.json"), "utf8").catch(async () => {
    const hits = []
    const walk = async (dir) => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.name === "status.json") hits.push(full) } }
    await walk(env.XDG_STATE_HOME)
    return fs.readFile(hits[0], "utf8")
  })
  assert.equal(raw.includes(SENTINEL), false, "no track, slug, title or proof in status.json")
  assert.equal(raw.includes("PRIVATE"), false)
  assert.equal(raw.includes(desk), false, "no path in status.json")
  assert.equal(raw.includes("example.test"), false)
}))

test("a scan that fails writes unavailable for every figure and never a zero", () => scratch(async ({ desk, env }) => {
  const found = await refreshSignoffStatus(env, desk, { now: NOW, scan: () => { throw new Error("disk went away") } })
  assert.equal(found, null)
  const { signoff } = await readStatus(env)
  assert.equal(signoff.checked_at, new Date(NOW).toISOString())
  for (const key of ["unsigned", "overdue", "oldest_unsigned_age_days", "not_recorded"]) assert.deepEqual(signoff[key], { state: "unavailable", reason: "scan_failed" })
  assert.equal(JSON.stringify(signoff).includes("disk went away"), false)
}))

test("recordUnsigned scans, records the counts and returns the list; a failed write still returns the list", () => scratch(async ({ desk, env }) => {
  await put(desk, ["alpha", "one"], card({ deliveredAt: ago(2) }))
  const found = await recordUnsigned(env, desk, NOW)
  assert.equal(found.count, 1)
  assert.deepEqual((await readStatus(env)).signoff.unsigned, { state: "measured", value: 1 })
  const blocker = path.join(path.dirname(desk), "a-file")
  await fs.writeFile(blocker, "x")
  const broken = { ...env, XDG_STATE_HOME: path.join(blocker, "state") }
  assert.equal((await recordUnsigned(broken, desk, NOW)).count, 1, "a state folder that cannot be written never hides the list")
  assert.equal(await recordUnsigned(env, desk, NOW, { scan: () => { throw new Error("x") } }), null)
  assert.equal(await recordUnsigned(broken, desk, NOW, { scan: () => { throw new Error("x") } }), null)
}))

test("the scan stays inside the boot budget on a desk with 500 archived cards", () => withDesk(async (desk) => {
  const body = card({ deliveredAt: ago(2) }) + "x".repeat(40_000)
  for (let n = 0; n < 500; n += 1) await put(desk, [`track-${n % 10}`, "_archive", `task-${n}`], body)
  for (let n = 0; n < 20; n += 1) await put(desk, [`live-${n % 4}`, `live-${n}`], card({ deliveredAt: ago(1) }))
  const started = performance.now()
  const found = unsignedDeliveries(desk, { now: NOW })
  const took = performance.now() - started
  assert.equal(found.count, 520)
  assert.equal(found.at_least, false)
  console.log(`budget scan of 500 archived and 20 live cards took ${took.toFixed(0)} ms`)
  assert.ok(took < 5000, `the scan took ${took} ms, the bound is 5000 ms`)
}))

test("a proof with no kind shows its reference, an unquoted evidence time is read, and a card with no status is skipped", () => withDesk(async (desk) => {
  await put(desk, ["alpha", "no-kind"], card({ deliveredAt: null, evidence: { kind: null, ref: "abc123", recordedAt: ago(4), bare: true } }))
  await put(desk, ["alpha", "no-status"], "---\ntitle: x\n---\n")
  const found = unsignedDeliveries(desk, { now: NOW })
  assert.equal(found.count, 1)
  assert.equal(found.tasks[0].proof, "abc123")
  assert.equal(found.tasks[0].age_days, 4)
}))

test("archived cards with the same modification time are read in a fixed order", () => withDesk(async (desk) => {
  const when = new Date(NOW - 5000)
  for (const name of ["b", "a", "c"]) {
    const file = await put(desk, ["alpha", "_archive", name], card({ deliveredAt: ago(2) }))
    await fs.utimes(file, when, when)
  }
  assert.deepEqual(unsignedDeliveries(desk, { now: NOW, archiveCap: 2 }).tasks.map((task) => task.slug), ["a", "b"])
}))
