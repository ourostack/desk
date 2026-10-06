// task_focus — a session's main agent declares the task it is working on — plus the focus held for the session, the
// `focus` field on task_create and the hints task_update, task_archive and task_move add. Hints never gate a call.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import {
  taskFocus,
  focusNote,
  TASK_FOCUS_FIELDS,
  NO_FOCUS_HINT,
  focusedHint,
  PROGRESS_ENTRIES,
  PROGRESS_ENTRY_CHARS,
} from "../../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { recentProgress } from "../../../../../plugins/desk/mcp/src/tools/task-body.js"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { task_move } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { createFocusHolder, toolRequirement, requirementMet } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import { callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { mkTempDeskRoot } from "./_helpers.js"

const DONE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/1" }
const MAIN_FOCUSED = (name) => `If you are the session's main agent: focused on ${name}; call task_focus if you have switched tasks, or with clear: true for none.`
const MAIN_NONE = "If you are the session's main agent: no task in focus; call task_focus with the task you are working on, or with clear: true for none."

async function card(root, track, slug, extra = {}) {
  await task_create({ deskRoot: root, input: { track, slug, title: "T", status: "processing", ...extra } })
}

function ctx() {
  const focus = createFocusHolder()
  return { focus, statusContext: { focus } }
}

test("hint strings are the brief's, worded for the main agent", () => {
  assert.equal(NO_FOCUS_HINT, MAIN_NONE)
  assert.equal(focusedHint({ track: "a", slug: "b-c" }), MAIN_FOCUSED("a/b-c"))
  assert.deepEqual(TASK_FOCUS_FIELDS, ["track", "slug", "clear"])
})

test("focus then status returns focused, with status and recent progress", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  for (const note of ["one", "two", "three", "four", "five", "six"]) await task_update({ deskRoot: root, input: { track: "tr", slug: "alpha-work", note } })
  const { focus, statusContext } = ctx()
  const result = await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  assert.equal(result.status, "focused")
  assert.deepEqual([result.track, result.slug, result.task_status], ["tr", "alpha-work", "processing"])
  assert.equal(result.recent_progress.length, PROGRESS_ENTRIES)
  assert.match(result.recent_progress[0], /two$/u)
  assert.match(result.recent_progress[4], /six$/u)
  assert.equal(result.archived, undefined)
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-work" })
})

test("recent_progress is empty for a card with no progress section, and a status-less card reads null", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const result = await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" } })
  assert.deepEqual(result.recent_progress, [])
  await fs.writeFile(path.join(root, "tr", "alpha-work", "task.md"), "---\ntitle: T\n---\nbody\n")
  assert.equal((await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" } })).task_status, null)
})

test("each progress entry is capped, and a credential-like entry is redacted", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  await task_update({ deskRoot: root, input: { track: "tr", slug: "alpha-work", note: "x".repeat(PROGRESS_ENTRY_CHARS * 3) } })
  const [entry] = (await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" } })).recent_progress
  assert.equal(entry.length, PROGRESS_ENTRY_CHARS)
  assert.ok(entry.endsWith("…"))
})

test("a credential-like progress entry is redacted in recent_progress and the rest of the note survives", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  await task_update({ deskRoot: root, input: { track: "tr", slug: "alpha-work", note: "plain note kept" } })
  await task_update({ deskRoot: root, input: { track: "tr", slug: "alpha-work", note: "wired login using ghp_abcdefghijklmnopqrstuvwxyz0123456789 in staging" } })
  const result = await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" } })
  assert.equal(result.recent_progress.length, 2)
  assert.match(result.recent_progress[0], /plain note kept$/u)
  const secretEntry = result.recent_progress[1]
  assert.doesNotMatch(secretEntry, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/u)
  assert.match(secretEntry, /wired login using/u)
  assert.match(secretEntry, /in staging/u)
  assert.doesNotMatch(JSON.stringify(result), /ghp_abcdefghijklmnopqrstuvwxyz0123456789/u)
})

test("recentProgress ignores fences, other sections, plain lines and blank bullets", () => {
  const body = [
    "intro", "## Progress log", "", "- first", "plain line", "- ", "```", "- fenced", "## Other", "```", "1. numbered", "## Later", "- not progress",
  ].join("\n")
  assert.deepEqual(recentProgress(body, 5, 300), ["first", "numbered"])
  assert.deepEqual(recentProgress("no section\n", 5, 300), [])
  assert.deepEqual(recentProgress("## Progress log\n- a\n- b\n- c\n", 2, 300), ["b", "c"])
})

