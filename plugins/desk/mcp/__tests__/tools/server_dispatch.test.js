// server_dispatch — sanity-check that server.callTool routes every tool
// to its real implementation (no remaining stubs after Unit 6).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { callTool, createMcpServer, createMcpTransport, startServer, TOOL_IMPLS } from "../../src/server.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { withPrivateStore } from "../../src/feedback/store.js"
import { cleanup, mkFeedbackFixture, useStateHome } from "../feedback/_helpers.js"
import { mkLedgerFixture, useHostEnv } from "../measurement/_helpers.js"

// The surface as it was advertised while the private feedback API was still
// registered. Retiring that API has to remove exactly one name from this list
// and leave the other routes — person-scoped writes and private measurement
// included — exactly where they were.
const SURFACE_BEFORE_FEEDBACK_RETIREMENT = [
  "task_create",
  "task_update",
  "task_archive",
  "task_move",
  "track_create",
  "track_update",
  "track_rename",
  "friction_add",
  "lesson_add",
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
  assert.equal(body.path, path.join("t", "book-flights", "task.md"))
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
  assert.equal(body.to, path.join("some-track", "book-flights-now"))
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
    input: { track: "nope", slug: "nada", frontmatter: { status: "x" } },
  })
  assert.ok(res.isError, "missing-task should surface as isError")
  const body = parseResult(res)
  assert.equal(body.status, "error")
  assert.match(body.message, /does not exist/)
})

test("server.callTool routes desk_thread to the real implementation", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "desk_thread",
    input: { start_path: "nope/does/not/exist.md" },
  })
  // No isError — without a readiness controller, desk_thread returns the
  // structured fail-closed lexical capability diagnostic.
  const body = parseResult(res)
  assert.equal(body.status, "error")
  assert.equal(body.code, "required_capability_unavailable")
  assert.equal(body.capability, "lexical")
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
    input: { track: "nope", slug: "nada", frontmatter: { status: "x" } },
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

test("server.callTool treats admitted readiness without a live controller as an explicit null readiness handle", async () => {
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
      statusContext: { admission: { state: "CONTROL_READY" } },
    })
    assert.equal(res.isError, undefined)
    assert.equal(received.readiness, null)
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
  assert.equal(body.path, path.join("desks", "ari", "t", "book-flights", "task.md"))
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

test("the live server advertises one tool fewer and no longer names desk_feedback", async () => {
  const fixture = await mkFeedbackFixture()
  try {
    const { list } = await liveHandlers({ deskRoot: fixture.deskRoot, person: "ari" })
    const listed = await list()
    const advertised = listed.tools.map((tool) => tool.name)

    assert.equal(listed.tools.some((tool) => tool.name === "desk_feedback"), false)
    assert.equal(listed.tools.some((tool) => tool.name === "desk_work_ledger"), true)
    assert.equal(
      listed.tools.length,
      SURFACE_BEFORE_FEEDBACK_RETIREMENT.length - 1,
      `expected exactly one retired tool; advertised: ${advertised.join(", ")}`,
    )
    assert.deepEqual(
      advertised,
      SURFACE_BEFORE_FEEDBACK_RETIREMENT.filter((name) => name !== "desk_feedback"),
    )
    for (const tool of listed.tools) {
      assert.equal(typeof tool.description, "string")
      assert.notEqual(tool.description, "")
    }
  } finally {
    await cleanup(fixture.base)
  }
})

test("calling desk_feedback is refused without opening or creating feedback storage", async () => {
  const preserved = await mkFeedbackFixture()
  const restore = useStateHome(preserved.stateHome)
  try {
    // Preserved private bytes: recorded through the retained storage primitive,
    // never migrated anywhere by this change.
    const seeded = await withPrivateStore(
      { deskRoot: preserved.deskRoot, person: "ari" },
      (store) => store.capture({ text: "preserved private preview feedback", taskRef: null }),
    )
    const beforePrivateFiles = await hashedTree(preserved.stateHome)
    assert.ok(
      Object.keys(beforePrivateFiles).length > 0,
      "the fixture must actually hold preserved private bytes",
    )

    const { call } = await liveHandlers({ deskRoot: preserved.deskRoot, person: "ari" })
    for (const args of [
      { action: "list" },
      { action: "capture", text: "written after retirement" },
      { action: "delete", entry_id: seeded.entry_id },
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

test("person scoping and the private measurement route survive the feedback retirement", async () => {
  const fixture = await mkLedgerFixture()
  const restore = useHostEnv(fixture)
  try {
    const { call } = await liveHandlers({ deskRoot: fixture.deskRoot, person: "rowan" })

    const written = await call({
      params: { name: "task_create", arguments: { track: "t", slug: "book-flights", title: "T" } },
    })
    assert.equal(written.isError, undefined)
    assert.equal(parseResult(written).path, path.join("desks", "rowan", "t", "book-flights", "task.md"))

    const capabilities = await call({
      params: { name: "desk_work_ledger", arguments: { action: "capabilities" } },
    })
    assert.equal(capabilities.isError, undefined, JSON.stringify(capabilities.content))
    assert.equal(parseResult(capabilities).status, "ok")
  } finally {
    restore()
    await cleanup(fixture.base)
  }
})
