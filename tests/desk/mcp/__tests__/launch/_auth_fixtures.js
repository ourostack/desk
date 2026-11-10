import { EventEmitter } from "node:events"

export const PASSWORD = "FAKE_PROPERTY_PASSWORD_577"

export function nativeSnapshot({ value = PASSWORD, userModify = "read-only", type = "password" } = {}) {
  const strings = []
  const s = (value) => {
    if (value === "") return -1
    const existing = strings.indexOf(value)
    if (existing !== -1) return existing
    strings.push(value)
    return strings.length - 1
  }
  const empty = () => ({ index: [], value: [] })
  const document = {
    frameId: s("main"), documentURL: s("https://synthetic.invalid/"), title: s("Sign in"),
    baseURL: s("https://synthetic.invalid/"), contentLanguage: -1, encodingName: s("UTF-8"),
    publicId: -1, systemId: -1,
    nodes: {
      parentIndex: [-1, 0, 1, 2], nodeType: [9, 1, 1, 1],
      nodeName: ["#document", "HTML", "BODY", "INPUT"].map(s),
      nodeValue: [-1, -1, -1, -1], backendNodeId: [101, 102, 103, 104],
      attributes: [[], [], [], [s("type"), s(type), s("aria-label"), s("Password")]],
      inputValue: { index: [3], value: [s(value)] }, textValue: empty(),
      shadowRootType: empty(), contentDocumentIndex: empty(), inputChecked: { index: [] },
      optionSelected: { index: [] }, isClickable: { index: [3] },
    },
    layout: {
      nodeIndex: [1, 2, 3],
      styles: [1, 2, 3].map(() => [s("block"), s("visible"), s(userModify)]),
      bounds: [1, 2, 3].map(() => [0, 0, 100, 20]), text: [-1, -1, -1],
      stackingContexts: { index: [] },
    },
    textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
  }
  return { documents: [document], strings }
}

// DOM.getDocument with pierce: a frame owner carries its child document as contentDocument.
export function inspectedDOM(packet, index = 0) {
  const document = packet.documents[index]
  const table = document.nodes
  const text = (i) => i === -1 ? "" : packet.strings[i]
  const rows = table.nodeType.map((nodeType, i) => ({
    nodeId: index * 1000 + i + 1, backendNodeId: table.backendNodeId[i], nodeType,
    nodeName: text(table.nodeName[i]), localName: nodeType === 1 ? text(table.nodeName[i]).toLowerCase() : "",
    nodeValue: text(table.nodeValue[i]), attributes: table.attributes[i].map(text), children: [],
  }))
  table.parentIndex.forEach((parent, i) => { if (parent >= 0) rows[parent].children.push(rows[i]) })
  table.contentDocumentIndex.index.forEach((row, i) => { rows[row].contentDocument = inspectedDOM(packet, table.contentDocumentIndex.value[i]).root })
  return { root: rows[0] }
}

export const FRAME_TEXT = "CHILD_FRAME_TEXT_688"
export const FALLBACK_TEXT = "FRAME_FALLBACK_TEXT_688"
export const FRAME_TYPED = "CHILD_FRAME_TYPED_688"
export const FRAME_EDITED = "CHILD_FRAME_EDITED_688"

// The sign-in page plus a visible main-document paragraph and an iframe (with fallback text) whose
// child document holds text, a filled field and a hidden editable region, as DOMSnapshot reports a page with a child frame.
// `echo` adds main-document text, as when page script copies something from the frame.
export function framedSnapshot({ echo } = {}) {
  const packet = nativeSnapshot()
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  const main = packet.documents[0]
  const css = main.layout.styles[0]
  const add = (document, parent, type, name, value, id) => {
    const nodes = document.nodes
    nodes.parentIndex.push(parent)
    nodes.nodeType.push(type)
    nodes.nodeName.push(s(name))
    nodes.nodeValue.push(value === undefined ? -1 : s(value))
    nodes.backendNodeId.push(id)
    nodes.attributes.push([])
    document.layout.nodeIndex.push(nodes.nodeType.length - 1)
    document.layout.styles.push(css.slice())
    document.layout.bounds.push([0, 0, 100, 20])
    document.layout.text.push(-1)
    return nodes.nodeType.length - 1
  }
  add(main, add(main, 2, 1, "P", undefined, 105), 3, "#text", "Main product title" + (echo ? " " + echo : ""), 106)
  const iframe = add(main, 2, 1, "IFRAME", undefined, 107)
  add(main, iframe, 3, "#text", FALLBACK_TEXT, 108)
  main.nodes.contentDocumentIndex = { index: [iframe], value: [1] }
  const child = structuredClone(main)
  child.frameId = s("child")
  child.nodes = {
    parentIndex: [-1, 0, 1], nodeType: [9, 1, 1], nodeName: ["#document", "HTML", "BODY"].map(s),
    nodeValue: [-1, -1, -1], backendNodeId: [201, 202, 203], attributes: [[], [], []],
    inputValue: { index: [], value: [] }, textValue: { index: [], value: [] }, shadowRootType: { index: [], value: [] },
    contentDocumentIndex: { index: [], value: [] }, inputChecked: { index: [] }, optionSelected: { index: [] }, isClickable: { index: [] },
  }
  child.layout = { nodeIndex: [1, 2], styles: [css.slice(), css.slice()], bounds: [[0, 0, 1, 1], [0, 0, 1, 1]], text: [-1, -1], stackingContexts: { index: [] } }
  add(child, 2, 3, "#text", FRAME_TEXT, 204)
  const input = add(child, 2, 1, "INPUT", undefined, 205)
  child.nodes.inputValue = { index: [input], value: [s(FRAME_TYPED)] }
  const editor = add(child, 2, 1, "DIV", undefined, 206)
  child.nodes.attributes[editor] = [s("contenteditable"), s("")]
  add(child, editor, 3, "#text", FRAME_EDITED, 207)
  for (const row of [editor, editor + 1]) {
    const at = child.layout.nodeIndex.indexOf(row)
    for (const key of ["nodeIndex", "styles", "bounds", "text"]) child.layout[key].splice(at, 1)
  }
  packet.documents.push(child)
  return packet
}

