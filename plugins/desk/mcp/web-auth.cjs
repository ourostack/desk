"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var failures = new WeakMap();

var STYLES = ["display", "visibility", "-webkit-user-modify"];
var EMBEDDED = new Set(["IFRAME", "FRAME", "FENCEDFRAME", "PORTAL", "OBJECT", "EMBED"]);
var EXCLUDED = new Set(["HEAD", "SCRIPT", "STYLE", "TEMPLATE", "META", "LINK", "NOSCRIPT"]);
var ROLES = { INPUT: "textbox", TEXTAREA: "textbox", BUTTON: "button", A: "link", SELECT: "combobox", OPTION: "option", FORM: "form", H1: "heading", H2: "heading", H3: "heading" };
var ARITY = {
  snapshot: [1, 2], goto: [2, 2], "go-back": [1, 1], "go-forward": [1, 1], reload: [1, 1],
  click: [2, 2], dblclick: [2, 2], fill: [3, 3], type: [3, 3], press: [3, 3], select: [3, 3],
  check: [2, 2], uncheck: [2, 2], hover: [2, 2], "tab-list": [1, 1], "tab-new": [1, 1],
  "tab-close": [1, 1], "tab-select": [2, 2], resize: [3, 3], mousewheel: [3, 3]
};

function fail(code, applied) {
  var message = code + ": The authenticated browser could not safely complete this operation." +
    (applied ? " The action may have applied; its output was refused." : "");
  var error = new Error(message);
  error.plain = true;
  error.authCode = code;
  failures.set(error, Object.freeze({ code: code, message: message }));
  return error;
}

function knownFailure(error) {
  return error && typeof error === "object" && failures.has(error);
}

function safeFailure(error) {
  return error && typeof error === "object" ? failures.get(error) : undefined;
}

function sameStage(expected, current) {
  return expected && current.isFile() && expected.dev === current.dev && expected.ino === current.ino &&
    current.nlink === 1n && typeof current.dev === "bigint" && current.dev >= 0n &&
    typeof current.ino === "bigint" && current.ino > 0n;
}

function requireTrue(value, code) {
  if (!value) throw fail(code || "AUTH_NATIVE_DATA_INVALID");
}

function dataOnly(value, budget) {
  budget = budget || { nodes: 0, chars: 0, active: new WeakSet() };
  requireTrue(++budget.nodes <= 200000, "AUTH_OUTPUT_TOO_LARGE");
  if (typeof value === "string") {
    budget.chars += value.length;
    requireTrue(value.length <= 1048576 && budget.chars <= 16777216, "AUTH_OUTPUT_TOO_LARGE");
    return;
  }
  if (typeof value === "number") { requireTrue(Number.isFinite(value)); return; }
  if (value === null || typeof value === "boolean" || value === undefined) return;
  requireTrue(typeof value === "object");
  var prototype = Object.getPrototypeOf(value);
  requireTrue(prototype === null || prototype === Object.prototype || (Array.isArray(value) && prototype === Array.prototype));
  requireTrue(!budget.active.has(value));
  budget.active.add(value);
  try {
    if (Array.isArray(value)) {
      requireTrue(value.length <= 200000);
      for (var i = 0; i < value.length; i++) requireTrue(Object.prototype.hasOwnProperty.call(value, i));
    }
    Object.values(Object.getOwnPropertyDescriptors(value)).forEach(function (descriptor) {
      requireTrue(Object.prototype.hasOwnProperty.call(descriptor, "value"));
      dataOnly(descriptor.value, budget);
    });
  } finally { budget.active.delete(value); }
}

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function inspect(root) {
  dataOnly(root);
  var nodes = new Map();
  var controls = new Set();
  var signature = [];
  function walk(node, parent, cssPath, shadow) {
    requireTrue(node && integer(node.backendNodeId, 1, Number.MAX_SAFE_INTEGER) && !nodes.has(node.backendNodeId));
    requireTrue(integer(node.nodeType, 1, 12) && typeof node.nodeName === "string");
    requireTrue(!EMBEDDED.has(node.nodeName) && !node.contentDocument, "AUTH_FRAME_COVERAGE_REFUSED");
    var children = node.children || [];
    requireTrue(Array.isArray(children));
    if (node.childNodeCount !== undefined) requireTrue(node.childNodeCount === children.length);
    var entry = { id: node.backendNodeId, type: node.nodeType, name: node.nodeName, parent: parent, path: cssPath, shadow: shadow };
    nodes.set(entry.id, entry);
    if (entry.name === "INPUT" || entry.name === "TEXTAREA") controls.add(entry.id);
    signature.push([entry.id, entry.type, entry.name, parent, shadow]);
    var ordinal = new Map();
    children.forEach(function (child) {
      var childPath = cssPath;
      if (child.nodeType === 1) {
        var tag = child.nodeName.toLowerCase();
        requireTrue(/^[a-z][a-z0-9-]*$/.test(tag), "AUTH_TARGET_KIND_REFUSED");
        ordinal.set(tag, (ordinal.get(tag) || 0) + 1);
        childPath = (cssPath ? cssPath + " > " : "") + tag + ":nth-of-type(" + ordinal.get(tag) + ")";
      }
      walk(child, entry.id, childPath, shadow);
    });
    (node.shadowRoots || []).forEach(function (shadowRoot) {
      if (shadowRoot.shadowRootType === "user-agent") {
        requireTrue(["INPUT", "TEXTAREA", "SELECT"].indexOf(entry.name) !== -1, "AUTH_SHADOW_COVERAGE_REFUSED");
        return;
      }
      requireTrue(shadowRoot.shadowRootType === "open", "AUTH_SHADOW_COVERAGE_REFUSED");
      signature.push([entry.id, shadowRoot.backendNodeId, "open"]);
      walk(shadowRoot, entry.id, undefined, true);
    });
    if (node.templateContent) walk(node.templateContent, entry.id, undefined, shadow);
  }
  requireTrue(root && root.nodeType === 9, "AUTH_DOCUMENT_REFUSED");
  walk(root, 0, "", false);
  return { root: root.backendNodeId, nodes: nodes, controls: controls, signature: JSON.stringify(signature) };
}

