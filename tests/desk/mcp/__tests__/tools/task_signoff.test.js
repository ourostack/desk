// task_signoff — the one tool that records the operator's yes or no on a delivered task, with the witness and the clock injected.

import { test, mock } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { taskSignoff, TASK_SIGNOFF_FIELDS } from "../../../../../plugins/desk/mcp/src/tools/task-signoff.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { REFUSAL_REASONS, RETURN_REASONS, parseReturn } from "../../../../../plugins/desk/mcp/src/factory/outcome.js"
import { WITNESS_REASONS, issueTicket, recordPrompt, recordStop } from "../../../../../plugins/desk/mcp/src/runtime/signoff-witness.js"
import { TOOL_NAMES, TOOL_DESCRIPTIONS } from "../../../../../plugins/desk/mcp/src/tool-names.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../../plugins/desk/mcp/src/tool-schemas.js"
import { TOOL_IMPLS, callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { deferredToolsLoadHint } from "../../../../../plugins/desk/mcp/src/util/deferred-tools.js"
import { isTaskToolName, mcpToolName } from "../../../../../plugins/desk/mcp/src/runtime/copilot-hook-payload.js"
import { toolKind } from "../../../../../plugins/desk/mcp/src/factory/tool-kinds.js"
import { resolveDeskStateDir } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

const SENTINEL = "SENTINEL-card-body-text"
const PR_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/7" }
const FUTURE = Date.now() + 3_600_000
const AT = new Date(FUTURE).toISOString()
const UNVERIFIED_TAIL = " Desk could not see a human turn behind this answer, so it is recorded as unverified."
const REPO = path.resolve(new URL("../../../../../", import.meta.url).pathname)

const now = () => FUTURE
// A witnessed turn: a human prompt after the delivery and after the last stop, the main agent, a human origin.
const human = (extra = {}) => () => ({ promptAt: FUTURE - 60_000, stopAt: FUTURE - 120_000, mainAgent: true, humanOrigin: true, ...extra })
const nobody = () => null
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
  return taskSignoff({ deskRoot: root, input: { track: "t", slug, ...input }, witness: human(), now, finalize, refreshSignoff, schedulePush: () => {}, ...extra })
}

const body = async (file) => readFileSync(file, "utf8")
const rewrite = async (file, change) => {
  // The parse is cached by content, so a card in another test with the same bytes shares the object: change a copy.
  const parsed = await readFront(file)
  const data = structuredClone(parsed.data)
  change(data)
  await writeMarkdown(file, data, parsed.content)
}

test("an acceptance of a delivered task writes accepted with the verdict's verified value", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "ship-fix")
  const before = (await readFront(file)).data
  const result = await sign(root, "ship-fix", { outcome: "accepted" })
  assert.equal(result.status, "signed")
  assert.equal(result.path, path.join("t", "ship-fix", "task.md"))
  assert.deepEqual(result.signoff, { state: "accepted", at: AT, verified: true, reason: null })
  assert.equal(result.verified, true)
  assert.equal(result.say, "Recorded: ship-fix accepted.")
  assert.equal("unverified_because" in result, false)
  const { data } = await readFront(file)
  assert.deepEqual(data.signoff, { state: "accepted", at: AT, verified: true, reason: null })
  assert.equal(data.status, "done")
  assert.equal(data.flow.rev, before.flow.rev + 1)
  assert.equal(data.flow.deliveries, 1)
  assert.equal(data.title, before.title)
})

test("the witness is asked for this task and outcome with the injected clock", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "ask-witness")
  const asked = []
  await sign(root, "ask-witness", { outcome: "accepted" }, { witness: (request) => { asked.push(request); return human()() } })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].track, "t")
  assert.equal(asked[0].slug, "ask-witness")
  assert.equal(asked[0].outcome, "accepted")
  assert.equal(asked[0].now(), FUTURE)
})

test("an acceptance with no witness is recorded unverified and the answer says why", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "no-eyes")
  const result = await sign(root, "no-eyes", { outcome: "accepted" }, { witness: nobody })
  assert.equal(result.status, "signed")
  assert.equal(result.verified, false)
  assert.equal(result.unverified_because, "no_witness")
  assert.equal(result.unverified_note, "Desk found no record of a human turn behind this call, so the answer is kept as unverified. Repeat the call in a later turn on a host where Desk can see the operator's message.")
  assert.equal(result.say, `Recorded: no-eyes accepted.${UNVERIFIED_TAIL}`)
  assert.equal((await readFront(file)).data.signoff.verified, false)
})

test("a witness that throws is no witness", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "bad-witness")
  const result = await sign(root, "bad-witness", { outcome: "accepted" }, { witness: () => { throw new Error("boom") } })
  assert.equal(result.verified, false)
  assert.equal(result.unverified_because, "no_witness")
})

