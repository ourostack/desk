import { test } from "node:test"
import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { mkTempRoot } from "../_temp_roots.js"
import { nativeSnapshot, editingSnapshot, inspectedDOM, fakeDriver, framedSnapshot, PASSWORD, FRAME_TEXT, FALLBACK_TEXT, FRAME_TYPED, FRAME_EDITED } from "./_auth_fixtures.js"

const require = createRequire(import.meta.url)
const auth = require("../../../../../plugins/desk/mcp/web-auth.cjs")

function sanitize(packet) {
  let next = 0
  return auth.prepare(packet, auth.inspect(inspectedDOM(packet).root), "main", () => ++next).tree
}

function noPassword(value) {
  assert.equal(JSON.stringify(value).includes(PASSWORD), false)
  assert.ok(JSON.stringify(value).includes("[redacted]"))
}

// One snapshot attempt, so a single injected invalidation is the final answer.
const ONCE = { snapshotAttempts: 1 }

function adapterFor(native, root, timeout = 5000) {
  return auth.create(native.context, root, timeout, () => {}, ONCE)
}

function overlappingValueSnapshot(values, label) {
  const packet = nativeSnapshot({ value: values[0] })
  const table = packet.documents[0].nodes
  const s = text => { packet.strings.push(text); return packet.strings.length - 1 }
  table.attributes[3][3] = s(label)
  table.parentIndex.push(2)
  table.nodeType.push(1)
  table.nodeName.push(table.nodeName[3])
  table.nodeValue.push(-1)
  table.backendNodeId.push(105)
  table.attributes.push([s("type"), s("password")])
  table.inputValue.index.push(4)
  table.inputValue.value.push(s(values[1]))
  const layout = packet.documents[0].layout
  layout.nodeIndex.push(4)
  layout.styles.push(layout.styles[2].slice())
  layout.bounds.push([0, 0, 100, 20])
  layout.text.push(-1)
  return packet
}

function hookStageWrites(root, afterWrite) {
  const original = fs.promises.open
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    if (String(args[0]).startsWith(root) && args[1] === "wx") {
      const write = file.writeFile.bind(file)
      file.writeFile = async (...data) => {
        const result = await write(...data)
        afterWrite(args[0])
        return result
      }
    }
    return file
  }
  return () => { fs.promises.open = original }
}

test("the production collector redacts native property-only empty revealed autocomplete and hidden controls", () => {
  for (const packet of [nativeSnapshot(), nativeSnapshot({ value: "" }), nativeSnapshot({ type: "text" })]) {
    assert.equal(packet.strings.includes("value"), false, "the property is not a value attribute")
    noPassword(sanitize(packet))
  }
  const hidden = nativeSnapshot()
  for (const key of ["nodeIndex", "styles", "bounds", "text"]) hidden.documents[0].layout[key].pop()
  const result = sanitize(hidden)
  noPassword(result)
  const input = result.children[0].children[0].children[0]
  assert.equal(input.visible, false)
  const autocomplete = nativeSnapshot({ type: "text" })
  autocomplete.strings.push("autocomplete", "current-password")
  autocomplete.documents[0].nodes.attributes[3].push(autocomplete.strings.length - 2, autocomplete.strings.length - 1)
  noPassword(sanitize(autocomplete))
})

test("the production collector protects native CSS editing inheritance designMode and missing styles", () => {
  for (const mode of ["read-write", "read-write-plaintext-only", "future-editing-mode"]) noPassword(sanitize(editingSnapshot(mode)))
  const inherited = editingSnapshot()
  inherited.documents[0].layout.styles[1][2] = inherited.documents[0].layout.styles[2][2]
  noPassword(sanitize(inherited))
  const designMode = editingSnapshot()
  for (const style of designMode.documents[0].layout.styles) style[2] = designMode.documents[0].layout.styles[2][2]
  noPassword(sanitize(designMode))
  for (const missing of [[], [-1, -1, -1]]) {
    const packet = editingSnapshot()
    packet.documents[0].layout.styles[2] = missing
    noPassword(sanitize(packet))
  }
  const missingRow = editingSnapshot()
  for (const key of ["nodeIndex", "styles", "bounds", "text"]) missingRow.documents[0].layout[key].splice(2, 1)
  noPassword(sanitize(missingRow))
})

test("control values are collected before earlier read-only labels and text are rendered", () => {
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  const inputName = table.nodeName[3], inputAttributes = table.attributes[3], value = table.inputValue.value[0]
  table.parentIndex = [-1, 0, 1, 2, 3, 2]
  table.nodeType = [9, 1, 1, 1, 3, 1]
  table.nodeName = [table.nodeName[0], table.nodeName[1], table.nodeName[2], s("SPAN"), s("#text"), inputName]
  table.nodeValue = [-1, -1, -1, -1, s(PASSWORD), -1]
  table.backendNodeId = [101, 102, 103, 105, 106, 104]
  table.attributes = [[], [], [], [s("aria-label"), s("Echo " + PASSWORD)], [], inputAttributes]
  table.inputValue = { index: [5], value: [value] }
  const css = packet.documents[0].layout.styles[0]
  packet.documents[0].layout.nodeIndex = [1, 2, 3, 4, 5]
  packet.documents[0].layout.styles = [1, 2, 3, 4, 5].map(() => css.slice())
  noPassword(sanitize(packet))
})

test("overlapping native values redact the union of original matches without rewriting placeholders", () => {
  for (const { values, label, expected } of [
    { values: ["a", "aSECRET"], label: "aSECRET", expected: "[redacted]" },
    { values: ["aSECRET", "a"], label: "aSECRET", expected: "[redacted]" },
    { values: ["abc", "bcd"], label: "abcd", expected: "[redacted]" },
    { values: ["bcd", "abc"], label: "abcd", expected: "[redacted]" },
    { values: ["aa", "a"], label: "aaa", expected: "[redacted]" },
    { values: ["redacted", "secret"], label: "secret", expected: "[redacted]" },
    { values: ["a", "aSECRET"], label: "aSECRET / aSECRET", expected: "[redacted] / [redacted]" },
    { values: ["abc", "bcd"], label: "safe", expected: "safe" },
  ]) {
    const tree = sanitize(overlappingValueSnapshot(values, label))
    assert.equal(tree.children[0].children[0].children[0].name, expected)
  }
})

test("overlapping native values cannot leak suffixes into owned snapshot text or artifacts", async () => {
  const root = await mkTempRoot("auth-overlap-artifact-")
  const native = fakeDriver({ packet: overlappingValueSnapshot(["a", "aSECRET"], "aSECRET") })
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["snapshot", "--save"])
    assert.equal(result.snapshot.children[0].children[0].children[0].name, "[redacted]")
    assert.equal(JSON.stringify(result).includes("SECRET"), false)
    assert.equal(result.text.includes("SECRET"), false)
    const artifact = fs.readFileSync(result.artifact, "utf8")
    assert.equal(artifact.includes("SECRET"), false)
    assert.ok(artifact.includes("[redacted]"))
  } finally { await adapter.close() }
})

test("overlap match budgets accept the boundary and refuse excess before rendering", () => {
  const allowed = sanitize(overlappingValueSnapshot(["a", "z"], "a".repeat(200000)))
  assert.equal(allowed.children[0].children[0].children[0].name, "[redacted]")
  assert.throws(() => sanitize(overlappingValueSnapshot(["a", "z"], "a".repeat(200001))), /AUTH_OUTPUT_TOO_LARGE/u)
})

// The sign-in page plus `extra` visible DIVs, the shape of a large real page such as a store product page.
function widePage(extra) {
  const packet = nativeSnapshot()
  const document = packet.documents[0]
  const nodes = document.nodes
  packet.strings.push("DIV")
  const div = packet.strings.length - 1
  const css = document.layout.styles[0]
  for (let i = 0; i < extra; i++) {
    nodes.parentIndex.push(2); nodes.nodeType.push(1); nodes.nodeName.push(div); nodes.nodeValue.push(-1)
    nodes.backendNodeId.push(1000 + i); nodes.attributes.push([])
    document.layout.nodeIndex.push(nodes.nodeType.length - 1); document.layout.styles.push(css.slice())
    document.layout.bounds.push([0, 0, 100, 20]); document.layout.text.push(-1)
  }
  return packet
}

test("large real pages are read; a main document beyond 100,000 nodes is refused", () => {
  const tree = sanitize(widePage(25000))
  assert.equal(tree.children[0].children[0].children.length, 25001)
  noPassword(tree)
  assert.throws(() => sanitize(widePage(100000)), /AUTH_OUTPUT_TOO_LARGE/u)
})

test("malformed native control and style fields refuse instead of guessing", () => {
  for (const mutate of [
    (p) => { p.documents[0].nodes.inputValue = { index: [], value: [] } },
    (p) => { p.documents[0].nodes.inputValue.value[0] = 100000 },
    (p) => { p.documents[0].nodes.inputValue.index.push(3); p.documents[0].nodes.inputValue.value.push(0) },
    (p) => { p.documents[0].layout.styles[0] = [0, 1] },
    (p) => { p.documents[0].frameId = p.strings.length },
  ]) {
    const packet = nativeSnapshot()
    mutate(packet)
    assert.throws(() => sanitize(packet), /AUTH_/u)
  }
  const clean = nativeSnapshot()
  const scope = auth.inspect(inspectedDOM(clean).root)
  let reads = 0
  Object.defineProperty(clean, "strings", { get() { reads++; throw new Error(PASSWORD) } })
  assert.throws(() => auth.prepare(clean, scope, "main", () => 1), /AUTH_/u)
  assert.equal(reads, 0)
})