function prepare(packet, scope, frameId, nextRef) {
  dataOnly(packet);
  requireTrue(Array.isArray(packet.documents) && packet.documents.length === 1, "AUTH_FRAME_COVERAGE_REFUSED");
  requireTrue(Array.isArray(packet.strings));
  var strings = packet.strings;
  function text(index, empty) {
    requireTrue(integer(index, empty === false ? 0 : -1, strings.length - 1));
    if (index === -1) return "";
    requireTrue(typeof strings[index] === "string");
    return strings[index];
  }
  var document = packet.documents[0];
  requireTrue(text(document.frameId, false) === frameId, "AUTH_DOCUMENT_REFUSED");
  var table = document.nodes;
  requireTrue(table && Array.isArray(table.nodeType));
  var count = table.nodeType.length;
  requireTrue(count > 0 && count <= 20000, "AUTH_OUTPUT_TOO_LARGE");
  ["parentIndex", "nodeName", "nodeValue", "backendNodeId", "attributes"].forEach(function (key) {
    requireTrue(Array.isArray(table[key]) && table[key].length === count);
  });
  function sparse(field, boolean) {
    requireTrue(field && Array.isArray(field.index));
    if (!boolean) requireTrue(Array.isArray(field.value) && field.index.length === field.value.length);
    var result = new Map();
    field.index.forEach(function (index, offset) {
      requireTrue(integer(index, 0, count - 1) && !result.has(index));
      result.set(index, boolean ? true : text(field.value[offset]));
    });
    return result;
  }
  var input = sparse(table.inputValue);
  var textarea = sparse(table.textValue);
  var shadows = sparse(table.shadowRootType);
  requireTrue(table.contentDocumentIndex && Array.isArray(table.contentDocumentIndex.index) &&
    table.contentDocumentIndex.index.length === 0, "AUTH_FRAME_COVERAGE_REFUSED");
  var layout = document.layout;
  requireTrue(layout && Array.isArray(layout.nodeIndex) && Array.isArray(layout.styles) &&
    layout.nodeIndex.length === layout.styles.length);
  var style = new Map();
  layout.nodeIndex.forEach(function (index, offset) {
    requireTrue(integer(index, 0, count - 1) && !style.has(index));
    var row = layout.styles[offset];
    requireTrue(Array.isArray(row) && (row.length === 0 || row.length === STYLES.length));
    style.set(index, row.map(function (value) { return text(value); }));
  });
  var ids = new Set();
  var controls = new Set();
  var rows = [];
  for (var i = 0; i < count; i++) {
    var id = table.backendNodeId[i];
    requireTrue(integer(id, 1, Number.MAX_SAFE_INTEGER) && !ids.has(id));
    ids.add(id);
    requireTrue(integer(table.nodeType[i], 1, 12) && integer(table.parentIndex[i], i === 0 ? -1 : 0, i - 1));
    var name = text(table.nodeName[i], false);
    requireTrue(!EMBEDDED.has(name), "AUTH_FRAME_COVERAGE_REFUSED");
    requireTrue(!shadows.has(i) || shadows.get(i) === "open", "AUTH_SHADOW_COVERAGE_REFUSED");
    var attributes = table.attributes[i];
    requireTrue(Array.isArray(attributes) && attributes.length % 2 === 0);
    var attrs = new Map();
    for (var a = 0; a < attributes.length; a += 2) {
      var key = text(attributes[a], false);
      requireTrue(!attrs.has(key));
      attrs.set(key, text(attributes[a + 1]));
    }
    var control = name === "INPUT" || name === "TEXTAREA";
    if (control) {
      controls.add(id);
      requireTrue((name === "INPUT" ? input : textarea).has(i));
    }
    var parent = i === 0 ? null : rows[table.parentIndex[i]];
    var css = style.get(i) || [];
    var shadow = Boolean(shadows.has(i) || (parent && parent.shadow));
    var excluded = EXCLUDED.has(name) || Boolean(parent && parent.excluded);
    var unknown = table.nodeType[i] !== 9 && (css.length !== 3 || css[2] !== "read-only" || shadow);
    var opaque = control || unknown || Boolean(parent && parent.opaque);
    rows.push({ id: id, name: name, type: table.nodeType[i], attrs: attrs, parent: parent,
      css: css, shadow: shadow, excluded: excluded, opaque: opaque,
      value: text(table.nodeValue[i]), children: [] });
    if (parent) parent.children.push(rows[i]);
  }
  requireTrue(rows[0].type === 9 && rows[0].id === scope.root, "AUTH_DOCUMENT_REFUSED");
  requireTrue(controls.size === scope.controls.size &&
    Array.from(controls).every(function (id) { return scope.controls.has(id); }), "AUTH_CONTROL_COVERAGE_REFUSED");
  scope.nodes.forEach(function (node) {
    requireTrue(ids.has(node.id) || node.type === 11, "AUTH_CONTROL_COVERAGE_REFUSED");
  });
  var secrets = new Set();
  // Complete the native value pass before any label or text is rendered.
  input.forEach(function (value) { if (value) secrets.add(value); });
  textarea.forEach(function (value) { if (value) secrets.add(value); });
  rows.forEach(function (row) { if (row.opaque && row.value && !row.excluded) secrets.add(row.value); });
  function scrub(value) {
    secrets.forEach(function (secret) { value = value.split(secret).join("[redacted]"); });
    return value;
  }
  var targets = [];
  function render(row) {
    if (row.excluded) return null;
    if (row.type === 3) return { role: "text", text: row.opaque ? "[redacted]" : scrub(row.value) };
    if (row.type !== 1 && row.type !== 9) return null;
    var node = { role: ROLES[row.name] || (row.type === 9 ? "document" : "generic"), children: [] };
    var visible = row.css.length === 3 && row.css[0] !== "none" && ["hidden", "collapse"].indexOf(row.css[1]) === -1;
    node.visible = visible;
    if (!row.opaque && row.attrs.has("aria-label")) node.name = scrub(row.attrs.get("aria-label"));
    if (row.name === "INPUT" && !row.shadow && row.attrs.has("aria-label") && row.css[2] === "read-only" && !(row.parent && row.parent.opaque)) {
      node.name = scrub(row.attrs.get("aria-label"));
    }
    var inspected = scope.nodes.get(row.id);
    if (nextRef && row.type === 1 && visible && !row.shadow && inspected && inspected.path) {
      node.ref = "e" + nextRef();
      targets.push({ ref: node.ref, path: inspected.path, id: row.id });
    }
    if (row.name === "INPUT" || row.name === "TEXTAREA") {
      node.children.push({ role: "text", text: "[redacted]" });
    } else {
      row.children.forEach(function (child) {
        var rendered = render(child);
        if (rendered) node.children.push(rendered);
      });
      if (row.opaque && !node.children.length) node.children.push({ role: "text", text: "[redacted]" });
    }
    return node;
  }
  try {
    var tree = render(rows[0]);
    dataOnly(tree);
    var protection = rows.map(function (row) {
      var modify = row.css.length === 3 && ["read-only", "read-write", "read-write-plaintext-only"].indexOf(row.css[2]) !== -1 ? row.css[2] : "unknown";
      return [row.id, row.parent ? row.parent.id : 0, row.type, row.opaque, modify];
    });
    var redaction = crypto.createHash("sha256").update(JSON.stringify(Array.from(secrets).sort())).digest("hex");
    return { tree: tree, targets: targets, protection: protection, redaction: redaction };
  } finally {
    secrets.clear();
    rows.length = 0;
    input.clear();
    textarea.clear();
  }
}

