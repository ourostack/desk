// task_signoff — the one tool that records the operator's yes or no on a delivered task, with the clock injected.

import { test, mock } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { promises as fs, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { taskSignoff, TASK_SIGNOFF_FIELDS } from "../../../../../plugins/desk/mcp/src/tools/task-signoff.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { REFUSAL_REASONS, RETURN_REASONS, parseReturn } from "../../../../../plugins/desk/mcp/src/factory/outcome.js"
import { TOOL_NAMES, TOOL_DESCRIPTIONS } from "../../../../../plugins/desk/mcp/src/tool-names.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../../plugins/desk/mcp/src/tool-schemas.js"
import { TOOL_IMPLS, callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { deferredToolsHint } from "../../../../../plugins/desk/mcp/src/util/deferred-tools.js"
import { toolKind } from "../../../../../plugins/desk/mcp/src/factory/tool-kinds.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"
import { osEnv } from "../_os_env.js"
import { notCommitted } from "./_route_around.js"

const SENTINEL = "SENTINEL-card-body-text"
const PR_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/7" }
const FUTURE = Date.now() + 3_600_000
const AT = new Date(FUTURE).toISOString()
const REPO = path.resolve(fileURLToPath(new URL("../../../../../", import.meta.url)))

const now = () => FUTURE
const spy = () => {
  const calls = []
  return { calls, fn: async (...args) => { calls.push(args) } }
}

function initGit(root) {
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
}
const git = (root, ...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).stdout
const headOf = (root) => git(root, "rev-parse", "--verify", "-q", "HEAD").trim()
const lastFiles = (root) => git(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()

const TRACK_CARD = (slugs) => `---\nschema_version: 1\ntitle: T\nstatus: active\n---\n\n## Tasks\n\n| Slug | State | Repos | Tracker link | Doing doc |\n|------|-------|-------|--------------|-----------|\n${slugs.map((slug) => `| \`${slug}\` | processing | | | |`).join("\n")}\n`

// What a person does between steps on a Git desk: the files a test writes by hand are committed, so the tools see a clean tree.
function settle(root) {
  if (spawnSync("git", ["-C", root, "rev-parse", "--git-dir"], { encoding: "utf8" }).status !== 0) return
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "fixture")
}

// A delivered task: created at processing, then moved to done with evidence. The title and body carry the sentinel.
async function delivered(root, slug, { track = "t", archive = false } = {}) {
  await fs.mkdir(path.join(root, track), { recursive: true })
  const trackFile = path.join(root, track, "track.md")
  try {
    await fs.access(trackFile)
    await fs.appendFile(trackFile, `| \`${slug}\` | processing | | | |\n`)
  } catch {
    await fs.writeFile(trackFile, TRACK_CARD([slug]))
  }
  settle(root)
  await task_create({ deskRoot: root, input: { track, slug, title: `Title ${slug} ${SENTINEL}`, status: "processing", body: `${SENTINEL}\n` } })
  await task_update({ deskRoot: root, input: { track, slug, frontmatter: { status: "done" }, evidence: PR_EVIDENCE }, finalize: async () => {} })
  settle(root)
  if (archive) await task_archive({ deskRoot: root, input: { track, slug } })
  settle(root)
  return path.join(root, track, archive ? "_archive" : "", slug, "task.md")
}

// A done card as it was before the record existed: no signoff, no flow, evidence with a time.
async function legacyDone(root, slug, evidence = { kind: "pr", ref: PR_EVIDENCE.ref, recorded_at: "2020-01-01T00:00:00.000Z" }) {
  const dir = path.join(root, "t", slug)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, "task.md")
  await writeMarkdown(file, { schema_version: 1, title: `Title ${slug} ${SENTINEL}`, status: "done", created: "2020-01-01T00:00:00.000Z", updated: "2020-01-01T00:00:00.000Z", evidence }, `${SENTINEL}\n`)
  return file
}

// Calls the tool with everything injected; `extra` overrides any of it.
function sign(root, slug, input, extra = {}) {
  const finalize = extra.finalize ?? spy().fn
  const refreshSignoff = extra.refreshSignoff ?? spy().fn
  return taskSignoff({ deskRoot: root, input: { track: "t", slug, ...input }, now, finalize, refreshSignoff, schedulePush: () => {}, ...extra })
}

