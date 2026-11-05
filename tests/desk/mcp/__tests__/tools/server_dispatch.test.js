// server_dispatch — sanity-check that server.callTool routes every tool
// to its real implementation (no remaining stubs after Unit 6).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { PassThrough } from "node:stream"
import { callTool, createMcpServer, createMcpTransport, startServer, TOOL_IMPLS } from "../../../../../plugins/desk/mcp/src/server.js"
import { startFrontDoor } from "../../../../../plugins/desk/mcp/src/runtime/front-door.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../../plugins/desk/mcp/src/tool-schemas.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { cleanup, mkFeedbackFixture, useStateHome } from "../factory/_private_state_helpers.js"

// The surface as it was advertised while the private feedback API was still
// registered. Retiring that API has to remove exactly one name from this list
// and leave the other routes — person-scoped writes and private measurement
// included — exactly where they were.
const SURFACE_BEFORE_FEEDBACK_RETIREMENT = [
  "task_create",
  "task_update",
  "task_archive",
  "task_move",
  "task_focus",
  "task_signoff",
  "track_create",
  "track_update",
  "track_rename",
  "friction_add",
  "lesson_add",
  "desk_save",
  "desk_feedback",
  "desk_work_ledger",
  "desk_search",
  "desk_recall",
  "desk_similar",
  "desk_timeline",
  "desk_thread",
  "desk_reindex",
  "desk_status",
  "desk_doctor",
]

// The manual work-measurement ledger retired when the factory started
// accounting for finished jobs automatically (M3-12).
const RETIRED_PRIVATE_TOOLS = ["desk_feedback", "desk_work_ledger"]

function parseResult(res) {
  return JSON.parse(res.content[0].text)
}

/** Register the real list/call handlers against a caller-supplied server double. */
async function liveHandlers({ deskRoot, person = null }) {
  const handlers = []
  const transport = { kind: "fake-stdio" }
  const server = {
    setRequestHandler(schema, handler) {
      handlers.push(handler)
    },
    async connect(received) {
      assert.equal(received, transport)
    },
  }
  await startServer({ deskRoot, person, server, transport })
  assert.equal(handlers.length, 2)
  return { list: handlers[0], call: handlers[1] }
}

/** Content hash of every file under `dir`, so preserved bytes can be compared. */
async function hashedTree(dir) {
  const hashes = {}
  let entries
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return hashes
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    hashes[path.relative(dir, file)] = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex")
  }
  return hashes
}

test("server.callTool routes task_create to the real implementation", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_create",
    input: { track: "t", slug: "book-flights", title: "T" },
  })
  assert.ok(!res.isError)
  const body = parseResult(res)
  assert.equal(body.status, "created")
  assert.equal(body.path, path.posix.join("t", "book-flights", "task.md"))
})

test("server.callTool routes task_move to the real implementation", async () => {
  const root = await mkTempDeskRoot()
  await callTool({
    deskRoot: root,
    name: "task_create",
    input: { track: "some-track", slug: "book-flights", title: "T" },
  })
  const res = await callTool({
    deskRoot: root,
    name: "task_move",
    input: { track: "some-track", slug: "book-flights", to_slug: "book-flights-now" },
  })
  assert.ok(!res.isError)
  const body = parseResult(res)
  assert.equal(body.to, path.posix.join("some-track", "book-flights-now"))
})

test("server.callTool routes track_rename to the real implementation", async () => {
  const root = await mkTempDeskRoot()
  await callTool({
    deskRoot: root,
    name: "track_create",
    input: { slug: "old-track", title: "T", scope: "fixture scope; not anything else" },
  })
  const res = await callTool({
    deskRoot: root,
    name: "track_rename",
    input: { track: "old-track", to: "new-track" },
  })
  assert.ok(!res.isError)
  const body = parseResult(res)
  assert.equal(body.to, "new-track")
})

test("server.callTool surfaces tool errors as isError with structured body", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_update",
    input: { track: "nope", slug: "nada", frontmatter: { status: "paused" } },
  })
  assert.ok(res.isError, "missing-task should surface as isError")
  const body = parseResult(res)
  assert.equal(body.status, "error")
  assert.match(body.message, /does not exist/)
  assert.deepEqual(body.effects, { status: "unknown", readback_required: true })
  assert.doesNotMatch(body.fix, /Retry the call/u)
})