function renderText(node, depth) {
  depth = depth || 0;
  var line = "  ".repeat(depth) + "- " + node.role;
  if (node.ref) line += " [ref=" + node.ref + "]";
  if (node.name) line += " " + JSON.stringify(node.name);
  if (node.text !== undefined) line += ": " + JSON.stringify(node.text);
  return [line].concat((node.children || []).map(function (child) { return renderText(child, depth + 1); })).join("\n");
}

function checkArgs(args) {
  requireTrue(Array.isArray(args) && args.length > 0 && args.every(function (arg) {
    return typeof arg === "string" && arg.length <= 65536;
  }), "AUTH_ARGUMENTS_REFUSED");
  var bounds = ARITY[args[0]];
  requireTrue(bounds && args.length >= bounds[0] && args.length <= bounds[1], "AUTH_COMMAND_REFUSED");
  if (args[0] === "snapshot") requireTrue(args.length === 1 || args[1] === "--save", "AUTH_ARGUMENTS_REFUSED");
  if (args[0] === "goto") {
    var url;
    try { url = new URL(args[1]); } catch (error) { throw fail("AUTH_URL_REFUSED"); }
    requireTrue(["http:", "https:"].indexOf(url.protocol) !== -1 && !url.username && !url.password, "AUTH_URL_REFUSED");
  }
  if (["resize", "mousewheel", "tab-select"].indexOf(args[0]) !== -1) {
    args.slice(1).forEach(function (value) { requireTrue(/^-?\d+$/.test(value) && Math.abs(Number(value)) <= 10000, "AUTH_ARGUMENTS_REFUSED"); });
    if (args[0] !== "mousewheel") requireTrue(args.slice(1).every(function (value) { return Number(value) >= (args[0] === "resize" ? 1 : 0); }), "AUTH_ARGUMENTS_REFUSED");
  }
}