const body = async (file) => readFileSync(file, "utf8")
const rewrite = async (file, change) => {
  // The parse is cached by content, so a card in another test with the same bytes shares the object: change a copy.
  const parsed = await readFront(file)
  const data = structuredClone(parsed.data)
  change(data)
  await writeMarkdown(file, data, parsed.content)
}

// A track whose tasks are all terminal is archived whole into the desk's `_archive/` (archive-workflow), often before the operator answers.
function archiveTrack(root, track = "t") {
  const moved = spawnSync("git", ["-C", root, "mv", track, path.join("_archive", track)], { encoding: "utf8" })
  assert.equal(moved.status, 0, moved.stderr)
  git(root, "commit", "-q", "-m", `archive: track ${track}`)
}

const read = (relative) => readFileSync(path.join(REPO, relative), "utf8")

test("an acceptance of a delivered task writes accepted", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "ship-fix")
  const before = (await readFront(file)).data
  const result = await sign(root, "ship-fix", { outcome: "accepted" })
  assert.equal(result.status, "signed")
  assert.equal(result.path, "t/ship-fix/task.md")
  assert.deepEqual(result.signoff, { state: "accepted", at: AT, reason: null })
  assert.equal(result.say, "Recorded: ship-fix accepted.")
  for (const key of ["verified", "unverified_because", "unverified_note"]) assert.equal(key in result, false, key)
  const { data } = await readFront(file)
  assert.deepEqual(data.signoff, { state: "accepted", at: AT, reason: null })
  assert.equal(data.status, "done")
  assert.equal(data.flow.rev, before.flow.rev + 1)
  assert.equal(data.flow.deliveries, 1)
  assert.equal(data.title, before.title)
})


test("a refusal needs a reason and a return_reason, each from its list", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "needs-both")
  const before = await body(file)
  const head = headOf(root)
  const finalize = spy()
  const cases = [
    [{ outcome: "refused" }, /a refusal needs `reason`, the operator's reason, one of not_what_was_asked, defect, changed_ask, incomplete, other/],
    [{ outcome: "refused", reason: "defect" }, /a refusal needs `return_reason`, your own reading of the cause, one of agent_error, changed_ask, new_information, external/],
    [{ outcome: "refused", reason: "bogus", return_reason: "agent_error" }, /a refusal needs `reason`/],
    [{ outcome: "refused", reason: "defect", return_reason: "bogus" }, /a refusal needs `return_reason`/],
    [{ outcome: "refused", reason: "defect", return_reason: "" }, /a refusal needs `return_reason`/],
  ]
  for (const [input, message] of cases) await assert.rejects(sign(root, "needs-both", input, { finalize: finalize.fn }), message)
  assert.equal(await body(file), before, "the card bytes are unchanged")
  assert.equal(headOf(root), head, "no commit")
  assert.equal(finalize.calls.length, 0)
})

test("an acceptance with a reason is refused", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "no-reason-here")
  const before = await body(file)
  const head = headOf(root)
  await assert.rejects(sign(root, "no-reason-here", { outcome: "accepted", reason: "defect" }), /task_signoff: Drop `reason` and `return_reason` from an acceptance: an acceptance takes no `reason` or `return_reason`; drop them/)
  await assert.rejects(sign(root, "no-reason-here", { outcome: "accepted", return_reason: "agent_error" }), /task_signoff: Drop `reason` and `return_reason` from an acceptance: an acceptance takes no `reason` or `return_reason`; drop them/)
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
})

test("input that is not a track, a slug and an outcome is refused and writes nothing", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "odd-input")
  const before = await body(file)
  await assert.rejects(taskSignoff({ deskRoot: root, input: undefined, now }), /task_signoff: Pass `track` and `slug`: `track` and `slug` are required/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t" }, now }), /task_signoff: Pass `track` and `slug`: `track` and `slug` are required/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: 4, outcome: "accepted" }, now }), /task_signoff: Pass `track` and `slug`: `track` and `slug` are required/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: "odd-input" }, now }), /task_signoff: Pass `outcome` as one of the listed values: `outcome` must be accepted or refused/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: "odd-input", outcome: "maybe" }, now }), /task_signoff: Pass `outcome` as one of the listed values: `outcome` must be accepted or refused/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "../x", slug: "odd-input", outcome: "accepted" }, now }), /task_signoff: Pass `track` as a task folder name: `track` is not a valid task folder name/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: "a/b", outcome: "accepted" }, now }), /task_signoff: Pass `slug` as a task folder name: `slug` is not a valid task folder name/)
  assert.equal(await body(file), before)
})