test("clear returns cleared and empties the focus", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const { focus, statusContext } = ctx()
  await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  assert.deepEqual(await taskFocus({ deskRoot: root, input: { clear: true }, statusContext }), { status: "cleared" })
  assert.equal(focus.get(), null)
  assert.deepEqual(await taskFocus({ deskRoot: root, input: { clear: true } }), { status: "cleared" }, "no holder is fine")
})

test("a missing card throws card not found and leaves the focus as it was", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const { focus, statusContext } = ctx()
  await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  await assert.rejects(taskFocus({ deskRoot: root, input: { track: "tr", slug: "nope-nope" }, statusContext }), /^Error: card not found: tr\/nope-nope$/u)
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-work" })
})

test("with a person prefix, the prefixed card is found; a missing person folder reads as card not found", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, person: "ari", input: { track: "tr", slug: "alpha-work", title: "T" } })
  const found = await taskFocus({ deskRoot: root, person: "ari", input: { track: "tr", slug: "alpha-work" } })
  assert.equal(found.status, "focused")
  await assert.rejects(taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" } }), /card not found: tr\/alpha-work/u)
  await assert.rejects(taskFocus({ deskRoot: root, person: "nobody", input: { track: "tr", slug: "alpha-work" } }), /card not found/u)
  await assert.rejects(taskFocus({ deskRoot: root, person: "nobody", input: { track: "tr", slug: "alpha-work" } }), /card not found/u)
  await assert.rejects(taskFocus({ deskRoot: root, person: "a/b", input: { track: "tr", slug: "alpha-work" } }), /invalid --person alias/u, "other path errors are not hidden as a missing card")
  assert.equal(await fs.stat(path.join(root, "desks", "nobody")).catch(() => null), null, "no person folder was created")
})

test("a card found only under _archive is focused and says archived", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  await task_archive({ deskRoot: root, input: { track: "tr", slug: "alpha-work", evidence: DONE } })
  const { focus, statusContext } = ctx()
  const result = await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  assert.equal(result.status, "focused")
  assert.equal(result.archived, true)
  assert.equal(result.task_status, "done")
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-work" })
})

test("input must be exactly track and slug, or clear true, naming the accepted shapes", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const bad = [
    {}, undefined, { track: "tr" }, { slug: "alpha-work" }, { clear: false }, { clear: "true" },
    { clear: true, track: "tr", slug: "alpha-work" }, { clear: true, track: "tr" }, { clear: false, track: "tr", slug: "alpha-work" },
    { track: 5, slug: "alpha-work" }, { track: "tr", slug: ["alpha-work"] }, { track: "tr", slug: null },
    { track: "..", slug: "alpha-work" }, { track: "tr", slug: "a/b" }, { track: "tr", slug: "" }, { track: "tr", slug: " " },
  ]
  for (const input of bad) {
    const { focus, statusContext } = ctx()
    await assert.rejects(taskFocus({ deskRoot: root, input, statusContext }), /task_focus: .*(`track` and `slug`|accepted|`clear`)|task_focus:.*pass `track` and `slug`/u, JSON.stringify(input))
    assert.equal(focus.get(), null, `${JSON.stringify(input)} changed the focus`)
  }
  await assert.rejects(taskFocus({ deskRoot: root, input: { track: "tr" } }), /pass `track` and `slug` to focus a task, or `clear: true`/u)
})

test("task_create focus:true sets focus; without it (or on a failed create) focus is unchanged", async () => {
  const root = await mkTempDeskRoot()
  const { focus, statusContext } = ctx()
  const made = await task_create({ deskRoot: root, statusContext, input: { track: "tr", slug: "first-work", title: "T", focus: true } })
  assert.equal(made.status, "created")
  assert.equal(made.focused, true)
  assert.equal(made.focus_note, undefined, "create with focus never carries the no-focus hint")
  assert.deepEqual(focus.get(), { track: "tr", slug: "first-work" })
  const parked = await task_create({ deskRoot: root, statusContext, input: { track: "tr", slug: "parked-follow-up", title: "T" } })
  assert.equal(parked.focused, undefined)
  assert.deepEqual(focus.get(), { track: "tr", slug: "first-work" })
  await assert.rejects(task_create({ deskRoot: root, statusContext, input: { track: "tr", slug: "first-work", title: "T", focus: true } }), /already exists/u)
  await assert.rejects(task_create({ deskRoot: root, statusContext, input: { track: "tr", slug: "Bad Slug", title: "T", focus: true } }), /invalid slug/u)
  assert.deepEqual(focus.get(), { track: "tr", slug: "first-work" }, "a failed create keeps the focus")
  await assert.rejects(task_create({ deskRoot: root, statusContext, input: { track: "tr", slug: "third-work", title: "T", focus: "yes" } }), /`focus` must be true or false/u)
  await assert.rejects(fs.stat(path.join(root, "tr", "third-work")), /ENOENT/u)
  const direct = await task_create({ deskRoot: root, input: { track: "tr", slug: "direct-work", title: "T", focus: true } })
  assert.equal(direct.focused, undefined, "no session, nothing to hold")
})