test("a refusal needs a reason and a return_reason, each from its list", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "needs-both")
  const before = await body(file)
  const head = headOf(root)
  const finalize = spy()
  const asked = []
  const witness = () => { asked.push(1); return human()() }
  const cases = [
    [{ outcome: "refused" }, /a refusal needs `reason`, the operator's reason, one of not_what_was_asked, defect, changed_ask, incomplete, other/],
    [{ outcome: "refused", reason: "defect" }, /a refusal needs `return_reason`, your own reading of the cause, one of agent_error, changed_ask, new_information, external/],
    [{ outcome: "refused", reason: "bogus", return_reason: "agent_error" }, /a refusal needs `reason`/],
    [{ outcome: "refused", reason: "defect", return_reason: "bogus" }, /a refusal needs `return_reason`/],
    [{ outcome: "refused", reason: "defect", return_reason: "" }, /a refusal needs `return_reason`/],
  ]
  for (const [input, message] of cases) await assert.rejects(sign(root, "needs-both", input, { finalize: finalize.fn, witness }), message)
  assert.equal(await body(file), before, "the card bytes are unchanged")
  assert.equal(headOf(root), head, "no commit")
  assert.equal(finalize.calls.length, 0)
  assert.equal(asked.length, 0, "the witness is not consumed by a call that is refused up front")
})

test("an acceptance with a reason is refused", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "no-reason-here")
  const before = await body(file)
  const head = headOf(root)
  await assert.rejects(sign(root, "no-reason-here", { outcome: "accepted", reason: "defect" }), /task_signoff: an acceptance takes no `reason` or `return_reason`; drop them/)
  await assert.rejects(sign(root, "no-reason-here", { outcome: "accepted", return_reason: "agent_error" }), /task_signoff: an acceptance takes no `reason` or `return_reason`; drop them/)
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
})

test("input that is not a track, a slug and an outcome is refused and writes nothing", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "odd-input")
  const before = await body(file)
  await assert.rejects(taskSignoff({ deskRoot: root, input: undefined, witness: human(), now }), /task_signoff: `track` and `slug` are required/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t" }, witness: human(), now }), /task_signoff: `track` and `slug` are required/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: 4, outcome: "accepted" }, witness: human(), now }), /task_signoff: `track` and `slug` are required/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: "odd-input" }, witness: human(), now }), /task_signoff: `outcome` must be accepted or refused/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: "odd-input", outcome: "maybe" }, witness: human(), now }), /task_signoff: `outcome` must be accepted or refused/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "../x", slug: "odd-input", outcome: "accepted" }, witness: human(), now }), /task_signoff: `track` is not a valid task folder name/)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "t", slug: "a/b", outcome: "accepted" }, witness: human(), now }), /task_signoff: `slug` is not a valid task folder name/)
  assert.equal(await body(file), before)
})

test("an unknown track or slug is said so and nothing is written", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "real-one")
  const listing = await fs.readdir(root, { recursive: true })
  await assert.rejects(sign(root, "no-such-slug", { outcome: "accepted" }), /task_signoff: there is no task t\/no-such-slug in this desk; check the track and slug\. Nothing was recorded\./)
  await assert.rejects(taskSignoff({ deskRoot: root, input: { track: "nope", slug: "real-one", outcome: "accepted" }, witness: human(), now }), /there is no task nope\/real-one/)
  assert.deepEqual(await fs.readdir(root, { recursive: true }), listing)
})

test("a task that is not done cannot be signed and the message names its status", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "still-going", title: "T", status: "processing" } })
  const file = path.join(root, "t", "still-going", "task.md")
  const before = await body(file)
  const finalize = spy()
  await assert.rejects(sign(root, "still-going", { outcome: "accepted" }, { finalize: finalize.fn }), { message: "task_signoff: only a delivered task can be signed; this one is at processing." })
  await assert.rejects(sign(root, "still-going", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { finalize: finalize.fn }), { message: "task_signoff: only a delivered task can be signed; this one is at processing." })
  assert.equal(await body(file), before)
  assert.equal(finalize.calls.length, 0)
  await rewrite(file, (data) => { data.status = "bogus" })
  await assert.rejects(sign(root, "still-going", { outcome: "accepted" }), { message: "task_signoff: only a delivered task can be signed; this one is at no recognised status." })
})

test("a refusal puts the task back to processing and the answer says it is not done", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "send-back")
  const result = await sign(root, "send-back", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  assert.equal(result.status, "signed")
  assert.equal(result.say, "Recorded: send-back sent back (defect); it is back in processing.")
  assert.deepEqual(result.signoff, { state: "refused", at: AT, verified: true, reason: "defect" })
  assert.equal(result.report_as, "Task send-back is back at processing (not done).")
  assert.equal(result.report_note, "Do not tell the operator this task is done; it is at processing.")
  const { data } = await readFront(file)
  assert.equal(data.status, "processing")
  assert.equal(data.flow.reached, "processing")
  assert.deepEqual(data.signoff, { state: "refused", at: AT, verified: true, reason: "defect" })
  assert.match(await fs.readFile(path.join(root, "t", "track.md"), "utf8"), /\| `send-back` \| processing \|/)
})

test("a refusal appends a return caught after delivery with the human's reason and the agent's", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "return-line")
  await sign(root, "return-line", { outcome: "refused", reason: "not_what_was_asked", return_reason: "changed_ask" })
  const { data } = await readFront(file)
  assert.equal(data.returns.length, 1)
  assert.equal(data.returns[0], `${AT} done processing changed_ask after_delivery refused=not_what_was_asked verified`)
  assert.deepEqual(parseReturn(data.returns[0]), { at: AT, from: "done", to: "processing", reason: "changed_ask", caught: "after_delivery", refusal: "not_what_was_asked", refusal_verified: true })
})