test("closed shadow and missing author controls refuse; open shadow controls stay opaque", () => {
  const packet = nativeSnapshot()
  const dom = inspectedDOM(packet)
  const host = dom.root.children[0].children[0]
  const input = host.children.pop()
  host.shadowRoots = [{ nodeType: 11, nodeName: "#document-fragment", nodeId: 6, backendNodeId: 106, shadowRootType: "open", children: [input] }]
  packet.strings.push("open")
  packet.documents[0].nodes.shadowRootType = { index: [3], value: [packet.strings.length - 1] }
  let next = 0
  const prepared = auth.prepare(packet, auth.inspect(dom.root), "main", () => ++next)
  noPassword(prepared.tree)
  assert.equal(prepared.targets.some((target) => target.id === 104), false)
  assert.equal(prepared.tree.children[0].children[0].children[0].name, undefined, "opaque shadow data has no raw label")
  host.shadowRoots[0].shadowRootType = "closed"
  assert.throws(() => auth.inspect(dom.root), /AUTH_SHADOW/u)
  host.shadowRoots[0].shadowRootType = "unknown"
  assert.throws(() => auth.inspect(dom.root), /AUTH_SHADOW/u)
})

test("a child frame's document, fallback and controls are omitted from the main-document read", () => {
  const packet = framedSnapshot()
  let next = 0
  const prepared = auth.prepare(packet, auth.inspect(inspectedDOM(packet).root), "main", () => ++next)
  const text = JSON.stringify(prepared.tree)
  assert.ok(text.includes("Main product title"))
  for (const hidden of [FRAME_TEXT, FALLBACK_TEXT, FRAME_TYPED, FRAME_EDITED]) assert.equal(text.includes(hidden), false)
  assert.equal(prepared.frames, 1)
  const frame = prepared.tree.children[0].children[0].children.find((node) => node.role === "frame")
  assert.deepEqual(frame.children, [])
})

test("what may have been typed in a child frame is scrubbed where the main document copies it; frame page text is not", () => {
  for (const typed of [FRAME_TYPED, FRAME_EDITED]) {
    const text = JSON.stringify(sanitize(framedSnapshot({ echo: "Sending " + typed })))
    assert.equal(text.includes(typed), false)
    assert.ok(text.includes("Main product title Sending [redacted]"))
  }
  const page = JSON.stringify(sanitize(framedSnapshot({ echo: FRAME_TEXT })))
  assert.ok(page.includes(FRAME_TEXT), "read-only frame text is page text, not a secret")
  const controls = framedSnapshot({ echo: "Draft CHILD_TEXTAREA_688 for USB" })
  const child = controls.documents[1].nodes
  const s = (text) => controls.strings.push(text) - 1
  child.parentIndex.push(2, 2)
  child.nodeType.push(1, 1)
  child.nodeName.push(s("TEXTAREA"), s("INPUT"))
  child.nodeValue.push(-1, -1)
  child.backendNodeId.push(208, 209)
  child.attributes.push([], [s("type"), s("hidden")])
  child.textValue = { index: [child.nodeType.length - 2], value: [s("CHILD_TEXTAREA_688")] }
  child.inputValue.index.push(child.nodeType.length - 1)
  child.inputValue.value.push(s("US"))
  const drafted = JSON.stringify(sanitize(controls))
  assert.equal(drafted.includes("CHILD_TEXTAREA_688"), false, "a frame's textarea value is scrubbed")
  assert.ok(drafted.includes("for USB"), "a frame's hidden code is page content")
  for (const mutate of [
    (p) => { p.documents[1].nodes = undefined },
    (p) => { p.documents[1].nodes.nodeValue.pop() },
    (p) => { p.documents[1].nodes.parentIndex[2] = 5 },
  ]) {
    const packet = framedSnapshot()
    const scope = auth.inspect(inspectedDOM(packet).root)
    mutate(packet)
    assert.throws(() => auth.prepare(packet, scope, "main", () => 1), /AUTH_FRAME_COVERAGE_REFUSED/u)
  }
  const large = framedSnapshot()
  const scope = auth.inspect(inspectedDOM(large).root)
  large.documents[1].nodes.nodeType = new Array(100001).fill(1)
  assert.throws(() => auth.prepare(large, scope, "main", () => 1), /AUTH_OUTPUT_TOO_LARGE/u)
})

test("only frame owners may own child documents, and the main document must come first", () => {
  const dom = inspectedDOM(framedSnapshot())
  dom.root.children[0].children[0].children[0].contentDocument = { nodeType: 9, nodeName: "#document", backendNodeId: 999, children: [] }
  assert.throws(() => auth.inspect(dom.root), /AUTH_FRAME_COVERAGE_REFUSED/u)
  for (const mutate of [
    (p) => { p.documents[0].nodes.contentDocumentIndex.index = [3] },
    (p) => { p.documents[0].nodes.contentDocumentIndex.value = [0] },
    (p) => { p.documents[0].nodes.contentDocumentIndex.value = [2] },
    (p) => { p.documents[0].nodes.contentDocumentIndex = { index: [5] } },
    (p) => { p.documents.reverse() },
  ]) {
    const packet = framedSnapshot()
    const scope = auth.inspect(inspectedDOM(packet).root)
    mutate(packet)
    assert.throws(() => auth.prepare(packet, scope, "main", () => 1), /AUTH_/u)
  }
})

test("allowed actions pass literal data and all raw commands are refused before dispatch", async () => {
  const root = await mkTempRoot("auth-actions-")
  const native = fakeDriver()
  native.page.evaluateHandle = () => { throw new Error(PASSWORD) }
  const adapter = adapterFor(native, root)
  try {
    const snapshot = await adapter.call(["snapshot"])
    noPassword(snapshot)
    const input = snapshot.snapshot.children[0].children[0].children[0]
    const literal = 'fake "quote"\n`backtick` ${notExecuted}; --json'
    const result = await adapter.call(["fill", input.ref, literal])
    noPassword(result)
    assert.equal(JSON.stringify(result).includes(literal), false)
    assert.equal(native.calls.find((call) => call[0] === "fill")[1], literal)
    for (const args of [["eval", "() => 1"], ["run-code", "async page => 1"], ["console"], ["response-body", "1"], ["snapshot", "--raw"], ["snapshot", "--json"], ["snapshot", "--filename=../outside"], ["goto", "javascript:1"]]) {
      const before = native.calls.length
      await assert.rejects(adapter.call(args), /AUTH_/u)
      assert.equal(native.calls.length, before)
    }
    assert.equal(native.calls.some((call) => call[0] === "cdp" && /^Runtime\.(?:evaluate|callFunctionOn)/u.test(call[1])), false)
  } finally { await adapter.close() }
})

test("frame contradictions and API errors never return raw failure text or artifacts", async () => {
  for (const hook of [
    ({ method }) => { if (method === "Page.getFrameTree") throw new Error(PASSWORD) },
    ({ method }) => { if (method === "DOMSnapshot.captureSnapshot") throw new Error(PASSWORD) },
  ]) {
    const root = await mkTempRoot("auth-refusal-")
    const native = fakeDriver({ hook })
    const adapter = adapterFor(native, root)
    try {
      await assert.rejects(adapter.call(["snapshot", "--save"]), (error) => !error.message.includes(PASSWORD) && /AUTH_/u.test(error.message))
      assert.deepEqual(fs.readdirSync(root), [])
    } finally { await adapter.close() }
  }
})

test("same-document shadow mutation ABA and staging invalidation refuse all output", async () => {
  for (const event of ["DOM.shadowRootPushed", "DOM.documentUpdated", "DOM.childNodeInserted", "close"]) {
    const root = await mkTempRoot("auth-fence-")
    const native = fakeDriver({ hook: ({ method, count, cdp }) => {
      if (method === "DOM.getDocument" && count === 3) cdp.emit(event, {})
    } })
    const adapter = adapterFor(native, root)
    try {
      await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_/u)
      assert.deepEqual(fs.readdirSync(root), [])
      assert.equal(native.calls.some((call) => call[0] === "waitForSelector"), false, "a snapshot binds no element")
    } finally { await adapter.close() }
  }
})

test("owned artifacts contain only sanitized production DTOs", async () => {
  const root = await mkTempRoot("auth-artifact-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["snapshot", "--save"])
    noPassword(result)
    assert.equal(path.dirname(result.artifact), root)
    const bytes = fs.readFileSync(result.artifact, "utf8")
    assert.equal(bytes.includes(PASSWORD), false)
    assert.ok(bytes.includes("[redacted]"))
  } finally { await adapter.close() }
})

test("failed reader setup cannot be reused without complete domain admission", async () => {
  const root = await mkTempRoot("auth-setup-")
  let enabled = 0
  const native = fakeDriver({ hook: ({ method }) => {
    if (method === "DOM.enable" && enabled++ === 0) throw new Error(PASSWORD)
  } })
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot"]), /AUTH_/u)
    const result = await adapter.call(["snapshot"])
    noPassword(result)
    assert.equal(enabled, 2, "the failed reader must not bypass DOM enable on retry")
  } finally { await adapter.close() }
})

test("a command timeout closes the owned context and cannot publish late artifacts", async () => {
  const root = await mkTempRoot("auth-timeout-")
  const native = fakeDriver()
  const send = native.cdp.send
  native.cdp.send = async (...args) => {
    if (args[0] === "DOMSnapshot.captureSnapshot") await new Promise((resolve) => setTimeout(resolve, 80))
    return send(...args)
  }
  const adapter = adapterFor(native, root, 20)
  await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_TIMEOUT/u)
  assert.ok(native.calls.some((call) => call[0] === "context.close"))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(fs.readdirSync(root), [])
  await adapter.close()
})

test("closing a native context whose CDP session already closed does not invoke a stale detach", async () => {
  const root = await mkTempRoot("auth-close-")
  const native = fakeDriver()
  const close = native.context.close
  native.context.close = async () => { await close(); native.cdp.emit("close") }
  native.cdp.detach = async () => { throw new Error(PASSWORD) }
  const adapter = adapterFor(native, root)
  await adapter.call(["snapshot"])
  await adapter.close()
})

test("tab creation failure reports possible effects without untrusted exception text", async () => {
  const root = await mkTempRoot("auth-tab-error-")
  const native = fakeDriver()
  native.context.newPage = async () => { throw new Error(PASSWORD) }
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["tab-new"]), (error) =>
      error.message.includes("AUTH_TAB_ACTION_FAILED") && error.message.includes("may have applied") && !error.message.includes(PASSWORD))
  } finally { await adapter.close() }
})

