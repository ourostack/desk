"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var failures = new WeakMap();

var STYLES = ["display", "visibility", "-webkit-user-modify"];
var TARGET_WAIT_MS = 2000;
var SNAPSHOT_ATTEMPTS = 5;
var SNAPSHOT_SETTLE_MS = 250;
// Refs from this many of the latest reads stay usable: an agent often reads twice (find, then find again) before it
// acts. Every action re-resolves its ref against the page as it is now, so an older ref acts only on its own node.
var REF_READS = 3;
var NAVIGATIONS = ["goto", "go-back", "go-forward", "reload"];
// wait: a bare wait pauses this long; no wait outlasts half the command time or a minute; text is looked for this often.
var WAIT_DEFAULT_MS = 2000;
var WAIT_MAX_MS = 60000;
var WAIT_POLL_MS = 1000;
// A page this small whose words read as an error is usually a transient error page, worth one reload.
var ERROR_PAGE_CHARS = 20000;
// Text an agent reads in one reply: hosts set aside larger tool output in a file the agent may never open.
var TEXT_BUDGET = 24000;
// One text longer than this reads cut short, so a single long paragraph cannot crowd out the rest of the page.
var LINE_CHARS = 4000;
var ERROR_PAGE = /\b(?:oops|something went wrong|unknown error|an error occurred|try again later)\b/i;
// A large store product page has about 18,000 nodes and 250,000 native values.
var MAX_NODES = 100000;
var MAX_VALUES = 2000000;
var RETRIED = ["AUTH_SNAPSHOT_INVALIDATED"];
var EDITS = ["type", "fill", "press"];
var EDITABLE = ["read-write", "read-write-plaintext-only"];
// Runs in the page: whether a field or editing host now holds the text (all of it for fill, some of it for type).
var HOLDS = function (node, input) {
  var flat = function (value) { return String(value || "").replace(/\s+/g, " ").trim(); };
  var current = flat(node.isContentEditable || typeof node.value !== "string" ? node.innerText : node.value);
  return input[1] === "fill" ? current === flat(input[0]) : current.indexOf(flat(input[0])) !== -1;
};
var EMBEDDED = new Set(["IFRAME", "FRAME", "FENCEDFRAME", "PORTAL", "OBJECT", "EMBED"]);
var UNTYPED = new Set(["hidden", "submit", "button", "reset", "image"]);
// Shorter values in fields nobody types into are page codes ("US", "0", "USD"), never a typed value's copy.
var UNTYPED_CODE_LENGTH = 8;
var EXCLUDED = new Set(["HEAD", "SCRIPT", "STYLE", "TEMPLATE", "META", "LINK", "NOSCRIPT"]);
var ROLES = { INPUT: "textbox", TEXTAREA: "textbox", BUTTON: "button", A: "link", SELECT: "combobox", OPTION: "option", FORM: "form", H1: "heading", H2: "heading", H3: "heading" };
var ARITY = {
  snapshot: [1, 2], find: [2, 2], goto: [2, 2], "go-back": [1, 1], "go-forward": [1, 1], reload: [1, 1],
  click: [2, 2], dblclick: [2, 2], fill: [3, 3], type: [3, 3], press: [2, 3], select: [3, 3], wait: [1, 3],
  check: [2, 2], uncheck: [2, 2], hover: [2, 2], "tab-list": [1, 1], "tab-new": [1, 1],
  "tab-close": [1, 2], "tab-select": [2, 2], resize: [3, 3], mousewheel: [3, 3], screenshot: [1, 3]
};
// A ref is bound this many times when the page keeps moving it between the read and the browser's confirmation.
var BIND_ATTEMPTS = 3;
// Fields whose value a screenshot never shows: a password (also once a "show password" toggle has made it text), or a
// one-time code. The browser paints a box over each, in every frame.
var SECRET_FIELDS = "input[type=password], input[autocomplete~=current-password], input[autocomplete~=new-password], input[autocomplete~=one-time-code]";

var COMMANDS = "snapshot [--interactive | --save]; find <text>; goto <url>; go-back; go-forward; reload; wait [<seconds> | <text> | --gone <text>]; " +
  "click, dblclick, hover, check or uncheck <ref>; fill or type <ref> <text>; press [<ref>] <key>; select <ref> <value>; " +
  "mousewheel <dx> <dy>; resize <width> <height>; screenshot [<ref>] [--full]; tab-list; tab-new; tab-select <index>; tab-close [<index>]";
var SNAPSHOT_AGAIN = "Run [\"snapshot\"] to see the page as it is now and act on a ref from it.";
var CHANGING = "The page was changing while it was read. Run [\"wait\",\"2\"] (or wait for text you expect), then try again.";
// What to do instead, for each refusal. Nothing here ever needs eval or a page script: refs from a snapshot cover it.
var HINTS = {
  AUTH_COMMAND_REFUSED: "Commands in mine: " + COMMANDS + ". eval and page scripts are never needed: snapshot, then act on its refs; to let a page load, use wait.",
  AUTH_ARGUMENTS_REFUSED: "Check the arguments. Commands in mine: " + COMMANDS + ". A wait is 1 to 60 seconds (or 100 to 60000 ms), or up to 200 characters of text.",
  AUTH_URL_REFUSED: "goto takes a full http or https URL with no user name or password in it.",
  AUTH_TARGET_REFUSED: "That ref is not from one of the last " + REF_READS + " reads of this tab, or its element has gone. " + SNAPSHOT_AGAIN,
  AUTH_SNAPSHOT_INVALIDATED: "The page replaced that element, or navigated, since it was read. " + SNAPSHOT_AGAIN + " While a page loads, use [\"wait\",\"<text you expect>\"].",
  AUTH_FRAME_COVERAGE_REFUSED: CHANGING + " If it repeats, open the frame's own page with goto.",
  AUTH_SHADOW_COVERAGE_REFUSED: CHANGING + " If it repeats, this part of the page cannot be read in mine; [\"screenshot\"] shows it.",
  AUTH_ACTION_FAILED: SNAPSHOT_AGAIN + " Check the ref is the control you mean and is enabled; for a key, use a name such as Enter, Tab or Control+a.",
  AUTH_SCREENSHOT_FAILED: "Run [\"wait\",\"2\"], then try again; for one part of the page, pass a ref from a snapshot.",
  AUTH_TAB_ACTION_FAILED: "Run [\"tab-list\"] to see the tabs, then try again.",
  AUTH_TAB_REFUSED: "There is no such open tab. Run [\"tab-list\"] and use an index from it with tab-select or tab-close.",
  AUTH_OUTPUT_TOO_LARGE: "The page is too large to read whole. Go to a narrower page (a single item or chat) with goto, or close panels you do not need.",
  AUTH_TIMEOUT: "The command ran out of time, so this context was closed. Open a new one with browser_context and start again; keep waits under a minute.",
  AUTH_CONTEXT_REFUSED: "This context, or its selected tab, is closed. If [\"tab-list\"] shows tabs, select one with tab-select; otherwise open a new context with browser_context.",
  AUTH_TIMEOUT_CLOSE_FAILED: "Open a new context with browser_context.",
  AUTH_RUNTIME_POLICY_REFUSED: "This Desk process cannot protect authenticated output now. Close the context and open a new one with browser_context; if it repeats, report it with desk_doctor.",
  AUTH_READER_REFUSED: "The tab was replaced or closed. Run [\"tab-list\"], select a tab, then snapshot.",
  AUTH_READER_SETUP_FAILED: "The tab could not be read yet. Run [\"wait\",\"2\"], then snapshot; if it repeats, open a new context.",
  AUTH_DOCUMENT_REFUSED: "This page is not an ordinary HTML document mine can read. Go to the page's HTML address with goto, or use [\"screenshot\"].",
  AUTH_TARGET_KIND_REFUSED: "That element cannot be acted on in mine. " + SNAPSHOT_AGAIN + " Choose its labelled parent or another control."
};
var GENERAL_HINT = SNAPSHOT_AGAIN + " If the same refusal repeats, open a new context with browser_context.";