test("an unknown track or slug is said so and nothing is written", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "real-one")
  const listing = await fs.readdir(root, { recursive: true })
  await assert.rejects(sign(root, "no-such-slug", { outcome: "accepted" }), /task_signoff: Check the track and slug, then try again: there is no task t\/no-such-slug in this desk; check the track and slug\. Nothing was recorded\./)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "nope", slug: "real-one", outcome: "accepted" }, now }), /there is no task nope\/real-one/)
  assert.deepEqual(await fs.readdir(root, { recursive: true }), listing)
})

test("a task that is not done cannot be signed and the message names its status", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "still-going", title: "T", status: "processing" } })
  const file = path.join(root, "t", "still-going", "task.md")
  const before = await body(file)
  const finalize = spy()
  await assert.rejects(sign(root, "still-going", { outcome: "accepted" }, { finalize: finalize.fn }), { message: "task_signoff: Finish the task and move it to done with task_update first: only a delivered task can be signed; this one is at processing. Nothing was recorded. It is not delivered yet, so do not ask the person to accept it: tell them what is left, finish it, move the task to done with task_update, and ask \"Accept or send back?\" in that delivery." })
  await assert.rejects(sign(root, "still-going", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { finalize: finalize.fn }), { message: "task_signoff: Finish the task and move it to done with task_update first: only a delivered task can be signed; this one is at processing. Nothing was recorded. It is not delivered yet, so do not ask the person to accept it: tell them what is left, finish it, move the task to done with task_update, and ask \"Accept or send back?\" in that delivery." })
  assert.equal(await body(file), before)
  assert.equal(finalize.calls.length, 0)
  await rewrite(file, (data) => { data.status = "bogus" })
  await assert.rejects(sign(root, "still-going", { outcome: "accepted" }), { message: "task_signoff: Finish the task and move it to done with task_update first: only a delivered task can be signed; this one is at no recognised status. Nothing was recorded. It is not delivered yet, so do not ask the person to accept it: tell them what is left, finish it, move the task to done with task_update, and ask \"Accept or send back?\" in that delivery." })
})

test("a refusal puts the task back to processing and the answer says it is not done", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "send-back")
  const result = await sign(root, "send-back", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  assert.equal(result.status, "signed")
  assert.equal(result.say, "Recorded: send-back sent back (defect); it is back in processing.")
  assert.deepEqual(result.signoff, { state: "refused", at: AT, reason: "defect" })
  assert.equal(result.report_as, "Task send-back is back at processing (not done).")
  assert.equal(result.report_note, "Do not tell the operator this task is done; it is at processing.")
  const { data } = await readFront(file)
  assert.equal(data.status, "processing")
  assert.equal(data.flow.reached, "processing")
  assert.deepEqual(data.signoff, { state: "refused", at: AT, reason: "defect" })
  assert.match(await fs.readFile(path.join(root, "t", "track.md"), "utf8"), /\| `send-back` \| processing \|/)
})

test("a refusal appends a return caught after delivery with the human's reason and the agent's", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "return-line")
  await sign(root, "return-line", { outcome: "refused", reason: "not_what_was_asked", return_reason: "changed_ask" })
  const { data } = await readFront(file)
  assert.equal(data.returns.length, 1)
  assert.equal(data.returns[0], `${AT} done processing changed_ask after_delivery refused=not_what_was_asked`)
  assert.deepEqual(parseReturn(data.returns[0]), { at: AT, from: "done", to: "processing", reason: "changed_ask", caught: "after_delivery", refusal: "not_what_was_asked", refusal_verified: null })
})


test("a task refused and delivered again starts unsigned and keeps the refusal in returns", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "again-and-again")
  await sign(root, "again-and-again", { outcome: "refused", reason: "incomplete", return_reason: "agent_error" })
  await task_update({ deskRoot: root, input: { track: "t", slug: "again-and-again", frontmatter: { status: "done" }, evidence: PR_EVIDENCE }, finalize: async () => {} })
  const { data } = await readFront(file)
  assert.equal(data.status, "done")
  assert.deepEqual(data.signoff, { state: "delivered_unsigned", at: null, reason: null })
  assert.equal(data.returns.length, 1)
  assert.match(data.returns[0], /refused=incomplete$/)
  assert.equal(data.flow.deliveries, 2)
})