test("malformed native child-frame coverage is not treated as an empty frame tree", async () => {
  const root = await mkTempRoot("auth-frame-shape-")
  const native = fakeDriver()
  const send = native.cdp.send
  native.cdp.send = async (method, params) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "loader" }, childFrames: {} } }
    return send(method, params)
  }
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_FRAME/u)
    assert.deepEqual(fs.readdirSync(root), [])
  } finally { await adapter.close() }
})

test("CSS-only protection changes during binding or staging refuse output and refs without DOM events", async () => {
  for (const phase of ["binding", "staging"]) {
    const root = await mkTempRoot("auth-css-continuity-")
    const packet = editingSnapshot("read-only")
    const change = () => {
      packet.strings.push("read-write")
      packet.documents[0].layout.styles[2][2] = packet.strings.length - 1
      packet.documents[0].layout.styles[3][2] = packet.strings.length - 1
    }
    const native = fakeDriver({ packet, hook: ({ method, count }) => {
      if (phase === "binding" && method === "DOM.getDocument" && count === 2) change()
    } })
    const adapter = adapterFor(native, root)
    const restore = phase === "staging" ? hookStageWrites(root, change) : () => {}
    try {
      await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_PROTECTION_INVALIDATED/u)
      assert.deepEqual(fs.readdirSync(root), [])
      await assert.rejects(adapter.call(["fill", "e3", "literal"]), /AUTH_TARGET_REFUSED/u)
      assert.equal(native.calls.some((call) => call[0] === "fill"), false)
    } finally { restore(); await adapter.close() }
  }
})

test("privately branded error data remains safe if public error properties are replaced", async () => {
  const root = await mkTempRoot("auth-error-data-")
  let reads = 0
  const owned = auth.fail("AUTH_PROTECTION_INVALIDATED")
  for (const key of ["message", "authCode"]) Object.defineProperty(owned, key, { get() { reads++; throw new Error(PASSWORD) } })
  const native = fakeDriver({ hook: ({ method }) => { if (method === "DOMSnapshot.captureSnapshot") throw owned } })
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot"]), (error) =>
      error.message.includes("AUTH_PROTECTION_INVALIDATED") && !error.message.includes(PASSWORD))
    assert.equal(reads, 0)
  } finally { await adapter.close() }
})

test("runtime changes during native waits or staging refuse output but not owned cleanup", async () => {
  for (const phase of ["collection", "binding", "staging"]) {
    const root = await mkTempRoot("auth-runtime-wait-")
    let blocked = false
    const native = fakeDriver({ hook: ({ method, count }) => {
      if (phase === "collection" && method === "DOMSnapshot.captureSnapshot" && count === 1) blocked = true
    } })
    const wait = native.page.mainFrame().waitForSelector
    if (phase === "binding") native.page.mainFrame().waitForSelector = async (...args) => {
      const handle = await wait(...args)
      blocked = true
      return handle
    }
    const restore = phase === "staging" ? hookStageWrites(root, () => { blocked = true }) : () => {}
    const adapter = auth.create(native.context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) }, ONCE)
    try {
      if (phase === "binding") {
        // Refs bind when an action uses them, so the wait gates the action, not the snapshot.
        const input = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
        await assert.rejects(adapter.call(["fill", input.ref, "literal"]), (error) => /AUTH_RUNTIME_POLICY_REFUSED/u.test(error.message) && !error.message.includes(PASSWORD))
        assert.equal(native.calls.some((call) => call[0] === "fill"), false)
      } else {
        await assert.rejects(adapter.call(["snapshot", "--save"]), (error) => /AUTH_RUNTIME_POLICY_REFUSED/u.test(error.message) && !error.message.includes(PASSWORD))
        assert.deepEqual(fs.readdirSync(root), [])
        await assert.rejects(adapter.call(["fill", "e3", "literal"]), /AUTH_RUNTIME_POLICY_REFUSED/u)
      }
    } finally { restore(); await adapter.close() }
    assert.ok(native.calls.some((call) => call[0] === "context.close"))
  }
})

test("rejected stage cleanup proceeds independently of failed handle disposal", async () => {
  for (const failUnlink of [false, true]) {
    const root = await mkTempRoot("auth-cleanup-independent-")
    const packet = editingSnapshot("read-only")
    const native = fakeDriver({ packet, hook: ({ method, count }) => {
      if (method === "DOM.getDocument" && count === 3) {
        packet.strings.push("read-write")
        packet.documents[0].layout.styles[2][2] = packet.strings.length - 1
        packet.documents[0].layout.styles[3][2] = packet.strings.length - 1
      }
    } })
    for (const handle of native.handles.values()) handle.dispose = async () => { throw new Error(PASSWORD) }
    const adapter = auth.create(native.context, root, 5000, () => {}, ONCE)
    const original = fs.promises.unlink
    let attempts = 0
    fs.promises.unlink = async (file) => {
      if (String(file).startsWith(root)) {
        attempts++
        if (failUnlink) throw new Error(PASSWORD)
      }
      return original(file)
    }
    try {
      await assert.rejects(adapter.call(["snapshot", "--save"]), (error) => {
        assert.equal(error.message.includes(PASSWORD), false)
        assert.ok(error.message.includes("AUTH_PROTECTION_INVALIDATED"))
        assert.equal(error.message.includes("AUTH_HANDLE_CLEANUP_FAILED"), false, "a snapshot owns no element handles")
        if (failUnlink) assert.ok(error.message.includes("AUTH_ARTIFACT_CLEANUP_FAILED"))
        return true
      })
      assert.equal(attempts, 1, "owned stage removal is still attempted")
      assert.equal(fs.readdirSync(root).length, failUnlink ? 1 : 0)
    } finally {
      fs.promises.unlink = original
      await adapter.close()
    }
  }
})

test("runtime policy gates actions and their post-await output while allowing context close", async () => {
  for (const when of ["before", "after"]) {
    const root = await mkTempRoot("auth-runtime-action-")
    const native = fakeDriver()
    let blocked = false
    const adapter = auth.create(native.context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) }, ONCE)
    try {
      const result = await adapter.call(["snapshot"])
      const input = result.snapshot.children[0].children[0].children[0]
      const fill = native.handles.get(104).fill
      if (when === "before") blocked = true
      else native.handles.get(104).fill = async (...args) => { await fill(...args); blocked = true }
      const reads = native.calls.filter((call) => call[0] === "cdp" && call[1] === "DOMSnapshot.captureSnapshot").length
      await assert.rejects(adapter.call(["fill", input.ref, "literal"]), (error) =>
        /AUTH_RUNTIME_POLICY_REFUSED/u.test(error.message) && !error.message.includes(PASSWORD))
      assert.equal(native.calls.filter((call) => call[0] === "fill").length, when === "before" ? 0 : 1)
      assert.equal(native.calls.filter((call) => call[0] === "cdp" && call[1] === "DOMSnapshot.captureSnapshot").length, reads)
    } finally { await adapter.close() }
  }
})

test("a replaced staged pathname is retained rather than blindly unlinked", async () => {
  const root = await mkTempRoot("auth-stage-identity-")
  let stage
  const native = fakeDriver({ hook: ({ method, count }) => {
    if (method === "DOM.getDocument" && count === 3) {
      fs.renameSync(stage, stage + ".displaced")
      fs.writeFileSync(stage, "FAKE_FOREIGN_FILE")
    }
  } })
  const restore = hookStageWrites(root, (file) => { stage = file })
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot", "--save"]), (error) =>
      error.message.includes("AUTH_STAGE_IDENTITY_REFUSED") &&
      error.message.includes("AUTH_ARTIFACT_CLEANUP_FAILED"))
    assert.equal(fs.readFileSync(stage, "utf8"), "FAKE_FOREIGN_FILE")
    assert.equal(fs.existsSync(stage + ".displaced"), true)
  } finally { restore(); await adapter.close() }
})

test("untrusted native error properties cannot become public error codes", async () => {
  const root = await mkTempRoot("auth-error-brand-")
  const native = fakeDriver({ hook: ({ method }) => {
    if (method === "DOMSnapshot.captureSnapshot") throw Object.assign(new Error(PASSWORD), { authCode: PASSWORD })
  } })
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot"]), (error) =>
      /AUTH_/u.test(error.message) && !error.message.includes(PASSWORD))
  } finally { await adapter.close() }
})

test("stage-close failure preserves primary policy refusal and remains available to owned cleanup", async () => {
  const root = await mkTempRoot("auth-stage-close-failure-")
  const native = fakeDriver()
  let blocked = false
  let closes = 0
  let opened
  let originalClose
  const restoreWrite = hookStageWrites(root, () => { blocked = true })
  const originalOpen = fs.promises.open
  fs.promises.open = async (...args) => {
    const file = await originalOpen(...args)
    if (String(args[0]).startsWith(root)) {
      opened = file
      originalClose = file.close.bind(file)
      file.close = async () => {
        closes++
        if (closes === 1) throw new Error(PASSWORD)
        return originalClose()
      }
    }
    return file
  }
  const adapter = auth.create(native.context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) }, ONCE)
  try {
    await assert.rejects(adapter.call(["snapshot", "--save"]), (error) =>
      error.message.includes("AUTH_RUNTIME_POLICY_REFUSED") &&
      error.message.includes("AUTH_STAGE_CLOSE_FAILED") &&
      !error.message.includes(PASSWORD))
    await adapter.close()
    assert.equal(closes, 2, "the still-owned file handle is retried during close")
  } finally {
    fs.promises.open = originalOpen
    restoreWrite()
    if (opened && originalClose) await originalClose()
    await adapter.close()
  }
})