test("task_create focus:false behaves as no focus argument", async () => {
  const root = await mkTempDeskRoot()
  const { focus, statusContext } = ctx()
  const made = await task_create({ deskRoot: root, statusContext, input: { track: "tr", slug: "first-work", title: "T", focus: false } })
  assert.equal(made.focus_note, MAIN_NONE)
  assert.equal(focus.get(), null)
})

test("hint names main agent on an update to another card", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  await card(root, "tr", "beta-work")
  const { statusContext } = ctx()
  await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  const other = await task_update({ deskRoot: root, statusContext, input: { track: "tr", slug: "beta-work", note: "n" } })
  assert.equal(other.focus_note, MAIN_FOCUSED("tr/alpha-work"))
  const same = await task_update({ deskRoot: root, statusContext, input: { track: "tr", slug: "alpha-work", note: "n" } })
  assert.equal(same.focus_note, undefined)
  const archived = await task_archive({ deskRoot: root, statusContext, input: { track: "tr", slug: "beta-work", outcome: "cancelled" } })
  assert.equal(archived.focus_note, MAIN_FOCUSED("tr/alpha-work"))
  const again = await task_archive({ deskRoot: root, statusContext, input: { track: "tr", slug: "beta-work" } })
  assert.equal(again.status, "already_archived")
  assert.equal(again.focus_note, MAIN_FOCUSED("tr/alpha-work"))
  assert.match(MAIN_FOCUSED("x/y"), /^If you are the session's main agent: /u)
})

test("no-focus hint repeats on every task tool result until the session sets a focus", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const { statusContext } = ctx()
  const first = await task_update({ deskRoot: root, statusContext, input: { track: "tr", slug: "alpha-work", note: "a" } })
  assert.equal(first.focus_note, MAIN_NONE)
  const second = await task_update({ deskRoot: root, statusContext, input: { track: "tr", slug: "alpha-work", note: "b" } })
  assert.equal(second.focus_note, MAIN_NONE)
  const third = await task_create({ deskRoot: root, statusContext, input: { track: "tr", slug: "beta-work", title: "T" } })
  assert.equal(third.focus_note, MAIN_NONE)
  const fourth = await task_archive({ deskRoot: root, statusContext, input: { track: "tr", slug: "beta-work", outcome: "cancelled" } })
  assert.equal(fourth.focus_note, MAIN_NONE)
  await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  const after = await task_update({ deskRoot: root, statusContext, input: { track: "tr", slug: "alpha-work", note: "c" } })
  assert.equal(after.focus_note, undefined, "the hint stops once a focus is set")
})

test("no-focus hint also rides task_move and task_create, stops after a deliberate clear, and task_focus itself never carries it", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const moved = ctx()
  const result = await task_move({ deskRoot: root, statusContext: moved.statusContext, input: { track: "tr", slug: "alpha-work", to_slug: "alpha-renamed" } })
  assert.equal(result.focus_note, MAIN_NONE)
  const created = ctx()
  assert.equal((await task_create({ deskRoot: root, statusContext: created.statusContext, input: { track: "tr", slug: "beta-work", title: "T" } })).focus_note, MAIN_NONE)
  const cleared = ctx()
  assert.equal((await taskFocus({ deskRoot: root, input: { clear: true }, statusContext: cleared.statusContext })).focus_note, undefined)
  assert.equal((await task_update({ deskRoot: root, statusContext: cleared.statusContext, input: { track: "tr", slug: "beta-work", note: "n" } })).focus_note, undefined, "a session that cleared on purpose is not nagged")
  const focused = ctx()
  const out = await taskFocus({ deskRoot: root, input: { track: "tr", slug: "beta-work" }, statusContext: focused.statusContext })
  assert.equal(out.focus_note, undefined)
})

test("focusNote is silent without a holder or a different-card target", () => {
  assert.equal(focusNote({}, { track: "a", slug: "b" }), undefined)
  assert.equal(focusNote(undefined, undefined), undefined)
  const { focus, statusContext } = ctx()
  focus.set({ track: "a", slug: "b" })
  assert.equal(focusNote(statusContext), undefined)
})