export function fakeDriver({ packet = nativeSnapshot(), hook, launchError, closeError } = {}) {
  const calls = []
  const context = new EventEmitter()
  const page = new EventEmitter()
  const handles = new Map()
  for (const id of packet.documents[0].nodes.backendNodeId) {
    const handle = { dispose: async () => { calls.push(["dispose", id]) } }
    for (const method of ["scrollIntoViewIfNeeded", "click", "dblclick", "fill", "type", "press", "selectOption", "check", "uncheck", "hover"]) {
      handle[method] = async (...args) => {
        calls.push([method, ...args])
        if (method === "fill" || method === "type") {
          const table = packet.documents[0].nodes
          const row = table.backendNodeId.indexOf(id)
          const position = table.inputValue.index.indexOf(row)
          if (position !== -1) {
            packet.strings.push(args[0])
            table.inputValue.value[position] = packet.strings.length - 1
          }
        }
      }
    }
    // Read-back runs the page function on the control's current value.
    handle.evaluate = async (fn, arg) => {
      calls.push(["evaluate", id])
      const table = packet.documents[0].nodes
      const position = table.inputValue.index.indexOf(table.backendNodeId.indexOf(id))
      return fn({ isContentEditable: false, value: position === -1 ? undefined : packet.strings[table.inputValue.value[position]], innerText: "" }, arg)
    }
    handles.set(id, handle)
  }
  const frame = {
    waitForSelector: async (selector, options) => {
      calls.push(["waitForSelector", selector, options])
      const ending = selector.split(" > ").at(-1).replace(/^css=/, "").split(":")[0].toUpperCase()
      const row = packet.documents[0].nodes.nodeName.findIndex((index) => packet.strings[index] === ending)
      return handles.get(packet.documents[0].nodes.backendNodeId[row])
    },
  }
  page.context = () => context
  page.mainFrame = () => frame
  page.frames = () => [frame]
  page.isClosed = () => false
  for (const method of ["goto", "goBack", "goForward", "reload", "setViewportSize", "close"]) {
    page[method] = async (...args) => { calls.push([method, ...args]) }
  }
  page.mouse = { wheel: async (...args) => calls.push(["wheel", ...args]) }
  context.pages = () => [page]
  context.newPage = async () => page
  context.close = async () => {
    calls.push(["context.close"])
    if (closeError) throw closeError
  }
  const cdp = new EventEmitter()
  const counts = new Map()
  cdp.send = async (method, params) => {
    calls.push(["cdp", method, params])
    counts.set(method, (counts.get(method) ?? 0) + 1)
    hook?.({ method, count: counts.get(method), cdp, context, page })
    if (["Page.enable", "DOM.enable", "Runtime.enable"].includes(method)) return {}
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "loader", mimeType: "text/html" } } }
    if (method === "DOM.getDocument") return inspectedDOM(packet)
    if (method === "DOMSnapshot.captureSnapshot") return structuredClone(packet)
    throw new Error(`unsupported fake method ${PASSWORD}`)
  }
  cdp.detach = async () => { calls.push(["cdp.detach"]) }
  context.newCDPSession = async (target) => {
    if (target !== page) throw new Error(PASSWORD)
    calls.push(["newCDPSession"])
    return cdp
  }
  const driver = {
    version: "1.63.0",
    chromium: {
      launchPersistentContext: async (...args) => {
        calls.push(["launchPersistentContext", ...args])
        if (launchError) throw launchError
        return context
      },
    },
  }
  return { driver, calls, context, page, cdp, handles, packet }
}

export function editingSnapshot(mode = "read-write") {
  const packet = nativeSnapshot()
  const s = (text) => { packet.strings.push(text); return packet.strings.length - 1 }
  const document = packet.documents[0]
  const nodes = document.nodes
  nodes.nodeName[3] = s("DIV")
  nodes.attributes[3] = []
  nodes.inputValue = { index: [], value: [] }
  nodes.parentIndex.push(3)
  nodes.nodeType.push(3)
  nodes.nodeName.push(s("#text"))
  nodes.nodeValue.push(s(PASSWORD))
  nodes.backendNodeId.push(105)
  nodes.attributes.push([])
  document.layout.nodeIndex.push(4)
  const write = s(mode)
  document.layout.styles[2][2] = write
  document.layout.styles.push([document.layout.styles[2][0], document.layout.styles[2][1], write])
  document.layout.bounds.push([0, 0, 100, 20])
  document.layout.text.push(s(PASSWORD))
  return packet
}