test("successful tab creation carries effects through subsequent reader and protection failures", async () => {
  for (const failure of ["cdp", "domain", "protection"]) {
    const root = await mkTempRoot("auth-created-tab-failure-")
    const native = fakeDriver({ hook: ({ method }) => {
      if (failure === "domain" && method === "DOM.enable") throw new Error(PASSWORD)
      if (failure === "protection" && method === "DOMSnapshot.captureSnapshot") throw new Error(PASSWORD)
    } })
    let created = 0
    native.context.pages = () => created ? [native.page] : []
    native.context.newPage = async () => { created++; return native.page }
    if (failure === "cdp") native.context.newCDPSession = async () => { throw new Error(PASSWORD) }
    const adapter = adapterFor(native, root)
    try {
      const primary = failure === "protection" ? "AUTH_SNAPSHOT_FAILED" : "AUTH_READER_SETUP_FAILED"
      await assert.rejects(adapter.call(["tab-new"]), (error) =>
        error.message.includes(primary) && error.message.includes("may have applied") && !error.message.includes(PASSWORD))
      assert.equal(created, 1)
      assert.equal(native.context.pages().length, 1)
      assert.deepEqual(fs.readdirSync(root), [])
    } finally { await adapter.close() }
  }
})

test("native value changes during binding or staging invalidate earlier redaction decisions", async () => {
  for (const phase of ["binding", "staging"]) {
    const root = await mkTempRoot("auth-value-continuity-")
    const packet = nativeSnapshot({ value: "" })
    packet.strings.push(PASSWORD)
    const marker = packet.strings.length - 1
    packet.documents[0].nodes.attributes[3][3] = marker
    const change = () => { packet.documents[0].nodes.inputValue.value[0] = marker }
    const native = fakeDriver({ packet, hook: ({ method, count }) => {
      if (phase === "binding" && method === "DOM.getDocument" && count === 2) change()
    } })
    const restore = phase === "staging" ? hookStageWrites(root, change) : () => {}
    const adapter = adapterFor(native, root)
    try {
      await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_REDACTION_INVALIDATED/u)
      assert.deepEqual(fs.readdirSync(root), [])
      await assert.rejects(adapter.call(["fill", "e3", "literal"]), /AUTH_TARGET_REFUSED/u)
      assert.equal(native.calls.some(call => call[0] === "fill"), false)
    } finally { restore(); await adapter.close() }
  }
})

test("an action's element handle is disposed after use and a failed disposal is retained for owned close", async () => {
  for (const synchronous of [false, true]) {
    const root = await mkTempRoot("auth-action-handle-")
    const native = fakeDriver()
    const adapter = adapterFor(native, root)
    let attempts = 0
    let refuse = true
    try {
      const input = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
      assert.equal(native.calls.some((call) => call[0] === "waitForSelector"), false, "refs bind only when used")
      native.handles.get(104).dispose = () => {
        attempts++
        if (refuse) {
          if (synchronous) throw new Error(PASSWORD)
          return Promise.reject(new Error(PASSWORD))
        }
        return Promise.resolve()
      }
      await assert.rejects(adapter.call(["fill", input.ref, "literal"]), error =>
        /AUTH_HANDLE_CLEANUP_FAILED/u.test(error.message) && /may have applied/u.test(error.message) && !error.message.includes(PASSWORD))
      assert.equal(native.calls.filter((call) => call[0] === "fill").length, 1)
      assert.equal(attempts, 1)
      await assert.rejects(adapter.close(), /AUTH_HANDLE_CLEANUP_FAILED/u)
      refuse = false
      await adapter.close()
      assert.equal(attempts, 3, "close retries the still-owned rejected disposal")
    } finally { refuse = false; await adapter.close() }
  }
})

test("an action scrolls its element into view first, so a button enabled only once seen (GitHub's Authorize) is clicked", async () => {
  const root = await mkTempRoot("auth-action-scroll-")
  const native = fakeDriver()
  const handle = native.handles.get(104)
  let seen = false
  handle.scrollIntoViewIfNeeded = async (options) => { native.calls.push(["scrollIntoViewIfNeeded", options]); seen = true }
  // Like Playwright's click, the action waits for the element to be enabled before it would scroll; it never is unless seen.
  handle.click = async () => { if (!seen) throw new Error("timeout waiting for enabled " + PASSWORD); native.calls.push(["click"]) }
  const adapter = adapterFor(native, root)
  try {
    const input = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
    await adapter.call(["click", input.ref])
    const order = native.calls.map((call) => call[0]).filter((name) => name === "scrollIntoViewIfNeeded" || name === "click")
    assert.deepEqual(order, ["scrollIntoViewIfNeeded", "click"])
    assert.deepEqual(native.calls.find((call) => call[0] === "scrollIntoViewIfNeeded")[1], { timeout: 5000 })
  } finally { await adapter.close() }
})

