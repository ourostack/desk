import { test } from "node:test"
import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { deskFailure } from "../../../../../plugins/desk/mcp/src/runtime/desk-failure.js"
import { vagueFailuresIn } from "../../../../../plugins/desk/mcp/src/lib/ouro-ui/registry/ouro/ax/precise-copy.ts"
import { mkTempRoot } from "../_temp_roots.js"
import { nativeSnapshot, editingSnapshot, inspectedDOM, fakeDriver, framedSnapshot, pageNode, PASSWORD, FRAME_TEXT, FALLBACK_TEXT, FRAME_TYPED, FRAME_EDITED } from "./_auth_fixtures.js"

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

// Every node of a snapshot tree, in page order.
function all(node) { return [node, ...(node.children || []).flatMap(all)] }

// A page mid-navigation: each capture sees a newer document than the DOM read just before it.
function navigating(packet) { packet.documents[0].nodes.backendNodeId[0] += 1000 }

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

test("a child frame's document is read inside its owner: its text shows, its fallback does not, and what was typed there stays redacted", () => {
  const packet = framedSnapshot()
  let next = 0
  const prepared = auth.prepare(packet, auth.inspect(inspectedDOM(packet).root), "main", () => ++next)
  const text = JSON.stringify(prepared.tree)
  assert.ok(text.includes("Main product title"))
  assert.ok(text.includes(FRAME_TEXT), "the frame's page text is read")
  for (const hidden of [FALLBACK_TEXT, FRAME_TYPED, FRAME_EDITED, PASSWORD]) assert.equal(text.includes(hidden), false, hidden)
  assert.equal(prepared.frames, 0)
  const frame = prepared.tree.children[0].children[0].children.find((node) => node.role === "frame")
  assert.equal(frame.children[0].role, "document")
  assert.ok(JSON.stringify(frame).includes(FRAME_TEXT))
  const control = prepared.targets.find((target) => target.id === 205)
  assert.ok(control, "a control in the frame has a ref")
  assert.match(control.path, /^html:nth-of-type\(1\) > body:nth-of-type\(1\) > input:nth-of-type\(1\)$/u, "its path is from the frame's own document")
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
    (p) => { p.documents[1].nodes.nodeType = [] },
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

test("a page that changes throughout a read is read from its one capture; a tab that closes during it refuses all output", async () => {
  for (const event of ["DOM.shadowRootPushed", "DOM.documentUpdated", "DOM.childNodeInserted", "DOM.attributeModified", "Runtime.executionContextDestroyed"]) {
    const root = await mkTempRoot("auth-fence-")
    const native = fakeDriver({ hook: ({ method, cdp }) => {
      if (method === "DOM.getDocument" || method === "DOMSnapshot.captureSnapshot") cdp.emit(event, {})
    } })
    const adapter = adapterFor(native, root)
    try {
      const result = await adapter.call(["snapshot", "--save"])
      noPassword(result)
      noPassword(fs.readFileSync(result.artifact, "utf8"))
      assert.equal(native.calls.filter((call) => call[0] === "cdp" && call[1] === "DOMSnapshot.captureSnapshot").length, 1, "one capture, no re-reads")
      assert.equal(native.calls.some((call) => call[0] === "waitForSelector"), false, "a snapshot binds no element")
      await adapter.call(["click", inputRef(result)])
      assert.equal(native.calls.filter((call) => call[0] === "click").length, 1, "its refs act on the busy page")
    } finally { await adapter.close() }
  }
  const root = await mkTempRoot("auth-fence-close-")
  const native = fakeDriver({ hook: ({ method, cdp }) => { if (method === "DOMSnapshot.captureSnapshot") cdp.emit("close", {}) } })
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot", "--save"]), /AUTH_CONTEXT_REFUSED/u)
    assert.deepEqual(fs.readdirSync(root), [])
  } finally { await adapter.close() }
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
  assert.deepEqual(fs.readdirSync(root).filter((name) => !/^screenshot-[0-9a-f-]{36}\.png$/u.test(name)), [], "only the evidence picture is kept")
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

test("a read is protected by its own capture: text made editable after it is redacted from the next read on", async () => {
  const root = await mkTempRoot("auth-css-continuity-")
  const packet = editingSnapshot("read-only")
  const change = () => {
    packet.strings.push("read-write")
    packet.documents[0].layout.styles[2][2] = packet.strings.length - 1
    packet.documents[0].layout.styles[3][2] = packet.strings.length - 1
  }
  const native = fakeDriver({ packet })
  const restore = hookStageWrites(root, change)
  const adapter = adapterFor(native, root)
  try {
    const saved = await adapter.call(["snapshot", "--save"])
    assert.ok(saved.text.includes(PASSWORD), "read-only page text at the capture is page text")
    assert.equal(JSON.parse(fs.readFileSync(saved.artifact, "utf8")).text, saved.text, "the artifact is that capture's read")
    noPassword(await adapter.call(["snapshot"]))
  } finally { restore(); await adapter.close() }
})

test("privately branded error data remains safe if public error properties are replaced", async () => {
  const root = await mkTempRoot("auth-error-data-")
  let reads = 0
  const owned = auth.fail("AUTH_FRAME_COVERAGE_REFUSED")
  for (const key of ["message", "authCode"]) Object.defineProperty(owned, key, { get() { reads++; throw new Error(PASSWORD) } })
  const native = fakeDriver({ hook: ({ method }) => { if (method === "DOMSnapshot.captureSnapshot") throw owned } })
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot"]), (error) =>
      error.message.includes("AUTH_FRAME_COVERAGE_REFUSED") && !error.message.includes(PASSWORD))
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
    const native = fakeDriver()
    for (const handle of native.handles.values()) handle.dispose = async () => { throw new Error(PASSWORD) }
    const restore = hookStageWrites(root, () => native.page.emit("crash"))
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
        assert.ok(error.message.includes("AUTH_CONTEXT_REFUSED"))
        assert.equal(error.message.includes("AUTH_HANDLE_CLEANUP_FAILED"), false, "a snapshot owns no element handles")
        if (failUnlink) assert.ok(error.message.includes("AUTH_ARTIFACT_CLEANUP_FAILED"))
        return true
      })
      assert.equal(attempts, 1, "owned stage removal is still attempted")
      assert.equal(fs.readdirSync(root).length, failUnlink ? 1 : 0)
    } finally {
      fs.promises.unlink = original
      restore()
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
  const native = fakeDriver()
  const restore = hookStageWrites(root, (file) => {
    stage = file
    fs.renameSync(stage, stage + ".displaced")
    fs.writeFileSync(stage, "FAKE_FOREIGN_FILE")
  })
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

test("a value typed after a read is redacted from the next read on, wherever the page repeats it", async () => {
  const root = await mkTempRoot("auth-value-continuity-")
  const packet = nativeSnapshot({ value: "" })
  packet.strings.push(PASSWORD)
  const marker = packet.strings.length - 1
  packet.documents[0].nodes.attributes[3][3] = marker
  const change = () => { packet.documents[0].nodes.inputValue.value[0] = marker }
  const native = fakeDriver({ packet })
  const restore = hookStageWrites(root, change)
  const adapter = adapterFor(native, root)
  try {
    const saved = await adapter.call(["snapshot", "--save"])
    assert.equal(JSON.parse(fs.readFileSync(saved.artifact, "utf8")).text, saved.text, "the artifact is that capture's read")
    noPassword(await adapter.call(["snapshot"]))
  } finally { restore(); await adapter.close() }
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
    const scroll = native.calls.find((call) => call[0] === "scrollIntoViewIfNeeded")[1]
    assert.ok(scroll.timeout > 0 && scroll.timeout <= 2500, "the action's deadline is half the command's time, not all of it")
  } finally { await adapter.close() }
})

// Playwright's timeout error, as the client sees it: its class name is the only part the code relies on.
function timeoutError(message) {
  const error = new Error(message)
  error.name = "TimeoutError"
  return error
}

test("ref actions share one deadline under the command's time, so a stalled step fails before the command does", async () => {
  const root = await mkTempRoot("auth-action-deadline-")
  const native = fakeDriver()
  const handle = native.handles.get(104)
  const seen = []
  handle.scrollIntoViewIfNeeded = async (options) => { seen.push(["scroll", options.timeout]); await new Promise((resolve) => setTimeout(resolve, 300)) }
  handle.click = async (options) => { seen.push(["click", options.timeout]) }
  const adapter = adapterFor(native, root)
  try {
    const input = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
    await adapter.call(["click", input.ref])
    const [scroll, click] = seen.map(([, timeout]) => timeout)
    assert.ok(scroll > 0 && scroll <= 2500)
    assert.ok(click >= 1 && scroll - click >= 200, "the click gets only what the scroll left of the shared deadline")
  } finally { await adapter.close() }
})

test("a Playwright timeout on an action keeps the context open with a recoverable code, and says nothing of the page", async () => {
  const root = await mkTempRoot("auth-action-covered-")
  const native = fakeDriver()
  const handle = native.handles.get(104)
  const click = handle.click
  const adapter = adapterFor(native, root)
  try {
    const input = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
    handle.click = async () => { throw timeoutError("<span>" + PASSWORD + "</span> intercepts pointer events") }
    await assert.rejects(adapter.call(["click", input.ref]), error =>
      error.message.includes("AUTH_ACTION_COVERED") && error.message.includes("may have applied") && !error.message.includes(PASSWORD))
    assert.equal(native.calls.some((call) => call[0] === "context.close"), false, "the context is not closed")
    handle.click = click
    noPassword(await adapter.call(["snapshot"]))
  } finally { handle.click = click; await adapter.close() }
})

test("Playwright's timeout wording maps to fixed codes, and its text never reaches the output", async () => {
  const root = await mkTempRoot("auth-action-codes-")
  const native = fakeDriver()
  const handle = native.handles.get(104)
  const click = handle.click
  const adapter = adapterFor(native, root)
  const cases = [
    ["<div>" + PASSWORD + "</div> intercepts pointer events", "AUTH_ACTION_COVERED"],
    ["element is not visible " + PASSWORD, "AUTH_ACTION_NOT_READY"],
    ["element is not stable", "AUTH_ACTION_NOT_READY"],
    ["element is not enabled", "AUTH_ACTION_NOT_READY"],
    ["waiting for " + PASSWORD, "AUTH_ACTION_TIMEOUT"],
  ]
  try {
    const input = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0]
    for (const [message, code] of cases) {
      handle.click = async () => { throw timeoutError(message) }
      await assert.rejects(adapter.call(["click", input.ref]), error =>
        error.message.includes(code) && !error.message.includes(PASSWORD) && !error.message.includes("intercepts"))
    }
    assert.equal(native.calls.some((call) => call[0] === "context.close"), false)
  } finally { handle.click = click; await adapter.close() }
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
    await assert.rejects(adapter.call(["tab-close"]), /AUTH_TAB_REFUSED.*tab-list/u)
    await assert.rejects(adapter.call(["tab-select", "3"]), /AUTH_TAB_REFUSED.*tab-list/u)
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
  assert.deepEqual(fs.readdirSync(root).filter(name => !/^screenshot-/u.test(name)), [], "only the evidence picture is kept")
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
  const send = native.cdp.send
  native.cdp.send = async (method, params) => method === "Page.getFrameTree"
    ? { frameTree: { frame: { id: "main", loaderId: "loader" }, childFrames: [{ frame: { id: "child", parentId: "main", loaderId: "child-loader" } }] } }
    : send(method, params)
  return native
}

test("a page with a child frame reads and saves the frame's content without its fallback or typed values, and a ref in it acts through its owner", async () => {
  const root = await mkTempRoot("auth-tree-child-")
  const native = framedDriver()
  const send = native.cdp.send
  // The browser names each path: the frame owner's in the page, the field's in the frame's document.
  const named = { owner: 107, child: 201 }
  native.cdp.send = async (method, params) => {
    if (method === "DOM.querySelector") { native.calls.push(["cdp", method, params]); return { nodeId: /iframe:nth-of-type\(1\)$/u.test(params.selector) ? 8 : 7 } }
    if (method === "DOM.describeNode") { native.calls.push(["cdp", method, params]); return { node: { backendNodeId: params.nodeId === 8 ? named.owner : 205 } } }
    if (method === "DOM.getDocument") {
      const dom = await send(method, params)
      const owner = (function find(node) { return node.backendNodeId === 107 ? node : (node.children || []).map(find).find(Boolean) })(dom.root)
      // Each bind reads the page, then confirms: a document replaced in between is seen only by the confirmation.
      if (params.pierce && (named.child !== 201 || named.tree) && (named.reads = (named.reads ?? 0) + 1) % 2 === 0) {
        owner.contentDocument.backendNodeId = named.child
        if (named.tree) owner.backendNodeId = named.tree
      }
      return dom
    }
    return send(method, params)
  }
  const adapter = adapterFor(native, root)
  try {
    // Between the read and the action, the owner's path comes to name another iframe, or the frame shows another
    // document: the field at the same path in it is not the one the ref was read in, so nothing is filled there.
    for (const [moved, expected] of [[{ owner: 999 }, "owner"], [{ child: 299 }, "document"], [{ tree: 777 }, "owner gone from the document"]]) {
      const read = await adapter.call(["snapshot"])
      const stale = all(all(read.snapshot).find((node) => node.role === "frame")).find((node) => node.role === "textbox")
      Object.assign(named, moved)
      const confirmations = native.calls.filter((call) => call[1] === "DOM.getDocument").length
      await assert.rejects(adapter.call(["fill", stale.ref, "elsewhere"]), /AUTH_SNAPSHOT_INVALIDATED/u, expected)
      assert.ok(native.calls.filter((call) => call[1] === "DOM.getDocument").length > confirmations)
      assert.equal(native.calls.some((call) => call[0] === "fill"), false, expected)
      Object.assign(named, { owner: 107, child: 201, reads: 0, tree: undefined })
    }
    const result = await adapter.call(["snapshot", "--save"])
    assert.equal(result.framesOmitted, undefined)
    assert.ok(result.text.includes("Main product title"))
    assert.ok(result.text.includes(FRAME_TEXT))
    assert.match(result.text, /^ *- frame/mu)
    const artifact = fs.readFileSync(result.artifact, "utf8")
    assert.ok(artifact.includes(FRAME_TEXT))
    for (const hidden of [FALLBACK_TEXT, FRAME_TYPED, FRAME_EDITED, PASSWORD]) {
      assert.equal(JSON.stringify(result).includes(hidden), false, hidden)
      assert.equal(artifact.includes(hidden), false, hidden)
    }
    const frame = all(result.snapshot).find((node) => node.role === "frame")
    const field = all(frame).find((node) => node.role === "textbox")
    const filled = await adapter.call(["fill", field.ref, "literal"])
    const waits = native.calls.filter((call) => call[0] === "waitForSelector").map((call) => call[1])
    assert.match(waits[0], /iframe:nth-of-type\(1\)$/u, "through the frame's owner")
    assert.equal(waits[1], "css=html:nth-of-type(1) > body:nth-of-type(1) > input:nth-of-type(1)")
    const confirm = native.calls.filter((call) => call[1] === "DOM.querySelector").slice(-2)
    assert.equal(confirm[0][2].nodeId, 1, "the browser confirms the owner's path in the page")
    assert.equal(confirm[1][2].nodeId, 1001, "and the field's path inside the frame's document")
    assert.equal(native.packet.strings[native.packet.documents[1].nodes.inputValue.value[0]], "literal")
    assert.equal(filled.typed.verified, true)
    assert.equal(JSON.stringify(filled).includes("literal"), false)
    for (const call of native.calls.filter((call) => call[0] === "dispose")) assert.ok([107, 205].includes(call[1]))
  } finally { await adapter.close() }
})

test("frame and navigation events during a read do not refuse it; a document replaced between the DOM read and the capture is read again", async () => {
  for (const [event, params] of [
    ["Page.frameNavigated", { frame: { id: "child", parentId: "main", loaderId: "next" } }],
    ["Page.frameAttached", { frameId: "child2", parentFrameId: "child" }],
    ["Page.frameDetached", { frameId: "child" }],
    ["Page.frameNavigated", { frame: { id: "main", loaderId: "next" } }],
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
      const result = await adapter.call(["snapshot"])
      assert.equal(result.framesOmitted, undefined)
      assert.ok(result.text.includes(FRAME_TEXT))
    } finally { await adapter.close() }
  }
  for (const [attempts, expected] of [[1, /AUTH_SNAPSHOT_INVALIDATED/u], [undefined, null]]) {
    const native = framedDriver()
    let replaced = 0
    const send = native.cdp.send
    native.cdp.send = async (method, params) => {
      if (method === "DOMSnapshot.captureSnapshot" && ++replaced === 1) navigating(native.packet)
      return send(method, params)
    }
    const adapter = auth.create(native.context, await mkTempRoot("auth-replaced-"), 5000, () => {}, attempts ? { snapshotAttempts: attempts } : undefined)
    try {
      if (expected) await assert.rejects(adapter.call(["snapshot"]), expected)
      else assert.ok((await adapter.call(["snapshot"])).text.includes(FRAME_TEXT), "the next attempt reads the new document")
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
  const native = fakeDriver()
  const restore = hookStageWrites(root, () => { throw auth.fail("") })
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
    restore()
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
  assert.equal(text.includes("\"US\""), false, "hidden text is not on screen, so it is not read")
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

test("nodes the DOM read has but the capture lacks (unslotted, or removed between them) are not read and get no ref", () => {
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
  const read = () => auth.prepare(packet, auth.inspect(dom.root), "main", () => ++next)
  noPassword(read().tree)
  host.children.push({ nodeType: 1, nodeName: "INNER-EL", backendNodeId: 134, childNodeCount: 1,
    children: [{ nodeType: 1, nodeName: "INPUT", backendNodeId: 137, children: [] }],
    shadowRoots: [{ nodeType: 11, nodeName: "#document-fragment", backendNodeId: 135, shadowRootType: "open",
      children: [{ nodeType: 3, nodeName: "#text", backendNodeId: 136, nodeValue: "nested" }] }] })
  host.childNodeCount = 2
  host.shadowRoots[0].children.push({ nodeType: 3, nodeName: "#text", backendNodeId: 133, nodeValue: "shadow text" })
  const prepared = read()
  noPassword(prepared.tree)
  const text = JSON.stringify(prepared.tree)
  for (const absent of ["Nov 9", "nested", "shadow text"]) assert.equal(text.includes(absent), false, absent)
  assert.equal(prepared.targets.some((target) => [131, 134, 137].includes(target.id)), false, "nothing the capture lacks has a ref")
  assert.ok(prepared.targets.some((target) => target.id === 104), "the rest of the page keeps its refs")
})

test("a document replaced between the DOM read and the capture is read again, within a bounded number of attempts", async () => {
  for (const [fires, expected] of [[1, "ok"], [4, "ok"], [5, "AUTH_SNAPSHOT_INVALIDATED"]]) {
    const root = await mkTempRoot("auth-retry-")
    const packet = nativeSnapshot()
    const native = fakeDriver({ packet, hook: ({ method, count }) => {
      if (method === "DOMSnapshot.captureSnapshot" && count <= fires) navigating(packet)
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
      assert.equal(reads, Math.min(fires + 1, 5))
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

test("a capture is judged by the native contract alone: native failures are not reinterpreted and a control without its value refuses", async () => {
  const root = await mkTempRoot("auth-stale-pair-")
  const native = fakeDriver({ hook: ({ method, count, cdp }) => {
    if (method === "DOMSnapshot.captureSnapshot" && count === 1) {
      cdp.emit("DOM.childNodeInserted", {})
      throw auth.fail("AUTH_FRAME_COVERAGE_REFUSED")
    }
  } })
  const adapter = adapterFor(native, root)
  try {
    await assert.rejects(adapter.call(["snapshot"]), /AUTH_FRAME_COVERAGE_REFUSED/u, "a native-call failure is not reinterpreted")
  } finally { await adapter.close() }
  const steady = nativeSnapshot()
  steady.documents[0].nodes.inputValue = { index: [], value: [] }
  const unchanged = adapterFor(fakeDriver({ packet: steady }), root)
  try {
    await assert.rejects(unchanged.call(["snapshot"]), /AUTH_NATIVE_DATA_INVALID/u, "a control the capture has without its value is never guessed")
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

test("Teams removing a script between the DOM read and the capture does not stop the read", async () => {
  const root = await mkTempRoot("auth-late-removal-")
  for (const emits of [true, false]) {
    const once = adapterFor(lateRemovalDriver({ emits }), root)
    try { assert.match((await once.call(["snapshot"])).text, /Password/u) } finally { await once.close() }
  }
})

test("a control only the capture has is read without a ref, and its value stays redacted", async () => {
  const root = await mkTempRoot("auth-late-insert-")
  const native = fakeDriver()
  const send = native.cdp.send
  native.cdp.send = async (method, params) => {
    const result = await send(method, params)
    if (method === "DOMSnapshot.captureSnapshot") {
      native.cdp.emit("DOM.childNodeInserted", {})
      const table = result.documents[0].nodes
      table.parentIndex.push(2); table.nodeType.push(1); table.nodeName.push(table.nodeName[3]); table.nodeValue.push(-1)
      table.backendNodeId.push(905); table.attributes.push([])
      result.strings.push("LATE_TYPED_VALUE_679"); table.inputValue.index.push(table.nodeType.length - 1); table.inputValue.value.push(result.strings.length - 1)
      result.documents[0].layout.nodeIndex.push(table.nodeType.length - 1)
      result.documents[0].layout.styles.push(result.documents[0].layout.styles[2].slice())
    }
    return result
  }
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["snapshot"])
    noPassword(result)
    assert.equal(JSON.stringify(result).includes("LATE_TYPED_VALUE_679"), false)
    const fields = all(result.snapshot).filter((node) => node.role === "textbox")
    assert.equal(fields.length, 2)
    assert.equal(fields.filter((node) => node.ref).length, 1, "only the control the DOM read names has a ref")
  } finally { await adapter.close() }
})

test("a ref from an earlier read acts only on its unchanged node, whatever later reads saw", async () => {
  const root = await mkTempRoot("auth-flush-refs-")
  const native = fakeDriver()
  const send = native.cdp.send
  let documents = 0
  native.cdp.send = async (method, params) => {
    const result = await send(method, params)
    // The second snapshot's DOM read has a node its capture lacks.
    if (method === "DOM.getDocument" && params && params.depth === -1 && ++documents === 2) {
      result.root.children[0].children.unshift({ nodeId: 900, backendNodeId: 900, nodeType: 1, nodeName: "SCRIPT", localName: "script", nodeValue: "", attributes: [], children: [] })
    }
    return result
  }
  const adapter = adapterFor(native, root)
  try {
    const first = await adapter.call(["snapshot"])
    const ref = first.text.match(/\[ref=(\w+)\]/u)[1]
    assert.match((await adapter.call(["snapshot"])).text, /Password/u)
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

// A rich-text editor: an editable DIV (the host) holding an editable P, both refs in the snapshot.
function editorPacket() {
  const packet = editingSnapshot()
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  const document = packet.documents[0]
  const nodes = document.nodes
  nodes.parentIndex.push(3); nodes.nodeType.push(1); nodes.nodeName.push(s("P")); nodes.nodeValue.push(-1)
  nodes.backendNodeId.push(106); nodes.attributes.push([])
  document.layout.nodeIndex.push(5)
  document.layout.styles.push(document.layout.styles[3].slice())
  document.layout.bounds.push([0, 0, 100, 20]); document.layout.text.push(-1)
  return packet
}
function browserNames(native, byTag) {
  const send = native.cdp.send
  native.cdp.send = async (method, params) => {
    if (method === "DOM.querySelector") { native.calls.push(["cdp", method, params]); return { nodeId: 7, selector: params.selector } }
    if (method === "DOM.describeNode") { native.calls.push(["cdp", method, params]); return { node: { backendNodeId: byTag(native.calls.filter((c) => c[1] === "DOM.querySelector").at(-1)[2].selector) } } }
    return send(method, params)
  }
}

test("keys typed at a node inside a rich-text editor go to its editing host, chosen from the snapshot and confirmed by the browser", async () => {
  const root = await mkTempRoot("auth-editor-")
  const native = fakeDriver({ packet: editorPacket() })
  browserNames(native, (selector) => /div:nth-of-type\(1\)$/u.test(selector) ? 104 : /p:nth-of-type\(1\)$/u.test(selector) ? 106 : 0)
  native.handles.get(104).evaluate = async (fn, arg) => fn(pageNode(native.focus, native.handles.get(104), { tagName: "DIV", isContentEditable: true, innerText: "typed text" }), arg)
  const adapter = adapterFor(native, root)
  const paragraphRef = (snapshot) => snapshot.text.match(/- generic \[ref=(\w+)\]\n\s*$/u)?.[1] ?? snapshot.text.match(/\[ref=(\w+)\]/gu).at(-1).match(/e\d+/u)[0]
  try {
    let snapshot = await adapter.call(["snapshot"])
    assert.match(snapshot.text, /- textbox \[ref=e\d+\]/u, "the host is a textbox")
    const result = await adapter.call(["type", paragraphRef(snapshot), "typed text"])
    assert.deepEqual(result.typed, { verified: true })
    assert.deepEqual(native.calls.filter((call) => call[0] === "focus").map((call) => call[1]), [104], "it focuses the host")
    const keys = native.calls.filter((call) => call[0] === "keys")
    assert.ok(keys.every((call) => call[1] === 104), "the keys go to the host it focused")
    assert.equal(keys.map((call) => call[2]).join(""), "typed text")
    assert.match(native.calls.filter((call) => call[0] === "waitForSelector").at(-1)[1], /div:nth-of-type\(1\)$/u, "bound at the host")
    assert.ok(native.calls.some((call) => call[0] === "cdp" && call[1] === "DOM.querySelector"), "the browser confirms the host")
    snapshot = await adapter.call(["snapshot"])
    await adapter.call(["click", paragraphRef(snapshot)])
    assert.match(native.calls.filter((call) => call[0] === "waitForSelector").at(-1)[1], /p:nth-of-type\(1\)$/u, "a click acts on the node it names")
  } finally { await adapter.close() }
})

test("an editing host that the browser no longer names at its path, or that is no longer an ancestor, takes no keys", async () => {
  for (const variant of ["moved", "detached"]) {
    const root = await mkTempRoot("auth-editor-refuse-")
    const packet = editorPacket()
    const native = fakeDriver({ packet })
    // "moved": the browser names another node at the host's path. "detached": it names the host correctly, so only
    // the ancestor check can stop the keys, before anything is bound.
    browserNames(native, (selector) => variant === "moved" ? 999 : /div:nth-of-type\(1\)$/u.test(selector) ? 104 : 106)
    const adapter = adapterFor(native, root)
    try {
      const snapshot = await adapter.call(["snapshot"])
      const ref = snapshot.text.match(/\[ref=(\w+)\]/gu).at(-1).match(/e\d+/u)[0]
      if (variant === "detached") packet.documents[0].nodes.parentIndex[5] = 2
      const before = native.calls.length
      await assert.rejects(adapter.call(["fill", ref, "x"]), /AUTH_SNAPSHOT_INVALIDATED/u)
      assert.equal(native.calls.some((call) => call[0] === "fill"), false)
      if (variant === "detached") {
        const after = native.calls.slice(before)
        assert.equal(after.some((call) => call[0] === "waitForSelector" || call[1] === "DOM.querySelector"), false, "refused before binding")
      }
    } finally { await adapter.close() }
  }
})

test("read-back is a strict verdict: a page that answers anything but true reports unverified", async () => {
  const root = await mkTempRoot("auth-readback-")
  const native = fakeDriver()
  native.handles.get(104).evaluate = async () => "true"
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["fill", inputRef(await adapter.call(["snapshot"])), "x"])
    assert.deepEqual(result.typed, { verified: false })
  } finally { await adapter.close() }
})


// A page keeps markup it does not show (a hidden error template, say "Oops, unknown error!"), which must not read as
// if the page showed it.
function templatePage(display = "none", visibility = "visible") {
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const layout = packet.documents[0].layout
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  table.parentIndex.push(2, 4, 2, 6, 2, 8, 9)
  table.nodeType.push(1, 3, 1, 3, 1, 1, 3)
  table.nodeName.push(s("DIV"), s("#text"), s("SECTION"), s("#text"), s("DIV"), s("SPAN"), s("#text"))
  table.nodeValue.push(-1, s("Shown words"), -1, s("Oops, unknown error!"), -1, -1, s("Contents child"))
  table.backendNodeId.push(105, 106, 107, 108, 109, 110, 111)
  table.attributes.push([], [], [], [], [], [], [])
  const css = layout.styles[0]
  const row = (index, styles) => { layout.nodeIndex.push(index); layout.styles.push(styles); layout.bounds.push([0, 0, 10, 10]); layout.text.push(-1) }
  row(4, css.slice()); row(5, css.slice())
  // The template: either no layout at all (display: none) or laid out but hidden.
  if (display !== "none") { row(6, [s(display), s(visibility), css[2]]); row(7, [s(display), s(visibility), css[2]]) }
  // display: contents has no box of its own, yet its children show.
  row(9, css.slice()); row(10, css.slice())
  return packet
}

test("text and elements the page does not show are not read, while hidden controls stay redacted", () => {
  for (const [display, visibility] of [["none", "visible"], ["block", "hidden"], ["block", "collapse"]]) {
    const tree = sanitize(templatePage(display, visibility))
    const text = JSON.stringify(tree)
    noPassword(text)
    assert.equal(text.includes("Oops"), false, `${display}/${visibility} template text is not read`)
    assert.equal(text.includes("section"), false, "an element holding nothing shown is left out")
    assert.ok(text.includes("Shown words"))
    assert.ok(text.includes("Contents child"), "display: contents children still show")
  }
})

test("wait pauses for seconds or milliseconds, or until text shows or goes, and returns a fresh snapshot", async () => {
  const root = await mkTempRoot("auth-native-wait-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root, 8000)
  try {
    let started = Date.now()
    const timed = await adapter.call(["wait", "1"])
    assert.ok(Date.now() - started >= 950, "a number up to 60 is seconds")
    assert.equal(timed.waited.seconds, 1)
    assert.ok(timed.snapshot.children[0].children[0].children[0].ref, "the snapshot's refs are usable")
    started = Date.now()
    assert.equal((await adapter.call(["wait", "300"])).waited.seconds, 0.3, "a larger number is milliseconds")
    assert.ok(Date.now() - started < 950)
    assert.equal((await adapter.call(["wait", "--time", "0.2"])).waited.seconds, 0.2)
    assert.ok((await adapter.call(["wait"])).waited.seconds > 0, "a bare wait pauses briefly")
    const found = await adapter.call(["wait", "password"])
    assert.deepEqual(found.waited, { text: "password", found: true }, "text matches names case-insensitively")
    assert.equal((await adapter.call(["wait", "--text", "Password"])).waited.found, true)
    assert.equal((await adapter.call(["wait", "--gone", "Loading"])).waited.found, true, "text that is gone is found gone at once")
    assert.equal((await adapter.call(["wait", "--text", "-1"])).waited.found, false, "text that starts with - follows --text")
    // Text that never comes gives the last snapshot, not a refusal, within half the command time.
    started = Date.now()
    const missing = await adapter.call(["wait", "never shows"])
    assert.equal(missing.waited.found, false)
    assert.match(missing.hint, /snapshot/u)
    assert.ok(Date.now() - started >= 3900 && Date.now() - started < 7000)
    const ref = missing.snapshot.children[0].children[0].children[0].ref
    await adapter.call(["click", ref])
    for (const args of [["wait", "0"], ["wait", "61000"], ["wait", "-1"], ["wait", ""], ["wait", "--time", "x"], ["wait", "--text", ""], ["wait", "--bogus", "x"], ["wait", "--text"], ["wait", "a".repeat(201)], ["wait", "   "]]) {
      await assert.rejects(adapter.call(args), /AUTH_ARGUMENTS_REFUSED.*wait/u, JSON.stringify(args))
    }
  } finally { await adapter.close() }
})

test("wait keeps waiting through a page that is still changing, and a closed context refuses it", async () => {
  const root = await mkTempRoot("auth-native-wait-churn-")
  let churn = 3
  const native = fakeDriver({
    hook: ({ method, cdp }) => { if (method === "DOMSnapshot.captureSnapshot" && churn-- > 0) cdp.emit("DOM.childNodeCountUpdated", {}) },
  })
  const adapter = adapterFor(native, root, 8000)
  try {
    assert.equal((await adapter.call(["wait", "--text", "password"])).waited.found, true)
    assert.equal(native.calls.filter((call) => call[1] === "DOMSnapshot.captureSnapshot").length, 1, "a busy page is read at once")
  } finally { await adapter.close() }
  await assert.rejects(adapter.call(["wait", "1"]), /AUTH_CONTEXT_REFUSED.*browser_context/u)
  const loading = nativeSnapshot()
  const stuck = fakeDriver({ packet: loading, hook: ({ method }) => { if (method === "DOMSnapshot.captureSnapshot") navigating(loading) } })
  const busy = adapterFor(stuck, await mkTempRoot("auth-native-wait-stuck-"), 2000)
  try {
    await assert.rejects(busy.call(["wait", "password"]), /AUTH_SNAPSHOT_INVALIDATED.*wait/u, "a page that never finishes loading is reported at the deadline")
  } finally { await busy.close() }
  const broken = fakeDriver({ hook: ({ method }) => { if (method === "DOMSnapshot.captureSnapshot") throw new Error(PASSWORD) } })
  const failing = adapterFor(broken, await mkTempRoot("auth-native-wait-broken-"), 8000)
  try {
    const started = Date.now()
    await assert.rejects(failing.call(["wait", "password"]), error => !error.message.includes(PASSWORD) && /^AUTH_/u.test(error.message))
    assert.ok(Date.now() - started < 2000, "a refusal that waiting cannot fix is reported at once")
  } finally { await failing.close() }
})

test("wait for text to go reports when it stays", async () => {
  const root = await mkTempRoot("auth-native-wait-gone-")
  const adapter = adapterFor(fakeDriver(), root, 6000)
  try {
    const stays = await adapter.call(["wait", "--gone", "Password"])
    assert.deepEqual(stays.waited, { text: "Password", found: false })
    assert.match(stays.hint, /did not go within 3 s/u)
  } finally { await adapter.close() }
})

// A request as a page reports it: its frame is the main frame when `main` is set, and it fails with `errorText` when given.
function requestOn(native, url, { type = "xhr", main = false, errorText } = {}) {
  return { url: () => url, resourceType: () => type, isNavigationRequest: () => main, frame: () => native.page.mainFrame(), failure: () => (errorText ? { errorText } : null) }
}

// A wait that runs out polls for half the command's time, and the diagnosis and its picture need the rest: 2 s left a loaded runner
// too little (#855).
const WAIT_OUT_MS = 6000

test("a wait that never finds its text says why, with evidence: hosts and codes, console counts and a picture, and no page text or query", async () => {
  const root = await mkTempRoot("auth-not-ready-")
  const native = fakeDriver()
  native.page.url = () => "https://app.example.test/work/item?token=QUERY_SECRET_688"
  // Time enough after the wait for a picture on a busy runner: the picture only gets what is left of the command's time.
  const adapter = adapterFor(native, root, 4000)
  try {
    const broken = requestOn(native, "https://cdn.example.test/app.js?key=REQUEST_QUERY_688", { type: "script", errorText: "net::ERR_CONNECTION_RESET" })
    native.page.emit("request", broken)
    native.page.emit("requestfailed", broken)
    native.page.emit("request", requestOn(native, "https://files.example.test/doc/PATH_SECRET_688", { type: "fetch" }))
    native.page.emit("console", { type: () => "error", text: () => "CONSOLE_TEXT_688" })
    native.page.emit("console", { type: () => "warning", text: () => "CONSOLE_TEXT_688" })
    native.page.emit("pageerror", new Error("PAGE_ERROR_TEXT_688"))
    const missing = await adapter.call(["wait", "never shows"])
    const { diagnosis } = missing
    assert.equal(missing.waited.found, false)
    assert.equal(diagnosis.url, "https://app.example.test/work/item")
    assert.equal(diagnosis.status, null)
    assert.deepEqual(diagnosis.network.failed, [{ host: "cdn.example.test", type: "script", code: "net_error" }])
    assert.deepEqual(diagnosis.network.pending.map(({ host, type }) => ({ host, type })), [{ host: "files.example.test", type: "fetch" }])
    assert.deepEqual(diagnosis.console, { errors: 1, warnings: 1, pageErrors: 1 })
    assert.equal(diagnosis.signIn, false)
    assert.equal(path.dirname(diagnosis.screenshot), root)
    assert.ok(fs.existsSync(diagnosis.screenshot), "the picture is kept")
    assert.match(missing.hint, /Probably network requests are still pending or failing for cdn\.example\.test, files\.example\.test; /u)
    assert.match(missing.hint, /friction_add with \{"error_code":"auth_page_not_ready"\}/u)
    const shown = JSON.stringify([diagnosis, missing.hint])
    for (const secret of ["QUERY_SECRET_688", "REQUEST_QUERY_688", "PATH_SECRET_688", "CONSOLE_TEXT_688", "PAGE_ERROR_TEXT_688", "token=", "?"]) {
      assert.equal(shown.includes(secret), false, secret)
    }
  } finally { await adapter.close() }
})

test("a page on a sign-in host is waiting on a sign-in redirect, and the hint says so", async () => {
  const root = await mkTempRoot("auth-not-ready-signin-")
  const native = fakeDriver()
  native.page.url = () => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=SIGNIN_QUERY_688"
  const adapter = adapterFor(native, root, WAIT_OUT_MS)
  try {
    native.page.emit("request", requestOn(native, native.page.url(), { type: "document", main: true }))
    const missing = await adapter.call(["wait", "never shows"])
    assert.equal(missing.diagnosis.signIn, true)
    assert.equal(missing.diagnosis.url, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize")
    assert.match(missing.hint, /Probably the page was waiting on a sign-in redirect; /u)
    assert.match(missing.hint, /complete sign-in in the person's own browser, then open a new context/u)
    assert.equal(JSON.stringify(missing.diagnosis).includes("SIGNIN_QUERY_688"), false)
    native.page.url = () => "https://app.example.test/work"
    native.page.emit("request", requestOn(native, "https://github.com/login?return_to=SIGNIN_QUERY_688", { type: "document", main: true }))
    assert.equal((await adapter.call(["wait", "never shows"])).diagnosis.signIn, true, "the last main navigation was to a sign-in page")
    native.page.emit("request", requestOn(native, "https://app.example.test/work", { type: "document", main: true }))
    assert.equal((await adapter.call(["wait", "never shows"])).diagnosis.signIn, false)
  } finally { await adapter.close() }
})

test("a diagnosis shows a host or path that looks like an address or token as redacted, and a main document's failure or status", async () => {
  const root = await mkTempRoot("auth-not-ready-redact-")
  const native = fakeDriver()
  native.page.url = () => "https://app.example.test/mail/user@example.test/"
  const adapter = adapterFor(native, root, WAIT_OUT_MS)
  try {
    const blocked = requestOn(native, "https://0123456789abcdef0123456789abcdef.example.test/x", { type: "xhr", errorText: "net::ERR_BLOCKED_BY_CLIENT" })
    native.page.emit("request", blocked)
    native.page.emit("requestfailed", blocked)
    const missing = await adapter.call(["wait", "never shows"])
    assert.equal(missing.diagnosis.url, "https://app.example.test/[redacted]")
    assert.deepEqual(missing.diagnosis.network.failed, [{ host: "[redacted]", type: "xhr", code: "blocked" }])
    const main = requestOn(native, "https://app.example.test/work", { type: "document", main: true })
    native.page.emit("request", main)
    native.page.emit("response", { request: () => main, status: () => 503 })
    native.page.emit("requestfinished", main)
    const failing = await adapter.call(["wait", "never shows"])
    assert.equal(failing.diagnosis.status, 503)
    assert.match(failing.hint, /Probably the page's main document returned HTTP 503; /u)
  } finally { await adapter.close() }
})

test("a timed-out command keeps a picture and its diagnosis before its context closes, and names them in the failure", async () => {
  const root = await mkTempRoot("auth-timeout-evidence-")
  const native = fakeDriver()
  native.page.url = () => "https://app.example.test/work"
  const send = native.cdp.send
  native.cdp.send = async (...args) => {
    if (args[0] === "DOMSnapshot.captureSnapshot") await new Promise(resolve => setTimeout(resolve, 80))
    return send(...args)
  }
  const adapter = adapterFor(native, root, 20)
  native.page.emit("request", requestOn(native, "https://cdn.example.test/app.js", { type: "script" }))
  await assert.rejects(adapter.call(["snapshot", "--save"]), error => {
    const shot = native.calls.find(call => call[0] === "page.screenshot")[1].path
    return error.message.startsWith("AUTH_TIMEOUT: desk-web: browser command: ") &&
      error.message.includes(`; evidence kept before the close: screenshot ${shot}; `) &&
      error.message.includes("pending requests cdn.example.test; ") && error.message.endsWith(".")
  })
  const order = native.calls.map(call => call[0])
  assert.ok(order.indexOf("page.screenshot") !== -1 && order.indexOf("page.screenshot") < order.indexOf("context.close"), "the picture is taken before the close")
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(fs.readdirSync(root).every(name => /^screenshot-[0-9a-f-]{36}\.png$/u.test(name)), "only the picture is kept, no staged snapshot")
  await adapter.close()
})

test("a picture that hangs cannot hold a timed-out context open past its bound, and one that arrives late is removed", async () => {
  const root = await mkTempRoot("auth-timeout-hung-")
  const native = fakeDriver()
  native.page.screenshot = () => new Promise(() => {})
  const send = native.cdp.send
  native.cdp.send = async (...args) => {
    if (args[0] === "DOMSnapshot.captureSnapshot") await new Promise(resolve => setTimeout(resolve, 80))
    return send(...args)
  }
  const adapter = auth.create(native.context, root, 20, () => {}, { snapshotAttempts: 1, evidenceMs: 50 })
  const started = Date.now()
  await assert.rejects(adapter.call(["snapshot", "--save"]), error => /^AUTH_TIMEOUT: .*; evidence kept before the close: no screenshot was kept; /u.test(error.message))
  assert.ok(native.calls.some(call => call[0] === "context.close"), "the context closed")
  assert.ok(Date.now() - started < 1000, "the close followed the 50 ms bound, not the hung picture")
  await adapter.close()

  const late = fakeDriver()
  late.page.screenshot = async (options) => {
    await new Promise(resolve => setTimeout(resolve, 150))
    fs.writeFileSync(options.path, "FAKE_PNG")
  }
  const lateSend = late.cdp.send
  late.cdp.send = async (...args) => {
    if (args[0] === "DOMSnapshot.captureSnapshot") await new Promise(resolve => setTimeout(resolve, 80))
    return lateSend(...args)
  }
  const lateRoot = await mkTempRoot("auth-timeout-late-")
  const slow = auth.create(late.context, lateRoot, 20, () => {}, { snapshotAttempts: 1, evidenceMs: 50 })
  await assert.rejects(slow.call(["snapshot", "--save"]), error => /no screenshot was kept/u.test(error.message))
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.deepEqual(fs.readdirSync(lateRoot), [], "a picture that arrives after its bound is removed")
  await slow.close()
})

test("a diagnosis reads an unusual address, request type or event as a plain value and never fails on it", async () => {
  const root = await mkTempRoot("auth-not-ready-odd-")
  const native = fakeDriver()
  native.page.url = () => "http://app.example.test:8080/work"
  const adapter = adapterFor(native, root, WAIT_OUT_MS)
  try {
    const unparsed = requestOn(native, "not an address", { type: "beacon" })
    native.page.emit("request", unparsed)
    native.page.emit("requestfailed", unparsed)
    for (const errorText of ["net::ERR_ABORTED", "net::ERR_ABORTED"]) {
      const inline = requestOn(native, "data:image/png;base64,AAAA", { type: "image", errorText })
      native.page.emit("request", inline)
      native.page.emit("requestfailed", inline)
    }
    const slow = requestOn(native, "https://slow.example.test/api", { errorText: "net::ERR_TIMED_OUT" })
    native.page.emit("request", slow)
    native.page.emit("requestfailed", slow)
    const detached = { ...requestOn(native, "https://detached.example.test/x"), isNavigationRequest: () => { throw new Error("frame detached") } }
    native.page.emit("request", detached)
    const fine = requestOn(native, "https://fine.example.test/data")
    native.page.emit("request", fine)
    native.page.emit("response", { request: () => fine, status: () => 200 })
    native.page.emit("requestfinished", fine)
    const stranger = requestOn(native, "https://stranger.example.test/x")
    native.page.emit("response", { request: () => stranger, status: () => 500 })
    native.page.emit("requestfinished", stranger)
    native.page.emit("console", { type: () => "log", text: () => "LOG_TEXT_849" })
    const first = await adapter.call(["wait", "never shows"])
    assert.equal(first.diagnosis.url, "http://app.example.test:8080/work")
    assert.deepEqual(first.diagnosis.network.failed, [
      { host: "unknown", type: "other", code: "net_error" },
      { host: "data", type: "image", code: "aborted" },
      { host: "slow.example.test", type: "xhr", code: "timeout" },
    ], "one entry per host, type and code, oldest first; a request finished with HTTP 200 or never seen is not a failure")
    assert.deepEqual(first.diagnosis.network.pending.map(({ host }) => host), ["detached.example.test"], "a request whose frame is gone counts as a plain request")
    assert.equal(first.diagnosis.status, null, "a request's frame that cannot be read is not the main document")
    assert.deepEqual(first.diagnosis.console, { errors: 0, warnings: 0, pageErrors: 0 }, "a log line is not counted")
    assert.equal(JSON.stringify(first.diagnosis).includes("LOG_TEXT_849"), false)

    native.page.url = () => "about:blank"
    assert.equal((await adapter.call(["wait", "never shows"])).diagnosis.url, "about:", "only the scheme of an address that is not a web page")
    native.page.url = () => "not an address"
    const unknown = await adapter.call(["wait", "never shows"])
    assert.equal(unknown.diagnosis.url, "unknown")
    assert.equal(unknown.diagnosis.signIn, false)
  } finally { await adapter.close() }
})

test("a wait whose reads were slow still answers within the command's time, giving up the picture rather than the diagnosis", async () => {
  const root = await mkTempRoot("auth-not-ready-budget-")
  const native = fakeDriver()
  native.page.screenshot = () => new Promise(() => {})
  const send = native.cdp.send
  native.cdp.send = async (...args) => {
    if (args[0] === "DOMSnapshot.captureSnapshot") await new Promise(resolve => setTimeout(resolve, 300))
    return send(...args)
  }
  const adapter = adapterFor(native, root, 2000)
  try {
    const missing = await adapter.call(["wait", "never shows"])
    assert.equal(missing.waited.found, false)
    assert.equal(missing.diagnosis.screenshot, null)
    assert.match(missing.hint, /no screenshot was kept/u)
  } finally { await adapter.close() }
})

test("a diagnosis keeps only the last 200 requests a page made", async () => {
  const root = await mkTempRoot("auth-not-ready-recent-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root, WAIT_OUT_MS)
  try {
    const finished = Array.from({ length: 201 }, (_, index) => requestOn(native, `https://done${index}.example.test/x`, { errorText: "net::ERR_FAILED" }))
    for (const request of finished) {
      native.page.emit("request", request)
      native.page.emit("requestfailed", request)
    }
    const waiting = Array.from({ length: 201 }, (_, index) => requestOn(native, `https://wait${index}.example.test/x`))
    for (const request of waiting) native.page.emit("request", request)
    // The oldest pending request was dropped to keep 200: its failure arrives with nothing left to record.
    native.page.emit("requestfailed", waiting[0])
    const { diagnosis } = await adapter.call(["wait", "never shows"])
    assert.deepEqual(diagnosis.network.failed.map(({ host }) => host), Array.from({ length: 10 }, (_, index) => `done${191 + index}.example.test`))
    assert.deepEqual(diagnosis.network.pending.map(({ host }) => host), Array.from({ length: 10 }, (_, index) => `wait${191 + index}.example.test`))
    assert.equal(diagnosis.network.failed.some(({ host }) => host === "wait0.example.test"), false, "a dropped request's failure is not recorded")
  } finally { await adapter.close() }
})

test("a main document that never arrived, or a page whose scripts failed, is named as the likely cause", async () => {
  const root = await mkTempRoot("auth-not-ready-main-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root, WAIT_OUT_MS)
  try {
    const main = requestOn(native, "https://app.example.test/work", { type: "document", main: true, errorText: "net::ERR_NAME_NOT_RESOLVED" })
    native.page.emit("request", main)
    native.page.emit("requestfailed", main)
    const missing = await adapter.call(["wait", "never shows"])
    assert.equal(missing.diagnosis.mainFailed, "net_error")
    assert.match(missing.hint, /Probably the page's main document did not arrive \(net_error\); /u)
  } finally { await adapter.close() }

  const scripted = fakeDriver()
  scripted.page.screenshot = async () => { throw new Error("SCREENSHOT_FAILED_849") }
  const failing = adapterFor(scripted, await mkTempRoot("auth-not-ready-scripts-"), 2000)
  try {
    scripted.page.emit("console", { type: () => "error", text: () => "CONSOLE_TEXT_849" })
    const missing = await failing.call(["wait", "never shows"])
    assert.equal(missing.diagnosis.screenshot, null, "a picture that fails is not kept")
    assert.equal(missing.diagnosis.screenshotSkipped, true)
    assert.match(missing.hint, /Probably the page's scripts reported errors; .*; no screenshot was kept; /u)
    assert.equal(JSON.stringify(missing).includes("SCREENSHOT_FAILED_849"), false)
  } finally { await failing.close() }
})

test("a timed-out command's evidence names the main document's status, failed hosts with their codes and a sign-in redirect", async () => {
  const root = await mkTempRoot("auth-timeout-evidence-signin-")
  const native = fakeDriver()
  native.page.url = () => "https://login.microsoftonline.com/common/oauth2/authorize?client_id=SIGNIN_QUERY_849"
  const send = native.cdp.send
  native.cdp.send = async (...args) => {
    if (args[0] === "DOMSnapshot.captureSnapshot") await new Promise(resolve => setTimeout(resolve, 80))
    return send(...args)
  }
  const adapter = adapterFor(native, root, 20)
  const main = requestOn(native, native.page.url(), { type: "document", main: true })
  native.page.emit("request", main)
  native.page.emit("response", { request: () => main, status: () => 200 })
  const blocked = requestOn(native, "https://cdn.example.test/app.js", { type: "script", errorText: "net::ERR_BLOCKED_BY_CLIENT" })
  native.page.emit("request", blocked)
  native.page.emit("requestfailed", blocked)
  await assert.rejects(adapter.call(["snapshot", "--save"]), error =>
    error.message.includes("; main document status 200; failed requests cdn.example.test blocked; ") &&
    error.message.includes("; sign-in redirect yes.") && !error.message.includes("SIGNIN_QUERY_849"))
  await adapter.close()
})

test("a command that times out before its tab was read keeps what evidence it can, and none when there is no tab or it cannot be read", async () => {
  // A new tab that opens only after the command's time: the command times out with its old tab still selected.
  const hang = function () { return new Promise(resolve => setTimeout(() => resolve(this.pages()[0]), 100)) }
  const settle = () => new Promise(resolve => setTimeout(resolve, 150))
  const unread = fakeDriver()
  unread.context.newPage = hang
  const before = auth.create(unread.context, await mkTempRoot("auth-timeout-unread-"), 20, () => {}, { snapshotAttempts: 1, evidenceMs: 50 })
  await assert.rejects(before.call(["tab-new"]), error =>
    /^AUTH_TIMEOUT: .*; evidence kept before the close: no screenshot was kept; main document status none; /u.test(error.message))
  assert.equal(unread.calls.some(call => call[0] === "page.screenshot"), false, "a tab with no reader is not pictured")
  await settle()
  await before.close()

  const empty = fakeDriver()
  empty.context.pages = () => []
  empty.context.newPage = hang
  const none = auth.create(empty.context, await mkTempRoot("auth-timeout-no-tab-"), 20, () => {}, { snapshotAttempts: 1, evidenceMs: 50 })
  await assert.rejects(none.call(["tab-new"]), error => /^AUTH_TIMEOUT: /u.test(error.message) && !error.message.includes("evidence kept"))
  await settle()
  await none.close()

  const unreadable = fakeDriver()
  unreadable.context.newPage = hang
  unreadable.page.url = () => { throw new Error("TARGET_CLOSED_849") }
  const broken = auth.create(unreadable.context, await mkTempRoot("auth-timeout-unreadable-"), 20, () => {}, { snapshotAttempts: 1, evidenceMs: 50 })
  await assert.rejects(broken.call(["tab-new"]), error =>
    /^AUTH_TIMEOUT: /u.test(error.message) && !error.message.includes("evidence kept") && !error.message.includes("TARGET_CLOSED_849"))
  assert.ok(unreadable.calls.some(call => call[0] === "context.close"), "the context still closes")
  await settle()
  await broken.close()
})

test("a picture reported late with no file written is let go without an error", async () => {
  const late = fakeDriver()
  late.page.screenshot = async () => { await new Promise(resolve => setTimeout(resolve, 150)) }
  const send = late.cdp.send
  late.cdp.send = async (...args) => {
    if (args[0] === "DOMSnapshot.captureSnapshot") await new Promise(resolve => setTimeout(resolve, 80))
    return send(...args)
  }
  const root = await mkTempRoot("auth-timeout-late-unwritten-")
  const slow = auth.create(late.context, root, 20, () => {}, { snapshotAttempts: 1, evidenceMs: 50 })
  await assert.rejects(slow.call(["snapshot", "--save"]), error => /no screenshot was kept/u.test(error.message))
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.deepEqual(fs.readdirSync(root), [])
  await slow.close()
})

test("press with only a key presses it on whatever has focus", async () => {
  const root = await mkTempRoot("auth-native-key-")
  const native = fakeDriver()
  native.page.keyboard = { press: async (...args) => native.calls.push(["keyboard.press", ...args]) }
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["press", "Enter"])
    assert.ok(native.calls.some(call => call[0] === "keyboard.press" && call[1] === "Enter"))
    assert.equal(result.actionMayHaveApplied, true)
    assert.ok(result.snapshot)
    await adapter.call(["press", "Shift+Tab"])
    for (const key of ["", "Enter Enter", "a".repeat(41)]) await assert.rejects(adapter.call(["press", key]), /AUTH_ARGUMENTS_REFUSED/u)
    native.page.keyboard.press = async () => { throw new Error(PASSWORD) }
    await assert.rejects(adapter.call(["press", "Enter"]), error => /AUTH_ACTION_FAILED/u.test(error.message) && !error.message.includes(PASSWORD))
  } finally { await adapter.close() }
})

test("every refusal says what to do instead, and none points at eval or page scripts", async () => {
  const root = await mkTempRoot("auth-native-hints-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root)
  try {
    for (const command of ["eval", "run-code", "evaluate", "console", "wait-for"]) {
      await assert.rejects(adapter.call([command, "document.title"]), error => {
        assert.match(error.message, /^AUTH_COMMAND_REFUSED: /u)
        for (const word of ["snapshot", "wait", "goto", "click", "fill", "press", "reload"]) assert.ok(error.message.includes(word), word)
        assert.match(error.message, /eval.*never needed/u)
        return true
      })
    }
    await assert.rejects(adapter.call(["click", "e999"]), /AUTH_TARGET_REFUSED.*\["snapshot"\]/u)
    await assert.rejects(adapter.call(["goto", "file:///etc"]), /AUTH_URL_REFUSED.*https/u)
  } finally { await adapter.close() }
  for (const code of auth.FAILURE_CODES) {
    const message = auth.fail(code).message
    assert.ok(message.startsWith(`${code}: desk-web: `), code)
    assert.ok(message.includes(`; to file a bug with its evidence, call friction_add with {"error_code":"${code.toLowerCase()}"}; `), code)
    assert.equal(/\beval\b(?!.*never needed)/u.test(message), false, code)
  }
  assert.match(auth.fail("AUTH_SOMETHING_NEW").message, /^AUTH_SOMETHING_NEW: desk-web: browser command: .*; to look further, .*; to file a bug with its evidence/u, "an unlisted code still gets the general advice")
})

test("a timed-out command and a covered control say what probably happened, how to look further, the call that reports them, and how to keep working", () => {
  const timeout = auth.fail("AUTH_TIMEOUT", true).message
  assert.ok(timeout.includes("the command ran out of time"), "the probable cause")
  assert.ok(timeout.includes(", and the action may have applied and its output was refused; "), "the probable cause, when the action may have applied")
  assert.ok(timeout.includes("; to look further, open a new context with browser_context, then [\"snapshot\"]; "), "how to look further")
  assert.ok(timeout.includes(`; to file a bug with its evidence, call friction_add with {"error_code":"auth_timeout"}; `), "the call that reports it")
  assert.ok(timeout.endsWith("; start again from the page you were on; keep waits under a minute."), "how to keep working")
  const covered = auth.fail("AUTH_ACTION_COVERED").message
  assert.ok(covered.includes("is probably covering that control"), "the probable cause")
  assert.ok(covered.includes("; to look further, run [\"find\",\"<text>\"] to see what covers it; "), "how to look further")
  assert.ok(covered.includes(`; to file a bug with its evidence, call friction_add with {"error_code":"auth_action_covered"}; `), "the call that reports it")
  assert.ok(covered.endsWith("; this context is still open; press [\"press\",\"Escape\"] or click what covers it, then act on a fresh ref from [\"snapshot\"]."), "how to keep working")
  for (const message of [timeout, covered]) assert.deepEqual(vagueFailuresIn(message), [])
})

test("a browser failure line is the Ouro AX problem line that deskFailure writes, with desk-web as its tool", () => {
  for (const [code, applied] of [["AUTH_TIMEOUT", true], ["AUTH_ACTION_COVERED", false], ["AUTH_CONTEXT_REFUSED", false]]) {
    const { thing, probably, look, keepWorking } = auth.FAILURES[code]
    const line = deskFailure({
      code: code.toLowerCase(), thing, look, keepWorking,
      probably: applied ? `${probably}, and the action may have applied and its output was refused` : probably
    })
    assert.equal(auth.fail(code, applied).message, `${code}: ${line.replace(/^desk:/u, "desk-web:")}`, code)
  }
})

test("a small page that reads as an error gets reload advice; a large page that mentions one does not", async () => {
  const root = await mkTempRoot("auth-native-error-page-")
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const layout = packet.documents[0].layout
  packet.strings.push("#text", "Oops, unknown error!")
  table.parentIndex.push(2); table.nodeType.push(3); table.nodeName.push(packet.strings.length - 2)
  table.nodeValue.push(packet.strings.length - 1); table.backendNodeId.push(105); table.attributes.push([])
  layout.nodeIndex.push(4); layout.styles.push(layout.styles[0].slice()); layout.bounds.push([0, 0, 10, 10]); layout.text.push(-1)
  const native = fakeDriver({ packet })
  const adapter = adapterFor(native, root)
  try {
    const small = await adapter.call(["snapshot"])
    assert.match(small.hint, /\["reload"\].*\["wait"/u)
    packet.strings.push("x".repeat(30000))
    table.nodeValue[4] = packet.strings.length - 1
    assert.equal((await adapter.call(["snapshot"])).hint, undefined)
  } finally { await adapter.close() }
})

// Chrome lays out neither a dropdown's options nor any option's text, so a shown select keeps them readable.
function selectPage({ selectShown = true, optionCss = null } = {}) {
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const layout = packet.documents[0].layout
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  table.parentIndex.push(2, 4, 5, 4, 7, 7, 8, 2, 11)
  table.nodeType.push(1, 1, 3, 1, 1, 3, 3, 1, 3)
  table.nodeName.push(s("SELECT"), s("OPTION"), s("#text"), s("OPTGROUP"), s("OPTION"), s("#text"), s("#text"), s("P"), s("#text"))
  table.nodeValue.push(-1, -1, s("Apple"), -1, -1, s("Group text"), s("Banana"), -1, s("Hidden paragraph"))
  table.backendNodeId.push(105, 106, 107, 108, 109, 110, 111, 112, 113)
  table.attributes.push([s("aria-label"), s("Fruit")], [], [], [], [], [], [], [], [])
  const css = layout.styles[0]
  if (selectShown) { layout.nodeIndex.push(4); layout.styles.push(css.slice()); layout.bounds.push([0, 0, 10, 10]); layout.text.push(-1) }
  if (optionCss) { layout.nodeIndex.push(8); layout.styles.push([s(optionCss), css[1], css[2]]); layout.bounds.push([0, 0, 10, 10]); layout.text.push(-1) }
  return packet
}

test("a shown select keeps its options readable though they have no layout, and nothing else unlaid is read", () => {
  const text = JSON.stringify(sanitize(selectPage()))
  noPassword(text)
  for (const label of ["Apple", "Banana", "Group text"]) assert.ok(text.includes(label), label)
  assert.equal(text.includes("Hidden paragraph"), false)
  assert.equal(JSON.stringify(sanitize(selectPage({ selectShown: false }))).includes("Apple"), false, "a hidden select's options are not read")
  assert.equal(JSON.stringify(sanitize(selectPage({ optionCss: "none" }))).includes("Banana"), false, "an option styled away is not read")
})

const g = (ref, children = [], extra = {}) => ({ role: "generic", ...(ref ? { ref } : {}), ...extra, children })
const t = (text) => ({ role: "text", text })

test("the text agents read leaves out unnamed wrappers but keeps every name, text and ref that holds something", () => {
  const tree = { role: "document", children: [g("e1", [g("e2", [g("e3", [g(null, [t("Inbox")])])]), g("e4", []), g(null, []),
    g("e5", [g("e6", [t("Alpha")]), g("e7", [t("Beta")])]), g(null, [g("e8", [t("One")]), g("e9", [t("Two")])]),
    { role: "textbox", ref: "e10", name: "Type a message", children: [t("[redacted]")] }, g("e11", [], { name: "Close" })])] }
  const { text, left } = auth.renderText(tree)
  assert.equal(left, 0)
  assert.equal(auth.renderText({ role: "document", children: [g(null, [g(null, [t("Loose")])])] }).text, "- document\n  - text: \"Loose\"")
  assert.equal(text, [
    "- document",
    "  - generic [ref=e1]",
    "    - generic [ref=e3]: \"Inbox\"",
    "    - generic [ref=e5]",
    "      - generic [ref=e6]: \"Alpha\"",
    "      - generic [ref=e7]: \"Beta\"",
    "    - generic [ref=e8]: \"One\"",
    "    - generic [ref=e9]: \"Two\"",
    "    - textbox [ref=e10] \"Type a message\"",
    "      - text: \"[redacted]\"",
    "    - generic [ref=e11] \"Close\"",
  ].join("\n"))
})

test("past the budget, controls and named lines stay, then text in page order, and the rest is counted", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => g(`e${i + 100}`, [t(`Message ${i} ${"x".repeat(40)}`)]))
  const tree = { role: "document", children: [g("e1", [...rows, { role: "textbox", ref: "e9", name: "Type a message", children: [] }])] }
  const { text, left } = auth.renderText(tree)
  assert.ok(text.length <= auth.TEXT_BUDGET, String(text.length))
  assert.ok(left > 1000)
  assert.ok(text.includes("Message 0 "), "page order keeps the start")
  assert.ok(text.includes("textbox [ref=e9] \"Type a message\""), "a control at the end still shows")
  assert.ok(text.length > auth.TEXT_BUDGET * 0.9, "the budget is used")
  assert.match(text, /\u2026 \d+ lines left out/u)
  // Controls spread down the whole page leave a marker between almost every pair of kept lines; those count too.
  const nest = (depth, inner) => depth ? g(`n${depth}-${inner.ref}`, [inner, g(`m${depth}-${inner.ref}`, [t("x")])]) : inner
  const items = Array.from({ length: 3000 }, (_, i) => nest(12, g(`e${i + 5000}`, [g(`w${i}`, [t(`Message ${i}`)]), { role: "button", ref: `b${i}`, name: "More", children: [] }])))
  const spread = auth.renderText({ role: "document", children: items })
  assert.ok(spread.text.length <= auth.TEXT_BUDGET && spread.text.length > auth.TEXT_BUDGET * 0.9, String(spread.text.length))
  assert.ok((spread.text.match(/Message \d+/gu) || []).length > 50, "named buttons do not crowd out the text")
  assert.ok(spread.left > 0 && spread.text.includes("\u2026"))
  const long = auth.renderText({ role: "document", children: [t("y".repeat(50000))] })
  assert.ok(long.text.length < 4100 && long.text.includes("\u2026"), "one long text is cut short")
  const named = auth.renderText({ role: "document", children: [{ role: "button", ref: "e1", name: "n".repeat(30000), children: [] }] })
  assert.ok(named.text.length < 4100 && named.text.includes("button [ref=e1]"), "one long name is cut short, not dropped")
})

test("find and snapshot --interactive narrow a snapshot whose refs stay usable", async () => {
  const root = await mkTempRoot("auth-native-views-")
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const layout = packet.documents[0].layout
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  table.parentIndex.push(2, 4, 2, 6); table.nodeType.push(1, 3, 1, 3)
  table.nodeName.push(s("DIV"), s("#text"), s("DIV"), s("#text")); table.nodeValue.push(-1, s("Ari (You)"), -1, s("Someone else"))
  table.backendNodeId.push(105, 106, 107, 108); table.attributes.push([], [], [], [])
  for (const index of [4, 5, 6, 7]) { layout.nodeIndex.push(index); layout.styles.push(layout.styles[0].slice()); layout.bounds.push([0, 0, 10, 10]); layout.text.push(-1) }
  const native = fakeDriver({ packet })
  const adapter = adapterFor(native, root)
  try {
    const found = await adapter.call(["find", "(you)"])
    assert.equal(found.matches, 1)
    assert.ok(found.text.includes("Ari (You)"))
    assert.equal(found.text.includes("Someone else"), false)
    assert.ok(found.text.includes("document"), "what contains a match is shown")
    noPassword(found)
    const none = await adapter.call(["find", "nothing like this"])
    assert.equal(none.matches, 0)
    const interactive = await adapter.call(["snapshot", "--interactive"])
    assert.ok(interactive.text.includes("textbox") && interactive.text.includes("Ari (You)"))
    noPassword(interactive)
    const ref = interactive.text.match(/generic \[ref=(e\d+)\]: "Ari \(You\)"/u)[1]
    await adapter.call(["click", ref])
    assert.ok(native.calls.some(call => call[0] === "click"))
    for (const args of [["find", " "], ["find", "a".repeat(201)], ["snapshot", "--everything"]]) await assert.rejects(adapter.call(args), /AUTH_ARGUMENTS_REFUSED/u)
  } finally { await adapter.close() }
})

test("find and wait match visible text with unusual spacing or split across elements, once each", async () => {
  const root = await mkTempRoot("auth-native-split-")
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const layout = packet.documents[0].layout
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  const add = (parent, type, name, value, backend) => {
    const at = table.parentIndex.length
    table.parentIndex.push(parent); table.nodeType.push(type); table.nodeName.push(s(name))
    table.nodeValue.push(value === null ? -1 : s(value)); table.backendNodeId.push(backend); table.attributes.push([])
    layout.nodeIndex.push(at); layout.styles.push(layout.styles[0].slice()); layout.bounds.push([0, 0, 10, 10]); layout.text.push(-1)
    return at
  }
  const nbsp = add(2, 1, "DIV", null, 201)
  add(nbsp, 3, "#text", "Ari\u00a0Mendelow", 202)
  const lines = add(2, 1, "P", null, 203)
  add(lines, 3, "#text", "\n      Grace\n    Hopper\n", 204)
  const card = add(2, 1, "DIV", null, 205)
  const first = add(card, 1, "SPAN", null, 206)
  add(first, 3, "#text", "Linus", 207)
  add(card, 3, "#text", " ", 208)
  const last = add(card, 1, "SPAN", null, 209)
  add(last, 3, "#text", "Torvalds", 210)
  const adapter = adapterFor(fakeDriver({ packet }), root)
  try {
    const nbspFound = await adapter.call(["find", "Ari Mendelow"])
    assert.equal(nbspFound.matches, 1)
    assert.ok(nbspFound.text.includes("Ari\u00a0Mendelow"), "the line that holds the name is shown")
    const newlineFound = await adapter.call(["find", "grace   hopper"])
    assert.equal(newlineFound.matches, 1)
    assert.ok(newlineFound.text.includes("Grace"), "a name broken across lines is found")
    const split = await adapter.call(["find", "Linus Torvalds"])
    assert.equal(split.matches, 1, "a name split across two spans counts once")
    assert.ok(split.text.includes("\"Linus\"") && split.text.includes("\"Torvalds\""), "the split text is shown")
    assert.equal((await adapter.call(["find", "Linus"])).matches, 1, "a name inside one span still counts once")
    const waited = await adapter.call(["wait", "Linus Torvalds"])
    assert.equal(waited.waited.found, true)
    const hidden = await adapter.call(["find", "FAKE_PROPERTY"])
    assert.equal(hidden.matches, 0, "a redacted value is not found through the text around it")
    noPassword(hidden)
  } finally { await adapter.close() }
})

test("a page too long to read in one reply says how to see the rest, in every view", async () => {
  const root = await mkTempRoot("auth-native-long-")
  const packet = nativeSnapshot()
  const table = packet.documents[0].nodes
  const layout = packet.documents[0].layout
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  const div = s("DIV"), textName = s("#text")
  for (let i = 0; i < 1200; i++) {
    const at = table.parentIndex.length
    table.parentIndex.push(2, at); table.nodeType.push(1, 3); table.nodeName.push(div, textName)
    table.nodeValue.push(-1, s(`Message ${i} ${"z".repeat(40)}`)); table.backendNodeId.push(1000 + 2 * i, 1001 + 2 * i); table.attributes.push([], [])
    for (const index of [at, at + 1]) { layout.nodeIndex.push(index); layout.styles.push(layout.styles[0].slice()); layout.bounds.push([0, 0, 10, 10]); layout.text.push(-1) }
  }
  const adapter = adapterFor(fakeDriver({ packet }), root, 20000)
  try {
    for (const args of [["snapshot"], ["find", "Message"], ["snapshot", "--interactive"]]) {
      const result = await adapter.call(args)
      assert.ok(result.text.length <= auth.TEXT_BUDGET, `${args}: ${result.text.length}`)
      assert.match(result.hint, /left out.*\["find"/u, String(args))
      assert.match(result.text, /\u2026 \d+ lines left out$/u, "the end that did not fit is counted")
      if (args[0] !== "find") assert.ok(result.text.includes("textbox"), "the control is kept")
      noPassword(result)
    }
  } finally { await adapter.close() }
})

test("refs from the last three reads stay usable, and older ones are refused", async () => {
  const root = await mkTempRoot("auth-native-ref-reads-")
  const native = fakeDriver()
  const adapter = adapterFor(native, root)
  try {
    const first = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0].ref
    await adapter.call(["find", "password"])
    await adapter.call(["wait", "--text", "password"])
    await adapter.call(["click", first])
    assert.ok(native.calls.some(call => call[0] === "click"), "a ref from three reads ago still acts")
    const second = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0].ref
    for (let i = 0; i < 3; i++) await adapter.call(["snapshot"])
    await assert.rejects(adapter.call(["click", second]), /AUTH_TARGET_REFUSED.*last 3 reads/u)
    await assert.rejects(adapter.call(["click", first]), /AUTH_TARGET_REFUSED/u)
    // A wait that polls many times counts as one read, and its unseen polls leave no refs behind.
    const held = (await adapter.call(["find", "password"])).text.match(/\[ref=(e\d+)\]/u)[1]
    const before = Math.max(...JSON.stringify(await adapter.call(["snapshot"])).match(/e\d+/gu).map(ref => Number(ref.slice(1))))
    const polled = await adapter.call(["wait", "never shows"])
    assert.equal(polled.waited.found, false)
    await adapter.call(["click", held])
    const returned = polled.snapshot.children[0].children[0].children[0].ref
    assert.ok(Number(returned.slice(1)) > before + 1, "the wait read the page more than once")
    await adapter.call(["click", returned])
    const kept = new Set(JSON.stringify(polled.snapshot).match(/e\d+/gu))
    for (let ref = before + 1; ref < Number(returned.slice(1)); ref++) {
      if (kept.has(`e${ref}`)) continue
      await assert.rejects(adapter.call(["click", `e${ref}`]), /AUTH_TARGET_REFUSED/u, `poll ref e${ref} is not kept`)
    }
  } finally { await adapter.close() }
})

test("a wait stopped by the runtime policy leaves none of its polls' refs behind", async () => {
  const root = await mkTempRoot("auth-native-wait-policy-")
  const native = fakeDriver()
  let blocked = false
  let checks = 0
  const adapter = auth.create(native.context, root, 8000, () => { if (blocked && ++checks > 40) throw new Error(PASSWORD) }, ONCE)
  try {
    const before = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0].ref
    blocked = true
    await assert.rejects(adapter.call(["wait", "never shows"]), /AUTH_RUNTIME_POLICY_REFUSED/u)
    blocked = false
    const after = (await adapter.call(["snapshot"])).snapshot.children[0].children[0].children[0].ref
    for (let ref = Number(before.slice(1)) + 1; ref < Number(after.slice(1)) - 3; ref++) {
      await assert.rejects(adapter.call(["click", `e${ref}`]), /AUTH_TARGET_REFUSED/u, `e${ref}`)
    }
  } finally { await adapter.close() }
  // The same refusal after a poll that itself failed (the page never settled) has no refs to drop.
  let churn = false
  let late = 0
  const busy = fakeDriver({ hook: ({ method, cdp }) => { if (churn && method === "DOMSnapshot.captureSnapshot") cdp.emit("DOM.childNodeCountUpdated", {}) } })
  const unsettled = auth.create(busy.context, await mkTempRoot("auth-native-wait-policy-busy-"), 8000, () => { if (churn && ++late > 30) throw new Error(PASSWORD) }, ONCE)
  try {
    await unsettled.call(["snapshot"])
    churn = true
    await assert.rejects(unsettled.call(["wait", "never shows"]), /AUTH_(RUNTIME_POLICY_REFUSED|SNAPSHOT_INVALIDATED)/u)
  } finally { await unsettled.close() }
})

test("a navigation whose page is still loading reports that it went through and how to read the page", async () => {
  const root = await mkTempRoot("auth-native-loading-")
  let loading = false
  const packet = nativeSnapshot()
  const native = fakeDriver({ packet, hook: ({ method, cdp }) => {
    if (method === "DOMSnapshot.captureSnapshot") cdp.emit("DOM.childNodeCountUpdated", {})
    if (loading && method === "DOMSnapshot.captureSnapshot") navigating(packet)
  } })
  const adapter = adapterFor(native, root)
  try {
    assert.ok((await adapter.call(["mousewheel", "0", "10"])).snapshot, "a page that is only busy is read")
    loading = true
    for (const args of [["goto", "https://synthetic.invalid/next"], ["reload"], ["go-back"], ["go-forward"]]) {
      const result = await adapter.call(args)
      assert.equal(result.navigated, true, String(args))
      assert.match(result.hint, /\["wait"/u)
    }
    await assert.rejects(adapter.call(["mousewheel", "0", "10"]), /AUTH_SNAPSHOT_INVALIDATED.*wait/u, "other actions still refuse an unread page")
    loading = false
    assert.ok((await adapter.call(["goto", "https://synthetic.invalid/"])).snapshot, "a settled page is read as before")
  } finally { await adapter.close() }
})

// Stream's player and transcript, Teams' panes: another site's document in its own process, under an IFRAME the main
// document names by frame id. The frame's page repeats the tab's password, and the main page echoes the frame's field.
const OOP_TEXT = "STREAM_TRANSCRIPT_679"
const OOP_TYPED = "OOP_TYPED_VALUE_679"
function outOfProcess() {
  const main = nativeSnapshot()
  const away = nativeSnapshot({ value: OOP_TYPED, type: "text" })
  const add = (packet, parent, type, name, value, id, attrs = []) => {
    const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
    const document = packet.documents[0]
    document.nodes.parentIndex.push(parent)
    document.nodes.nodeType.push(type)
    document.nodes.nodeName.push(s(name))
    document.nodes.nodeValue.push(value === undefined ? -1 : s(value))
    document.nodes.backendNodeId.push(id)
    document.nodes.attributes.push(attrs.map(s))
    document.layout.nodeIndex.push(document.nodes.nodeType.length - 1)
    document.layout.styles.push(document.layout.styles[0].slice())
    document.layout.bounds.push([0, 0, 100, 20])
    document.layout.text.push(-1)
    return document.nodes.nodeType.length - 1
  }
  add(main, 2, 1, "IFRAME", undefined, 107, ["title", "Stream player"])
  add(main, add(main, 2, 1, "P", undefined, 108), 3, "#text", "Sent " + OOP_TYPED, 109)
  away.strings.push("oop")
  away.documents[0].frameId = away.strings.length - 1
  away.documents[0].nodes.backendNodeId = [301, 302, 303, 304]
  add(away, add(away, 2, 1, "P", undefined, 305), 3, "#text", OOP_TEXT + " " + PASSWORD, 306)
  return { packet: main, outside: { packet: away, owner: 107 } }
}

test("an out-of-process child frame is read inside its owner, scrubbed by every value typed anywhere in the tab, and its refs act in it", async () => {
  const root = await mkTempRoot("auth-oopif-")
  const { packet, outside } = outOfProcess()
  const native = fakeDriver({ packet, outside })
  const send = native.oop.send
  native.oop.send = async (method, params) => {
    if (method === "DOM.querySelector") { native.calls.push(["oop", method, params]); return { nodeId: 9 } }
    if (method === "DOM.describeNode") { native.calls.push(["oop", method, params]); return { node: { backendNodeId: 304 } } }
    return send(method, params)
  }
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["snapshot", "--save"])
    const artifact = fs.readFileSync(result.artifact, "utf8")
    for (const output of [JSON.stringify(result), artifact]) {
      assert.ok(output.includes(OOP_TEXT), "the frame's page text is read")
      assert.ok(output.includes("Sent [redacted]"), "the frame's typed value is scrubbed where the main page repeats it")
      for (const hidden of [PASSWORD, OOP_TYPED]) assert.equal(output.includes(hidden), false, hidden)
    }
    assert.equal(result.framesOmitted, undefined)
    const frame = all(result.snapshot).find((node) => node.role === "frame")
    assert.equal(frame.name, "Stream player")
    const field = all(frame).find((node) => node.role === "textbox")
    assert.ok(field.ref)
    await adapter.call(["fill", field.ref, "literal"])
    assert.equal(outside.packet.strings[outside.packet.documents[0].nodes.inputValue.value[0]], "literal", "typed into the frame's own field")
    assert.ok(native.calls.some((call) => call[0] === "oop" && call[1] === "DOM.querySelector"), "its own session confirms the path")
    assert.equal(native.calls.some((call) => call[0] === "cdp" && /^Runtime\.(?:evaluate|callFunctionOn)/u.test(call[1])), false)
    assert.equal(native.calls.some((call) => call[0] === "oop" && /^Runtime\./u.test(call[1])), false)
  } finally { await adapter.close() }
  // A frame that cannot be read now shows empty; the rest of the tab still reads, and the tab's password stays redacted.
  const failing = outOfProcess()
  failing.outside.hook = ({ method }) => { if (method === "DOMSnapshot.captureSnapshot") throw new Error(PASSWORD) }
  const broken = fakeDriver(failing)
  const other = adapterFor(broken, root)
  try {
    const result = await other.call(["snapshot"])
    assert.equal(result.framesOmitted, 1)
    noPassword(result)
    assert.equal(JSON.stringify(result).includes(OOP_TEXT), false)
    assert.ok(broken.calls.some((call) => call[0] === "oop.detach"), "its session is let go")
  } finally { await other.close() }
})

test("tab-select brings the tab to the front, and refs from its snapshot act there; tab-close closes the tab it names", async () => {
  const root = await mkTempRoot("auth-tab-front-")
  const natives = [fakeDriver(), fakeDriver()]
  const context = natives[0].context
  let pages = natives.map((native) => native.page)
  context.pages = () => pages.slice()
  context.newCDPSession = async (page) => {
    const native = natives.find((candidate) => candidate.page === page)
    if (!native) throw new Error(PASSWORD)
    return native.cdp
  }
  for (const native of natives) {
    native.page.context = () => context
    native.page.isClosed = () => !pages.includes(native.page)
    native.page.close = async () => { pages = pages.filter((page) => page !== native.page); native.page.emit("close") }
  }
  let blocked = false
  const adapter = auth.create(context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) })
  try {
    await adapter.call(["snapshot"])
    const front = natives[1].page.bringToFront
    natives[1].page.bringToFront = async () => { blocked = true }
    await assert.rejects(adapter.call(["tab-select", "1"]), (error) => /AUTH_RUNTIME_POLICY_REFUSED/u.test(error.message) && !error.message.includes(PASSWORD))
    blocked = false
    assert.deepEqual(await adapter.call(["tab-list"]), { tabs: [{ index: 0, selected: true }, { index: 1, selected: false }] })
    natives[1].page.bringToFront = front
    const selected = await adapter.call(["tab-select", "1"])
    assert.equal(natives[1].calls.filter((call) => call[0] === "bringToFront").length, 1)
    await adapter.call(["click", inputRef(selected)])
    assert.equal(natives[1].calls.filter((call) => call[0] === "click").length, 1, "the ref acts in the selected tab")
    assert.equal(natives[0].calls.some((call) => call[0] === "click"), false)
    natives[0].page.bringToFront = async () => { throw new Error(PASSWORD) }
    await assert.rejects(adapter.call(["tab-select", "0"]), (error) => /AUTH_TAB_ACTION_FAILED/u.test(error.message) && !error.message.includes(PASSWORD))
    assert.deepEqual(await adapter.call(["tab-list"]), { tabs: [{ index: 0, selected: false }, { index: 1, selected: true }] }, "a tab that cannot come forward is not selected")
    const kept = inputRef(await adapter.call(["snapshot"]))
    assert.deepEqual(await adapter.call(["tab-close", "0"]), { closed: true })
    assert.deepEqual(pages, [natives[1].page])
    assert.deepEqual(await adapter.call(["tab-list"]), { tabs: [{ index: 0, selected: true }] })
    await adapter.call(["click", kept])
    assert.equal(natives[1].calls.filter((call) => call[0] === "click").length, 2, "closing another tab keeps this tab's refs")
    for (const args of [["tab-close", "5"], ["tab-close", "-1"], ["tab-close", "x"]]) await assert.rejects(adapter.call(args), /AUTH_(TAB|ARGUMENTS)_REFUSED/u)
  } finally { await adapter.close() }
})

test("screenshot saves the tab or one element in the private files folder, with every input, textarea and editable region masked in every frame", async () => {
  const root = await mkTempRoot("auth-screenshot-")
  const native = framedDriver()
  const adapter = adapterFor(native, root)
  try {
    const page = await adapter.call(["screenshot"])
    assert.deepEqual(Object.keys(page), ["screenshot"])
    assert.equal(path.dirname(page.screenshot), root)
    assert.match(path.basename(page.screenshot), /^screenshot-[0-9a-f-]{36}\.png$/u)
    assert.ok(fs.existsSync(page.screenshot))
    const shot = native.calls.find((call) => call[0] === "page.screenshot")[1]
    assert.equal(shot.fullPage, false)
    assert.equal(shot.timeout, 5000)
    const frames = native.page.frames().length
    assert.deepEqual(shot.mask.slice(0, frames).map((mask) => [mask.frame, mask.selector]),
      native.page.frames().map((frame, index) => [index, "input, textarea, [contenteditable]"]), "every field in every frame, also one that appears meanwhile")
    assert.deepEqual(shot.mask.slice(frames).map((mask) => [mask.through, mask.selector]), [
      [[], "css=html:nth-of-type(1) > body:nth-of-type(1) > input:nth-of-type(1)"],
      [["css=html:nth-of-type(1) > body:nth-of-type(1) > iframe:nth-of-type(1)"], "css=html:nth-of-type(1) > body:nth-of-type(1) > input:nth-of-type(1)"],
      [["css=html:nth-of-type(1) > body:nth-of-type(1) > iframe:nth-of-type(1)"], "css=html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(1)"],
    ], "each opaque region the read found, in the frame it is in")
    await adapter.call(["screenshot", "--full"])
    assert.equal(native.calls.filter((call) => call[0] === "page.screenshot")[1][1].fullPage, true)
    const ref = inputRef(await adapter.call(["snapshot"]))
    const element = await adapter.call(["screenshot", ref])
    const call = native.calls.find((entry) => entry[0] === "element.screenshot")
    assert.equal(call[1], 104)
    assert.equal(call[2].path, element.screenshot)
    assert.equal(call[2].mask.length, shot.mask.length)
    assert.ok(native.calls.some((entry) => entry[0] === "dispose" && entry[1] === 104), "the element handle is let go")
    for (const args of [["screenshot", "--full", "--full"], ["screenshot", ref, "--full"], ["screenshot", "x"], ["screenshot", ref, ref], ["screenshot", "--path=/tmp/x.png"]]) {
      await assert.rejects(adapter.call(args), /AUTH_ARGUMENTS_REFUSED/u, JSON.stringify(args))
    }
    await assert.rejects(adapter.call(["screenshot", "e999"]), /AUTH_TARGET_REFUSED/u)
    const files = fs.readdirSync(root).length
    native.page.screenshot = async (options) => { fs.writeFileSync(options.path, "PARTIAL"); throw new Error(PASSWORD) }
    await assert.rejects(adapter.call(["screenshot"]), (error) => /AUTH_SCREENSHOT_FAILED/u.test(error.message) && !error.message.includes(PASSWORD))
    assert.equal(fs.readdirSync(root).length, files, "a failed screenshot leaves no partial file")
    native.page.screenshot = async () => { throw new Error(PASSWORD) }
    await assert.rejects(adapter.call(["screenshot"]), /AUTH_SCREENSHOT_FAILED/u, "nothing was written to remove")
    const stale = inputRef(await adapter.call(["snapshot"]))
    native.packet.strings.push("Delete everything")
    native.packet.documents[0].nodes.attributes[3][3] = native.packet.strings.length - 1
    await assert.rejects(adapter.call(["screenshot", stale]), /AUTH_SNAPSHOT_INVALIDATED/u, "an element that changed is not pictured")
    assert.equal(fs.readdirSync(root).length, files)
  } finally { await adapter.close() }
})

test("a frame the read cannot show stays empty and is counted; two captures claiming one frame show neither, and both are scrubbed", () => {
  const { packet, outside } = outOfProcess()
  const marked = (dom) => {
    (function mark(node) { if (node.backendNodeId === 107) node.frameId = "oop"; (node.children || []).forEach(mark) })(dom.root)
    return dom
  }
  const away = { packet: outside.packet, scope: auth.inspect(inspectedDOM(outside.packet).root), frameId: "oop" }
  const read = (dom, frames) => {
    let next = 0
    return auth.prepare(packet, auth.inspect(dom.root), "main", () => ++next, frames)
  }
  const shown = read(marked(inspectedDOM(packet)), [away])
  assert.equal(shown.frames, 0)
  assert.ok(JSON.stringify(shown.tree).includes(OOP_TEXT))
  for (const [dom, frames] of [
    [marked(inspectedDOM(packet)), []],
    [inspectedDOM(packet), [away]],
    [marked(inspectedDOM(packet)), [away, { ...away, packet: structuredClone(away.packet) }]],
  ]) {
    const prepared = read(dom, frames)
    const text = JSON.stringify(prepared.tree)
    assert.equal(prepared.frames, 1)
    assert.equal(text.includes(OOP_TEXT), false)
    assert.equal(text.includes(PASSWORD), false)
    assert.equal(text.includes(OOP_TYPED), frames.length === 0, "a frame's typed value is scrubbed whenever its capture was taken")
  }
  const missing = inspectedDOM(packet)
  missing.root.children[0].children[0].children.splice(1, 1)
  assert.equal(read(missing, [away]).frames, 1, "an owner the DOM read lacks has no frame to show")
  assert.throws(() => read(marked(inspectedDOM(packet)), [{ ...away, frameId: undefined }]), /AUTH_FRAME_COVERAGE_REFUSED/u)
})

test("an out-of-process frame's session follows the frame: let go when it goes, reopened when it is back, and a session that cannot start leaves the frame empty", async () => {
  const root = await mkTempRoot("auth-oopif-life-")
  const { packet, outside } = outOfProcess()
  const native = fakeDriver({ packet, outside })
  native.oop.detach = async () => { native.calls.push(["oop.detach"]); throw new Error(PASSWORD) }
  const adapter = adapterFor(native, root)
  try {
    assert.ok((await adapter.call(["snapshot"])).text.includes(OOP_TEXT))
    const away = native.page.frames().at(-1)
    native.page.emit("framedetached", away)
    native.page.emit("framenavigated", native.page.mainFrame())
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(native.calls.filter((call) => call[0] === "oop.detach").length, 1)
    assert.ok((await adapter.call(["snapshot"])).text.includes(OOP_TEXT))
    assert.equal(native.calls.filter((call) => call[0] === "newCDPSession" && call[1] === "oop").length, 2)
  } finally { await adapter.close() }
  for (const detach of [async () => {}, async () => { throw new Error(PASSWORD) }]) {
    const failing = outOfProcess()
    failing.outside.hook = ({ method }) => { if (method === "DOM.enable") throw new Error(PASSWORD) }
    const broken = fakeDriver(failing)
    broken.oop.detach = async () => { broken.calls.push(["oop.detach"]); return detach() }
    const other = adapterFor(broken, root)
    try {
      const result = await other.call(["snapshot"])
      assert.equal(result.framesOmitted, 1)
      noPassword(result)
      assert.ok(broken.calls.some((call) => call[0] === "oop.detach"))
      await other.call(["snapshot"])
      assert.equal(broken.calls.filter((call) => call[0] === "newCDPSession" && call[1] === "oop").length, 1, "a frame without its own session is not asked again until it navigates")
    } finally { await other.close() }
  }
  for (const [method, count] of [["DOM.enable", 1], ["Page.getFrameTree", 2]]) {
    const policed = outOfProcess()
    let blocked = false
    policed.outside.hook = (call) => { if (call.method === method && call.count === count) blocked = true }
    const native = fakeDriver(policed)
    const adapter = auth.create(native.context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) }, ONCE)
    try {
      if (count === 2) await adapter.call(["snapshot"])
      await assert.rejects(adapter.call(["snapshot"]), (error) => /AUTH_RUNTIME_POLICY_REFUSED/u.test(error.message) && !error.message.includes(PASSWORD))
    } finally { await adapter.close() }
  }
})

test("a ref in a child frame is refused when its owner, the frame or the browser's confirmation cannot be had", async () => {
  for (const failure of ["owner", "frame", "confirm", "gone"]) {
    const root = await mkTempRoot("auth-frame-bind-")
    const native = framedDriver()
    const send = native.cdp.send
    let read = false
    let documents = 0
    native.cdp.send = async (method, params) => {
      if (method === "DOM.querySelector" && failure !== "gone") throw new Error(PASSWORD)
      // Each try reads the tab again, then asks for the document the ref was in, which is gone.
      if (method === "DOM.getDocument" && read && failure === "gone" && documents++ % 2) return { root: { nodeId: 1, backendNodeId: -1 } }
      return send(method, params)
    }
    const adapter = adapterFor(native, root)
    try {
      const result = await adapter.call(["snapshot"])
      const field = all(all(result.snapshot).find((node) => node.role === "frame")).find((node) => node.role === "textbox")
      read = true
      const frame = native.page.mainFrame()
      if (failure === "owner") frame.waitForSelector = async () => { throw new Error(PASSWORD) }
      if (failure === "frame") native.handles.get(107).contentFrame = async () => { throw new Error(PASSWORD) }
      await assert.rejects(adapter.call(["fill", field.ref, "literal"]), (error) =>
        new RegExp({ confirm: "AUTH_ACTION_FAILED", gone: "AUTH_SNAPSHOT_INVALIDATED" }[failure] || "AUTH_TARGET_REFUSED", "u").test(error.message) && !error.message.includes(PASSWORD))
      assert.equal(native.calls.some((call) => call[0] === "fill"), false)
      if (failure !== "owner") assert.ok(native.calls.some((call) => call[0] === "dispose" && call[1] === 107), "the owner handle is let go")
      if (failure === "confirm") assert.ok(native.calls.some((call) => call[0] === "dispose" && call[1] === 205), "the bound handle is let go")
    } finally { await adapter.close() }
  }
})

test("screenshot masks what markup alone does not mark: a CSS-editable page and open-shadow content by its host; a closed shadow or an unmasked region that stays is never pictured", async () => {
  const root = await mkTempRoot("auth-screenshot-regions-")
  const regions = (native) => native.calls.filter((call) => call[0] === "page.screenshot").at(-1)[1].mask
    .filter((mask) => mask.selector !== "input, textarea, [contenteditable]").map((mask) => mask.selector)
  const editable = fakeDriver({ packet: editingSnapshot() })
  let adapter = adapterFor(editable, root)
  try {
    await adapter.call(["screenshot"])
    assert.deepEqual(regions(editable), ["css=html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(1)"], "a region editable by CSS alone is covered from its outermost editable element")
  } finally { await adapter.close() }
  const packet = nativeSnapshot({ value: "Prefilled card 4111", type: "text" })
  packet.strings.push("open")
  packet.documents[0].nodes.shadowRootType = { index: [3], value: [packet.strings.length - 1] }
  const shadowed = fakeDriver({ packet })
  let kind = "open"
  const send = shadowed.cdp.send
  shadowed.cdp.send = async (method, params) => {
    const result = await send(method, params)
    if (method !== "DOM.getDocument") return result
    const body = result.root.children[0].children[0]
    body.shadowRoots = [{ nodeType: 11, nodeName: "#document-fragment", backendNodeId: 106, shadowRootType: kind, children: body.children.splice(0) }]
    return result
  }
  adapter = adapterFor(shadowed, root)
  try {
    const files = fs.readdirSync(root).length
    await adapter.call(["screenshot"])
    assert.deepEqual(regions(shadowed), ["css=html:nth-of-type(1) > body:nth-of-type(1)"], "a field in an open shadow is covered by its host")
    kind = "closed"
    await assert.rejects(adapter.call(["screenshot"]), /AUTH_SHADOW_COVERAGE_REFUSED/u)
    assert.equal(fs.readdirSync(root).length, files + 1, "nothing is pictured past a closed shadow")
  } finally { await adapter.close() }
  // Page script makes a region editable by CSS while the picture is taken: the read after it finds a region the mask
  // did not cover, so the picture is taken again; one that keeps appearing is refused and leaves no file.
  for (const [appears, expected] of [[1, null], [Infinity, /AUTH_SNAPSHOT_INVALIDATED/u]]) {
    const changing = nativeSnapshot({ type: "text" })
    const native = fakeDriver({ packet: changing })
    const body = changing.documents[0].layout.styles[1]
    const readOnly = body[2]
    const readWrite = changing.strings.push("read-write") - 1
    let shots = 0
    let shot = false
    native.page.screenshot = async (options) => {
      native.calls.push(["page.screenshot", options])
      fs.writeFileSync(options.path, "FAKE_PNG")
      shot = true
      body[2] = shots++ < appears ? readWrite : readOnly
    }
    // A region that keeps appearing is gone again whenever the next picture's read is taken.
    const send = native.cdp.send
    native.cdp.send = async (method, params) => {
      if (method === "DOMSnapshot.captureSnapshot" && !shot && appears === Infinity) body[2] = readOnly
      const result = await send(method, params)
      if (method === "DOMSnapshot.captureSnapshot") shot = false
      return result
    }
    const other = adapterFor(native, root)
    try {
      const files = fs.readdirSync(root).length
      if (expected) {
        await assert.rejects(other.call(["screenshot"]), expected)
        assert.equal(fs.readdirSync(root).length, files, "a picture that may show an unmasked region is removed")
      } else {
        const result = await other.call(["screenshot"])
        assert.ok(fs.existsSync(result.screenshot))
        assert.equal(native.calls.filter((call) => call[0] === "page.screenshot").length, 2, "taken again once the region was masked")
        assert.equal(fs.readdirSync(root).length, files + 1, "only the kept picture stays")
      }
    } finally { await other.close() }
  }
})

test("screenshot masks an out-of-process frame's fields in that frame", async () => {
  const root = await mkTempRoot("auth-screenshot-oopif-")
  const { packet, outside } = outOfProcess()
  const native = fakeDriver({ packet, outside })
  const adapter = adapterFor(native, root)
  try {
    const away = native.page.frames().at(-1)
    away.locator = (selector) => ({ away: true, selector })
    await adapter.call(["screenshot"])
    const masks = native.calls.find((call) => call[0] === "page.screenshot")[1].mask
    const field = "css=html:nth-of-type(1) > body:nth-of-type(1) > input:nth-of-type(1)"
    assert.ok(masks.some((mask) => mask.away && mask.selector === field), "the frame's own field, located in that frame")
    assert.ok(masks.some((mask) => !mask.away && mask.selector === field), "and the page's, in the page")
  } finally { await adapter.close() }
})

test("screenshot never pictures an out-of-process frame it could not read: a closed shadow or a failed read refuses, and a frame with no way in is masked whole by its owner", async () => {
  const root = await mkTempRoot("auth-screenshot-oopif-coverage-")
  for (const [failure, code] of [["closed", /AUTH_SHADOW_COVERAGE_REFUSED/u], ["read", /AUTH_FRAME_COVERAGE_REFUSED/u]]) {
    const { packet, outside } = outOfProcess()
    const native = fakeDriver({ packet, outside })
    const send = native.oop.send
    let broken = false
    native.oop.send = async (method, params) => {
      if (broken && failure === "read" && method === "DOMSnapshot.captureSnapshot") throw new Error(PASSWORD)
      const result = await send(method, params)
      if (broken && failure === "closed" && method === "DOM.getDocument") {
        const body = result.root.children[0].children[0]
        body.shadowRoots = [{ nodeType: 11, nodeName: "#document-fragment", backendNodeId: 399, shadowRootType: "closed", children: body.children.splice(0) }]
      }
      return result
    }
    const adapter = adapterFor(native, root)
    try {
      assert.ok((await adapter.call(["snapshot"])).text.includes(OOP_TEXT))
      broken = true
      const files = fs.readdirSync(root).length
      await assert.rejects(adapter.call(["screenshot"]), (error) => code.test(error.message) && !error.message.includes(PASSWORD) && !error.message.includes("[\"screenshot\"] shows"))
      assert.equal(native.calls.some((call) => call[0] === "page.screenshot"), false, `no picture past a ${failure} frame`)
      assert.equal(fs.readdirSync(root).length, files, "and no file")
    } finally { await adapter.close() }
  }
  const blind = outOfProcess()
  blind.outside.hook = ({ method }) => { if (method === "DOM.enable") throw new Error(PASSWORD) }
  const native = fakeDriver(blind)
  const adapter = adapterFor(native, root)
  try {
    const result = await adapter.call(["screenshot"])
    assert.ok(fs.existsSync(result.screenshot))
    const masks = native.calls.find((call) => call[0] === "page.screenshot")[1].mask
    assert.ok(masks.some((mask) => mask.frame === 0 && mask.through.length === 0 && mask.selector === "css=html:nth-of-type(1) > body:nth-of-type(1) > iframe:nth-of-type(1)"),
      "the owner of a frame with no session is masked whole")
  } finally { await adapter.close() }
})

test("type sends each key only while its target holds the focus: focus taken at once is taken back once, and focus taken again or while typing stops it, so the stealer gets no key", async () => {
  const root = await mkTempRoot("auth-type-focus-")
  // The live page: the target's focus handler starts a timer that moves focus to another field (an autofocus search
  // box, a chat composer) at once or a few keys in. The stealer must never get a key.
  for (const [atFocus, afterKeys, expected, held] of [[0, Infinity, null, "STEALTEST123"], [1, Infinity, null, "STEALTEST123"], [Infinity, Infinity, /AUTH_FOCUS_MOVED/u, ""], [0, 3, /AUTH_FOCUS_MOVED/u, "STE"]]) {
    const native = fakeDriver({ packet: nativeSnapshot({ value: "", type: "text" }) })
    const field = native.handles.get(104)
    const stealer = native.handles.get(103)
    const focus = field.focus
    let focused = 0
    let sent = 0
    field.focus = async () => { await focus(); if (focused++ < atFocus) native.focus.on = stealer }
    const type = native.page.keyboard.type
    native.page.keyboard.type = async (text) => { await type(text); if (++sent === afterKeys) native.focus.on = stealer }
    const adapter = adapterFor(native, root)
    try {
      const ref = inputRef(await adapter.call(["snapshot"]))
      if (expected) await assert.rejects(adapter.call(["type", ref, "STEALTEST123"]), (error) => expected.test(error.message))
      else assert.deepEqual((await adapter.call(["type", ref, "STEALTEST123"])).typed, { verified: true })
      const keys = native.calls.filter((call) => call[0] === "keys")
      assert.equal(keys.filter((call) => call[1] === 103).length, 0, "the stealer gets no key")
      assert.equal(keys.map((call) => call[2]).join(""), held, "the target gets every key sent")
    } finally { await adapter.close() }
  }
  // A document without the window's focus gets no keys, and only an exact true is a verdict.
  for (const setup of [(native) => { native.focus.window = false }, (native) => { native.handles.get(104).evaluate = async () => "true" }]) {
    const native = fakeDriver({ packet: nativeSnapshot({ value: "", type: "text" }) })
    setup(native)
    const adapter = adapterFor(native, root)
    try {
      await assert.rejects(adapter.call(["type", inputRef(await adapter.call(["snapshot"])), "x"]), /AUTH_FOCUS_MOVED/u)
      assert.equal(native.calls.some((call) => call[0] === "keyboard.type"), false)
    } finally { await adapter.close() }
  }
  // Focus inside an open shadow counts for its host and for the shadow's own field, and nowhere else.
  const doc = { hasFocus: () => true }
  const element = (tagName, rootHost) => ({ tagName, ownerDocument: doc, contains: () => false, getRootNode: () => ({ host: rootHost }) })
  const host = element("X-EDITOR")
  const inner = element("INPUT", host)
  const other = element("INPUT")
  host.shadowRoot = { activeElement: inner }
  doc.activeElement = host
  assert.equal(auth.FOCUSED(host), true)
  assert.equal(auth.FOCUSED(inner), true)
  assert.equal(auth.FOCUSED(other), false)
  doc.hasFocus = () => false
  assert.equal(auth.FOCUSED(inner), false, "a document without the window's focus gets no keys")
})