test("an unverified refusal is recorded as unverified in the return", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "unseen-no")
  const result = await sign(root, "unseen-no", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { witness: nobody })
  assert.equal(result.verified, false)
  assert.equal(result.say, `Recorded: unseen-no sent back (defect); it is back in processing.${UNVERIFIED_TAIL}`)
  const { data } = await readFront(file)
  assert.equal(data.status, "processing", "an unverified refusal still reopens the task")
  assert.equal(data.returns[0], `${AT} done processing agent_error after_delivery refused=defect unverified`)
  assert.equal(data.signoff.verified, false)
})

test("a task refused and delivered again starts unsigned and keeps the refusal in returns", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "again-and-again")
  await sign(root, "again-and-again", { outcome: "refused", reason: "incomplete", return_reason: "agent_error" })
  await task_update({ deskRoot: root, input: { track: "t", slug: "again-and-again", frontmatter: { status: "done" }, evidence: PR_EVIDENCE }, finalize: async () => {} })
  const { data } = await readFront(file)
  assert.equal(data.status, "done")
  assert.deepEqual(data.signoff, { state: "delivered_unsigned", at: null, verified: null, reason: null })
  assert.equal(data.returns.length, 1)
  assert.match(data.returns[0], /refused=incomplete verified$/)
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
  assert.match(data.returns[0], /agent_error after_delivery refused=defect verified$/)
  assert.match(data.returns[1], /changed_ask after_delivery refused=changed_ask verified$/)
  assert.equal(data.status, "processing")
})

test("a refusal of an archived task brings it back to the live tree", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await delivered(root, "from-the-shelf", { archive: true })
  const archived = path.join(root, "t", "_archive", "from-the-shelf")
  const live = path.join(root, "t", "from-the-shelf", "task.md")
  const result = await sign(root, "from-the-shelf", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  assert.equal(result.path, path.join("t", "from-the-shelf", "task.md"))
  await assert.rejects(fs.access(archived))
  const { data } = await readFront(live)
  assert.equal(data.status, "processing")
  assert.equal(data.returns.length, 1)
  assert.equal(git(root, "status", "--short").trim(), "", "everything is committed")
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "task_signoff: t/from-the-shelf")
  assert.match(git(root, "log", "-2", "--format=%s").split("\n")[1], /^task_move: from-the-shelf/)
})

test("a refusal whose unarchive fails records nothing", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "stuck-on-shelf", { archive: true })
  await fs.writeFile(path.join(path.dirname(file), "stray.txt"), "left by another session\n")
  const before = await body(file)
  const head = headOf(root)
  const finalize = spy()
  await assert.rejects(sign(root, "stuck-on-shelf", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { finalize: finalize.fn }), /task_signoff: the archived task could not be brought back \(task_move: .*\); nothing was recorded\. Bring it back with task_move \(unarchive: true\), then call task_signoff again\./)
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
  assert.equal(finalize.calls.length, 0)
})

test("an acceptance of an archived task leaves it archived", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "kept-on-shelf", { archive: true })
  const result = await sign(root, "kept-on-shelf", { outcome: "accepted" })
  assert.equal(result.path, path.join("t", "_archive", "kept-on-shelf", "task.md"))
  const { data } = await readFront(file)
  assert.equal(data.signoff.state, "accepted")
  assert.equal(data.status, "done")
  await assert.rejects(fs.access(path.join(root, "t", "kept-on-shelf")))
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "task_signoff: t/kept-on-shelf")
})

test("an unwitnessed call cannot change a witnessed sign-off", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "seen-once")
  await sign(root, "seen-once", { outcome: "accepted" })
  const before = await body(file)
  const head = headOf(root)
  const finalize = spy()
  const message = { message: "task_signoff: a verified answer is already recorded for this task and this call could not be verified, so nothing was changed." }
  await assert.rejects(sign(root, "seen-once", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { witness: nobody, finalize: finalize.fn }), message)
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
  assert.equal(finalize.calls.length, 0)
})

test("an unverified acceptance never overwrites a verified refusal or acceptance", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "held-refusal")
  await rewrite(file, (data) => { data.signoff = { state: "refused", at: "2026-10-05T11:00:00.000Z", verified: true, reason: "defect" } })
  const before = await body(file)
  const lower = /a verified answer is already recorded/
  await assert.rejects(sign(root, "held-refusal", { outcome: "accepted" }, { witness: nobody }), lower)
  await assert.rejects(sign(root, "held-refusal", { outcome: "accepted" }, { witness: human({ humanOrigin: false }) }), lower)
  assert.equal(await body(file), before)
  const second = await delivered(root, "held-accept")
  await sign(root, "held-accept", { outcome: "accepted" })
  const accepted = await body(second)
  await assert.rejects(sign(root, "held-accept", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { witness: nobody }), lower)
  assert.equal(await body(second), accepted)
})