test("archiving the focused card keeps the focus, so a later update of another card shows the hint", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  await card(root, "tr", "beta-work")
  await card(root, "tr", "gamma-work")
  const { focus, statusContext } = ctx()
  await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  await task_archive({ deskRoot: root, statusContext, input: { track: "tr", slug: "beta-work", outcome: "cancelled" } })
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-work" })
  const done = await task_archive({ deskRoot: root, statusContext, input: { track: "tr", slug: "alpha-work", outcome: "cancelled" } })
  assert.equal(done.focus_note, undefined, "the card acted on is the focused one")
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-work" }, "the factory keeps crediting the declared task, so the held focus agrees")
  const update = await task_update({ deskRoot: root, statusContext, input: { track: "tr", slug: "gamma-work", note: "n" } })
  assert.equal(update.focus_note, MAIN_FOCUSED("tr/alpha-work"))
})

test("already_archived of the focused card keeps the focus too", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const { focus, statusContext } = ctx()
  await task_archive({ deskRoot: root, input: { track: "tr", slug: "alpha-work", outcome: "cancelled" } })
  await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  assert.equal((await task_archive({ deskRoot: root, statusContext, input: { track: "tr", slug: "alpha-work" } })).status, "already_archived")
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-work" })
})

test("moving the focused card carries the focus; moving another leaves it", async () => {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "elsewhere-track"), { recursive: true })
  await fs.writeFile(path.join(root, "elsewhere-track", "track.md"), "---\ntitle: o\n---\n")
  await card(root, "tr", "alpha-work")
  await card(root, "tr", "beta-work")
  await card(root, "tr", "gamma-work")
  await fs.writeFile(path.join(root, "tr", "track.md"), "---\ntitle: o\n---\n")
  const { focus, statusContext } = ctx()
  await taskFocus({ deskRoot: root, input: { track: "tr", slug: "alpha-work" }, statusContext })
  const unrelated = await task_move({ deskRoot: root, statusContext, input: { track: "tr", slug: "beta-work", to_slug: "beta-renamed" } })
  assert.equal(unrelated.focus_note, undefined)
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-work" })
  const followed = await task_move({ deskRoot: root, statusContext, input: { track: "tr", slug: "alpha-work", to_slug: "alpha-renamed" } })
  assert.equal(followed.focus_note, undefined)
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-renamed" })
  await task_move({ deskRoot: root, statusContext, input: { track: "tr", slug: "alpha-renamed", to_track: "elsewhere-track" } })
  assert.deepEqual(focus.get(), { track: "elsewhere-track", slug: "alpha-renamed" })
  await task_move({ deskRoot: root, statusContext, input: { track: "elsewhere-track", slug: "alpha-renamed", to_track: "tr", into_task: "gamma-work" } })
  assert.deepEqual(focus.get(), { track: "tr", slug: "gamma-work" }, "a merge follows into the card that keeps the job")
})

test("task_move works with no session holder", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const result = await task_move({ deskRoot: root, input: { track: "tr", slug: "alpha-work", to_slug: "alpha-renamed" } })
  assert.equal(result.focus_note, undefined)
})

test("task_focus is not a write: its requirement is its own and needs only the runtime and a root", () => {
  assert.equal(toolRequirement("task_focus"), "focus")
  assert.equal(requirementMet("focus", { runtimeServer: {}, root: {} }), true)
  assert.equal(requirementMet("focus", { runtimeServer: {}, root: {}, authorityAdmitted: false, launcher: { blocksWrites: true }, stateBranch: { ok: false } }), true)
  assert.equal(requirementMet("focus", {}), false)
  assert.equal(requirementMet("focus", { runtimeServer: {}, root: {}, launcher: { mode: "refuse" } }), false)
})

test("server.callTool routes task_focus and surfaces a missing card as an error", async () => {
  const root = await mkTempDeskRoot()
  await card(root, "tr", "alpha-work")
  const { focus, statusContext } = ctx()
  const ok = await callTool({ deskRoot: root, name: "task_focus", input: { track: "tr", slug: "alpha-work" }, statusContext })
  assert.equal(JSON.parse(ok.content[0].text).status, "focused")
  assert.deepEqual(focus.get(), { track: "tr", slug: "alpha-work" })
  const missing = await callTool({ deskRoot: root, name: "task_focus", input: { track: "tr", slug: "nope-nope" }, statusContext })
  assert.equal(missing.isError, true)
  assert.match(JSON.parse(missing.content[0].text).message, /card not found: tr\/nope-nope/u)
})

test("the focus holder keeps the value and is undeclared until the first set", () => {
  const holder = createFocusHolder()
  assert.equal(holder.get(), null)
  assert.equal(holder.declared(), false)
  assert.equal(holder.declared(), false)
  holder.set({ track: "a", slug: "b-c" })
  assert.deepEqual(holder.get(), { track: "a", slug: "b-c" })
  const fresh = createFocusHolder()
  fresh.set(null)
  assert.equal(fresh.declared(), true)
})