test("an action disposes its element handle and binds the path of the ref it names", async () => {
  const root = await mkTempRoot("auth-action-bind-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root)
  try {
    const input = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
    await adapter.call(["fill", input.ref, "literal"])
    const waits = native.calls.filter((call) => call[0] === "waitForSelector")
    assert.equal(waits.length, 1)
    assert.match(waits[0][1], /^css=.*input:nth-of-type\(1\)$/u)
    assert.deepEqual(waits[0][2], { state: "attached", strict: true, timeout: 2000 })
    assert.ok(native.calls.some((call) => call[0] === "dispose" && call[1] === 104))
    const wait = native.page.mainFrame().waitForSelector
    native.page.mainFrame().waitForSelector = async () => { throw new Error(PASSWORD) }
    const next = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
    await assert.rejects(adapter.call(["fill", next.ref, "literal"]), error =>
      /AUTH_TARGET_REFUSED/u.test(error.message) && !error.message.includes(PASSWORD))
    native.page.mainFrame().waitForSelector = wait
    const failing = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
    const handle = native.handles.get(104)
    const { click, dispose } = handle
    handle.click = async () => { throw new Error(PASSWORD) }
    handle.dispose = async () => { throw new Error(PASSWORD) }
    await assert.rejects(adapter.call(["click", failing.ref]), error =>
      /AUTH_ACTION_FAILED/u.test(error.message) && !/AUTH_HANDLE_CLEANUP_FAILED/u.test(error.message) && !error.message.includes(PASSWORD),
      "the action's own failure is the primary report")
    await assert.rejects(adapter.close(), /AUTH_HANDLE_CLEANUP_FAILED/u, "the failed disposal stays owned")
    Object.assign(handle, { click, dispose })
  } finally { await adapter.close() }
})

test("tab selection retains Page identity when an unrelated earlier page closes", async () => {
  const root = await mkTempRoot("auth-page-selection-")
  const natives = [fakeDriver(), fakeDriver(), fakeDriver()]
  const context = natives[0].context
  let pages = natives.map(native => native.page)
  context.pages = () => pages.slice()
  context.newCDPSession = async page => natives.find(native => native.page === page).cdp
  for (const native of natives) {
    native.page.context = () => context
    native.page.isClosed = () => !pages.includes(native.page)
    native.page.close = async () => {
      pages = pages.filter(page => page !== native.page)
      native.page.emit("close")
    }
  }
  const adapter = auth.create(context, root, 5000, () => {})
  try {
    await adapter.call(["tab-select", "1"])
    await natives[0].page.close()
    assert.deepEqual(await adapter.call(["tab-list"]), { tabs: [{ index: 0, selected: true }, { index: 1, selected: false }] })
    await adapter.call(["goto", "https://synthetic.invalid/"])
    assert.equal(natives[1].calls.filter(call => call[0] === "goto").length, 1)
    assert.equal(natives[2].calls.filter(call => call[0] === "goto").length, 0)
    await adapter.call(["tab-close"])
    assert.deepEqual(pages, [natives[2].page])
  } finally { await adapter.close() }
})

test("a closed selected Page refuses navigation instead of choosing another tab", async () => {
  const root = await mkTempRoot("auth-selected-page-closed-")
  const native = fakeDriver()
  const other = fakeDriver()
  const context = native.context
  let pages = [native.page, other.page]
  context.pages = () => pages.slice()
  native.page.isClosed = () => !pages.includes(native.page)
  other.page.context = () => context
  context.newCDPSession = async page => page === native.page ? native.cdp : other.cdp
  const adapter = auth.create(context, root, 5000, () => {})
  try {
    await adapter.call(["snapshot"])
    pages = [other.page]
    native.page.emit("close")
    await assert.rejects(adapter.call(["goto", "https://synthetic.invalid/"]), /AUTH_CONTEXT_REFUSED/u)
    assert.equal(other.calls.some(call => call[0] === "goto"), false)
    await assert.rejects(adapter.call(["tab-close"]), /AUTH_TARGET_REFUSED/u)
    assert.deepEqual(pages, [other.page])
  } finally { await adapter.close() }
})

test("native inspection qualifies leaf counts templates and supported user-agent roots", () => {
  const dom = inspectedDOM(nativeSnapshot())
  const input = dom.root.children[0].children[0].children[0]
  delete input.children
  input.childNodeCount = 0
  input.shadowRoots = [{ shadowRootType: "user-agent" }]
  const template = { nodeType: 1, nodeName: "TEMPLATE", backendNodeId: 110,
    children: [], templateContent: { nodeType: 11, nodeName: "#document-fragment", backendNodeId: 111, children: [] } }
  dom.root.children[0].children[0].children.push(template)
  const scope = auth.inspect(dom.root)
  assert.ok(scope.controls.has(104))
  assert.ok(scope.nodes.has(111))
  input.childNodeCount = 1
  assert.throws(() => auth.inspect(dom.root), /AUTH_NATIVE_DATA_INVALID/u)
  input.childNodeCount = 0
  // Media controls, details and SVG use carry user-agent roots too; their trees are never walked or rendered.
  input.nodeName = "DIV"
  input.shadowRoots = [{ shadowRootType: "user-agent", nodeType: 11, nodeName: "#document-fragment", backendNodeId: 120,
    children: [{ nodeType: 3, nodeName: "#text", backendNodeId: 121, nodeValue: PASSWORD }] }]
  const internal = auth.inspect(dom.root)
  assert.equal(internal.nodes.has(120) || internal.nodes.has(121), false)
  assert.equal(internal.controls.has(104), false)
  input.shadowRoots[0].shadowRootType = "closed"
  assert.throws(() => auth.inspect(dom.root), /AUTH_SHADOW_COVERAGE_REFUSED/u)
  input.shadowRoots[0].shadowRootType = "user-agent"
  // Template content is inert: its fragment is recorded, its children (whatever their count) are not walked.
  template.templateContent.childNodeCount = 1
  template.templateContent.children = [{ nodeType: 1, nodeName: "INPUT", backendNodeId: 112, children: [] }]
  const inert = auth.inspect(dom.root)
  assert.ok(inert.nodes.has(111))
  assert.equal(inert.nodes.has(112) || inert.controls.has(112), false)
  template.templateContent.nodeType = 1
  assert.throws(() => auth.inspect(dom.root), /AUTH_NATIVE_DATA_INVALID/u)
})

test("native textareas excluded content comments and unlabeled opaque regions stay private", () => {
  for (const name of ["TEXTAREA", "SCRIPT", "DIV", "#comment"]) {
    const packet = nativeSnapshot()
    const nodes = packet.documents[0].nodes
    packet.strings.push(name)
    nodes.nodeName[3] = packet.strings.length - 1
    nodes.attributes[3] = []
    if (name === "TEXTAREA") {
      nodes.textValue = nodes.inputValue
      nodes.inputValue = { index: [], value: [] }
    } else {
      nodes.inputValue = { index: [], value: [] }
      if (name === "#comment") nodes.nodeType[3] = 8
      if (name === "DIV") packet.documents[0].layout.styles[2] = []
    }
    const tree = sanitize(packet)
    assert.equal(JSON.stringify(tree).includes(PASSWORD), false)
    if (name === "TEXTAREA" || name === "DIV") assert.ok(JSON.stringify(tree).includes("[redacted]"))
    else assert.deepEqual(tree.children[0].children[0].children, [])
  }
  const empty = nativeSnapshot({ value: "" })
  empty.strings.push("TEXTAREA")
  empty.documents[0].nodes.nodeName[3] = empty.strings.length - 1
  empty.documents[0].nodes.textValue = empty.documents[0].nodes.inputValue
  empty.documents[0].nodes.inputValue = { index: [], value: [] }
  noPassword(sanitize(empty))
  assert.equal(auth.safeFailure("not-an-error"), undefined)
})

test("validated native history viewport mouse and no-argument locator actions dispatch literally", async () => {
  const root = await mkTempRoot("auth-native-commands-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root)
  try {
    for (const args of [["go-back"], ["go-forward"], ["reload"], ["resize", "640", "480"], ["mousewheel", "1", "-2"]]) {
      noPassword(await adapter.call(args))
    }
    for (const command of ["click", "dblclick", "check", "uncheck", "hover", "select"]) {
      const snap = await adapter.call(["snapshot"])
      const ref = snap.snapshot.children[0].children[0].children[0].ref
      noPassword(await adapter.call(command === "select" ? [command, ref, "literal"] : [command, ref]))
    }
    assert.ok(native.calls.some(call => call[0] === "goBack"))
    assert.ok(native.calls.some(call => call[0] === "goForward"))
    assert.ok(native.calls.some(call => call[0] === "reload"))
    assert.ok(native.calls.some(call => call[0] === "setViewportSize" && call[1].width === 640))
    assert.ok(native.calls.some(call => call[0] === "wheel" && call[1] === 1 && call[2] === -2))
    assert.ok(native.calls.some(call => call[0] === "selectOption" && call[1] === "literal"))
    await assert.rejects(adapter.call(["goto", "not a URL"]), /AUTH_URL_REFUSED/u)
    await assert.rejects(adapter.call(["resize", "0", "10"]), /AUTH_ARGUMENTS_REFUSED/u)
  } finally { await adapter.close() }
})

test("native action failures retain possible effects and unknown operation failures stay fixed", async () => {
  const root = await mkTempRoot("auth-native-failure-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root)
  try {
    const snap = await adapter.call(["snapshot"])
    const ref = snap.snapshot.children[0].children[0].children[0].ref
    native.handles.get(104).click = async () => { throw new Error(PASSWORD) }
    await assert.rejects(adapter.call(["click", ref]), error =>
      error.message.includes("AUTH_ACTION_FAILED") && error.message.includes("may have applied") && !error.message.includes(PASSWORD))
    const pages = native.context.pages
    native.context.pages = () => { throw new Error(PASSWORD) }
    await assert.rejects(adapter.call(["tab-list"]), error =>
      error.message.includes("AUTH_OPERATION_FAILED") && !error.message.includes(PASSWORD))
    native.context.pages = pages
    native.page.close = async () => { throw new Error(PASSWORD) }
    await assert.rejects(adapter.call(["tab-close"]), /AUTH_TAB_ACTION_FAILED/u)
  } finally { await adapter.close() }
})

test("owned context closure retries after an untrusted failure and crashed readers refuse reuse", async () => {
  const root = await mkTempRoot("auth-close-retry-")
  const native = fakeDriver()
  const close = native.context.close
  let attempts = 0
  native.context.close = async () => { if (++attempts === 1) throw new Error(PASSWORD); return close() }
  const adapter = adapterFor(native, root)
  await adapter.call(["snapshot"])
  native.page.emit("crash")
  await assert.rejects(adapter.call(["snapshot"]), /AUTH_READER_REFUSED/u)
  await assert.rejects(adapter.close(), error => /AUTH_CLOSE_FAILED/u.test(error.message) && !error.message.includes(PASSWORD))
  await adapter.close()
  assert.equal(attempts, 2)
})

test("timeout cleanup failure refuses without losing context-close retry ownership", async () => {
  const root = await mkTempRoot("auth-timeout-close-fail-")
  const native = fakeDriver({ closeError: new Error(PASSWORD) })
  const send = native.cdp.send
  native.cdp.send = async (...args) => {
    if (args[0] === "DOMSnapshot.captureSnapshot") await new Promise(resolve => setTimeout(resolve, 40))
    return send(...args)
  }
  const adapter = adapterFor(native, root, 10)
  await assert.rejects(adapter.call(["snapshot", "--save"]), error =>
    error.message.includes("AUTH_TIMEOUT_CLOSE_FAILED") && !error.message.includes(PASSWORD))
  native.context.close = async () => {}
  await new Promise(resolve => setTimeout(resolve, 50))
  await adapter.close()
  assert.deepEqual(fs.readdirSync(root), [])
})

test("missing staged files retain refusal without false artifact cleanup uncertainty", async () => {
  const root = await mkTempRoot("auth-stage-gone-")
  const native = fakeDriver()
  const restore = hookStageWrites(root, file => fs.unlinkSync(file))
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot", "--save"]), error =>
      error.message.includes("AUTH_SNAPSHOT_FAILED") && !error.message.includes("AUTH_ARTIFACT_CLEANUP_FAILED"))
    assert.deepEqual(fs.readdirSync(root), [])
  } finally { restore(); await adapter.close() }
})

test("an isolated stage-close failure remains owned through failed close and successful retry", async () => {
  const root = await mkTempRoot("auth-stage-close-only-")
  const native = fakeDriver()
  const original = fs.promises.open
  let allowClose = false
  let descriptor
  let actualClose
  fs.promises.open = async (...args) => {
    const file = await original(...args)
    if (String(args[0]).startsWith(root) && args[1] === "wx") {
      descriptor = file
      actualClose = file.close.bind(file)
      file.close = async () => {
        if (!allowClose) throw new Error(PASSWORD)
        return actualClose()
      }
    }
    return file
  }
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_STAGE_CLOSE_FAILED/u)
    await assert.rejects(adapter.close(), error =>
      error.message.includes("AUTH_STAGE_CLOSE_FAILED") && error.message.includes("AUTH_CLOSE_FAILED"))
    allowClose = true
    await adapter.close()
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    fs.promises.open = original
    allowClose = true
    if (descriptor && actualClose) await actualClose()
    await adapter.close()
  }
})

function framedDriver() {
  const native = fakeDriver({ packet: framedSnapshot() })
  native.page.frames = () => [native.page.mainFrame(), {}]
  const send = native.cdp.send
  native.cdp.send = async (method, params) => method === "Page.getFrameTree"
    ? { frameTree: { frame: { id: "main", loaderId: "loader" }, childFrames: [{ frame: { id: "child", parentId: "main", loaderId: "child-loader" } }] } }
    : send(method, params)
  return native
}

test("a page with child frames is read from its main document and its saved artifact omits every frame", async () => {
  const root = await mkTempRoot("auth-tree-child-")
  const native = framedDriver()
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["snapshot", "--save"])
    assert.equal(result.framesOmitted, 1)
    assert.ok(result.text.includes("Main product title"))
    assert.match(result.text, /^ *- frame/mu)
    const artifact = fs.readFileSync(result.artifact, "utf8")
    for (const hidden of [FRAME_TEXT, FALLBACK_TEXT, FRAME_TYPED, FRAME_EDITED]) {
      assert.equal(JSON.stringify(result).includes(hidden), false)
      assert.equal(artifact.includes(hidden), false)
    }
  } finally { await adapter.close() }
})

test("child-frame navigation does not invalidate a main-document read; main-frame navigation does", async () => {
  for (const [event, params, settles] of [
    ["Page.frameNavigated", { frame: { id: "child", parentId: "main", loaderId: "next" } }, true],
    ["Page.frameAttached", { frameId: "child2", parentFrameId: "child" }, true],
    ["Page.frameDetached", { frameId: "child" }, true],
    ["Page.frameNavigated", { frame: { id: "main", loaderId: "next" } }, false],
  ]) {
    const root = await mkTempRoot("auth-child-frame-event-")
    const native = framedDriver()
    const send = native.cdp.send
    let reads = 0
    native.cdp.send = async (method, params2) => {
      if (method === "DOMSnapshot.captureSnapshot" && ++reads === 1) native.cdp.emit(event, params)
      return send(method, params2)
    }
    const adapter = adapterFor(native, root)
    try {
      if (settles) assert.equal((await adapter.call(["snapshot"])).framesOmitted, 1)
      else await assert.rejects(adapter.call(["snapshot"]), /AUTH_SNAPSHOT_INVALIDATED/u)
    } finally { await adapter.close() }
  }
})