test("a verified call upgrades an unverified one", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "seen-later")
  await sign(root, "seen-later", { outcome: "accepted" }, { witness: nobody })
  assert.equal((await readFront(file)).data.signoff.verified, false)
  const finalize = spy()
  const result = await sign(root, "seen-later", { outcome: "accepted" }, { finalize: finalize.fn })
  assert.equal(result.status, "signed")
  assert.equal(result.verified, true)
  assert.equal(result.say, "Recorded: seen-later accepted.")
  assert.equal((await readFront(file)).data.signoff.verified, true)
  assert.equal(finalize.calls.length, 1)
  const other = await delivered(root, "seen-later-no")
  await sign(root, "seen-later-no", { outcome: "accepted" }, { witness: nobody })
  const flipped = await sign(root, "seen-later-no", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  assert.equal(flipped.verified, true)
  assert.equal((await readFront(other)).data.status, "processing")
})

test("repeating a witnessed acceptance changes nothing and says so", async () => {
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
  assert.equal(result.verified, true)
  assert.equal(result.path, path.join("t", "said-twice", "task.md"))
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
  assert.equal(finalize.calls.length, 0)
  assert.equal(refresh.calls.length, 0)
  // An unwitnessed repeat of a witnessed answer is also unchanged, and keeps the record's verified value.
  const lower = await sign(root, "said-twice", { outcome: "accepted" }, { witness: nobody })
  assert.equal(lower.status, "unchanged")
  assert.equal(lower.verified, true)
  assert.equal(lower.say, "Already recorded: said-twice accepted.")
  assert.equal(await body(file), before)
})

test("an unverified repeat of an unverified answer says it is still unverified", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "unseen-twice")
  await sign(root, "unseen-twice", { outcome: "accepted" }, { witness: nobody })
  const before = await body(file)
  const result = await sign(root, "unseen-twice", { outcome: "accepted" }, { witness: nobody })
  assert.equal(result.status, "unchanged")
  assert.equal(result.verified, false)
  assert.equal(result.unverified_because, "no_witness")
  assert.equal(result.say, `Already recorded: unseen-twice accepted.${UNVERIFIED_TAIL}`)
  assert.equal(await body(file), before)
})

test("a done card holding a refusal answers unchanged to the same refusal", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "hand-built")
  await rewrite(file, (data) => { data.signoff = { state: "refused", at: "2026-10-05T11:00:00.000Z", verified: true, reason: "defect" } })
  const before = await body(file)
  const result = await sign(root, "hand-built", { outcome: "refused", reason: "other", return_reason: "external" })
  assert.equal(result.status, "unchanged")
  assert.equal(result.say, "Already recorded: hand-built sent back.")
  assert.equal(await body(file), before)
})

test("a legacy done task can be accepted and its flow record starts as adopted", async () => {
  const root = await mkTempDeskRoot()
  const file = await legacyDone(root, "before-records")
  const result = await sign(root, "before-records", { outcome: "accepted" })
  assert.equal(result.status, "signed")
  const { data } = await readFront(file)
  assert.equal(data.flow.since, "adopted")
  assert.equal(data.signoff.state, "accepted")
  assert.equal(data.signoff.verified, true)
  assert.equal(data.status, "done")
})

test("a legacy done task that is refused gets a flow, a return and its place at processing", async () => {
  const root = await mkTempDeskRoot()
  const file = await legacyDone(root, "before-records-no")
  await sign(root, "before-records-no", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  const { data } = await readFront(file)
  assert.equal(data.flow.since, "adopted")
  assert.equal(data.flow.reached, "processing")
  assert.equal(data.status, "processing")
  assert.equal(data.returns.length, 1)
})

test("the time of delivery for the verdict is the flow's, else the evidence's, and absent only when both are unreadable", async () => {
  const root = await mkTempDeskRoot()
  // A legacy card delivered "later" than the human turn: same turn.
  const late = await legacyDone(root, "legacy-late", { kind: "pr", ref: PR_EVIDENCE.ref, recorded_at: new Date(FUTURE).toISOString() })
  const sameTurn = await sign(root, "legacy-late", { outcome: "accepted" })
  assert.equal(sameTurn.unverified_because, "same_turn_as_delivery")
  assert.equal((await readFront(late)).data.signoff.verified, false)
  // A flow time that cannot be read falls back to the evidence time.
  const fallback = await delivered(root, "flow-unreadable")
  await rewrite(fallback, (data) => { data.flow.delivered_at = "not a time"; data.evidence.recorded_at = new Date(FUTURE).toISOString() })
  assert.equal((await sign(root, "flow-unreadable", { outcome: "accepted" })).unverified_because, "same_turn_as_delivery")
  // Both unreadable: absent, so it does not stand in the way.
  const neither = await delivered(root, "both-unreadable")
  await rewrite(neither, (data) => { data.flow.delivered_at = "not a time"; data.evidence.recorded_at = "nor this" })
  assert.equal((await sign(root, "both-unreadable", { outcome: "accepted" })).verified, true)
  // No evidence time at all on a card with no flow: absent.
  const bare = await legacyDone(root, "no-evidence-time", { kind: "pr", ref: PR_EVIDENCE.ref })
  assert.equal((await sign(root, "no-evidence-time", { outcome: "accepted" })).verified, true)
  assert.ok(bare)
  // A readable evidence time that is a Date (a YAML reader may make one) is used too.
  const dated = await delivered(root, "evidence-date")
  await rewrite(dated, (data) => { data.flow.delivered_at = null; data.evidence.recorded_at = new Date(FUTURE) })
  assert.equal((await sign(root, "evidence-date", { outcome: "accepted" })).unverified_because, "same_turn_as_delivery")
})

test("a delivery after the human turn is the same turn, from the flow's time", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "turn-order")
  const deliveredAt = Date.parse((await readFront(file)).data.flow.delivered_at)
  const result = await sign(root, "turn-order", { outcome: "accepted" }, { witness: human({ promptAt: deliveredAt - 1000, stopAt: deliveredAt - 5000 }) })
  assert.equal(result.unverified_because, "same_turn_as_delivery")
  assert.equal(result.unverified_note, "Record the answer in a later turn, after the operator has replied.")
})