function hintFor(code) {
  return HINTS[String(code).split(";")[0]] || GENERAL_HINT;
}

function fail(code, applied) {
  var message = code + ": The authenticated browser could not safely complete this operation." +
    (applied ? " The action may have applied; its output was refused." : "") + " " + hintFor(code);
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
  requireTrue(++budget.nodes <= MAX_VALUES, "AUTH_OUTPUT_TOO_LARGE");
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
      requireTrue(value.length <= MAX_VALUES);
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

// What an element is, for re-resolving a ref on a page that kept changing elsewhere: its name, its attributes other
// than presentation (class, style), and its subtree's element names and text, open shadow roots included. Child
// frames and template content are never read, and the hash never leaves the process.
var PRESENTATION = ["class", "style"];
function fingerprint(raw) {
  var hash = crypto.createHash("sha256");
  (function walk(node) {
    var attrs = node.attributes || [];
    var kept = [];
    for (var i = 0; i + 1 < attrs.length; i += 2) if (PRESENTATION.indexOf(attrs[i]) === -1) kept.push(attrs[i], attrs[i + 1]);
    hash.update(JSON.stringify([node.nodeType, node.nodeName, node.nodeType === 3 ? node.nodeValue : "", kept]));
    if (EMBEDDED.has(node.nodeName)) return;
    (node.children || []).forEach(walk);
    (node.shadowRoots || []).forEach(function (root) { if (root.shadowRootType === "open") walk(root); });
    hash.update(")");
  })(raw);
  return hash.digest("hex");
}

// The DOM as the browser names it (DOM.getDocument with pierce), for the CSS path each ref binds by. A same-process
// child frame's document is walked from its owner, with paths from that document's own root; `chain` lists the frame
// owners between the read's top document and a node, outermost first.
function inspect(root) {
  dataOnly(root);
  var nodes = new Map();
  var controls = new Set();
  function walk(node, parent, cssPath, shadow, doc, chain, reach) {
    requireTrue(node && integer(node.backendNodeId, 1, Number.MAX_SAFE_INTEGER) && !nodes.has(node.backendNodeId));
    requireTrue(integer(node.nodeType, 1, 12) && typeof node.nodeName === "string");
    var frame = EMBEDDED.has(node.nodeName);
    requireTrue(frame || !node.contentDocument, "AUTH_FRAME_COVERAGE_REFUSED");
    var children = node.children || [];
    requireTrue(Array.isArray(children));
    if (node.childNodeCount !== undefined) requireTrue(node.childNodeCount === children.length);
    var entry = { id: node.backendNodeId, type: node.nodeType, name: node.nodeName, parent: parent, path: cssPath, shadow: shadow,
      raw: node, doc: doc, chain: chain, reach: reach && !shadow };
    nodes.set(entry.id, entry);
    if (entry.name === "INPUT" || entry.name === "TEXTAREA") controls.add(entry.id);
    if (frame) {
      if (typeof node.frameId === "string" && node.frameId) entry.frameId = node.frameId;
      // A frame owner's fallback content is never rendered; the document it shows is read in its place.
      if (node.contentDocument) {
        var inner = node.contentDocument;
        requireTrue(inner && inner.nodeType === 9, "AUTH_FRAME_COVERAGE_REFUSED");
        walk(inner, entry.id, "", false, inner.backendNodeId, chain.concat([entry.id]), entry.reach && Boolean(cssPath));
      }
      return;
    }
    var ordinal = new Map();
    children.forEach(function (child) {
      var childPath = cssPath;
      if (child.nodeType === 1) {
        var tag = child.nodeName.toLowerCase();
        requireTrue(/^[a-z][a-z0-9-]*$/.test(tag), "AUTH_TARGET_KIND_REFUSED");
        ordinal.set(tag, (ordinal.get(tag) || 0) + 1);
        childPath = (cssPath ? cssPath + " > " : "") + tag + ":nth-of-type(" + ordinal.get(tag) + ")";
      }
      walk(child, entry.id, childPath, shadow, doc, chain, reach);
    });
    (node.shadowRoots || []).forEach(function (shadowRoot) {
      // Browser-internal trees (form controls, media controls, details, SVG use) are absent from
      // DOMSnapshot, so they are never rendered; control values come from the native value fields.
      if (shadowRoot.shadowRootType === "user-agent") return;
      requireTrue(shadowRoot.shadowRootType === "open", "AUTH_SHADOW_COVERAGE_REFUSED");
      entry.host = true;
      walk(shadowRoot, entry.id, undefined, true, doc, chain, reach);
    });
    // Template content is inert, excluded from rendering and absent from DOMSnapshot; only its fragment is recorded.
    if (node.templateContent) inert(node.templateContent, entry.id);
  }
  function inert(fragment, parent) {
    requireTrue(fragment && integer(fragment.backendNodeId, 1, Number.MAX_SAFE_INTEGER) && !nodes.has(fragment.backendNodeId));
    requireTrue(fragment.nodeType === 11);
    nodes.set(fragment.backendNodeId, { id: fragment.backendNodeId, type: 11, name: fragment.nodeName, parent: parent, shadow: false });
  }
  requireTrue(root && root.nodeType === 9, "AUTH_DOCUMENT_REFUSED");
  walk(root, 0, "", false, root.backendNodeId, [], true);
  return { root: root.backendNodeId, nodes: nodes, controls: controls };
}

// Unrendered (display: none) nodes have no layout row, so no computed style. -webkit-user-modify is inherited
// and only contenteditable changes it in markup, so they take their nearest styled ancestor's mode.
function editingMode(styled, css, attrs, parentMode) {
  if (styled) return css.length === STYLES.length ? css[2] : "unknown";
  var editable = attrs.has("contenteditable") ? attrs.get("contenteditable").toLowerCase() : undefined;
  return editable === "false" ? "read-only" : editable !== undefined ? "read-write" : parentMode || "unknown";
}

// Whether a native control value could have been typed, and so must be scrubbed wherever it appears.
function typedValue(value, attrs) {
  var type = (attrs.get("type") || "").toLowerCase();
  // A checkbox or radio value is page markup nobody types ("on" when unset).
  if ((type === "checkbox" || type === "radio") && value === (attrs.has("value") ? attrs.get("value") : "on")) return false;
  return !(UNTYPED.has(type) && value.length < UNTYPED_CODE_LENGTH);
}

// One DOMSnapshot capture is one instant of the page: every value and every text in it are from the same moment, so a
// read needs nothing but the capture to protect what it shows. The DOM read (`scope`) only names the paths refs bind
// by; a node one read has and the other lacks (the page changed between them) is shown without a ref, or not at all.
// `outside` holds the captures of out-of-process child frames, each with its own DOM read and frame id; each is shown
// inside the frame owner whose frame id it carries. Every value typed anywhere in the page is scrubbed everywhere.
function prepare(packet, scope, frameId, nextRef, outside) {
  var secrets = new Set();
  var budget = { rows: 0 };
  // Whitespace alone protects nothing and would blank every space in the page.
  function secret(value) { if (value && /\S/u.test(value)) secrets.add(value); }
  var main = rowsOf(packet, scope, frameId, undefined, secret, budget);
  var linked = new Map();
  (outside || []).forEach(function (frame) {
    requireTrue(frame && typeof frame.frameId === "string" && frame.scope, "AUTH_FRAME_COVERAGE_REFUSED");
    // Two captures claiming one frame contradict each other: neither is shown, and both are still scrubbed.
    var read = rowsOf(frame.packet, frame.scope, frame.frameId, frame.key, secret, budget);
    linked.set(frame.frameId, linked.has(frame.frameId) ? null : read);
  });
  // The document root must be the one the DOM read named; otherwise the page navigated between the two reads.
  requireTrue(main.rows[0].id === scope.root, "AUTH_SNAPSHOT_INVALIDATED");
  [main].concat(Array.from(linked.values()).filter(Boolean)).forEach(function (read) {
    read.rows.forEach(function (row) {
      if (!row.frame || row.content || row.framed) return;
      var owner = read.scope.nodes.get(row.id);
      var inner = owner && owner.frameId ? linked.get(owner.frameId) : undefined;
      if (inner && !inner.claimed) { inner.claimed = true; row.content = inner.rows[0]; }
    });
  });
  function scrub(value) {
    var matches = [];
    secrets.forEach(function (secret) {
      var index = value.indexOf(secret);
      while (index !== -1) {
        requireTrue(matches.length < 200000, "AUTH_OUTPUT_TOO_LARGE");
        matches.push([index, index + secret.length]);
        index = value.indexOf(secret, index + 1);
      }
    });
    if (!matches.length) return value;
    matches.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; });
    var result = "";
    var copied = 0;
    var start = matches[0][0];
    var end = matches[0][1];
    matches.slice(1).forEach(function (match) {
      if (match[0] <= end) { end = Math.max(end, match[1]); return; }
      result += value.slice(copied, start) + "[redacted]";
      copied = end;
      start = match[0];
      end = match[1];
    });
    return result + value.slice(copied, start) + "[redacted]" + value.slice(end);
  }
  var targets = [];
  var frames = 0;
  function render(row) {
    if (row.excluded) return null;
    // Only what the page renders is read: text with no layout, or hidden, is not on screen (Teams keeps a hidden
    // "Oops, unknown error!" template in its DOM that would read as a failure).
    if (row.type === 3) return shown(row) || listed(row) ? { role: "text", text: row.opaque ? "[redacted]" : scrub(row.value) } : null;
    if (row.type !== 1 && row.type !== 9) return null;
    var node = { role: ROLES[row.name] || (row.type === 9 ? "document" : "generic"), children: [] };
    var visible = shown(row);
    node.visible = visible;
    if (!row.opaque && row.attrs.has("aria-label")) node.name = scrub(row.attrs.get("aria-label"));
    if (row.name === "INPUT" && !row.shadow && row.attrs.has("aria-label") && row.css[2] === "read-only" && !(row.parent && row.parent.opaque)) {
      node.name = scrub(row.attrs.get("aria-label"));
    }
    // A rich-text editor's host (Teams' composer) is a textbox an agent can find by its author label; what was typed
    // in it stays redacted, and so does a label that repeats it.
    if (row.type === 1 && !row.shadow && EDITABLE.indexOf(row.modify) !== -1 && !(row.parent && EDITABLE.indexOf(row.parent.modify) !== -1)) {
      node.role = "textbox";
      if (row.attrs.has("aria-label")) node.name = scrub(row.attrs.get("aria-label"));
    }
    var inspected = row.read.scope.nodes.get(row.id);
    if (nextRef && row.type === 1 && visible && !row.shadow && inspected && inspected.path && inspected.reach && inspected.doc === row.doc) {
      node.ref = "e" + nextRef();
      // Keys typed into a node inside a rich-text editor go to its editing host: the outermost editable ancestor.
      var host = row;
      while (EDITABLE.indexOf(host.modify) !== -1 && host.parent && !host.parent.shadow && EDITABLE.indexOf(host.parent.modify) !== -1) host = host.parent;
      targets.push({ ref: node.ref, path: inspected.path, id: row.id, host: EDITABLE.indexOf(row.modify) !== -1 ? host.id : row.id, key: row.read.key });
    }
    if (row.frame) {
      node.role = "frame";
      if (node.name === undefined && !row.opaque && row.attrs.has("title")) node.name = scrub(row.attrs.get("title"));
      var inner = row.content ? render(row.content) : null;
      if (inner) node.children.push(inner);
      else frames++;
    } else if (row.name === "INPUT" || row.name === "TEXTAREA") {
      node.children.push({ role: "text", text: "[redacted]" });
    } else {
      row.children.forEach(function (child) {
        var rendered = render(child);
        if (rendered) node.children.push(rendered);
      });
      if (row.opaque && !node.children.length) node.children.push({ role: "text", text: "[redacted]" });
    }
    // An element that is not on screen and holds nothing that is is left out (display: contents keeps its shown
    // children); a hidden control or private region still shows as redacted.
    if (row.type === 1 && !visible && !row.frame && !node.children.length && !listed(row)) return null;
    return node;
  }
  function shown(row) { return row.css.length === 3 && row.css[0] !== "none" && ["hidden", "collapse"].indexOf(row.css[1]) === -1; }
  // A dropdown's options (and a list box's option text) have no layout of their own, yet they are what a shown select
  // offers; only an option styled away is left out.
  function listed(row) {
    if (row.css.length === 3 || !row.parent) return false;
    var up = row.parent;
    while (up.parent && ["OPTION", "OPTGROUP"].indexOf(up.name) !== -1 && (up.css.length !== 3 || shown(up))) up = up.parent;
    return up.name === "SELECT" && shown(up);
  }
  try {
    var tree = render(main.rows[0]);
    dataOnly(tree);
    return { tree: tree, targets: targets, frames: frames };
  } finally {
    secrets.clear();
  }
}

