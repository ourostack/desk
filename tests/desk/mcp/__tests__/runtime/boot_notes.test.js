// Session start lists the open notes teammates left in this person's `_inbox/` (note_leave), oldest first and bounded,
// with one instruction: tell the operator early without displacing the work, read a note before related work, and
// call note_ack once the operator has seen it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce, runBootCli } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText, notesInstruction } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { renderNote } from "../../../../../plugins/desk/mcp/src/runtime/inbox.js"

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}

// A Crew workspace where Ari left Saranya a note.
async function workspace() {
  const root = await mkTempRoot("desk-boot-notes-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", "desks.md"), "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n| saranya | saranya@example.com |\n")
  const inbox = path.join(root, "desks", "saranya", "_inbox")
  await fs.mkdir(inbox, { recursive: true })
  await fs.writeFile(path.join(inbox, "2026-10-30-ari-tracker-abcdef.md"), renderNote({ from: "ari", to: "saranya", created: "2026-10-30T13:00:00-07:00", subject: "Your tracker is being extended", related: [], body: "Here's my understanding of what Ari was thinking." }))
  return root
}

const boot = (root, extra = {}) => bootOnce({
  env: { DESK: root, DESK_PERSON: "saranya" }, cwd: root, homeDir: root, gh, jq,
  syncFn: async () => ({ state: "synced" }),
  factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  repoFn: () => ({ states: [], pending: [] }),
  lastSyncFn: () => "2026-09-30T10:00:00.000Z",
  ...extra,
})

const NOTES = { path: "desks/saranya/_inbox", count: 1, more: 0, notes: [{ from: "ari", created: "2026-10-30T13:00:00-07:00", subject: "Your tracker is being extended", path: "desks/saranya/_inbox/2026-10-30-ari-tracker-abcdef.md" }] }

test("boot carries the person's open notes and says what to do with them, and nothing when there are none", async () => {
  const root = await workspace()
  const result = await boot(root)
  assert.deepEqual(result.notes, NOTES)
  assert.ok(result.instructions.includes(notesInstruction(NOTES)), "the --json instructions")
  assert.ok(result.text_instructions.includes(notesInstruction(NOTES)), "the text instructions")
  // Ari has no notes; a session with no person, or a read that fails, shows none and never stops the boot.
  const ari = await boot(root, { env: { DESK: root, DESK_PERSON: "ari" } })
  assert.equal(ari.notes, null)
  assert.equal(ari.instructions.some((line) => /open notes? from teammates/u.test(line)), false)
  assert.equal((await boot(root, { personFn: async () => ({ status: "unresolved", reason: "login_not_cached" }) })).notes, null)
  const throwing = await boot(root, { notesFn: () => { throw new Error("EACCES") } })
  assert.deepEqual([throwing.notes, throwing.status], [null, "ready"])
  // A solo desk has no inbox to read.
  const solo = await mkTempRoot("desk-boot-notes-solo-")
  await fs.mkdir(path.join(solo, "_meta"), { recursive: true })
  await fs.mkdir(path.join(solo, "_inbox"), { recursive: true })
  await fs.writeFile(path.join(solo, "_inbox", "x.md"), "---\nstatus: open\n---\n")
  assert.equal((await boot(solo, { env: { DESK: solo } })).notes, null)
})

test("notesInstruction tells the agent to raise the notes early without displacing the work, read them first and acknowledge them", () => {
  assert.equal(notesInstruction(NOTES), "1 open note from a teammate is waiting in desks/saranya/_inbox/ (listed under \"Notes from teammates\", oldest first). Tell the operator about it early in your reply, in a line or two, and keep doing the work they asked for: a note never displaces it. Read a note before you act on work it relates to. Once the operator has seen a note, call note_ack with its path; until then every session start lists it.")
  assert.match(notesInstruction({ ...NOTES, count: 7 }), /^7 open notes from teammates are waiting in desks\/saranya\/_inbox\/ [^]* Tell the operator about them early/u)
})

test("formatBootText lists the open notes before the tasks, and says how many more there are", () => {
  const base = { status: "ready", degraded: [], pending: [], instructions: [], root: { path: "/work/desk" }, active_tasks: { task_count: 0, tracks: [] } }
  const text = formatBootText({ ...base, notes: NOTES })
  assert.match(text, /\n\nNotes from teammates \(1 open, oldest first\):\n- 2026-10-30 from ari: Your tracker is being extended \(desks\/saranya\/_inbox\/2026-10-30-ari-tracker-abcdef\.md\)\n\nActive tasks \(0\):/u)
  const many = formatBootText({ ...base, notes: { ...NOTES, count: 8, more: 3 } })
  assert.match(many, /\(desks\/saranya\/_inbox\/2026-10-30-ari-tracker-abcdef\.md\)\n- and 3 more in desks\/saranya\/_inbox\/\n/u)
  assert.equal(formatBootText({ ...base, notes: null }).includes("Notes from teammates"), false)
  assert.equal(formatBootText(base).includes("Notes from teammates"), false)
})

test("runBootCli puts the notes in --json and in the text", async () => {
  const root = await workspace()
  const run = async (argv) => {
    let written = ""
    await runBootCli({ argv, env: { DESK: root, DESK_PERSON: "saranya" }, io: { stdout: { write: (text) => { written += text } } }, bootFn: (options) => boot(root, options) })
    return written
  }
  assert.deepEqual(JSON.parse(await run(["--json"])).notes, NOTES)
  const text = await run([])
  assert.match(text, /\nNotes from teammates \(1 open, oldest first\):\n- 2026-10-30 from ari: Your tracker is being extended/u)
  assert.match(text, /\n\d+\. 1 open note from a teammate is waiting in desks\/saranya\/_inbox\//u)
})