test("runtime changes after successful tab creation retain the applied-effect refusal", async () => {
  const root = await mkTempRoot("auth-tab-runtime-")
  const native = fakeDriver()
  let blocked = false
  native.context.newPage = async () => { blocked = true; return native.page }
  const adapter = auth.create(native.context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) }, ONCE)
  try {
    await assert.rejects(adapter.call(["tab-new"]), error =>
      error.message.includes("AUTH_RUNTIME_POLICY_REFUSED") &&
      error.message.includes("may have applied") && !error.message.includes(PASSWORD))
    assert.equal(native.calls.some(call => call[0] === "newCDPSession"), false)
  } finally { await adapter.close() }
})

test("a branded empty primary code still reports staged artifact cleanup uncertainty", async () => {
  const root = await mkTempRoot("auth-empty-primary-")
  const native = fakeDriver({ hook: ({ method, count }) => {
    if (method === "DOM.getDocument" && count === 3) throw auth.fail("")
  } })
  const adapter = adapterFor(native, root)
  const original = fs.promises.unlink
  let attempts = 0
  fs.promises.unlink = async (file) => {
    if (String(file).startsWith(root)) { attempts++; throw new Error(PASSWORD) }
    return original(file)
  }
  try {
    await assert.rejects(adapter.call(["snapshot", "--save"]), error =>
      error.message.includes("AUTH_OPERATION_FAILED") &&
      error.message.includes("AUTH_ARTIFACT_CLEANUP_FAILED") && !error.message.includes(PASSWORD))
    assert.equal(attempts, 1)
  } finally {
    fs.promises.unlink = original
    await adapter.close()
  }
})

test("reader setup and detach failures preserve primary refusal and cleanup uncertainty", async () => {
  const root = await mkTempRoot("auth-reader-primary-")
  const native = fakeDriver({ hook: ({ method }) => {
    if (method === "DOM.enable") throw auth.fail("AUTH_RUNTIME_POLICY_REFUSED")
  } })
  native.cdp.detach = async () => { throw new Error(PASSWORD) }
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot"]), error =>
      error.message.includes("AUTH_RUNTIME_POLICY_REFUSED") &&
      error.message.includes("AUTH_READER_CLEANUP_FAILED") &&
      !error.message.includes(PASSWORD))
    await assert.rejects(adapter.call(["snapshot"]), /AUTH_READER_REFUSED/u)
  } finally { await adapter.close() }
})

test("the native document envelope is validated without reading accessors", async () => {
  const root = await mkTempRoot("auth-envelope-")
  const native = fakeDriver()
  const send = native.cdp.send
  let reads = 0
  native.cdp.send = async (method, params) => {
    if (method === "DOM.getDocument") return Object.defineProperty({}, "root", {
      enumerable: true, get() { reads++; throw new Error(PASSWORD) },
    })
    return send(method, params)
  }
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_NATIVE_DATA_INVALID/u)
    assert.equal(reads, 0)
    assert.deepEqual(fs.readdirSync(root), [])
  } finally { await adapter.close() }
})

// A page body: <span>Echo on and off</span><input type=checkbox> next to the fixture's password input.
function labelledPage({ checkbox = "on", spanValue = "Echo on and off", whitespace = " " } = {}) {
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  const css = packet.documents[0].layout.styles[0]
  table.parentIndex.push(2, 4, 2, 2)
  table.nodeType.push(1, 3, 1, 3)
  table.nodeName.push(s("SPAN"), s("#text"), table.nodeName[3], s("#text"))
  table.nodeValue.push(-1, s(spanValue), -1, s(whitespace))
  table.backendNodeId.push(105, 106, 107, 108)
  table.attributes.push([], [], checkbox === undefined ? [s("type"), s("checkbox")] : [s("type"), s("checkbox"), s("value"), s(checkbox)], [])
  table.inputValue.index.push(6)
  table.inputValue.value.push(s(checkbox ?? "on"))
  packet.documents[0].layout.nodeIndex.push(4, 5, 6)
  packet.documents[0].layout.styles.push(css.slice(), css.slice(), css.slice())
  return packet
}

test("checkbox markup values and whitespace never become redaction secrets; typed values still do", () => {
  for (const checkbox of ["on", undefined, "yes"]) {
    const text = JSON.stringify(sanitize(labelledPage({ checkbox, spanValue: "Echo on and off, yes" })))
    noPassword(text)
    assert.ok(text.includes("Echo on and off, yes"), "page text keeps its words and spaces")
  }
  const typed = labelledPage({ checkbox: "typed-elsewhere", spanValue: "Echo typed-elsewhere" })
  typed.documents[0].nodes.attributes[6] = [typed.strings.indexOf("type"), typed.strings.indexOf("checkbox")]
  assert.equal(JSON.stringify(sanitize(typed)).includes("typed-elsewhere"), false, "a value differing from its markup is protected")
  const radio = labelledPage({ checkbox: "on", spanValue: "Echo on" })
  radio.strings.push("text")
  radio.documents[0].nodes.attributes[6][1] = radio.strings.length - 1
  assert.equal(JSON.stringify(sanitize(radio)).includes("Echo on"), false, "a text field's value is protected however short")
  radio.documents[0].nodes.attributes[6] = []
  assert.equal(JSON.stringify(sanitize(radio)).includes("Echo on"), false, "an input without a type is a text field")
})

test("short hidden and button input values are page codes; longer ones may copy a typed value and stay secrets", () => {
  const page = (type, value, spanValue) => {
    const packet = labelledPage({ checkbox: value, spanValue })
    packet.documents[0].nodes.attributes[6] = [packet.strings.indexOf("type"), packet.strings.push(type) - 1]
    return JSON.stringify(sanitize(packet))
  }
  for (const type of ["hidden", "submit", "button", "reset", "image", "HIDDEN"]) {
    assert.ok(page(type, "US", "USB Bluetooth 5.0").includes("USB Bluetooth 5.0"), type + " codes are page content")
    assert.equal(page(type, "+15551234567", "Code sent to +15551234567").includes("+1555"), false, type + " copies of typed values stay secret")
  }
  for (const type of ["text", "number", "email", "search"]) {
    assert.equal(page(type, "US", "USB Bluetooth").includes("USB"), false, type + " fields stay protected however short")
  }
})
// <div style="display:none">US</div><span>USB Bluetooth Dongle</span>: hidden nodes have no layout row, so no computed style.
function hiddenTextPage(divAttributes = []) {
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  const css = packet.documents[0].layout.styles[0]
  table.parentIndex.push(2, 4, 2, 6)
  table.nodeType.push(1, 3, 1, 3)
  table.nodeName.push(s("DIV"), s("#text"), s("SPAN"), s("#text"))
  table.nodeValue.push(-1, s("US"), -1, s("USB Bluetooth Dongle"))
  table.backendNodeId.push(105, 106, 107, 108)
  table.attributes.push(divAttributes.map(s), [], [], [])
  packet.documents[0].layout.nodeIndex.push(6, 7)
  packet.documents[0].layout.styles.push(css.slice(), css.slice())
  return packet
}

test("hidden page text inherits its editing mode, so it neither hides as a secret nor redacts visible words", () => {
  const text = JSON.stringify(sanitize(hiddenTextPage()))
  noPassword(text)
  assert.ok(text.includes("USB Bluetooth Dongle"))
  assert.ok(text.includes("\"US\""), "hidden read-only text is page text")
  for (const attributes of [["contenteditable", ""], ["contenteditable", "true"], ["contenteditable", "plaintext-only"], ["contenteditable", "TRUE"]]) {
    const editable = JSON.stringify(sanitize(hiddenTextPage(attributes)))
    assert.equal(editable.includes("USB"), false, "hidden editable content stays a secret everywhere")
    assert.ok(editable.includes("[redacted]B Bluetooth Dongle"))
  }
  const off = JSON.stringify(sanitize(hiddenTextPage(["contenteditable", "false"])))
  assert.ok(off.includes("USB Bluetooth Dongle"))
  const editingBody = hiddenTextPage()
  editingBody.strings.push("read-write")
  editingBody.documents[0].layout.styles[1][2] = editingBody.strings.length - 1
  assert.equal(JSON.stringify(sanitize(editingBody)).includes("USB"), false, "hidden content of an editable ancestor stays a secret")
  const noAncestor = hiddenTextPage()
  for (const key of ["nodeIndex", "styles", "bounds", "text"]) noAncestor.documents[0].layout[key].splice(0, 2)
  assert.equal(JSON.stringify(sanitize(noAncestor)).includes("\"US\""), false, "without a styled ancestor hidden text stays opaque")
})

test("one node's repeated layout rows must agree", () => {
  const packet = nativeSnapshot()
  const layout = packet.documents[0].layout
  layout.nodeIndex.push(2)
  layout.styles.push(layout.styles[1].slice())
  noPassword(sanitize(packet))
  packet.strings.push("none")
  layout.styles[3][0] = packet.strings.length - 1
  assert.throws(() => sanitize(packet), /AUTH_NATIVE_DATA_INVALID/u)
})