// Every document of one capture as rows, checked against the native contract, with each value that may have been
// typed handed to `secret` before anything is rendered. Same-process child documents hang from their frame owners.
function rowsOf(packet, scope, frameId, key, secret, budget) {
  dataOnly(packet);
  requireTrue(Array.isArray(packet.documents) && packet.documents.length >= 1, "AUTH_DOCUMENT_REFUSED");
  requireTrue(Array.isArray(packet.strings));
  var strings = packet.strings;
  var read = { scope: scope, key: key, rows: [] };
  function text(index, empty) {
    requireTrue(integer(index, empty === false ? 0 : -1, strings.length - 1));
    if (index === -1) return "";
    requireTrue(typeof strings[index] === "string");
    return strings[index];
  }
  requireTrue(text(packet.documents[0].frameId, false) === frameId, "AUTH_DOCUMENT_REFUSED");
  function sparse(field, size) {
    requireTrue(field && Array.isArray(field.index));
    requireTrue(Array.isArray(field.value) && field.index.length === field.value.length);
    var result = new Map();
    field.index.forEach(function (index, offset) {
      requireTrue(integer(index, 0, size - 1) && !result.has(index));
      result.set(index, text(field.value[offset]));
    });
    return result;
  }
  function attributesOf(attributes) {
    requireTrue(Array.isArray(attributes) && attributes.length % 2 === 0);
    var attrs = new Map();
    for (var a = 0; a < attributes.length; a += 2) {
      var name = text(attributes[a], false);
      requireTrue(!attrs.has(name));
      attrs.set(name, text(attributes[a + 1]));
    }
    return attrs;
  }
  function styles(layout, size) {
    requireTrue(layout && Array.isArray(layout.nodeIndex) && Array.isArray(layout.styles) &&
      layout.nodeIndex.length === layout.styles.length);
    var result = new Map();
    layout.nodeIndex.forEach(function (index, offset) {
      requireTrue(integer(index, 0, size - 1));
      var row = layout.styles[offset];
      requireTrue(Array.isArray(row) && (row.length === 0 || row.length === STYLES.length));
      var values = row.map(function (value) { return text(value); });
      // One node can own several layout objects (inline continuations, anonymous wrappers); their styles must agree.
      if (result.has(index)) requireTrue(JSON.stringify(result.get(index)) === JSON.stringify(values));
      else result.set(index, values);
    });
    return result;
  }
  var ids = new Set();
  var documents = packet.documents.map(function (document, d) {
    // A child document that breaks the native contract cannot be scrubbed, so nothing of the page is shown.
    var coverage = d === 0 ? "AUTH_NATIVE_DATA_INVALID" : "AUTH_FRAME_COVERAGE_REFUSED";
    var table = document && document.nodes;
    requireTrue(table && Array.isArray(table.nodeType), coverage);
    var count = table.nodeType.length;
    budget.rows += count;
    requireTrue(count > 0 && count <= MAX_NODES && budget.rows <= MAX_NODES * 4, count > 0 ? "AUTH_OUTPUT_TOO_LARGE" : coverage);
    ["parentIndex", "nodeName", "nodeValue", "backendNodeId", "attributes"].forEach(function (name) {
      requireTrue(Array.isArray(table[name]) && table[name].length === count, coverage);
    });
    var input = sparse(table.inputValue, count);
    var textarea = sparse(table.textValue, count);
    var shadows = sparse(table.shadowRootType, count);
    var owners = table.contentDocumentIndex;
    requireTrue(owners && Array.isArray(owners.index) && Array.isArray(owners.value) &&
      owners.index.length === owners.value.length, "AUTH_FRAME_COVERAGE_REFUSED");
    var style = styles(document.layout, count);
    var rows = [];
    for (var i = 0; i < count; i++) {
      var id = table.backendNodeId[i];
      requireTrue(integer(id, 1, Number.MAX_SAFE_INTEGER) && !ids.has(id));
      ids.add(id);
      requireTrue(integer(table.nodeType[i], 1, 12) && integer(table.parentIndex[i], i === 0 ? -1 : 0, i - 1), coverage);
      var name = text(table.nodeName[i], false);
      var parent = i === 0 ? null : rows[table.parentIndex[i]];
      var framed = Boolean(parent && (parent.frame || parent.framed));
      requireTrue(framed || !shadows.has(i) || shadows.get(i) === "open", "AUTH_SHADOW_COVERAGE_REFUSED");
      var attrs = attributesOf(table.attributes[i]);
      var control = !framed && (name === "INPUT" || name === "TEXTAREA");
      if (control) requireTrue((name === "INPUT" ? input : textarea).has(i));
      var css = style.get(i) || [];
      var modify = editingMode(style.has(i), css, attrs, parent && parent.modify);
      var shadow = Boolean(shadows.has(i) || (parent && parent.shadow));
      var excluded = EXCLUDED.has(name) || framed || Boolean(parent && parent.excluded);
      var unknown = table.nodeType[i] !== 9 && (modify !== "read-only" || shadow);
      var opaque = control || unknown || Boolean(parent && parent.opaque);
      var row = { id: id, name: name, type: table.nodeType[i], attrs: attrs, parent: parent, doc: id, read: read,
        css: css, shadow: shadow, excluded: excluded, opaque: opaque, modify: modify, frame: EMBEDDED.has(name), framed: framed,
        value: text(table.nodeValue[i]), children: [] };
      if (parent) { row.doc = parent.doc; parent.children.push(row); }
      rows.push(row);
      read.rows.push(row);
    }
    requireTrue(rows[0].type === 9, "AUTH_DOCUMENT_REFUSED");
    // Complete the native value pass before any label or text is rendered.
    input.forEach(function (value, index) { if (typedValue(value, rows[index].attrs)) secret(value); });
    textarea.forEach(secret);
    rows.forEach(function (row) { if (row.opaque && !row.excluded) secret(row.value); });
    return { rows: rows, owners: owners };
  });
  // Only frame owners own child documents, each at most once, and the top document is nobody's child.
  var owned = new Set();
  documents.forEach(function (document) {
    document.owners.index.forEach(function (index, offset) {
      var child = document.owners.value[offset];
      requireTrue(integer(index, 0, document.rows.length - 1) && document.rows[index].frame &&
        integer(child, 1, documents.length - 1) && !owned.has(child), "AUTH_FRAME_COVERAGE_REFUSED");
      owned.add(child);
      document.rows[index].content = documents[child].rows[0];
    });
  });
  return read;
}