test("server.callTool preserves a real desk_save partial write without advising blind retry", async t => {
  const root = await mkTempDeskRoot()
  t.diagnostic(`Owned fixture: ${root}; removed by the exact-root registry at file teardown.`)
  const open = fs.open
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file === path.join(root, "later.md")) throw new Error("owned later write failure")
    return open(file, ...args)
  })
  const result = await callTool({
    deskRoot: root, name: "desk_save",
    input: { files: [{ path: "notes.md", content: "applied\n" }, { path: "later.md", content: "later\n" }], message: "save" },
  })
  assert.equal(result.isError, true)
  assert.deepEqual(parseResult(result).effects, {
    status: "partial", applied_paths: ["notes.md"], uncertain_paths: ["later.md"], readback_required: true,
  })
  assert.doesNotMatch(parseResult(result).fix, /Retry the call/u)
  assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "applied\n")
  await assert.rejects(fs.stat(path.join(root, "later.md")), { code: "ENOENT" })
})

test("server.callTool requires readback for returned failures and preserves refusal and success responses", async () => {
  const original = TOOL_IMPLS.desk_save
  try {
    for (const result of [
      { status: "updated", commit: { status: "failed", reason: "commit failed" } },
      { status: "failed", effects: { status: "partial", applied_paths: ["notes.md"], readback_required: true } },
      { status: "failed", effects: { status: "partial", applied_paths: ["notes.md"], uncertain_paths: ["later.md"], operation: "owned write" } },
      { status: "failed", commit: { status: "failed", effects: {
        status: "unknown", readback_required: true,
        readback: { head_before: null, head_after: null, attribution: "unverified" },
      } } },
      { status: "refused", code: "authority" },
      { status: "committed" },
    ]) {
      TOOL_IMPLS.desk_save = async () => result
      const body = parseResult(await callTool({ deskRoot: await mkTempDeskRoot(), name: "desk_save", input: {} }))
      if (result.status === "refused" || result.status === "committed") assert.deepEqual(body, result)
      else {
        assert.deepEqual(body.effects, { ...(result.effects ?? result.commit?.effects ?? { status: "unknown" }), readback_required: true })
        assert.match(body.fix, /Read back/u)
        assert.doesNotMatch(body.fix, /Retry the call/u)
      }
    }
  } finally {
    TOOL_IMPLS.desk_save = original
  }
})

for (const frontDoor of [false, true]) test(`an actual lost desk_save commit response retains both effect receipts through ${frontDoor ? "stdio" : "server"} dispatch`, async t => {
  const root = await mkTempDeskRoot()
  t.diagnostic(`Owned fixture: ${root}; removed by the exact-root registry at file teardown.`)
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git("init", "-q")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.com")
  await fs.writeFile(path.join(root, "notes.md"), "before\n")
  git("add", "notes.md")
  git("commit", "-qm", "seed")
  const before = git("rev-parse", "HEAD")
  await fs.writeFile(path.join(root, "unrelated.md"), "outside staged bytes\n")
  git("add", "unrelated.md")
  const index = git("ls-files", "-s", "--", "unrelated.md")
  const original = TOOL_IMPLS.desk_save
  let commits = 0
  TOOL_IMPLS.desk_save = args => original({
    ...args,
    schedulePush: () => assert.fail("uncertain commit must not push"),
    spawnGit(command, gitArgs, options) {
      const result = spawnSync(command, gitArgs, options)
      if (gitArgs[2] !== "commit") return result
      commits++
      assert.equal(result.status, 0, result.stderr)
      return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("lost response"), { code: "ETIMEDOUT" }) }
    },
  })
  let response
  const values = { files: [{ path: "notes.md", content: "after\n" }], message: "save" }
  try {
    if (frontDoor) {
      const input = new PassThrough(), output = new PassThrough()
      let wire = ""
      output.on("data", chunk => { wire += chunk.toString("utf8") })
      const door = startFrontDoor({
        input, output, callTool: ({ name, input: toolInput, signal }) => callTool({ deskRoot: root, name, input: toolInput, signal }),
      })
      input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desk_save", arguments: values } })}\n`)
      await door.closed
      response = JSON.parse(wire).result
    } else {
      response = await callTool({ deskRoot: root, name: "desk_save", input: values })
    }
  } finally {
    TOOL_IMPLS.desk_save = original
  }
  const body = parseResult(response)
  assert.equal(body.status, "failed")
  assert.equal(commits, 1)
  assert.deepEqual(body.effects, { status: "partial", applied_paths: ["notes.md"], readback_required: true })
  assert.deepEqual(body.commit.effects, {
    status: "unknown", readback_required: true,
    readback: { head_before: before, head_after: git("rev-parse", "HEAD"), attribution: "unverified" },
  })
  assert.doesNotMatch(body.fix, /Retry the call/u)
  assert.equal(git("show", "HEAD:notes.md"), "after")
  assert.equal(git("show", "--format=", "--name-only", "HEAD"), "notes.md")
  assert.equal(git("ls-files", "-s", "--", "unrelated.md"), index)
})