test("a second refusal appends a second return", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "twice-refused")
  await sign(root, "twice-refused", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  await task_update({ deskRoot: root, input: { track: "t", slug: "twice-refused", frontmatter: { status: "done" }, evidence: PR_EVIDENCE }, finalize: async () => {} })
  await sign(root, "twice-refused", { outcome: "refused", reason: "changed_ask", return_reason: "changed_ask" })
  const { data } = await readFront(file)
  assert.equal(data.returns.length, 2)
  assert.match(data.returns[0], /agent_error after_delivery refused=defect$/)
  assert.match(data.returns[1], /changed_ask after_delivery refused=changed_ask$/)
  assert.equal(data.status, "processing")
})

test("a refusal of an archived task brings it back to the live tree", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await delivered(root, "from-the-shelf", { archive: true })
  const archived = path.join(root, "t", "_archive", "from-the-shelf")
  const live = path.join(root, "t", "from-the-shelf", "task.md")
  const result = await sign(root, "from-the-shelf", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  assert.equal(result.path, "t/from-the-shelf/task.md")
  await assert.rejects(fs.access(archived))
  const { data } = await readFront(live)
  assert.equal(data.status, "processing")
  assert.equal(data.returns.length, 1)
  assert.equal(git(root, "status", "--short").trim(), "", "everything is committed")
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "task_signoff: t/from-the-shelf")
  assert.match(git(root, "log", "-2", "--format=%s").split("\n")[1], /^task_update: from-the-shelf/)
})

test("a refusal whose unarchive fails records nothing", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "stuck-on-shelf", { archive: true })
  await fs.writeFile(path.join(path.dirname(file), "stray.txt"), "left by another session\n")
  const before = await body(file)
  const head = headOf(root)
  const finalize = spy()
  await assert.rejects(sign(root, "stuck-on-shelf", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { finalize: finalize.fn }), /task_signoff: Use task_update \(unarchive: true\) to bring it back, then try again: the archived task could not be brought back \(task_update: .*\); nothing was recorded\. Bring it back with task_update \(unarchive: true\), then call task_signoff again\./)
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
  assert.equal(finalize.calls.length, 0)
})

test("an acceptance of an archived task leaves it archived", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "kept-on-shelf", { archive: true })
  const result = await sign(root, "kept-on-shelf", { outcome: "accepted" })
  assert.equal(result.path, "t/_archive/kept-on-shelf/task.md")
  const { data } = await readFront(file)
  assert.equal(data.signoff.state, "accepted")
  assert.equal(data.status, "done")
  await assert.rejects(fs.access(path.join(root, "t", "kept-on-shelf")))
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "task_signoff: t/kept-on-shelf")
})


test("an acceptance of a task whose whole track was archived is recorded where the card is", async () => {
  for (const archive of [true, false]) {
    const root = await mkTempDeskRoot()
    initGit(root)
    await fs.mkdir(path.join(root, "_archive"), { recursive: true })
    await delivered(root, "track-on-shelf", { archive })
    archiveTrack(root)
    const rel = archive ? "_archive/t/_archive/track-on-shelf/task.md" : "_archive/t/track-on-shelf/task.md"
    const result = await sign(root, "track-on-shelf", { outcome: "accepted" })
    assert.equal(result.status, "signed")
    assert.equal(result.path, rel)
    const { data } = await readFront(path.join(root, rel))
    assert.equal(data.signoff.state, "accepted")
    assert.equal(data.status, "done")
    await assert.rejects(fs.access(path.join(root, "t")), "the track stays archived")
    assert.equal(git(root, "status", "--short").trim(), "", "everything is committed")
    assert.deepEqual(lastFiles(root), [rel])
  }
})