// Each reason the witness can give reaches the answer with its code and one thing to do.
const NOTES = {
  no_witness: "Desk found no record of a human turn behind this call, so the answer is kept as unverified. Repeat the call in a later turn on a host where Desk can see the operator's message.",
  subagent: "A subagent must not record the operator's answer. Leave it to the main agent.",
  subagent_not_ruled_out: "Desk could not tell the main agent from a subagent, so the answer is kept as unverified. Repeat the call from the main agent in a later turn, on a host where Desk can see it.",
  not_human_origin: "This turn did not start with a message from the operator. Record the answer after the operator replies.",
  human_origin_unknown: "Desk could not tell whether the operator's message started this turn, so the answer is kept as unverified. Repeat the call in a later turn after the operator replies.",
  no_prompt_since_stop: "No operator message has arrived since you last stopped. Record the answer after the operator replies.",
  same_turn_as_delivery: "Record the answer in a later turn, after the operator has replied.",
}
const WITNESS_FOR = {
  no_witness: nobody,
  subagent: human({ mainAgent: false }),
  subagent_not_ruled_out: human({ mainAgent: null }),
  not_human_origin: human({ humanOrigin: false }),
  human_origin_unknown: human({ humanOrigin: null }),
  no_prompt_since_stop: human({ stopAt: FUTURE }),
  same_turn_as_delivery: human({ promptAt: 1000, stopAt: 0 }),
}

test("each witness reason reaches the answer with its note, and the list is covered", async () => {
  assert.deepEqual(Object.keys(NOTES).sort(), WITNESS_REASONS.filter((reason) => reason !== "witnessed").sort())
  const root = await mkTempDeskRoot()
  for (const [reason, witness] of Object.entries(WITNESS_FOR)) {
    const slug = `reason-${reason.replaceAll("_", "-")}`
    const file = await delivered(root, slug)
    const result = await sign(root, slug, { outcome: "accepted" }, { witness })
    assert.equal(result.verified, false, reason)
    assert.equal(result.unverified_because, reason)
    assert.equal(result.unverified_note, NOTES[reason])
    assert.ok(result.say.endsWith(UNVERIFIED_TAIL), reason)
    assert.equal((await readFront(file)).data.signoff.verified, false, reason)
  }
})

test("threat: the call in the turn that delivered the work is recorded unverified", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "same-turn")
  const deliveredAt = Date.parse((await readFront(file)).data.flow.delivered_at)
  const result = await sign(root, "same-turn", { outcome: "accepted" }, { witness: human({ promptAt: deliveredAt - 1, stopAt: deliveredAt - 100 }) })
  assert.equal(result.status, "signed")
  assert.equal(result.unverified_because, "same_turn_as_delivery")
})

test("threat: no witness (Codex, hooks off) is recorded unverified", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "codex-turn")
  const result = await sign(root, "codex-turn", { outcome: "accepted" }, { witness: nobody })
  assert.equal(result.unverified_because, "no_witness")
})

test("threat: Copilot (the main agent is not proven) is recorded unverified", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "copilot-turn")
  const result = await sign(root, "copilot-turn", { outcome: "accepted" }, { witness: () => ({ promptAt: FUTURE - 60_000, stopAt: FUTURE - 120_000, mainAgent: null, humanOrigin: true }) })
  assert.equal(result.unverified_because, "subagent_not_ruled_out")
})

test("threat: a notification or wake-up that started the turn is recorded unverified", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "wake-up-turn")
  const result = await sign(root, "wake-up-turn", { outcome: "accepted" }, { witness: human({ humanOrigin: false }) })
  assert.equal(result.unverified_because, "not_human_origin")
})

test("a sign-off asks the factory to re-derive the job's sessions", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "re-derive")
  const finalize = spy()
  const env = { HOME: "/nowhere" }
  await sign(root, "re-derive", { outcome: "accepted" }, { finalize: finalize.fn, env })
  assert.equal(finalize.calls.length, 1)
  const [request] = finalize.calls[0]
  assert.equal(request.deskRoot, root)
  assert.equal(request.env, env)
  assert.equal(request.identity.track, "t")
  assert.equal(request.identity.slug, "re-derive")
  assert.match(request.identity.job, /^[0-9a-f]+$/u)
  await delivered(root, "re-derive-no")
  await sign(root, "re-derive-no", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { finalize: finalize.fn })
  assert.equal(finalize.calls.length, 2, "a refusal asks too")
})

