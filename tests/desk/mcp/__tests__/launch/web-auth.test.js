import { test } from "node:test"
import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { mkTempRoot } from "../_temp_roots.js"
import { nativeSnapshot, editingSnapshot, inspectedDOM, fakeDriver, PASSWORD } from "./_auth_fixtures.js"

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

function adapterFor(native, root, timeout = 5000) {
  return auth.create(native.context, root, timeout, () => {})
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
    ({ method, page }) => { if (method === "Page.getFrameTree") page.frames = () => [page.mainFrame(), {}] },
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
      assert.ok(native.calls.some((call) => call[0] === "dispose"))
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
    const adapter = auth.create(native.context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) })
    try {
      await assert.rejects(adapter.call(["snapshot", "--save"]), (error) => /AUTH_RUNTIME_POLICY_REFUSED/u.test(error.message) && !error.message.includes(PASSWORD))
      assert.deepEqual(fs.readdirSync(root), [])
      await assert.rejects(adapter.call(["fill", "e3", "literal"]), /AUTH_RUNTIME_POLICY_REFUSED/u)
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
    const adapter = auth.create(native.context, root, 5000, () => {})
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
        assert.ok(error.message.includes("AUTH_HANDLE_CLEANUP_FAILED"))
        if (failUnlink) assert.ok(error.message.includes("AUTH_ARTIFACT_CLEANUP_FAILED"))
        return true
      })
      assert.equal(attempts, 1, "owned stage removal is still attempted")
      assert.equal(fs.readdirSync(root).length, failUnlink ? 1 : 0)
    } finally {
      fs.promises.unlink = original
      await assert.rejects(adapter.close(), /AUTH_HANDLE_CLEANUP_FAILED/u)
      for (const handle of native.handles.values()) handle.dispose = async () => {}
      await adapter.close()
    }
  }
})

test("runtime policy gates actions and their post-await output while allowing context close", async () => {
  for (const when of ["before", "after"]) {
    const root = await mkTempRoot("auth-runtime-action-")
    const native = fakeDriver()
    let blocked = false
    const adapter = auth.create(native.context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) })
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
  const adapter = auth.create(native.context, root, 5000, () => { if (blocked) throw new Error(PASSWORD) })
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

test("committed ref disposal attempts every handle and retains failures for owned close", async () => {
  for (const synchronous of [false, true]) {
    const root = await mkTempRoot("auth-committed-handle-")
    const native = fakeDriver()
    const adapter = adapterFor(native, root)
    const attempts = new Map()
    let refuse = true
    try {
      await adapter.call(["snapshot"])
      for (const [id, handle] of native.handles) {
        handle.dispose = () => {
          attempts.set(id, (attempts.get(id) || 0) + 1)
          if (id === 102 && refuse) {
            if (synchronous) throw new Error(PASSWORD)
            return Promise.reject(new Error(PASSWORD))
          }
          return Promise.resolve()
        }
      }
      await assert.rejects(adapter.call(["snapshot", "--save"]), error =>
        /AUTH_HANDLE_CLEANUP_FAILED/u.test(error.message) && !error.message.includes(PASSWORD))
      assert.ok(attempts.get(103) > 0 && attempts.get(104) > 0, "a previous failure does not prevent other disposals")
      assert.deepEqual(fs.readdirSync(root), [])
      const before = attempts.get(102)
      refuse = false
      await adapter.close()
      assert.ok(attempts.get(102) > before, "close retries the still-owned rejected disposal")
    } finally { refuse = false; await adapter.close() }
  }
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