test("server.callTool routes desk_thread to the real implementation", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "desk_thread",
    input: { start_path: "nope/does/not/exist.md" },
  })
  // No isError: before the session's search engine starts, desk_thread says search is starting.
  const body = parseResult(res)
  assert.equal(body.status, "error")
  assert.equal(body.code, "search_starting")
})

test("server.callTool rejects unknown tool names", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "this_does_not_exist",
    input: {},
  })
  assert.ok(res.isError)
  assert.match(res.content[0].text, /unknown tool/)
})

// Unit 1.2c: the unknown-tool + error branches must still behave with a
// `person` present on the dispatch call (the new threaded field).

test("server.callTool rejects unknown tool names even with person set", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "this_does_not_exist",
    input: {},
    person: "ari",
  })
  assert.ok(res.isError)
  assert.match(res.content[0].text, /unknown tool/)
})

test("server.callTool reports registered tools missing from the implementation table", async () => {
  const root = await mkTempDeskRoot()
  const original = TOOL_IMPLS.desk_status
  delete TOOL_IMPLS.desk_status
  try {
    const res = await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    })
    const body = JSON.parse(res.content[0].text)
    assert.equal(body.status, "not_implemented")
    assert.equal(body.tool, "desk_status")
    assert.match(body.note, /wiring bug/)
  } finally {
    TOOL_IMPLS.desk_status = original
  }
})

test("server.callTool surfaces tool errors as isError with person set", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_update",
    input: { track: "nope", slug: "nada", frontmatter: { status: "paused" } },
    person: "ari",
  })
  assert.ok(res.isError)
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.status, "error")
  assert.match(body.message, /does not exist/)
})

test("server.callTool surfaces non-Error throws as string messages", async () => {
  const root = await mkTempDeskRoot()
  const original = TOOL_IMPLS.task_create
  TOOL_IMPLS.task_create = async () => {
    throw "string boom"
  }
  try {
    const res = await callTool({
      deskRoot: root,
      name: "task_create",
      input: {},
    })
    assert.ok(res.isError)
    const body = JSON.parse(res.content[0].text)
    assert.equal(body.status, "error")
    assert.equal(body.message, "string boom")
  } finally {
    TOOL_IMPLS.task_create = original
  }
})

test("server.callTool defaults omitted input to an empty object", async () => {
  const root = await mkTempDeskRoot()
  let received
  const original = TOOL_IMPLS.task_create
  TOOL_IMPLS.task_create = async (arg) => {
    received = arg
    return { status: "probed" }
  }
  try {
    const res = await callTool({
      deskRoot: root,
      name: "task_create",
    })
    assert.equal(res.isError, undefined)
    assert.deepEqual(received.input, {})
  } finally {
    TOOL_IMPLS.task_create = original
  }
})

test("server.callTool hands a tool the session's search engine, or null without one", async () => {
  const root = await mkTempDeskRoot()
  let received
  const original = TOOL_IMPLS.task_create
  TOOL_IMPLS.task_create = async (arg) => {
    received = arg
    return { status: "probed" }
  }
  try {
    const res = await callTool({
      deskRoot: root,
      name: "task_create",
      input: {},
      statusContext: {},
    })
    assert.equal(res.isError, undefined)
    assert.equal(received.search, null)
    const engine = { lexical: async () => ({}) }
    await callTool({ deskRoot: root, name: "task_create", input: {}, statusContext: { search: engine } })
    assert.equal(received.search, engine)
    assert.equal(received.queryRouter, engine)
  } finally {
    TOOL_IMPLS.task_create = original
  }
})

test("server.callTool routes a person-scoped write end-to-end (path shows desks/<alias>/)", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_create",
    input: { track: "t", slug: "book-flights", title: "T" },
    person: "ari",
  })
  assert.ok(!res.isError)
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.status, "created")
  assert.equal(body.path, path.posix.join("desks", "ari", "t", "book-flights", "task.md"))
})

test("server.callTool surfaces an invalid-alias throw as isError", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_create",
    input: { track: "t", slug: "s", title: "T" },
    person: "../evil",
  })
  assert.ok(res.isError)
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.status, "error")
  assert.match(body.message, /alias/i)
})