test("the default finalize does nothing when the factory is not set up, and a card with no resolvable job still signs", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "default-finalize")
  const result = await taskSignoff({ deskRoot: root, input: { track: "t", slug: "default-finalize", outcome: "accepted" }, witness: human(), now })
  assert.equal(result.status, "signed")
})

test("the signoff status refresh runs after a write with the environment, the desk and the time, and a failure never fails the sign-off", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "refresh-me")
  const refresh = spy()
  const env = { HOME: "/nowhere" }
  await sign(root, "refresh-me", { outcome: "accepted" }, { refreshSignoff: refresh.fn, env })
  assert.equal(refresh.calls.length, 1)
  assert.equal(refresh.calls[0][0], env)
  assert.equal(refresh.calls[0][1], root)
  assert.deepEqual(refresh.calls[0][2], { now: FUTURE })
  const second = await delivered(root, "refresh-fails")
  const errors = mock.method(console, "error", () => {})
  try {
    const result = await sign(root, "refresh-fails", { outcome: "accepted" }, { refreshSignoff: async () => { throw new Error(`boom ${SENTINEL}`) } })
    assert.equal(result.status, "signed")
    assert.equal(errors.mock.calls.some((call) => String(call.arguments[0]) === "desk_factory: signoff_status_refresh_deferred"), true)
    assert.ok(!errors.mock.calls.some((call) => call.arguments.some((arg) => String(arg).includes(SENTINEL))))
  } finally {
    errors.mock.restore()
  }
  assert.equal((await readFront(second)).data.signoff.state, "accepted")
  assert.ok(file)
})

test("on a Git desk the card and the track row are committed together and the answer says so", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await delivered(root, "committed-no")
  const pushes = []
  const result = await sign(root, "committed-no", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { schedulePush: (options) => pushes.push(options) })
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "task_signoff: t/committed-no")
  assert.deepEqual(lastFiles(root), ["t/committed-no/task.md", "t/track.md"])
  assert.equal(result.desk_commit, git(root, "rev-parse", "--short", "HEAD").trim())
  assert.equal(result.desk_pushed, false)
  assert.match(result.desk_note, /^Desk card only: Desk committed this card/)
  assert.deepEqual(Object.keys(result).slice(0, 2), ["status", "desk_note"])
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].root, root)
  assert.equal("commit" in result, false)
})

test("a commit that fails is reported and the sign-off stays written", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "commit-fails")
  const spawnGit = (cmd, args, options) => (args.includes("commit") ? { status: 1, stdout: "", stderr: "commit boom" } : spawnSync(cmd, args, options))
  const result = await sign(root, "commit-fails", { outcome: "accepted" }, { spawnGit })
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal("desk_commit" in result, false)
  assert.equal("desk_note" in result, false)
  assert.equal((await readFront(file)).data.signoff.state, "accepted")
})

test("a card with edits nobody has staged is written and not committed", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "dirty-card")
  await fs.appendFile(file, "\nA line another session left.\n")
  const head = headOf(root)
  const result = await sign(root, "dirty-card", { outcome: "accepted" })
  assert.equal(result.status, "signed")
  assert.equal(headOf(root), head)
  assert.equal("desk_commit" in result, false)
  assert.equal((await readFront(file)).data.signoff.state, "accepted")
})

test("a desk that is not a Git repository gets no commit fields", async () => {
  const root = await mkTempDeskRoot()
  await delivered(root, "no-git-here")
  const result = await sign(root, "no-git-here", { outcome: "accepted" })
  for (const key of ["commit", "desk_commit", "desk_pushed", "desk_note"]) assert.equal(key in result, false, key)
})

test("only the three records, the status and `updated` change; every other byte of the card survives", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "byte-for-byte")
  const before = await body(file)
  await sign(root, "byte-for-byte", { outcome: "accepted" })
  const after = await body(file)
  const keep = (text) => text.split("\n").filter((line) => !/^(updated|signoff|flow|returns):|^ {2}\S+:/u.test(line))
  assert.deepEqual(keep(after), keep(before))
})

test("the answer carries the sentence the agent must say and no card body text, title or path outside the desk", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await delivered(root, "private-one")
  await delivered(root, "private-two")
  await delivered(root, "private-three", { archive: true })
  const answers = [
    await sign(root, "private-one", { outcome: "accepted" }),
    await sign(root, "private-two", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { witness: nobody }),
    await sign(root, "private-three", { outcome: "refused", reason: "other", return_reason: "external" }),
    await sign(root, "private-one", { outcome: "accepted" }),
  ]
  for (const answer of answers) {
    const text = JSON.stringify(answer)
    assert.ok(!text.includes(SENTINEL), "no body text or title")
    assert.ok(!text.includes(root), "no absolute path")
    assert.equal(typeof answer.say, "string")
    assert.ok(answer.say.startsWith("Recorded: ") || answer.say.startsWith("Already recorded: "))
  }
  const errors = []
  for (const input of [{ outcome: "accepted", reason: "defect" }, { outcome: "refused" }]) {
    try { await sign(root, "private-one", input) } catch (error) { errors.push(error.message) }
  }
  try { await sign(root, "gone", { outcome: "accepted" }) } catch (error) { errors.push(error.message) }
  assert.equal(errors.length, 3)
  for (const message of errors) assert.ok(!message.includes(SENTINEL) && !message.includes(root))
})