// The text agents read is compact: busy apps nest dozens of unnamed wrappers per item, which read as nothing but cost
// most of the output. An unnamed wrapper with nothing in it is left out; one holding a single text reads as one line;
// one holding a single element, or holding several without a ref of its own, gives way to what it holds. Every
// named node, every text and every ref that holds something stays; the JSON tree (and a saved artifact) keeps it all.
// A view narrows it: find keeps lines holding the text and the lines that contain them; interactive keeps lines with
// a ref or a name. Past TEXT_BUDGET characters, named and non-generic lines stay, then the rest in page order.
function renderText(node, view) {
  var entries = [];
  // A wrapper that gives way to the one thing it holds hands that thing its ref, so the text stays clickable.
  (function walk(n, depth, parent, carried) {
    var children = n.children || [];
    var plain = (n.role === "generic" && !n.name && n.text === undefined) || n.role === "text";
    var ref = n.ref || (plain ? carried : undefined);
    if (n.role === "text" && ref) {
      entries.push({ depth: depth, parent: parent, ref: true, key: false, field: false, words: n.text, line: "- generic [ref=" + ref + "]: " + quote(n.text) });
      return;
    }
    if (n.role === "generic" && plain) {
      if (!children.length) return;
      if (children.length === 1) { walk(children[0], depth, parent, ref); return; }
      if (!ref) { children.forEach(function (child) { walk(child, depth, parent); }); return; }
    }
    var line = "- " + n.role;
    if (ref) line += " [ref=" + ref + "]";
    if (n.name) line += " " + quote(n.name);
    if (n.text !== undefined) line += ": " + quote(n.text);
    var index = entries.length;
    entries.push({ depth: depth, parent: parent, ref: Boolean(ref), key: Boolean(n.name) || ["generic", "text"].indexOf(n.role) === -1,
      field: ["textbox", "combobox", "heading"].indexOf(n.role) !== -1,
      words: [n.name, n.text].filter(function (value) { return typeof value === "string"; }).join(" "), line: line });
    children.forEach(function (child) { walk(child, depth + 1, index); });
  })(node, 0, -1);
  var keep = entries.map(function () { return !view; });
  var matches = 0;
  if (view && view.find !== undefined) {
    var needle = view.find.toLowerCase();
    entries.forEach(function (entry, index) {
      if (entry.words.toLowerCase().indexOf(needle) === -1) return;
      matches++;
      for (var at = index; at !== -1 && !keep[at]; at = entries[at].parent) keep[at] = true;
    });
  }
  if (view && view.interactive) entries.forEach(function (entry, index) { keep[index] = entry.ref || entry.key; });
  var full = entries.reduce(function (sum, entry) { return sum + entry.depth * 2 + entry.line.length + 1 + Math.max(0, entry.words.length - LINE_CHARS); }, 0);
  var size = function (entry) { return entry.depth * 2 + entry.line.length + 1; };
  // Choose lines for a budget: fields and headings first, other named lines up to half of it, then the rest in page
  // order, so a page full of named buttons still shows its text.
  function choose(budget) {
    var used = 0;
    var shown = entries.map(function () { return false; });
    function take(test, limit) {
      entries.forEach(function (entry, index) {
        if (keep[index] && !shown[index] && test(entry) && used + size(entry) <= limit) { used += size(entry); shown[index] = true; }
      });
    }
    take(function (entry) { return entry.field; }, budget);
    take(function (entry) { return entry.key; }, budget / 2);
    take(function () { return true; }, budget);
    return shown;
  }
  function print(shown) {
    var lines = [];
    var gap = 0;
    var left = 0;
    entries.forEach(function (entry, index) {
      if (!keep[index]) return;
      if (!shown[index]) { gap++; left++; return; }
      if (gap) lines.push("  ".repeat(entry.depth) + "- \u2026 " + gap + " lines left out");
      gap = 0;
      lines.push("  ".repeat(entry.depth) + entry.line);
    });
    if (gap) lines.push("- \u2026 " + gap + " lines left out");
    return { text: lines.join("\n"), left: left };
  }
  // The markers for what was left out cost room too: the largest choice whose whole print fits is found by halving.
  var printed = print(keep);
  if (printed.text.length > TEXT_BUDGET) {
    var low = 0;
    var high = TEXT_BUDGET;
    printed = print(choose(0));
    while (high - low > 64) {
      var middle = Math.floor((low + high) / 2);
      var tried = print(choose(middle));
      if (tried.text.length <= TEXT_BUDGET) { low = middle; printed = tried; } else high = middle;
    }
  }
  return { text: printed.text, left: printed.left, matches: matches, full: full };
}