test("server.startServer registers list/call handlers and forwards status context", async () => {
  const root = await mkTempDeskRoot()
  const handlers = []
  const transport = { kind: "fake-stdio" }
  const server = {
    setRequestHandler(schema, handler) {
      handlers.push({ schema, handler })
    },
    async connect(receivedTransport) {
      assert.equal(receivedTransport, transport)
    },
  }
  const statusContext = {
    root: { source: "unit-test", tried: [{ source: "unit-test", path: root }] },
    runtime: { runtime_cache_dir: "/tmp/runtime", source_mirror_path: "/tmp/runtime/source-mirror/hash" },
  }

  await startServer({ deskRoot: root, person: "ari", statusContext, server, transport })

  assert.equal(handlers.length, 2)
  const listed = await handlers[0].handler()
  assert.ok(listed.tools.some((tool) => tool.name === "desk_status"))
  // Every listed tool carries its declared schema, never the empty permissive one.
  for (const tool of listed.tools) assert.equal(tool.inputSchema, TOOL_INPUT_SCHEMAS[tool.name])

  const called = await handlers[1].handler({
    params: {
      name: "desk_status",
      arguments: {},
    },
  })
  const body = JSON.parse(called.content[0].text)
  assert.equal(body.root.source, "unit-test")
  assert.equal(body.runtime.runtime_cache_dir, "/tmp/runtime")
  assert.equal(body.runtime.loaded_from_source_mirror, true)
  assert.deepEqual(body.write_scope, {
    mode: "person",
    person: "ari",
    relative_path: "desks/ari",
  })

  const defaultArgs = await handlers[1].handler({
    params: {
      name: "desk_status",
    },
  })
  const defaultArgsBody = JSON.parse(defaultArgs.content[0].text)
  assert.equal(defaultArgsBody.status, "ok")

  const missingParams = await handlers[1].handler({})
  assert.ok(missingParams.isError)
  assert.match(missingParams.content[0].text, /unknown tool/)
})

test("server.startServer can construct its default transport", async () => {
  const root = await mkTempDeskRoot()
  const server = {
    setRequestHandler() {},
    async connect(receivedTransport) {
      assert.equal(typeof receivedTransport, "object")
    },
  }
  await startServer({ deskRoot: root, server })
})

test("server.startServer can construct server and transport through injected factories", async () => {
  const root = await mkTempDeskRoot()
  const transport = { kind: "factory-transport" }
  const server = {
    setRequestHandler() {},
    async connect(receivedTransport) {
      assert.equal(receivedTransport, transport)
    },
  }
  await startServer({
    deskRoot: root,
    createServer: () => server,
    createTransport: () => transport,
  })
})

test("server MCP factory helpers construct default SDK instances", () => {
  assert.equal(typeof createMcpServer().setRequestHandler, "function")
  assert.equal(typeof createMcpTransport(), "object")
})

// ── Retired private feedback API ────────────────────────────────────────────
//
// `desk_feedback` is gone from the advertised surface. What must NOT happen is
// a quiet migration: the participant's preserved private records stay exactly
// where they are, byte-for-byte, and a call to the retired name is refused by
// the ordinary unknown-tool path before any feedback storage is opened or
// created.

test("the live server advertises neither retired private tool", async () => {
  const fixture = await mkFeedbackFixture()
  try {
    const { list } = await liveHandlers({ deskRoot: fixture.deskRoot, person: "ari" })
    const listed = await list()
    const advertised = listed.tools.map((tool) => tool.name)

    assert.equal(listed.tools.some((tool) => tool.name === "desk_feedback"), false)
    assert.equal(listed.tools.some((tool) => tool.name === "desk_work_ledger"), false)
    const kept = SURFACE_BEFORE_FEEDBACK_RETIREMENT.filter((name) => !RETIRED_PRIVATE_TOOLS.includes(name))
    // The teammate-note tools sit with the other writes, after desk_save.
    const afterSave = kept.indexOf("desk_save") + 1
    const expected = [...kept.slice(0, afterSave), "note_leave", "note_ack", ...kept.slice(afterSave), "desk_skill", "improvement_open", "improvement_next", "improvement_update"]
    assert.equal(
      listed.tools.length,
      expected.length,
      `expected exactly the retired private tools to be gone; advertised: ${advertised.join(", ")}`,
    )
    assert.deepEqual(advertised, expected)
    for (const tool of listed.tools) {
      assert.equal(typeof tool.description, "string")
      assert.notEqual(tool.description, "")
      assert.doesNotMatch(tool.description, /work[- ]ledger|work-measurement/iu)
    }
  } finally {
    await cleanup(fixture.base)
  }
})