test("unslotted light children of a shadow host may be absent from the capture; other absences refuse", () => {
  const packet = nativeSnapshot()
  const dom = inspectedDOM(packet)
  const body = dom.root.children[0].children[0]
  const host = { nodeType: 1, nodeName: "RELATIVE-TIME", backendNodeId: 130, childNodeCount: 1,
    children: [{ nodeType: 3, nodeName: "#text", backendNodeId: 131, nodeValue: "Nov 9" }],
    shadowRoots: [{ nodeType: 11, nodeName: "#document-fragment", backendNodeId: 132, shadowRootType: "open", children: [] }] }
  body.children.push(host)
  const table = packet.documents[0].nodes
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  table.parentIndex.push(2)
  table.nodeType.push(1)
  table.nodeName.push(s("RELATIVE-TIME"))
  table.nodeValue.push(-1)
  table.backendNodeId.push(130)
  table.attributes.push([])
  let next = 0
  noPassword(auth.prepare(packet, auth.inspect(dom.root), "main", () => ++next).tree)
  host.children.push({ nodeType: 1, nodeName: "INNER-EL", backendNodeId: 134, childNodeCount: 0, children: [],
    shadowRoots: [{ nodeType: 11, nodeName: "#document-fragment", backendNodeId: 135, shadowRootType: "open",
      children: [{ nodeType: 3, nodeName: "#text", backendNodeId: 136, nodeValue: "nested" }] }] })
  host.childNodeCount = 2
  noPassword(auth.prepare(packet, auth.inspect(dom.root), "main", () => ++next).tree)
  host.children[1].children = [{ nodeType: 1, nodeName: "INPUT", backendNodeId: 137, children: [] }]
  host.children[1].childNodeCount = 1
  assert.throws(() => auth.prepare(packet, auth.inspect(dom.root), "main", () => ++next), /AUTH_CONTROL_COVERAGE_REFUSED/u,
    "an uncaptured control refuses wherever it is")
  host.children.pop()
  host.childNodeCount = 1
  host.shadowRoots = []
  assert.throws(() => auth.prepare(packet, auth.inspect(dom.root), "main", () => ++next), /AUTH_CONTROL_COVERAGE_REFUSED/u)
  host.shadowRoots = [{ nodeType: 11, nodeName: "#document-fragment", backendNodeId: 132, shadowRootType: "open",
    children: [{ nodeType: 3, nodeName: "#text", backendNodeId: 133, nodeValue: "shadow text" }] }]
  assert.throws(() => auth.prepare(packet, auth.inspect(dom.root), "main", () => ++next), /AUTH_CONTROL_COVERAGE_REFUSED/u,
    "shadow content itself must be captured")
})

test("a snapshot invalidated by a live page is retaken, fully re-qualified, within a bounded number of attempts", async () => {
  for (const [fires, expected] of [[1, "ok"], [4, "ok"], [5, "AUTH_SNAPSHOT_INVALIDATED"]]) {
    const root = await mkTempRoot("auth-retry-")
    const native = fakeDriver({ hook: ({ method, count, cdp }) => {
      if (method === "DOM.getDocument" && count % 3 === 2 && (count + 1) / 3 <= fires) cdp.emit("DOM.childNodeInserted", {})
    } })
    const adapter = auth.create(native.context, root, 20000, () => {})
    try {
      if (expected === "ok") {
        const result = await adapter.call(["snapshot", "--save"])
        noPassword(result)
        assert.equal(fs.readdirSync(root).length, 1, "only the final attempt publishes")
      } else {
        await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_SNAPSHOT_INVALIDATED/u)
        assert.deepEqual(fs.readdirSync(root), [])
      }
      const reads = native.calls.filter((call) => call[0] === "cdp" && call[1] === "DOMSnapshot.captureSnapshot").length
      assert.ok(reads >= Math.min(fires + 1, 5))
    } finally { await adapter.close() }
  }
  const root = await mkTempRoot("auth-retry-fixed-")
  let snapshots = 0
  const native = fakeDriver({ hook: ({ method }) => { if (method === "DOMSnapshot.captureSnapshot" && ++snapshots) throw auth.fail("AUTH_FRAME_COVERAGE_REFUSED") } })
  const adapter = auth.create(native.context, root, 5000, () => {})
  try {
    await assert.rejects(adapter.call(["snapshot"]), /AUTH_FRAME_COVERAGE_REFUSED/u)
    assert.equal(snapshots, 1, "a coverage verdict is final")
  } finally { await adapter.close() }
})

test("a coverage refusal from a document that changed between the two native reads is an invalidation", async () => {
  const root = await mkTempRoot("auth-stale-pair-")
  const native = fakeDriver({ hook: ({ method, count, cdp }) => {
    if (method === "DOMSnapshot.captureSnapshot" && count === 1) {
      cdp.emit("DOM.childNodeInserted", {})
      throw auth.fail("AUTH_CONTROL_COVERAGE_REFUSED")
    }
  } })
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot"]), /AUTH_CONTROL_COVERAGE_REFUSED/u, "a native-call failure is not reinterpreted")
  } finally { await adapter.close() }
  const packet = nativeSnapshot()
  const mutating = fakeDriver({ packet, hook: ({ method, count, cdp }) => {
    if (method === "DOMSnapshot.captureSnapshot" && count === 1) {
      cdp.emit("DOM.childNodeInserted", {})
      packet.documents[0].nodes.inputValue = { index: [], value: [] }
    }
  } })
  const stale = adapterFor(mutating, root)
  try {
    await assert.rejects(stale.call(["snapshot"]), /AUTH_SNAPSHOT_INVALIDATED/u)
  } finally { await stale.close() }
  const steady = nativeSnapshot()
  steady.documents[0].nodes.inputValue = { index: [], value: [] }
  const unchanged = adapterFor(fakeDriver({ packet: steady }), root)
  try {
    await assert.rejects(unchanged.call(["snapshot"]), /AUTH_NATIVE_DATA_INVALID/u, "an unchanged document keeps its coverage verdict")
  } finally { await unchanged.close() }
})

// Teams web: the page removes a <script> from <head> between DOM.getDocument and DOMSnapshot.captureSnapshot,
// and its mutation event reaches the reader only with the next native response.
function lateRemovalDriver({ emits = true } = {}) {
  const native = fakeDriver()
  const send = native.cdp.send
  let documents = 0
  let pending = false
  native.cdp.send = async (method, params) => {
    if (pending && method !== "DOMSnapshot.captureSnapshot") { pending = false; if (emits) native.cdp.emit("DOM.childNodeRemoved", {}) }
    const result = await send(method, params)
    if (method === "DOM.getDocument" && ++documents === 1) {
      result.root.children[0].children.unshift({ nodeId: 900, backendNodeId: 900, nodeType: 1, nodeName: "SCRIPT", localName: "script", nodeValue: "", attributes: [], children: [] })
      pending = true
    }
    return result
  }
  return native
}

test("a node removed between the two native reads is a stale pair once its late mutation event arrives, never a coverage verdict", async () => {
  const root = await mkTempRoot("auth-late-removal-")
  const once = adapterFor(lateRemovalDriver(), root)
  try { await assert.rejects(once.call(["snapshot"]), /AUTH_SNAPSHOT_INVALIDATED/u) } finally { await once.close() }
  const native = lateRemovalDriver()
  const settles = auth.create(native.context, root, 5000, () => {})
  try { assert.match((await settles.call(["snapshot"])).text, /Password/u) } finally { await settles.close() }
})

test("a coverage mismatch with no mutation behind it is still refused as coverage", async () => {
  const root = await mkTempRoot("auth-late-removal-none-")
  const native = lateRemovalDriver({ emits: false })
  const adapter = auth.create(native.context, root, 5000, () => {})
  try { await assert.rejects(adapter.call(["snapshot"]), /AUTH_CONTROL_COVERAGE_REFUSED/u) } finally { await adapter.close() }
})

test("a failed round trip before the coverage verdict keeps the coverage refusal", async () => {
  const root = await mkTempRoot("auth-late-removal-flush-")
  const native = lateRemovalDriver({ emits: false })
  const send = native.cdp.send
  native.cdp.send = async (method, params) => {
    if (method === "DOM.getDocument" && params && params.depth === 0) throw new Error("flush unavailable")
    return send(method, params)
  }
  const adapter = adapterFor(native, root)
  try { await assert.rejects(adapter.call(["snapshot"]), /AUTH_CONTROL_COVERAGE_REFUSED/u) } finally { await adapter.close() }
})

test("a control that appears before the protection re-read is a stale pair once its late event arrives", async () => {
  const root = await mkTempRoot("auth-late-insert-")
  for (const [emits, expected] of [[true, /AUTH_SNAPSHOT_INVALIDATED/u], [false, /AUTH_CONTROL_COVERAGE_REFUSED/u]]) {
    const native = fakeDriver()
    const send = native.cdp.send
    let snapshots = 0
    let pending = false
    native.cdp.send = async (method, params) => {
      if (pending && method !== "DOMSnapshot.captureSnapshot") { pending = false; if (emits) native.cdp.emit("DOM.childNodeInserted", {}) }
      const result = await send(method, params)
      if (method === "DOMSnapshot.captureSnapshot" && ++snapshots === 2) {
        const table = result.documents[0].nodes
        table.parentIndex.push(2); table.nodeType.push(1); table.nodeName.push(table.nodeName[3]); table.nodeValue.push(-1)
        table.backendNodeId.push(905); table.attributes.push([])
        result.strings.push(""); table.inputValue.index.push(table.nodeType.length - 1); table.inputValue.value.push(result.strings.length - 1)
        pending = true
      }
      return result
    }
    const adapter = adapterFor(native, root)
    try { await assert.rejects(adapter.call(["snapshot"]), expected) } finally { await adapter.close() }
  }
})

test("after the round trip resets native node bindings, an earlier ref acts only on its unchanged node", async () => {
  const root = await mkTempRoot("auth-flush-refs-")
  const native = fakeDriver()
  const send = native.cdp.send
  let documents = 0
  native.cdp.send = async (method, params) => {
    const result = await send(method, params)
    // The second snapshot's scope has a node its packet lacks, and no change event ever explains it.
    if (method === "DOM.getDocument" && params && params.depth === -1 && ++documents === 4) {
      result.root.children[0].children.unshift({ nodeId: 900, backendNodeId: 900, nodeType: 1, nodeName: "SCRIPT", localName: "script", nodeValue: "", attributes: [], children: [] })
    }
    return result
  }
  const adapter = adapterFor(native, root)
  try {
    const first = await adapter.call(["snapshot"])
    const ref = first.text.match(/\[ref=(\w+)\]/u)[1]
    await assert.rejects(adapter.call(["snapshot"]), /AUTH_CONTROL_COVERAGE_REFUSED/u)
    const label = native.packet.documents[0].nodes.attributes[3]
    native.packet.strings.push("Delete everything")
    label[3] = native.packet.strings.length - 1
    await assert.rejects(adapter.call(["click", ref]), /AUTH_SNAPSHOT_INVALIDATED/u, "its own label changed unseen")
    assert.equal(native.calls.some((call) => call[0] === "click"), false, "nothing is clicked")
  } finally { await adapter.close() }
})