function quote(text) { return JSON.stringify(text.length > LINE_CHARS ? text.slice(0, LINE_CHARS) + "\u2026" : text); }

function checkArgs(args) {
  requireTrue(Array.isArray(args) && args.length > 0 && args.every(function (arg) {
    return typeof arg === "string" && arg.length <= 65536;
  }), "AUTH_ARGUMENTS_REFUSED");
  var bounds = ARITY[args[0]];
  requireTrue(bounds && args.length >= bounds[0] && args.length <= bounds[1], "AUTH_COMMAND_REFUSED");
  if (args[0] === "snapshot") requireTrue(args.length === 1 || args[1] === "--save" || args[1] === "--interactive", "AUTH_ARGUMENTS_REFUSED");
  if (args[0] === "find") requireTrue(args[1].trim().length > 0 && args[1].length <= 200, "AUTH_ARGUMENTS_REFUSED");
  if (args[0] === "goto") {
    var url;
    try { url = new URL(args[1]); } catch (error) { throw fail("AUTH_URL_REFUSED"); }
    requireTrue(["http:", "https:"].indexOf(url.protocol) !== -1 && !url.username && !url.password, "AUTH_URL_REFUSED");
  }
  if (args[0] === "wait") waitPlan(args);
  // A key alone goes to whatever has focus: a key name or one character, with + between modifiers.
  if (args[0] === "press" && args.length === 2) requireTrue(/^[\x21-\x7e]{1,40}$/.test(args[1]), "AUTH_ARGUMENTS_REFUSED");
  if (args[0] === "screenshot") {
    var picks = args.slice(1).filter(function (value) { return value !== "--full"; });
    requireTrue(args.length - 1 - picks.length <= 1 && picks.length <= 1 && picks.every(function (value) { return /^e[1-9]\d*$/.test(value); }) &&
      !(picks.length && args.indexOf("--full") !== -1), "AUTH_ARGUMENTS_REFUSED");
  }
  if (["resize", "mousewheel", "tab-select", "tab-close"].indexOf(args[0]) !== -1) {
    args.slice(1).forEach(function (value) { requireTrue(/^-?\d+$/.test(value) && Math.abs(Number(value)) <= 10000, "AUTH_ARGUMENTS_REFUSED"); });
    if (args[0] !== "mousewheel") requireTrue(args.slice(1).every(function (value) { return Number(value) >= (args[0] === "resize" ? 1 : 0); }), "AUTH_ARGUMENTS_REFUSED");
  }
}

// ["wait"], ["wait","<n>"] (up to 60 is seconds, more is milliseconds), ["wait","--time","<n>"],
// ["wait","<text>"], ["wait","--text","<text>"] or ["wait","--gone","<text>"].
function waitPlan(args) {
  var flag = args.length === 3 ? args[1] : null;
  requireTrue(flag === null || ["--time", "--text", "--gone"].indexOf(flag) !== -1, "AUTH_ARGUMENTS_REFUSED");
  var value = args[args.length - 1];
  if (args.length === 1) return { ms: WAIT_DEFAULT_MS };
  if (flag === "--time" || (flag === null && /^\d+(?:\.\d+)?$/.test(value))) {
    requireTrue(/^\d+(?:\.\d+)?$/.test(value), "AUTH_ARGUMENTS_REFUSED");
    var number = Number(value);
    var ms = number <= 60 ? number * 1000 : number;
    requireTrue(ms >= 100 && ms <= WAIT_MAX_MS, "AUTH_ARGUMENTS_REFUSED");
    return { ms: Math.round(ms) };
  }
  // Text that starts with "-" (a negative number, an unknown option) needs --text in front of it.
  requireTrue(value.length <= 200 && value.trim().length > 0 && (flag !== null || value[0] !== "-"), "AUTH_ARGUMENTS_REFUSED");
  return { text: value, gone: flag === "--gone" };
}

function shows(node, text) {
  var needle = text.toLowerCase();
  return (function visit(n) {
    return [n.name, n.text].some(function (value) { return typeof value === "string" && value.toLowerCase().indexOf(needle) !== -1; }) ||
      (n.children || []).some(visit);
  })(node);
}

function LEFT_OUT(count) {
  return count + " lines were left out to keep this short. Use [\"find\",\"<text>\"] for the lines holding that text and " +
    "what contains them, [\"snapshot\",\"--interactive\"] for refs and named controls only, or [\"snapshot\",\"--save\"] for the whole page in a file.";
}