test("calling desk_feedback is refused without opening or creating feedback storage", async () => {
  const preserved = await mkFeedbackFixture()
  const restore = useStateHome(preserved.stateHome)
  try {
    // Preserved private bytes from the retired store: never migrated anywhere by this change.
    const retained = path.join(preserved.stateHome, "ouroboros-skills", "desk", "feedback", "0123456789abcdef0123456789abcdef")
    await fs.mkdir(retained, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(retained, "feedback.sqlite"), "retained private bytes", { mode: 0o600 })
    const beforePrivateFiles = await hashedTree(preserved.stateHome)
    assert.ok(
      Object.keys(beforePrivateFiles).length > 0,
      "the fixture must actually hold preserved private bytes",
    )

    const { call } = await liveHandlers({ deskRoot: preserved.deskRoot, person: "ari" })
    for (const args of [
      { action: "list" },
      { action: "capture", text: "written after retirement" },
      { action: "delete", entry_id: "entry-1" },
    ]) {
      const refused = await call({ params: { name: "desk_feedback", arguments: args } })
      assert.equal(refused.isError, true)
      assert.equal(refused.content[0].text, "unknown tool: desk_feedback")
    }

    const afterPrivateFiles = await hashedTree(preserved.stateHome)
    assert.deepEqual(afterPrivateFiles, beforePrivateFiles)
    assert.deepEqual(TOOL_IMPLS.desk_feedback, undefined)

    // A binding with no store yet must not gain one from the refusal.
    const fresh = await mkFeedbackFixture()
    const restoreFresh = useStateHome(fresh.stateHome)
    try {
      const freshCall = (await liveHandlers({ deskRoot: fresh.deskRoot, person: "rowan" })).call
      const refused = await freshCall({
        params: { name: "desk_feedback", arguments: { action: "capture", text: "no store, please" } },
      })
      assert.equal(refused.isError, true)
      await assert.rejects(() => fs.stat(fresh.stateHome), /ENOENT/u)
    } finally {
      restoreFresh()
      await cleanup(fresh.base)
    }
  } finally {
    restore()
    await cleanup(preserved.base)
  }
})

test("person scoping survives both private-tool retirements", async () => {
  const fixture = await mkFeedbackFixture()
  const restore = useStateHome(fixture.stateHome)
  try {
    const { call } = await liveHandlers({ deskRoot: fixture.deskRoot, person: "rowan" })

    const written = await call({
      params: { name: "task_create", arguments: { track: "t", slug: "book-flights", title: "T" } },
    })
    assert.equal(written.isError, undefined)
    assert.equal(parseResult(written).path, path.posix.join("desks", "rowan", "t", "book-flights", "task.md"))
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})

// ── Retired manual work ledger ──────────────────────────────────────────────
//
// `desk_work_ledger` is gone. A retained private partition under the legacy
// `work-ledger/` state path stays exactly where it is, byte-for-byte: a call to
// the retired name is refused by the ordinary unknown-tool path before any
// storage is opened, created, migrated or removed.

test("calling desk_work_ledger is refused without touching retained ledger partitions", async () => {
  const preserved = await mkFeedbackFixture()
  const restore = useStateHome(preserved.stateHome)
  try {
    const partition = path.join(preserved.stateHome, "ouroboros-skills", "desk", "work-ledger", "0123456789abcdef0123456789abcdef")
    await fs.mkdir(partition, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(partition, "work-ledger.sqlite"), "retained private bytes", { mode: 0o600 })
    const before = await hashedTree(preserved.stateHome)

    const { call } = await liveHandlers({ deskRoot: preserved.deskRoot, person: "ari" })
    for (const args of [{ action: "capabilities" }, { action: "report" }, { action: "delete", work_item_id: "x", confirm: true }]) {
      const refused = await call({ params: { name: "desk_work_ledger", arguments: args } })
      assert.equal(refused.isError, true)
      assert.equal(refused.content[0].text, "unknown tool: desk_work_ledger")
    }
    assert.deepEqual(await hashedTree(preserved.stateHome), before)
    assert.equal(TOOL_IMPLS.desk_work_ledger, undefined)

    // A binding with no state yet must not gain any from the refusal.
    const fresh = await mkFeedbackFixture()
    const restoreFresh = useStateHome(fresh.stateHome)
    try {
      const refused = await (await liveHandlers({ deskRoot: fresh.deskRoot, person: "rowan" })).call({
        params: { name: "desk_work_ledger", arguments: { action: "intake", request: "r", requested_by: "operator" } },
      })
      assert.equal(refused.isError, true)
      await assert.rejects(() => fs.stat(fresh.stateHome), /ENOENT/u)
    } finally {
      restoreFresh()
      await cleanup(fresh.base)
    }
  } finally {
    restore()
    await cleanup(preserved.base)
  }
})