// Live pages (Teams web) change somewhere every few milliseconds; a ref is re-resolved when it is used.
function inputRef(snapshot) { return snapshot.snapshot.children[0].children[0].children[0].ref }

test("a ref acts after the page changed elsewhere, but not after its own node changed or the main frame navigated", async () => {
  const root = await mkTempRoot("auth-live-ref-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root)
  try {
    let ref = inputRef(await adapter.call(["snapshot"]))
    native.cdp.emit("DOM.childNodeRemoved", {})
    native.cdp.emit("DOM.attributeModified", {})
    await adapter.call(["click", ref])
    assert.equal(native.calls.filter((call) => call[0] === "click").length, 1, "elsewhere changes do not block the action")
    ref = inputRef(await adapter.call(["snapshot"]))
    const attrs = native.packet.documents[0].nodes.attributes[3]
    native.packet.strings.push("highlighted")
    attrs.push(native.packet.strings.indexOf("class") === -1 ? (native.packet.strings.push("class"), native.packet.strings.length - 1) : native.packet.strings.indexOf("class"), native.packet.strings.indexOf("highlighted"))
    await adapter.call(["click", ref])
    assert.equal(native.calls.filter((call) => call[0] === "click").length, 2, "a presentation-only change is not a different element")
    ref = inputRef(await adapter.call(["snapshot"]))
    native.packet.strings.push("Delete everything")
    attrs[3] = native.packet.strings.length - 1
    await assert.rejects(adapter.call(["click", ref]), /AUTH_SNAPSHOT_INVALIDATED/u)
    assert.equal(native.calls.filter((call) => call[0] === "click").length, 2, "its own label changed")
    ref = inputRef(await adapter.call(["snapshot"]))
    const send = native.cdp.send
    native.cdp.send = async (method, params) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main", loaderId: "next", mimeType: "text/html" } } } : send(method, params)
    await assert.rejects(adapter.call(["click", ref]), /AUTH_SNAPSHOT_INVALIDATED/u)
    assert.equal(native.calls.filter((call) => call[0] === "click").length, 2, "the main frame navigated")
  } finally { await adapter.close() }
})

test("when the page changes while the ref binds, the browser must name the same node at its path", async () => {
  for (const [backendNodeId, acts] of [[104, true], [999, false], [0, false]]) {
    const root = await mkTempRoot("auth-live-bind-")
    const native = fakeDriver()
    const send = native.cdp.send
    native.cdp.send = async (method, params) => {
      if (method === "DOM.querySelector") { native.calls.push(["cdp", method, params]); return { nodeId: backendNodeId ? 7 : 0 } }
      if (method === "DOM.describeNode") { native.calls.push(["cdp", method, params]); return { node: { backendNodeId } } }
      return send(method, params)
    }
    const frame = native.page.mainFrame()
    const wait = frame.waitForSelector
    frame.waitForSelector = async (...args) => { native.cdp.emit("DOM.childNodeInserted", {}); return wait(...args) }
    const adapter = adapterFor(native, root)
    try {
      const ref = inputRef(await adapter.call(["snapshot"]))
      if (acts) await adapter.call(["click", ref])
      else await assert.rejects(adapter.call(["click", ref]), /AUTH_SNAPSHOT_INVALIDATED/u)
      assert.equal(native.calls.some((call) => call[0] === "click"), acts)
      assert.ok(native.calls.some((call) => call[0] === "cdp" && call[1] === "DOM.querySelector" && /input:nth-of-type\(1\)$/u.test(call[2].selector)))
      assert.ok(native.calls.some((call) => call[0] === "dispose" && call[1] === 104), "the bound handle is disposed either way")
    } finally { await adapter.close() }
  }
})

test("typing goes to the editing host of a rich-text editor, and the field reports whether it holds the text", async () => {
  const root = await mkTempRoot("auth-editor-")
  const native = fakeDriver()
  const inner = native.handles.get(104)
  const host = { calls: [], dispose: async () => { native.calls.push(["disposeHost", "editor"]) } }
  for (const method of ["scrollIntoViewIfNeeded", "fill", "type", "press"]) host[method] = async (...args) => { native.calls.push(["host." + method, ...args]) }
  let holds = "typed text"
  host.evaluate = async (fn, arg) => fn({ isContentEditable: true, innerText: holds }, arg)
  inner.evaluateHandle = async (fn) => {
    native.calls.push(["evaluateHandle", 104])
    assert.equal(fn({ isContentEditable: false }).isContentEditable, false, "a plain control is its own target")
    const editor = { isContentEditable: true, parentElement: { isContentEditable: false } }
    const paragraph = { isContentEditable: true, parentElement: editor }
    assert.equal(fn(paragraph), editor, "a paragraph inside an editor resolves to the editor")
    return { asElement: () => host, dispose: host.dispose }
  }
  const adapter = adapterFor(native, root)
  try {
    let result = await adapter.call(["type", inputRef(await adapter.call(["snapshot"])), "typed text"])
    assert.deepEqual(result.typed, { verified: true })
    assert.ok(native.calls.some((call) => call[0] === "host.type" && call[1] === "typed text"))
    assert.equal(native.calls.some((call) => call[0] === "type"), false, "the inner node never takes the keys")
    holds = "something else"
    result = await adapter.call(["fill", inputRef(await adapter.call(["snapshot"])), "typed text"])
    assert.deepEqual(result.typed, { verified: false })
    assert.equal(JSON.stringify(result).includes("something else"), false, "read-back reports a verdict, never the field's text")
    result = await adapter.call(["press", inputRef(await adapter.call(["snapshot"])), "Enter"])
    assert.equal(result.typed, undefined)
    assert.ok(native.calls.some((call) => call[0] === "host.press" && call[1] === "Enter"))
    assert.equal(native.calls.filter((call) => call[0] === "disposeHost").length, 3)
    await adapter.call(["click", inputRef(await adapter.call(["snapshot"]))])
    assert.equal(native.calls.filter((call) => call[0] === "evaluateHandle").length, 3, "a click acts on the node it names")
  } finally { await adapter.close() }
})

test("an element's fingerprint is its name, non-presentation attributes and subtree text, never a child frame's content", () => {
  const el = (name, attributes, children = [], extra = {}) => ({ nodeType: 1, nodeName: name, attributes, children, ...extra })
  const text = (value) => ({ nodeType: 3, nodeName: "#text", nodeValue: value })
  const base = el("BUTTON", ["aria-label", "Cancel", "class", "a"], [text("Cancel")])
  const fp = auth.fingerprint
  assert.equal(fp(base), fp(el("BUTTON", ["aria-label", "Cancel", "class", "b", "style", "x"], [text("Cancel")])), "presentation is ignored")
  assert.notEqual(fp(base), fp(el("BUTTON", ["aria-label", "Delete", "class", "a"], [text("Cancel")])), "a label change is a change")
  assert.notEqual(fp(base), fp(el("BUTTON", ["aria-label", "Cancel"], [text("Delete")])), "a text change is a change")
  assert.equal(fp({ nodeType: 1, nodeName: "DIV" }), fp(el("DIV", [])), "missing attributes and children are empty")
  assert.equal(fp(el("IFRAME", [], [], { contentDocument: { nodeType: 9, nodeName: "#document", children: [text("one")] } })),
    fp(el("IFRAME", [], [], { contentDocument: { nodeType: 9, nodeName: "#document", children: [text("two")] } })), "a child frame is never read")
  const host = (inside, type = "open") => el("DIV", [], [], { shadowRoots: [{ nodeType: 11, nodeName: "#document-fragment", shadowRootType: type, children: [text(inside)] }] })
  assert.notEqual(fp(host("one")), fp(host("two")), "open shadow content counts")
  assert.equal(fp(host("one", "user-agent")), fp(host("two", "user-agent")), "browser-internal trees do not")
})

test("read-back compares whitespace-normalised text and treats a missing value as empty", () => {
  assert.equal(auth.HOLDS({ isContentEditable: false }, ["", "fill"]), true)
  assert.equal(auth.HOLDS({ isContentEditable: false, value: "a  b\n" }, ["a b", "fill"]), true)
  assert.equal(auth.HOLDS({ isContentEditable: true, innerText: "before a b after" }, ["a b", "type"]), true)
  assert.equal(auth.HOLDS({ isContentEditable: true, innerText: "before a b after" }, ["a b", "fill"]), false)
})

test("an editing host that is not an element falls back to the node the ref names", async () => {
  const root = await mkTempRoot("auth-editor-fallback-")
  const native = fakeDriver()
  const inner = native.handles.get(104)
  inner.evaluateHandle = async () => ({ asElement: () => null, dispose: async () => { native.calls.push(["disposeHost", 104]) } })
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["fill", inputRef(await adapter.call(["snapshot"])), "x"])
    assert.ok(native.calls.some((call) => call[0] === "fill" && call[1] === "x"))
    assert.deepEqual(result.typed, { verified: true })
    assert.ok(native.calls.some((call) => call[0] === "disposeHost"))
  } finally { await adapter.close() }
})

test("a rich-text editor's host is a textbox named by its author label, its content and a label repeating it still redacted", () => {
  const find = (node, role) => node.role === role ? node : (node.children || []).map((child) => find(child, role)).find(Boolean)
  for (const [label, shown] of [["Type a message", "Type a message"], [PASSWORD, "[redacted]"]]) {
    const packet = editingSnapshot()
    packet.strings.push("aria-label", label)
    packet.documents[0].nodes.attributes[3] = [packet.strings.length - 2, packet.strings.length - 1]
    const tree = sanitize(packet)
    const box = find(tree, "textbox")
    assert.ok(box, "the editing host is a textbox")
    assert.equal(box.name, shown)
    noPassword(tree)
  }
  const nested = editingSnapshot()
  const tree = sanitize(nested)
  assert.equal(JSON.stringify(tree).match(/"textbox"/gu).length, 1, "only the editing host, not its editable children")
  assert.equal(find(sanitize(editingSnapshot("read-only")), "textbox"), undefined, "read-only content is not a textbox")
})
