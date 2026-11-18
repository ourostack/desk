// task_signoff, continued: the same suite as task_signoff.test.js, split so no single file sets a Windows shard's time.

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

test("a done card holding a refusal answers unchanged to the same refusal", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "hand-built")
  await rewrite(file, (data) => { data.signoff = { state: "refused", at: "2026-10-05T11:00:00.000Z", reason: "defect" } })
  const before = await body(file)
  const result = await sign(root, "hand-built", { outcome: "refused", reason: "other", return_reason: "external" })
  assert.equal(result.status, "unchanged")
  assert.equal(result.say, "Already recorded: hand-built sent back.")
  assert.equal(await body(file), before)
})

test("an old-shape card whose signoff block has verified: true still reads, and a repeated same answer is unchanged and keeps the block", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await delivered(root, "old-shape")
  const old = { state: "accepted", at: "2026-10-05T11:00:00.000Z", verified: true, reason: null }
  await rewrite(file, (data) => { data.signoff = old })
  settle(root)
  const before = await body(file)
  const head = headOf(root)
  const finalize = spy()
  const result = await sign(root, "old-shape", { outcome: "accepted" }, { finalize: finalize.fn })
  assert.equal(result.status, "unchanged")
  assert.equal(result.say, "Already recorded: old-shape accepted.")
  assert.equal(await body(file), before)
  assert.equal(headOf(root), head)
  assert.equal(finalize.calls.length, 0)
  assert.deepEqual((await readFront(file)).data.signoff, old)
  const refused = await delivered(root, "old-shape-no")
  await rewrite(refused, (data) => { data.signoff = { state: "refused", at: "2026-10-05T11:00:00.000Z", verified: false, reason: "defect" } })
  const held = await body(refused)
  assert.equal((await sign(root, "old-shape-no", { outcome: "refused", reason: "defect", return_reason: "agent_error" })).status, "unchanged")
  assert.equal(await body(refused), held)
})

test("a different outcome replaces the answer already held", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "changed-mind")
  await sign(root, "changed-mind", { outcome: "accepted" })
  assert.equal((await readFront(file)).data.signoff.state, "accepted")
  const result = await sign(root, "changed-mind", { outcome: "refused", reason: "defect", return_reason: "agent_error" })
  assert.equal(result.status, "signed")
  const { data } = await readFront(file)
  assert.equal(data.status, "processing")
  assert.deepEqual(data.signoff, { state: "refused", at: AT, reason: "defect" })
  assert.equal(data.returns.length, 1)
  const old = await delivered(root, "changed-mind-old")
  await rewrite(old, (data) => { data.signoff = { state: "refused", at: "2026-10-05T11:00:00.000Z", verified: true, reason: "defect" } })
  const accepted = await sign(root, "changed-mind-old", { outcome: "accepted" })
  assert.equal(accepted.status, "signed")
  assert.deepEqual((await readFront(old)).data.signoff, { state: "accepted", at: AT, reason: null })
})

test("parseReturn reads the five-part, the six-part and the old seven-part line", () => {
  const base = `${AT} done processing agent_error after_delivery`
  assert.deepEqual(parseReturn(base), { at: AT, from: "done", to: "processing", reason: "agent_error", caught: "after_delivery", refusal: null, refusal_verified: null })
  assert.deepEqual(parseReturn(`${base} refused=defect`), { at: AT, from: "done", to: "processing", reason: "agent_error", caught: "after_delivery", refusal: "defect", refusal_verified: null })
  assert.equal(parseReturn(`${base} refused=defect verified`).refusal_verified, true)
  assert.equal(parseReturn(`${base} refused=defect unverified`).refusal_verified, false)
  assert.equal(parseReturn(`${base} refused=defect maybe`), null)
})

test("a legacy done task can be accepted and its flow record starts as adopted", async () => {
  const root = await mkTempDeskRoot()
  const file = await legacyDone(root, "before-records")
  const result = await sign(root, "before-records", { outcome: "accepted" })
  assert.equal(result.status, "signed")
  const { data } = await readFront(file)
  assert.equal(data.flow.since, "adopted")
  assert.equal(data.signoff.state, "accepted")
  assert.equal("verified" in data.signoff, false)
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
  const result = await taskSignoff({ deskRoot: root, input: { track: "t", slug: "default-finalize", outcome: "accepted" }, now })
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
  assert.deepEqual(notCommitted(result.commit), { status: "failed", reason: "commit boom" })
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
    await sign(root, "private-two", { outcome: "refused", reason: "defect", return_reason: "agent_error" }),
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
  assert.ok(TOOL_DESCRIPTIONS.task_signoff.startsWith("Record the operator's answer to a delivered task: accepted or refused. Call it only after the operator has answered, in a turn after the one that delivered the work. A refusal needs `reason` (theirs) and `return_reason` (your own reading) and puts the task back to processing."))
  assert.ok(!/witness/iu.test(TOOL_DESCRIPTIONS.task_signoff))
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

test("every place that lists the tools lists task_signoff", () => {
  assert.match(read("plugins/desk/mcp/bootstrap.cjs"), /"task_focus", "task_signoff"/u)
  assert.ok(JSON.parse(read("plugins/desk/.mcp.claude-codex.json")) && read("plugins/desk/.mcp.claude-codex.json").includes("'task_signoff'"))
  assert.ok(read("scripts/test-desk-docs.cjs").includes('"task_signoff"'))
  assert.ok(read("plugins/desk/mcp/README.md").includes("`task_signoff`"))
  for (const host of ["claude", "copilot"]) assert.ok(deferredToolsHint(host).includes("task_signoff"), host)
  assert.equal(toolKind({ host: "copilot-cli", name: "desk-task_signoff" }), "desk")
  assert.equal(toolKind({ host: "claude-code", name: "mcp__plugin_desk_desk__task_signoff" }), "desk")
})

test("a clock that gives no usable time is refused and nothing is written", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "bad-clock")
  const before = await body(file)
  await assert.rejects(sign(root, "bad-clock", { outcome: "accepted" }, { now: () => 8.64e15 }), /task_signoff: outcome: Pass the time as an ISO time/)
  assert.equal(await body(file), before)
})


test("a refusal refreshes the signoff status too, and `updated` is written in whole seconds", async () => {
  const root = await mkTempDeskRoot()
  const file = await delivered(root, "refresh-refusal")
  const refresh = spy()
  await sign(root, "refresh-refusal", { outcome: "refused", reason: "defect", return_reason: "agent_error" }, { refreshSignoff: refresh.fn })
  assert.equal(refresh.calls.length, 1)
  assert.match((await readFront(file)).data.updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u)
})


test("with nothing injected, a sign-off refreshes status.json.signoff from the desk as it now stands", async () => {
  const { readStatus } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  const root = await mkTempDeskRoot()
  await delivered(root, "counted-one")
  await delivered(root, "counted-two")
  const stateHome = await fs.mkdtemp(path.join(path.dirname(root), "signoff-state-"))
  const env = osEnv({ HOME: stateHome, XDG_STATE_HOME: stateHome })
  const result = await taskSignoff({ deskRoot: root, input: { track: "t", slug: "counted-one", outcome: "accepted" }, env, now, finalize: async () => {}, schedulePush: () => {} })
  assert.equal(result.status, "signed")
  const { signoff } = await readStatus(env)
  assert.deepEqual(signoff.unsigned, { state: "measured", value: 1 })
})