// The same snapshot, read through a narrower view.
function narrow(result, view) {
  var rendered = renderText(result.snapshot, view);
  result.text = rendered.text;
  delete result.hint;
  if (view.find !== undefined) result.matches = rendered.matches;
  if (rendered.left) result.hint = LEFT_OUT(rendered.left);
  return result;
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function create(context, outputDir, timeoutMs, runtimePolicy, options) {
  requireTrue(typeof runtimePolicy === "function", "AUTH_RUNTIME_POLICY_MISSING");
  var attempts = options && integer(options.snapshotAttempts, 1, SNAPSHOT_ATTEMPTS) ? options.snapshotAttempts : SNAPSHOT_ATTEMPTS;
  var closed = false;
  var readers = new Map();
  var refs = new Map();
  var cleanupRecords = new Set();
  var next = 0;
  // A wait's polls are reads the agent never sees: their refs are kept apart until one is returned.
  var polled = new WeakMap();
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
  function dropRefs(page) {
    refs.forEach(function (record, ref) { if (!page || record.reader.page === page) refs.delete(ref); });
  }
  async function readerFor(page) {
    checkRuntime();
    requireTrue(page && page.context() === context && context.pages().indexOf(page) !== -1 && !page.isClosed(), "AUTH_CONTEXT_REFUSED");
    if (readers.has(page)) {
      requireTrue(readers.get(page).ready && readers.get(page).alive, "AUTH_READER_REFUSED");
      return readers.get(page);
    }
    var cdp = await context.newCDPSession(page);
    var reader = { page: page, cdp: cdp, epoch: 0, alive: true, ready: false, listeners: [], outside: new Map() };
    // The epoch only says whether the browser must confirm a ref's path before an action; it never refuses a read.
    var dirty = function () { reader.epoch++; };
    ["DOM.documentUpdated", "DOM.childNodeInserted", "DOM.childNodeRemoved", "DOM.childNodeCountUpdated",
      "DOM.attributeModified", "DOM.attributeRemoved", "DOM.characterDataModified", "DOM.shadowRootPushed", "DOM.shadowRootPopped",
      "Runtime.executionContextsCleared", "Runtime.executionContextDestroyed", "Page.frameNavigated", "Page.frameDetached"]
      .forEach(function (event) { watch(reader, cdp, event, dirty); });
    watch(reader, cdp, "close", function () { reader.alive = false; dirty(); });
    watch(reader, page, "close", function () { reader.alive = false; dirty(); });
    watch(reader, page, "crash", function () { reader.alive = false; dirty(); });
    // A frame that navigates may move into or out of its own process; one that goes takes its session with it.
    var forget = function (frame) { forgetFrame(reader, frame); };
    watch(reader, page, "framenavigated", forget);
    watch(reader, page, "framedetached", forget);
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
  function forgetFrame(reader, frame) {
    var session = reader.outside.get(frame);
    reader.outside.delete(frame);
    if (session) {
      session.alive = false;
      Promise.resolve().then(function () { return session.cdp.detach(); }).catch(function () {});
    }
  }
  function live(reader) {
    checkRuntime();
    requireTrue(!closed && reader.alive && !reader.page.isClosed() && reader.page.context() === context &&
      context.pages().indexOf(reader.page) !== -1, "AUTH_CONTEXT_REFUSED");
  }
  // One target's frame and DOM: the tab's own session, or an out-of-process frame's.
  async function readTarget(target) {
    var response = await send(target, "Page.getFrameTree");
    dataOnly(response);
    var tree = response.frameTree;
    requireTrue(tree && tree.frame && typeof tree.frame.id === "string" && tree.frame.id &&
      typeof tree.frame.loaderId === "string" && tree.frame.loaderId &&
      (tree.childFrames === undefined || Array.isArray(tree.childFrames)), "AUTH_FRAME_COVERAGE_REFUSED");
    var dom = await send(target, "DOM.getDocument", { depth: -1, pierce: true });
    dataOnly(dom);
    return { scope: inspect(dom.root), frameId: tree.frame.id, loaderId: tree.frame.loaderId };
  }
  async function qualify(reader) {
    live(reader);
    return readTarget(reader);
  }
  // Out-of-process child frames (another site's player, chat or sign-in) have their own sessions. Each is read the
  // way the tab is; one that cannot be read now (it navigated or went) shows as an empty frame and the rest still reads.
  async function readOutside(reader) {
    var main = reader.page.mainFrame();
    var found = [];
    var frames = reader.page.frames();
    for (var f = 0; f < frames.length; f++) {
      var frame = frames[f];
      if (frame === main) continue;
      var session = reader.outside.get(frame);
      if (session === undefined) {
        session = null;
        var cdp;
        try {
          checkRuntime();
          // Only an out-of-process frame has a session of its own; for any other frame the browser says no.
          cdp = await context.newCDPSession(frame);
          session = { cdp: cdp, frame: frame, alive: true };
          await send(session, "DOM.enable");
        } catch (error) {
          if (knownFailure(error) && safeFailure(error).code === "AUTH_RUNTIME_POLICY_REFUSED") throw error;
          if (cdp) { try { await cdp.detach(); } catch (detachError) { /* the frame went with it */ } }
          session = null;
        }
        reader.outside.set(frame, session);
      }
      if (!session) continue;
      try {
        var read = await readTarget(session);
        var packet = await send(session, "DOMSnapshot.captureSnapshot", { computedStyles: STYLES.slice() });
        found.push({ session: session, read: read, packet: packet });
      } catch (error) {
        if (knownFailure(error) && safeFailure(error).code === "AUTH_RUNTIME_POLICY_REFUSED") throw error;
        forgetFrame(reader, frame);
      }
    }
    return found;
  }
  // Whether the browser names that node at its path now, in the document it is in; one DOM round trip.
  async function names(target, entry) {
    var resolved = 0;
    try {
      var doc = await send(target, "DOM.getDocument", entry.chain.length ? { depth: -1, pierce: true } : { depth: 0 });
      var root = entry.chain.length ? findNode(doc.root, entry.doc) : doc.root;
      if (root) {
        var found = await send(target, "DOM.querySelector", { nodeId: root.nodeId, selector: entry.path });
        resolved = found.nodeId ? (await send(target, "DOM.describeNode", { nodeId: found.nodeId })).node.backendNodeId : 0;
      }
    } finally { if (target.epoch !== undefined) target.epoch++; }
    return resolved === entry.id;
  }
  function findNode(node, id) {
    if (node.backendNodeId === id) return node;
    var next = [].concat(node.children, node.shadowRoots, node.contentDocument).filter(Boolean);
    for (var i = 0; i < next.length; i++) { var hit = findNode(next[i], id); if (hit) return hit; }
    return undefined;
  }
  // A ref binds to its node as the page is now: the same native node, in the same document load, whose name,
  // attributes and subtree text are unchanged since the read. The page may change anywhere else meanwhile; if it moves
  // the node while the browser binds it, the binding is tried again with the node's new path.
  async function bind(reader, record, command) {
    var target = record.target;
    for (var attempt = 1; ; attempt++) {
      var now = await qualify(reader);
      if (target !== reader) {
        requireTrue(target.alive && reader.outside.get(target.frame) === target, "AUTH_SNAPSHOT_INVALIDATED");
        now = await readTarget(target);
      }
      var quiet = reader.epoch;
      var node = now.scope.nodes.get(record.id);
      var then = record.stamp.scope.nodes.get(record.id);
      requireTrue(now.frameId === record.stamp.frameId && now.loaderId === record.stamp.loaderId &&
        node && node.path && node.reach && fingerprint(node.raw) === fingerprint(then.raw), "AUTH_SNAPSHOT_INVALIDATED");
      // Focusing a node inside a rich-text editor blurs the editor, so keys and text go to its editing host, chosen
      // from the snapshot's computed editing modes and still an ancestor of the node now; never by page script.
      var actorId = record.id;
      var actor = node;
      if (EDITS.indexOf(command) !== -1 && record.host !== record.id) {
        actorId = record.host;
        actor = now.scope.nodes.get(actorId);
        var up = node;
        while (up && up.id !== actorId) up = now.scope.nodes.get(up.parent);
        requireTrue(up && actor.path && actor.reach && actor.doc === node.doc, "AUTH_SNAPSHOT_INVALIDATED");
      }
      checkRuntime();
      var wait = { state: "attached", strict: true, timeout: Math.min(timeoutMs, TARGET_WAIT_MS) };
      var frame = target === reader ? reader.page.mainFrame() : target.frame;
      // Into each same-process frame between the read's top document and the node, through its owner element.
      for (var c = 0; c < actor.chain.length; c++) {
        var owner = now.scope.nodes.get(actor.chain[c]);
        requireTrue(owner && owner.path && owner.reach, "AUTH_SNAPSHOT_INVALIDATED");
        var held;
        try { held = { handle: await frame.waitForSelector("css=" + owner.path, wait) }; }
        catch (error) { throw fail("AUTH_TARGET_REFUSED"); }
        requireTrue(held.handle, "AUTH_TARGET_REFUSED");
        cleanupRecords.add(held);
        try { frame = await held.handle.contentFrame(); }
        catch (error) { frame = null; }
        finally { await disposeRecords([held]); }
        requireTrue(frame, "AUTH_TARGET_REFUSED");
      }
      var bound;
      try { bound = { handle: await frame.waitForSelector("css=" + actor.path, wait) }; }
      catch (error) { throw fail("AUTH_TARGET_REFUSED"); }
      requireTrue(bound.handle, "AUTH_TARGET_REFUSED");
      cleanupRecords.add(bound);
      // Unchanged since the read, the path still names that node; otherwise the browser itself confirms it does.
      var confirmed;
      try {
        confirmed = reader.epoch === quiet && actorId === record.id && target === reader && !actor.chain.length ? true : await names(target, actor);
      } catch (error) {
        await disposeRecords([bound]);
        throw error;
      }
      if (confirmed) return bound;
      await disposeRecords([bound]);
      requireTrue(attempt < BIND_ATTEMPTS, "AUTH_SNAPSHOT_INVALIDATED");
    }
  }
  async function snapshot(reader, save, applied, poll) {
    var provisional = [];
    var staged;
    var stageIdentity;
    var stageCloseFailed = false;
    var primary;
    try {
      var before = await qualify(reader);
      var packet = await send(reader, "DOMSnapshot.captureSnapshot", { computedStyles: STYLES.slice() });
      var outside = await readOutside(reader);
      var prepared;
      try {
        prepared = prepare(packet, before.scope, before.frameId, function () { return ++next; }, outside.map(function (frame) {
          return { packet: frame.packet, scope: frame.read.scope, frameId: frame.read.frameId, key: frame };
        }));
      } finally { packet = null; }
      // Refs bind lazily: an action re-reads the page and finds the ref's node in it before resolving its path,
      // so a page with thousands of elements does not wait on one selector round trip per element.
      prepared.targets.forEach(function (target) {
        var from = target.key || { session: reader, read: before };
        provisional.push({ ref: target.ref, path: target.path, id: target.id, host: target.host, reader: reader, target: from.session, stamp: from.read });
      });
      outside.forEach(function (frame) { frame.packet = null; });
      checkRuntime();
      var rendered = renderText(prepared.tree);
      var result = { snapshot: prepared.tree, text: rendered.text };
      if (rendered.left) result.hint = LEFT_OUT(rendered.left);
      if (prepared.frames) result.framesOmitted = prepared.frames;
      if (rendered.full <= ERROR_PAGE_CHARS && ERROR_PAGE.test(result.text)) {
        result.hint = "This page reads as an error, which is often transient: run [\"reload\"], then [\"wait\",\"<text you expect>\"].";
      }
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
      requireTrue(!closed && reader.alive, "AUTH_CONTEXT_REFUSED");
      // No await between this admission check, the owned rename and ref activation.
      if (staged) {
        requireTrue(sameStage(stageIdentity, fs.lstatSync(staged, { bigint: true })), "AUTH_STAGE_IDENTITY_REFUSED");
        checkRuntime();
        fs.renameSync(staged, final); staged = undefined; result.artifact = final;
      }
      provisional.forEach(function (record) { refs.set(record.ref, record); });
      if (poll) polled.set(result, provisional);
      else counted(reader, provisional);
      return result;
    } catch (error) {
      primary = knownFailure(error) ? safeFailure(error).code : "AUTH_SNAPSHOT_FAILED";
      throw fail(primary, applied);
    } finally {
      var cleanup = [];
      if (stageCloseFailed) cleanup.push("AUTH_STAGE_CLOSE_FAILED");
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
  // A picture of the tab, or of one element, in the context's private files folder. Password and one-time-code fields
  // are painted over in every frame, so the picture never shows what was typed there.
  async function screenshot(reader, args) {
    var picked = args.slice(1).filter(function (value) { return value !== "--full"; })[0];
    var record;
    if (picked) {
      record = refs.get(picked);
      requireTrue(record && record.reader === reader, "AUTH_TARGET_REFUSED");
    } else live(reader);
    var file = path.join(outputDir, "screenshot-" + crypto.randomUUID() + ".png");
    var bound;
    var written = false;
    try {
      if (record) bound = await bind(reader, record, "screenshot");
      checkRuntime();
      var mask = reader.page.frames().map(function (frame) { return frame.locator(SECRET_FIELDS); });
      var options = { path: file, mask: mask, timeout: timeoutMs };
      written = true;
      if (bound) await bound.handle.screenshot(options);
      else await reader.page.screenshot(Object.assign(options, { fullPage: args.indexOf("--full") !== -1 }));
      checkRuntime();
      requireTrue(!closed, "AUTH_CONTEXT_REFUSED");
      return { screenshot: file };
    } catch (error) {
      if (written) { try { await fs.promises.unlink(file); } catch (unlinkError) { /* never written */ } }
      throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_SCREENSHOT_FAILED");
    } finally {
      if (bound) await disposeRecords([bound]);
    }
  }
  // One more read of this tab: its refs join the last REF_READS reads, and older ones go.
  function counted(reader, records) {
    reader.reads = (reader.reads || 0) + 1;
    records.forEach(function (record) { record.read = reader.reads; });
    refs.forEach(function (record, ref) { if (record.reader === reader && record.read <= reader.reads - REF_READS) refs.delete(ref); });
  }
  function unpolled(records) {
    // Ref numbers never repeat and nothing else runs during a wait, so these are still the poll's own records.
    records.forEach(function (record) { refs.delete(record.ref); });
  }
  async function settled(reader, save, applied, poll) {
    for (var attempt = 1; ; attempt++) {
      try { return await snapshot(reader, save, applied, poll); }
      catch (error) {
        // snapshot() only throws branded failures.
        if (closed || attempt >= attempts || RETRIED.indexOf(safeFailure(error).code) === -1) throw error;
        await new Promise(function (resolve) { setTimeout(resolve, SNAPSHOT_SETTLE_MS * attempt); });
        checkRuntime();
      }
    }
  }
  // A wait reads nothing new: it pauses, or reads ordinary snapshots until text shows (or goes), and returns the last.
  async function wait(reader, plan) {
    var limit = Math.min(WAIT_MAX_MS, Math.floor(timeoutMs / 2));
    if (plan.ms !== undefined) {
      var ms = Math.min(plan.ms, limit);
      await sleep(ms);
      checkRuntime();
      var paused = await settled(reader, false, false);
      paused.waited = { seconds: ms / 1000 };
      return paused;
    }
    var deadline = Date.now() + limit;
    var last;
    var pending = [];
    for (;;) {
      unpolled(pending);
      pending = [];
      try { last = await settled(reader, false, false, true); pending = polled.get(last); }
      catch (error) {
        if (closed || RETRIED.indexOf(safeFailure(error).code) === -1 || Date.now() >= deadline) throw error;
        last = undefined;
      }
      if (last && shows(last.snapshot, plan.text) !== plan.gone) {
        last.waited = { text: plan.text, found: true };
        counted(reader, pending);
        return last;
      }
      if (last && Date.now() >= deadline) {
        counted(reader, pending);
        last.waited = { text: plan.text, found: false };
        last.hint = "The text did not " + (plan.gone ? "go" : "show") + " within " + limit / 1000 + " s. Read this snapshot; if the page is still loading, wait again.";
        return last;
      }
      // The next poll rechecks the runtime policy first thing, after this poll's refs are dropped.
      await sleep(WAIT_POLL_MS);
    }
  }
  async function execute(args) {
    checkRuntime();
    checkArgs(args);
    requireTrue(!closed, "AUTH_CONTEXT_REFUSED");
    var pages = context.pages();
    var page = selected;
    var command = args[0];
    if (command === "tab-select") {
      requireTrue(Number(args[1]) < pages.length, "AUTH_TAB_REFUSED");
      page = pages[Number(args[1])];
      // A tab in the background has no focus and paints lazily, so clicks and keys land on the one in front.
      try { checkRuntime(); await page.bringToFront(); checkRuntime(); }
      catch (error) { throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_TAB_ACTION_FAILED"); }
      selected = page;
    }
    if (command === "tab-new") {
      try { checkRuntime(); page = await context.newPage(); checkRuntime(); selected = page; }
      catch (error) { throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_TAB_ACTION_FAILED", true); }
    }
    if (command === "tab-list") return { tabs: context.pages().map(function (tab, index) { return { index: index, selected: tab === selected }; }) };
    if (command === "tab-close") {
      try {
        if (args.length === 2) {
          requireTrue(Number(args[1]) < pages.length, "AUTH_TAB_REFUSED");
          page = pages[Number(args[1])];
        }
        requireTrue(page && context.pages().indexOf(page) !== -1 && !page.isClosed(), "AUTH_TAB_REFUSED");
        checkRuntime(); await page.close(); checkRuntime();
        if (page === selected || context.pages().indexOf(selected) === -1) selected = context.pages()[0];
        dropRefs(page); checkRuntime(); return { closed: true };
      }
      catch (error) { throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_TAB_ACTION_FAILED", true); }
    }
    var reader;
    try { reader = await readerFor(page); }
    catch (error) {
      throw fail(knownFailure(error) ? safeFailure(error).code : "AUTH_READER_SETUP_FAILED", command === "tab-new");
    }
    if (command === "snapshot" && args[1] === "--interactive") return narrow(await settled(reader, false, false), { interactive: true });
    if (command === "find") return narrow(await settled(reader, false, false), { find: args[1] });
    if (command === "snapshot" || command === "tab-select" || command === "tab-new") return settled(reader, args[1] === "--save", command === "tab-new");
    if (command === "wait") return wait(reader, waitPlan(args));
    if (command === "screenshot") return screenshot(reader, args);
    var applied = false;
    try {
      if (NAVIGATIONS.concat(["resize", "mousewheel"]).indexOf(command) !== -1) {
        checkRuntime();
        applied = true;
        if (command === "goto") await page.goto(args[1], { timeout: timeoutMs });
        if (command === "go-back") await page.goBack({ timeout: timeoutMs });
        if (command === "go-forward") await page.goForward({ timeout: timeoutMs });
        if (command === "reload") await page.reload({ timeout: timeoutMs });
        if (command === "resize") await page.setViewportSize({ width: Number(args[1]), height: Number(args[2]) });
        if (command === "mousewheel") await page.mouse.wheel(Number(args[1]), Number(args[2]));
        checkRuntime();
      } else if (command === "press" && args.length === 2) {
        checkRuntime();
        applied = true;
        await page.keyboard.press(args[1]);
        checkRuntime();
      } else {
        requireTrue(/^e[1-9]\d*$/.test(args[1]), "AUTH_TARGET_REFUSED");
        var record = refs.get(args[1]);
        requireTrue(record && record.reader === reader, "AUTH_TARGET_REFUSED");
        // A live page (Teams) changes somewhere every few milliseconds, so the ref is re-resolved now, wherever its
        // node is: the main document, a child frame's, or an out-of-process frame's.
        var bound = await bind(reader, record, command);
        var actionError;
        var typed;
        try {
          checkRuntime();
          applied = true;
          // Playwright waits for an element to be enabled before scrolling it into view, but some pages enable a control
          // only once it has been seen (GitHub's OAuth "Authorize" button), so it would wait forever. Scroll first.
          await bound.handle.scrollIntoViewIfNeeded({ timeout: timeoutMs });
          checkRuntime();
          var method = command === "select" ? "selectOption" : command;
          if (args.length === 3) await bound.handle[method](args[2], { timeout: timeoutMs });
          else await bound.handle[method]({ timeout: timeoutMs });
          checkRuntime();
          // Typed text is redacted from every snapshot, so the field itself says whether it now holds it; only the
          // verdict comes back, never the field's text.
          if (command === "fill" || command === "type") typed = { verified: (await bound.handle.evaluate(HOLDS, [args[2], command])) === true };
          checkRuntime();
        } catch (error) {
          actionError = error;
          throw error;
        } finally {
          // A failed disposal stays owned for close; the action's own refusal is the primary report.
          try { await disposeRecords([bound]); } catch (cleanupError) { if (!actionError) throw cleanupError; }
        }
      }
      var outcome;
      try { outcome = await settled(reader, false, applied); }
      catch (error) {
        // A page still loading changes faster than it can be read. The navigation itself went through, so it says so
        // and how to read the page, rather than refusing what already happened.
        if (NAVIGATIONS.indexOf(command) === -1 || closed || RETRIED.indexOf(safeFailure(error).code) === -1) throw error;
        return { navigated: true, hint: "The page is still loading, so it was not read yet. Run [\"wait\",\"<text you expect>\"] (or [\"wait\",\"3\"]) to read it once it settles." };
      }
      if (typed) outcome.typed = typed;
      return outcome;
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

module.exports = { create: create, prepare: prepare, inspect: inspect, fingerprint: fingerprint, HOLDS: HOLDS, checkArgs: checkArgs, fail: fail, safeFailure: safeFailure, hintFor: hintFor, renderText: renderText, TEXT_BUDGET: TEXT_BUDGET, FAILURE_CODES: Object.keys(HINTS) };