test("a refusal of a task whose whole track was archived records nothing and says how to bring the track back", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  await delivered(root, "track-on-shelf", { archive: true })
  archiveTrack(root)
  const file = path.join(root, "_archive", "t", "_archive", "track-on-shelf", "task.md")
  const before = await body(file)
  const head = headOf(root)
  const finalize = spy()
  await assert.rejects(sign(root, "track-on-shelf", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { finalize: finalize.fn }), /task_signoff: Move the track back out of the archive, commit that, then call task_signoff again: the task's track is archived, so the task cannot go back to processing there; nothing was recorded\. From the desk root, bring the track back with `git mv _archive\/t t`, commit that, then call task_signoff again\./u)
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
  assert.equal(finalize.calls.length, 0)
})

test("when a live track of the same name exists, a refusal says to move the task's folder into it, and that move makes the refusal work", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  await delivered(root, "track-on-shelf", { archive: true })
  archiveTrack(root)
  await delivered(root, "newer-work")
  const head = headOf(root)
  await assert.rejects(sign(root, "track-on-shelf", { outcome: "refused", reason: "defect", return_reason: "agent_error" }), /task_signoff: Move the track back out of the archive, commit that, then call task_signoff again: the task's track is archived, so the task cannot go back to processing there; nothing was recorded\. A live track t exists too: from the desk root, move the task into it with `git mv _archive\/t\/_archive\/track-on-shelf t\/track-on-shelf`, commit that, then call task_signoff again\./u)
  assert.equal(headOf(root), head)
  const moved = spawnSync("git", ["-C", root, "mv", "_archive/t/_archive/track-on-shelf", "t/track-on-shelf"], { encoding: "utf8" })
  assert.equal(moved.status, 0, moved.stderr)
  git(root, "commit", "-q", "-m", "bring the task back")
  const result = await sign(root, "track-on-shelf", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  assert.equal(result.path, "t/track-on-shelf/task.md")
  assert.equal((await readFront(path.join(root, "t", "track-on-shelf", "task.md"))).data.status, "processing")
})

test("on a crew desk the refusal names the track's paths from the desk root", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const mine = path.join(root, "desks", "ari")
  await fs.mkdir(path.join(mine, "_archive"), { recursive: true })
  await fs.mkdir(path.join(mine, "_meta"), { recursive: true })
  await fs.mkdir(path.join(mine, "t"), { recursive: true })
  await fs.writeFile(path.join(mine, "t", "track.md"), TRACK_CARD(["crew-task"]))
  settle(root)
  await task_create({ deskRoot: root, person: "ari", input: { track: "t", slug: "crew-task", title: "Crew task", status: "processing", body: "b\n" } })
  await task_update({ deskRoot: root, person: "ari", input: { track: "t", slug: "crew-task", frontmatter: { status: "done" }, evidence: PR_EVIDENCE }, finalize: async () => {} })
  settle(root)
  const moved = spawnSync("git", ["-C", root, "mv", "desks/ari/t", "desks/ari/_archive/t"], { encoding: "utf8" })
  assert.equal(moved.status, 0, moved.stderr)
  git(root, "commit", "-q", "-m", "archive: track t")
  await assert.rejects(sign(root, "crew-task", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { person: "ari" }), /From the desk root, bring the track back with `git mv desks\/ari\/_archive\/t desks\/ari\/t`, commit that/u)
  const accepted = await sign(root, "crew-task", { outcome: "accepted" }, { person: "ari" })
  assert.equal(accepted.path, "desks/ari/_archive/t/crew-task/task.md")
})

test("a live card wins over one left in an archived track of the same name", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  await delivered(root, "same-name")
  archiveTrack(root)
  const live = await delivered(root, "same-name")
  const result = await sign(root, "same-name", { outcome: "accepted" })
  assert.equal(result.path, "t/same-name/task.md")
  assert.equal((await readFront(live)).data.signoff.state, "accepted")
})

test("repeating an acceptance changes nothing and says so", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "said-twice")
  await sign(root, "said-twice", { outcome: "accepted" })
  const before = await body(file)
  const head = headOf(root)
  const finalize = spy()
  const refresh = spy()
  const result = await sign(root, "said-twice", { outcome: "accepted" }, { finalize: finalize.fn, refreshSignoff: refresh.fn })
  assert.equal(result.status, "unchanged")
  assert.equal(result.say, "Already recorded: said-twice accepted.")
  assert.equal(result.path, "t/said-twice/task.md")
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
  assert.equal(finalize.calls.length, 0)
  assert.equal(refresh.calls.length, 0)
})