test("the tool is listed, has a schema whose fields match TASK_SIGNOFF_FIELDS, and dispatches", async () => {
  assert.ok(TOOL_NAMES.includes("task_signoff"))
  assert.equal(TOOL_DESCRIPTIONS.task_signoff, "Record the operator's answer to a delivered task: accepted or refused. Call it only after the operator has answered, in a turn after the one that delivered the work. A refusal needs `reason` (theirs) and `return_reason` (your own reading) and puts the task back to processing. Desk marks the answer verified only when it saw a human turn behind it. A subagent never calls this.")
  const schema = TOOL_INPUT_SCHEMAS.task_signoff
  assert.deepEqual(Object.keys(schema.properties).sort(), [...TASK_SIGNOFF_FIELDS].sort())
  assert.deepEqual(schema.required, ["track", "slug", "outcome"])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.outcome.enum, ["accepted", "refused"])
  assert.deepEqual(schema.properties.reason.enum, REFUSAL_REASONS)
  assert.deepEqual(schema.properties.return_reason.enum, RETURN_REASONS)
  assert.equal(TOOL_IMPLS.task_signoff, taskSignoff)
  const root = await mkTempDeskRoot()
  await delivered(root, "through-dispatch")
  const answer = JSON.parse((await callTool({ deskRoot: root, name: "task_signoff", input: { track: "t", slug: "through-dispatch", outcome: "accepted" } })).content[0].text)
  assert.equal(answer.status, "signed")
  assert.equal(answer.signoff.state, "accepted")
  const refused = await callTool({ deskRoot: root, name: "task_signoff", input: { track: "t", slug: "through-dispatch" } })
  assert.equal(refused.isError, true)
})

const read = (relative) => readFileSync(path.join(REPO, relative), "utf8")

test("every place that lists the tools lists task_signoff", () => {
  assert.match(read("plugins/desk/mcp/bootstrap.cjs"), /"task_focus", "task_signoff"/u)
  assert.ok(JSON.parse(read("plugins/desk/.mcp.json")) && read("plugins/desk/.mcp.json").includes("'task_signoff'"))
  assert.ok(read("scripts/test-desk-docs.cjs").includes('"task_signoff"'))
  assert.ok(read("scripts/audit-codex-plugin-cache.cjs").includes('"task_signoff"'))
  assert.ok(read("plugins/desk/mcp/README.md").includes("`task_signoff`"))
  for (const host of ["claude", "copilot"]) assert.ok(deferredToolsLoadHint(host).includes("task_signoff"), host)
  assert.equal(toolKind({ host: "copilot-cli", name: "desk-task_signoff" }), "desk")
  assert.equal(toolKind({ host: "claude-code", name: "mcp__plugin_desk_desk__task_signoff" }), "desk")
  assert.equal(isTaskToolName("desk-task_signoff"), true)
  assert.equal(mcpToolName("desk-task_signoff"), "mcp__desk__task_signoff")
})

test("a clock that gives no usable time is refused and nothing is written", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "bad-clock")
  const before = await body(file)
  await assert.rejects(sign(root, "bad-clock", { outcome: "accepted" }, { now: () => 8.64e15 }), /task_signoff: the time is not an ISO time/)
  assert.equal(await body(file), before)
})

// ── fix round 1 ─────────────────────────────────────────────────────────────

const deliveredMs = async (file) => Date.parse((await readFront(file)).data.flow.delivered_at)

test("a prompt in the same clock second as the delivery is the same turn, and one in the next second is a later turn", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "same-second")
  const stored = await deliveredMs(file)
  assert.equal(stored % 1000, 0, "the card keeps the delivery to the whole second")
  const at = (offset) => human({ promptAt: stored + offset, stopAt: stored - 5000 })
  // A prompt 137 ms before a delivery that landed 500 ms into the second, and one after its true time: both unverified.
  for (const [slug, offset] of [["second-before", 363], ["second-after", 700], ["second-end", 999]]) {
    if (slug !== "second-before") await delivered(root, slug)
    const result = await sign(root, slug === "second-before" ? "same-second" : slug, { outcome: "accepted" }, { witness: at(offset) })
    assert.equal(result.unverified_because, "same_turn_as_delivery", slug)
    assert.equal(result.verified, false)
  }
  const next = await delivered(root, "next-second")
  const later = await sign(root, "next-second", { outcome: "accepted" }, { witness: human({ promptAt: (await deliveredMs(next)) + 1000, stopAt: 0 }) })
  assert.equal(later.verified, true)
})

test("a delivery time that carries milliseconds is used as it is", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "with-millis")
  await rewrite(file, (data) => { data.flow.delivered_at = "2026-10-05T10:00:00.250Z" })
  const base = Date.parse("2026-10-05T10:00:00.250Z")
  const ok = await sign(root, "with-millis", { outcome: "accepted" }, { witness: human({ promptAt: base + 1, stopAt: base - 1000 }) })
  assert.equal(ok.verified, true)
})