function create(context, outputDir, timeoutMs, runtimePolicy) {
  requireTrue(typeof runtimePolicy === "function", "AUTH_RUNTIME_POLICY_MISSING");
  var closed = false;
  var readers = new Map();
  var refs = new Map();
  var cleanupRecords = new Set();
  var next = 0;
  var selected = context.pages()[0];
  var queue = Promise.resolve();
  var pending = new Set();
  var stageHandles = new Set();
  var contextClosing;
  function checkRuntime() {
    try { runtimePolicy(); } catch (error) { throw fail("AUTH_RUNTIME_POLICY_REFUSED"); }
  }
  async function send(reader, method, params) {
    checkRuntime();
    var response = await reader.cdp.send(method, params);
    checkRuntime();
    return response;
  }
  function closeContext() {
    if (!contextClosing) {
      contextClosing = Promise.resolve().then(function () { return context.close(); }).catch(function (error) {
        contextClosing = undefined;
        throw error;
      });
    }
    return contextClosing;
  }
  function watch(reader, emitter, event, listener) {
    emitter.on(event, listener);
    reader.listeners.push([emitter, event, listener]);
  }
  function unwatch(reader) {
    reader.listeners.forEach(function (entry) { entry[0].off(entry[1], entry[2]); });
    reader.listeners.length = 0;
  }
  async function disposeRecords(records) {
    var results = await Promise.allSettled(records.map(function (record) {
      return Promise.resolve().then(async function () {
        await record.handle.dispose();
        cleanupRecords.delete(record);
      });
    }));
    if (results.some(function (result) { return result.status === "rejected"; })) throw fail("AUTH_HANDLE_CLEANUP_FAILED");
  }
  function dropRefs() {
    var previous = Array.from(refs.values());
    refs.clear();
    return disposeRecords(previous);
  }
  async function readerFor(page) {
    checkRuntime();
    requireTrue(page && page.context() === context && context.pages().indexOf(page) !== -1 && !page.isClosed(), "AUTH_CONTEXT_REFUSED");
    if (readers.has(page)) {
      requireTrue(readers.get(page).ready && readers.get(page).alive, "AUTH_READER_REFUSED");
      return readers.get(page);
    }
    var cdp = await context.newCDPSession(page);
    var reader = { page: page, cdp: cdp, epoch: 0, alive: true, ready: false, listeners: [] };
    var dirty = function () { reader.epoch++; };
    ["DOM.documentUpdated", "DOM.childNodeInserted", "DOM.childNodeRemoved", "DOM.childNodeCountUpdated",
      "DOM.attributeModified", "DOM.attributeRemoved", "DOM.characterDataModified", "DOM.shadowRootPushed", "DOM.shadowRootPopped",
      "Page.frameAttached", "Page.frameDetached", "Page.frameNavigated", "Runtime.executionContextsCleared", "Runtime.executionContextDestroyed"]
      .forEach(function (event) { watch(reader, cdp, event, dirty); });
    watch(reader, cdp, "close", function () { reader.alive = false; dirty(); });
    watch(reader, page, "close", function () { reader.alive = false; dirty(); });
    watch(reader, page, "crash", function () { reader.alive = false; dirty(); });
    readers.set(page, reader);
    try {
      checkRuntime();
      await send(reader, "Page.enable");
      await send(reader, "DOM.enable");
      await send(reader, "Runtime.enable");
      reader.ready = true;
    } catch (error) {
      var primary = knownFailure(error) ? safeFailure(error).code : "AUTH_READER_SETUP_FAILED";
      reader.alive = false;
      unwatch(reader);
      try { await cdp.detach(); } catch (cleanupError) {
        throw fail(primary + "; retained cleanup uncertainty: AUTH_READER_CLEANUP_FAILED");
      }
      readers.delete(page);
      throw fail(primary);
    }
    return reader;
  }
  async function qualify(reader) {
    checkRuntime();
    requireTrue(!closed && reader.alive && !reader.page.isClosed() && reader.page.context() === context &&
      context.pages().indexOf(reader.page) !== -1, "AUTH_CONTEXT_REFUSED");
    requireTrue(reader.page.frames().length === 1 && reader.page.frames()[0] === reader.page.mainFrame(), "AUTH_FRAME_COVERAGE_REFUSED");
    var response = await send(reader, "Page.getFrameTree");
    dataOnly(response);
    var tree = response.frameTree;
    requireTrue(tree && tree.frame && typeof tree.frame.id === "string" && tree.frame.id &&
      typeof tree.frame.loaderId === "string" && tree.frame.loaderId &&
      (tree.childFrames === undefined || (Array.isArray(tree.childFrames) && tree.childFrames.length === 0)), "AUTH_FRAME_COVERAGE_REFUSED");
    var dom = await send(reader, "DOM.getDocument", { depth: -1, pierce: true });
    dataOnly(dom);
    var scope = inspect(dom.root);
    return { scope: scope, frameId: tree.frame.id, loaderId: tree.frame.loaderId };
  }
  function same(a, b, reader, epoch) {
    checkRuntime();
    requireTrue(!closed && reader.alive && reader.epoch === epoch &&
      a.frameId === b.frameId && a.loaderId === b.loaderId && a.scope.signature === b.scope.signature, "AUTH_SNAPSHOT_INVALIDATED");
  }
  async function verifyProtection(reader, scope, prepared, epoch) {
    var packet = await send(reader, "DOMSnapshot.captureSnapshot", { computedStyles: STYLES.slice() });
    var current;
    try { current = prepare(packet, scope.scope, scope.frameId); } finally { packet = null; }
    same(scope, scope, reader, epoch);
    requireTrue(JSON.stringify(current.protection) === JSON.stringify(prepared.protection), "AUTH_PROTECTION_INVALIDATED");
    requireTrue(current.redaction === prepared.redaction, "AUTH_REDACTION_INVALIDATED");
  }
  async function snapshot(reader, save, applied) {
    var provisional = [];
    var staged;
    var stageIdentity;
    var stageCloseFailed = false;
    var committed = false;
    var primary;
    try {
      var epoch = reader.epoch;
      var before = await qualify(reader);
      requireTrue(reader.epoch === epoch, "AUTH_SNAPSHOT_INVALIDATED");
      var packet = await send(reader, "DOMSnapshot.captureSnapshot", { computedStyles: STYLES.slice() });
      var prepared;
      try { prepared = prepare(packet, before.scope, before.frameId, function () { return ++next; }); } finally { packet = null; }
      for (var target of prepared.targets) {
        checkRuntime();
        var handle = await reader.page.mainFrame().waitForSelector("css=" + target.path, { state: "attached", strict: true, timeout: timeoutMs });
        requireTrue(handle, "AUTH_TARGET_REFUSED");
        var record = { ref: target.ref, handle: handle, reader: reader, epoch: epoch, stamp: before };
        provisional.push(record);
        cleanupRecords.add(record);
        checkRuntime();
      }
      var qualified = await qualify(reader);
      same(before, qualified, reader, epoch);
      await verifyProtection(reader, qualified, prepared, epoch);
      checkRuntime();
      var result = { snapshot: prepared.tree, text: renderText(prepared.tree) };
      if (applied) result.actionMayHaveApplied = true;
      var final;
      if (save) {
        final = path.join(outputDir, "snapshot-" + crypto.randomUUID() + ".json");
        staged = final + ".tmp";
        checkRuntime();
        var stageFile = await fs.promises.open(staged, "wx", 384);
        stageHandles.add(stageFile);
        var stageFailure;
        try {
          stageIdentity = await stageFile.stat({ bigint: true });
          requireTrue(sameStage(stageIdentity, stageIdentity), "AUTH_STAGE_IDENTITY_REFUSED");
          checkRuntime();
          await stageFile.writeFile(JSON.stringify(result));
          checkRuntime();
        } catch (error) {
          stageFailure = error;
          throw error;
        } finally {
          try { await stageFile.close(); stageHandles.delete(stageFile); }
          catch (error) {
            stageCloseFailed = true;
            if (!stageFailure) throw fail("AUTH_STAGE_CLOSE_FAILED");
          }
        }
      }
      await dropRefs();
      qualified = await qualify(reader);
      same(before, qualified, reader, epoch);
      await verifyProtection(reader, qualified, prepared, epoch);
      same(before, before, reader, epoch);
      // No await between this admission check, the owned rename and ref activation.
      if (staged) {
        requireTrue(sameStage(stageIdentity, fs.lstatSync(staged, { bigint: true })), "AUTH_STAGE_IDENTITY_REFUSED");
        checkRuntime();
        fs.renameSync(staged, final); staged = undefined; result.artifact = final;
      }
      provisional.forEach(function (record) { refs.set(record.ref, record); });
      committed = true;
      return result;
    } catch (error) {
      primary = knownFailure(error) ? safeFailure(error).code : "AUTH_SNAPSHOT_FAILED";
      throw fail(primary, applied);
    } finally {
      var cleanup = [];
      if (stageCloseFailed) cleanup.push("AUTH_STAGE_CLOSE_FAILED");
      if (!committed) {
        try { await disposeRecords(provisional); } catch (error) { cleanup.push("AUTH_HANDLE_CLEANUP_FAILED"); }
      }
      if (staged) {
        try {
          var current = await fs.promises.lstat(staged, { bigint: true });
          requireTrue(sameStage(stageIdentity, current), "AUTH_STAGE_IDENTITY_REFUSED");
          await fs.promises.unlink(staged);
        } catch (error) {
          if (error.code !== "ENOENT") cleanup.push("AUTH_ARTIFACT_CLEANUP_FAILED");
        }
      }
      if (cleanup.length) throw fail((primary || "AUTH_OPERATION_FAILED") + "; retained cleanup uncertainty: " + cleanup.join(", "), applied);
    }
  }
  async function execute(args) {
    checkRuntime();
    checkArgs(args);
    requireTrue(!closed, "AUTH_CONTEXT_REFUSED");
    var pages = context.pages();
    var page = selected;
    var command = args[0];
    if (command === "tab-select") { requireTrue(Number(args[1]) < pages.length, "AUTH_TARGET_REFUSED"); selected = pages[Number(args[1])]; page = selected; }
    if (command === "tab-new") {
      try { checkRuntime(); page = await context.newPage(); checkRuntime(); selected = page; }
      catch (error) { throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_TAB_ACTION_FAILED", true); }
    }
    if (command === "tab-list") return { tabs: context.pages().map(function (tab, index) { return { index: index, selected: tab === selected }; }) };
    if (command === "tab-close") {
      try {
        requireTrue(page && context.pages().indexOf(page) !== -1 && !page.isClosed(), "AUTH_TARGET_REFUSED");
        checkRuntime(); await page.close(); checkRuntime(); selected = context.pages()[0];
        await dropRefs(); checkRuntime(); return { closed: true };
      }
      catch (error) { throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_TAB_ACTION_FAILED", true); }
    }
    var reader;
    try { reader = await readerFor(page); }
    catch (error) {
      throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_READER_SETUP_FAILED", command === "tab-new");
    }
    if (command === "snapshot" || command === "tab-select" || command === "tab-new") return snapshot(reader, args[1] === "--save", command === "tab-new");
    var applied = false;
    try {
      if (["goto", "go-back", "go-forward", "reload", "resize", "mousewheel"].indexOf(command) !== -1) {
        checkRuntime();
        applied = true;
        if (command === "goto") await page.goto(args[1], { timeout: timeoutMs });
        if (command === "go-back") await page.goBack({ timeout: timeoutMs });
        if (command === "go-forward") await page.goForward({ timeout: timeoutMs });
        if (command === "reload") await page.reload({ timeout: timeoutMs });
        if (command === "resize") await page.setViewportSize({ width: Number(args[1]), height: Number(args[2]) });
        if (command === "mousewheel") await page.mouse.wheel(Number(args[1]), Number(args[2]));
        checkRuntime();
      } else {
        requireTrue(/^e[1-9]\d*$/.test(args[1]), "AUTH_TARGET_REFUSED");
        var record = refs.get(args[1]);
        requireTrue(record && record.reader === reader, "AUTH_TARGET_REFUSED");
        same(record.stamp, await qualify(reader), reader, record.epoch);
        checkRuntime();
        applied = true;
        var method = command === "select" ? "selectOption" : command;
        if (args.length === 3) await record.handle[method](args[2], { timeout: timeoutMs });
        else await record.handle[method]({ timeout: timeoutMs });
        checkRuntime();
      }
      return await snapshot(reader, false, applied);
    } catch (error) {
      throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_ACTION_FAILED", applied);
    }
  }
  function bounded(work) {
    var timer;
    return Promise.race([work, new Promise(function (_, reject) {
      timer = setTimeout(function () { closed = true; readers.forEach(function (reader) { reader.epoch++; }); reject(fail("AUTH_TIMEOUT", true)); }, timeoutMs);
    })]).finally(function () { clearTimeout(timer); });
  }
  return {
    call: function (args) {
      var result = queue.then(function () {
        var work = execute(args);
        pending.add(work);
        work.then(function () { pending.delete(work); }, function () { pending.delete(work); });
        return bounded(work);
      }).catch(async function (error) {
        if (knownFailure(error) && safeFailure(error).code === "AUTH_TIMEOUT") {
          try { await bounded(closeContext()); } catch (closeError) { throw fail("AUTH_TIMEOUT_CLOSE_FAILED", true); }
        }
        throw knownFailure(error) ? error : fail("AUTH_OPERATION_FAILED");
      });
      queue = result.catch(function () {});
      return result;
    },
    close: async function () {
      closed = true;
      readers.forEach(function (reader) { reader.epoch++; });
      try {
        await bounded(closeContext());
        await bounded(Promise.allSettled(Array.from(pending)));
        var fileClosures = await Promise.allSettled(Array.from(stageHandles).map(async function (file) {
          await file.close();
          stageHandles.delete(file);
        }));
        if (fileClosures.some(function (result) { return result.status === "rejected"; })) throw fail("AUTH_STAGE_CLOSE_FAILED");
        refs.clear();
        await disposeRecords(Array.from(cleanupRecords));
        // Closing the owned persistent context closes its CDP targets; stale detach calls can fail after that.
        readers.forEach(unwatch);
        readers.clear();
      } catch (error) {
        var primary = knownFailure(error) ? safeFailure(error).code : "AUTH_CLOSE_FAILED";
        throw fail(primary + "; retained cleanup uncertainty: AUTH_CLOSE_FAILED");
      }
    }
  };
}

module.exports = { create: create, prepare: prepare, inspect: inspect, checkArgs: checkArgs, fail: fail, safeFailure: safeFailure };