test("a witness that carries its own delivery time does not override the card's", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "own-time")
  const stored = await deliveredMs(file)
  const result = await sign(root, "own-time", { outcome: "accepted" }, { witness: human({ promptAt: stored + 500, stopAt: stored - 1000, deliveredAt: 1 }) })
  assert.equal(result.unverified_because, "same_turn_as_delivery")
})

test("a refusal refreshes the signoff status too, and `updated` is written in whole seconds", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "refresh-refusal")
  const refresh = spy()
  await sign(root, "refresh-refusal", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { refreshSignoff: refresh.fn })
  assert.equal(refresh.calls.length, 1)
  assert.match((await readFront(file)).data.updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u)
})

// The production witness: no `witness` is injected, so these go through `witnessFor` with the environment the host gives.

async function realWitnessDesk(slug, hostEnv) {
  const root = await mkTempDeskRoot()
  const state = await mkTempDeskRoot()
  const env = { HOME: state, XDG_STATE_HOME: state, ...hostEnv }
  const file = await delivered(root, slug)
  return { root, env, stateDir: resolveDeskStateDir({ env }), file, at: (await deliveredMs(file)) + 10_000 }
}

const humanLine = (at) => JSON.stringify({ type: "user", timestamp: new Date(at).toISOString(), promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, message: { role: "user", content: "yes, accepted" } })
const callLineFor = (at, id) => JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id, name: "mcp__desk__task_signoff", input: {} }] } })

test("through the server with no witness injected and no ticket, the answer and the card say unverified", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "default-dispatch")
  const answer = JSON.parse((await callTool({ deskRoot: root, name: "task_signoff", input: { track: "t", slug: "default-dispatch", outcome: "accepted" } })).content[0].text)
  assert.equal(answer.status, "signed")
  assert.equal(answer.verified, false)
  assert.equal(answer.unverified_because, "no_witness")
  assert.equal(answer.signoff.verified, false)
  assert.equal((await readFront(file)).data.signoff.verified, false)
})

test("the production witness verifies a call that has a real ticket from the hook", async () => {
  const { root, env, stateDir, file, at } = await realWitnessDesk("real-ticket", { CLAUDECODE: "1" })
  const transcript = path.join(env.HOME, "transcript.jsonl")
  await fs.writeFile(transcript, [humanLine(at), callLineFor(at + 1000, "toolu_real")].join("\n") + "\n")
  recordPrompt({ session_id: "s1" }, { stateDir, now: () => at })
  issueTicket({ hook_event_name: "PreToolUse", session_id: "s1", transcript_path: transcript, tool_use_id: "toolu_real", tool_input: { track: "t", slug: "real-ticket", outcome: "accepted" } }, { env, stateDir, now, clock: () => 0, sleep: () => {} })
  const result = await taskSignoff({ deskRoot: root, input: { track: "t", slug: "real-ticket", outcome: "accepted" }, env, now, finalize: async () => {}, refreshSignoff: async () => {}, schedulePush: () => {} })
  assert.equal(result.verified, true)
  assert.equal(result.say, "Recorded: real-ticket accepted.")
  assert.equal((await readFront(file)).data.signoff.verified, true)
})

test("the production witness on Copilot is always unverified, because the main agent is not proven", async () => {
  const { root, env, stateDir, file, at } = await realWitnessDesk("real-copilot", { COPILOT_AGENT_SESSION_ID: "cs1" })
  const home = path.join(env.HOME, "copilot")
  await fs.mkdir(path.join(home, "session-state", "cs1"), { recursive: true })
  await fs.writeFile(path.join(home, "session-state", "cs1", "events.jsonl"), JSON.stringify({ type: "user.message", data: { content: "yes" } }) + "\n")
  recordStop({ session_id: "cs1" }, { stateDir, now: () => at - 5000 })
  recordPrompt({ session_id: "cs1" }, { stateDir, now: () => at })
  const result = await taskSignoff({ deskRoot: root, input: { track: "t", slug: "real-copilot", outcome: "accepted" }, env: { ...env, COPILOT_HOME: home }, now, finalize: async () => {}, refreshSignoff: async () => {}, schedulePush: () => {} })
  assert.equal(result.verified, false)
  assert.equal(result.unverified_because, "subagent_not_ruled_out")
  assert.equal((await readFront(file)).data.signoff.verified, false)
})

test("with nothing injected, a sign-off refreshes status.json.signoff from the desk as it now stands", async () => {
  const { readStatus } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  const root = await mkTempDeskRoot()
  await delivered(root, "counted-one")
  await delivered(root, "counted-two")
  const stateHome = await fs.mkdtemp(path.join(path.dirname(root), "signoff-state-"))
  const env = { HOME: stateHome, XDG_STATE_HOME: stateHome }
  const result = await taskSignoff({ deskRoot: root, input: { track: "t", slug: "counted-one", outcome: "accepted" }, env, now, finalize: async () => {}, schedulePush: () => {} })
  assert.equal(result.status, "signed")
  const { signoff } = await readStatus(env)
  assert.deepEqual(signoff.unsigned, { state: "measured", value: 1 })
})
