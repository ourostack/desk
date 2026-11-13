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
// A ref's action shares one deadline of this long, or half the command time if less. Playwright then fails a stalled
// action before the command's own bound closes the context.
var ACTION_MAX_MS = 30000;
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
// Runs in the page: whether keys typed now reach the node (it, or an element inside it, has its document's focus and
// that document has the window's).
var FOCUSED = function (node) {
  var doc = node.ownerDocument;
  var active = doc.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  var inside = false;
  for (var at = active; at && !inside; at = at.getRootNode().host) inside = at === node || node.contains(at);
  return doc.hasFocus() && inside;
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
// What a screenshot never shows, as a snapshot never shows it: every input, textarea and editable region. The browser
// paints a box over each in every frame (its CSS engine reaches into open shadows), including any that appear while
// the picture is taken; the read before the picture adds what markup alone does not say (CSS-editable regions and
// open-shadow content, masked by their host).
var OPAQUE_FIELDS = "input, textarea, [contenteditable]";

var COMMANDS = "snapshot [--interactive | --save] / find <text> / goto <url> / go-back / go-forward / reload / wait [<seconds> | <text> | --gone <text>] / " +
  "click, dblclick, hover, check or uncheck <ref> / fill or type <ref> <text> / press [<ref>] <key> / select <ref> <value> / " +
  "mousewheel <dx> <dy> / resize <width> <height> / screenshot [<ref>] [--full] / tab-list / tab-new / tab-select <index> / tab-close [<index>]";
var SNAPSHOT_LOOK = "run [\"snapshot\"] to see the page as it is now";
var SNAPSHOT_AGAIN = "act on a ref from that snapshot";
var REPEATS = "if the same refusal repeats, open a new context with browser_context";
var CHANGING = "the page was changing while it was read";
// Each failure's parts: what probably happened, how to look further, and how to keep working. Nothing here ever needs eval
// or a page script: refs from a snapshot cover it.
var FAILURES = {
  AUTH_COMMAND_REFUSED: { thing: "browser command", probably: "mine does not run that command", look: "the commands mine runs are " + COMMANDS, keepWorking: "eval and page scripts are never needed: take a snapshot, then act on its refs, and use wait to let a page load" },
  AUTH_ARGUMENTS_REFUSED: { thing: "browser command", probably: "the arguments are not ones mine accepts for that command", look: "check them against the commands mine runs: " + COMMANDS + ". A wait is 1 to 60 seconds (or 100 to 60000 ms), or up to 200 characters of text", keepWorking: "run the command again with corrected arguments" },
  AUTH_URL_REFUSED: { thing: "browser command", probably: "the address for goto is not an allowed web address", look: "goto takes a full http or https URL with no user name or password in it", keepWorking: "run goto again with such a URL" },
  AUTH_TARGET_REFUSED: { thing: "browser element", probably: "that ref is not from one of the last " + REF_READS + " reads of this tab, or its element has gone", look: SNAPSHOT_LOOK, keepWorking: SNAPSHOT_AGAIN },
  AUTH_SNAPSHOT_INVALIDATED: { thing: "browser element", probably: "the page replaced that element, or navigated, since it was read", look: SNAPSHOT_LOOK, keepWorking: SNAPSHOT_AGAIN + "; while a page loads, use [\"wait\",\"<text you expect>\"]" },
  AUTH_FRAME_COVERAGE_REFUSED: { thing: "browser page", probably: CHANGING + ", so one of its frames was left out of the read", look: "run [\"wait\",\"2\"] (or wait for text you expect) so the page settles", keepWorking: "then try again; if it repeats, open the frame's own page with goto" },
  AUTH_SHADOW_COVERAGE_REFUSED: { thing: "browser page", probably: "part of this page, or of one of its frames, is in a closed shadow root, which mine can neither read nor picture, so neither snapshot nor screenshot can show it", look: "if the page was still loading, run [\"wait\",\"2\"] and try again", keepWorking: "otherwise open the frame's own page with goto, or use another way to reach what you need" },
  AUTH_FOCUS_MOVED: { thing: "browser element", probably: "something else on the page took the keyboard focus, so typing stopped before the next key, and the field may hold part of the text", look: SNAPSHOT_LOOK + ", and check the field", keepWorking: "then type into the field's ref again" },
  AUTH_ACTION_FAILED: { thing: "browser element", probably: "the action on that ref did not complete", look: SNAPSHOT_LOOK + ", and check the ref is the control you mean and is enabled", keepWorking: SNAPSHOT_AGAIN + "; for a key, use a name such as Enter, Tab or Control+a" },
  AUTH_ACTION_COVERED: { thing: "browser element", probably: "something else on the page is probably covering that control, such as a tooltip, menu or hover card", look: "run [\"find\",\"<text>\"] to see what covers it", keepWorking: "this context is still open; press [\"press\",\"Escape\"] or click what covers it, then act on a fresh ref from [\"snapshot\"]" },
  AUTH_ACTION_NOT_READY: { thing: "browser element", probably: "that control was not ready: probably hidden, still moving, or disabled", look: SNAPSHOT_LOOK + " to see whether it is visible and enabled", keepWorking: "this context is still open; if the page is still changing, run [\"wait\",\"2\"] first, then act on a fresh ref" },
  AUTH_ACTION_TIMEOUT: { thing: "browser element", probably: "that control did not respond in time", look: SNAPSHOT_LOOK, keepWorking: "this context is still open; act on a fresh ref from it, and if the page keeps stalling, run [\"wait\",\"2\"] first" },
  AUTH_TARGET_KIND_REFUSED: { thing: "browser element", probably: "that element cannot be acted on in mine", look: SNAPSHOT_LOOK, keepWorking: SNAPSHOT_AGAIN + ", choosing its labelled parent or another control" },
  AUTH_OUTPUT_TOO_LARGE: { thing: "browser page", probably: "the page is too large to read whole", look: "a narrower page, such as a single item or chat, is small enough to read", keepWorking: "go to it with goto, or close panels you do not need" },
  AUTH_DOCUMENT_REFUSED: { thing: "browser page", probably: "this page is not an ordinary HTML document mine can read", look: "the page's HTML address is the form mine can read", keepWorking: "go to that address with goto, or use [\"screenshot\"]" },
  AUTH_SCREENSHOT_FAILED: { thing: "browser page", probably: "the screenshot did not finish", look: "run [\"wait\",\"2\"]", keepWorking: "then try again; for one part of the page, pass a ref from a snapshot" },
  AUTH_TAB_ACTION_FAILED: { thing: "browser tab", probably: "the tab action did not finish safely", look: "run [\"tab-list\"] to see the tabs", keepWorking: "then try again" },
  AUTH_TAB_REFUSED: { thing: "browser tab", probably: "there is no such open tab", look: "run [\"tab-list\"] to see the open tabs", keepWorking: "use an index from it with tab-select or tab-close" },
  AUTH_TIMEOUT: { thing: "browser command", probably: "the command ran out of time (often a page that kept loading, or a control that never became clickable), so this context was closed", look: "open a new context with browser_context, then [\"snapshot\"]", keepWorking: "start again from the page you were on; keep waits under a minute" },
  AUTH_TIMEOUT_CLOSE_FAILED: { thing: "browser context", probably: "the command ran out of time and its context did not close cleanly", look: "call desk_doctor to see Desk's runtime state", keepWorking: "open a new context with browser_context" },
  AUTH_CONTEXT_REFUSED: { thing: "browser context", probably: "this context, or its selected tab, is closed", look: "run [\"tab-list\"] to see whether any tabs are open", keepWorking: "if tabs are open, select one with tab-select; otherwise open a new context with browser_context" },
  AUTH_READER_REFUSED: { thing: "browser tab", probably: "the tab was replaced or closed", look: "run [\"tab-list\"] to see the open tabs", keepWorking: "select a tab, then run [\"snapshot\"]" },
  AUTH_READER_SETUP_FAILED: { thing: "browser tab", probably: "the tab was not ready to be read yet", look: "run [\"wait\",\"2\"]", keepWorking: "then run [\"snapshot\"]; if it repeats, open a new context with browser_context" },
  AUTH_READER_CLEANUP_FAILED: { thing: "browser tab", probably: "the tab's reader was not released cleanly, so its cleanup is not confirmed", look: "call desk_doctor to see Desk's runtime state", keepWorking: "open a new context with browser_context" },
  AUTH_RUNTIME_POLICY_MISSING: { thing: "browser context", probably: "this Desk process has no output protection to check the browser against, so mine refused to open it", look: "call desk_doctor to see Desk's runtime state", keepWorking: "close the context and open a new one with browser_context; if it repeats, report it with desk_doctor" },
  AUTH_RUNTIME_POLICY_REFUSED: { thing: "browser command", probably: "this Desk process cannot protect authenticated output now", look: "call desk_doctor to see Desk's runtime state", keepWorking: "close the context and open a new one with browser_context; if it repeats, report it with desk_doctor" },
  AUTH_NATIVE_DATA_INVALID: { thing: "browser page", probably: "the browser returned page data that fails mine's checks", look: SNAPSHOT_LOOK, keepWorking: REPEATS },
  AUTH_HANDLE_CLEANUP_FAILED: { thing: "browser element", probably: "an element handle was not released, so its cleanup is not confirmed", look: "call desk_doctor to see Desk's runtime state", keepWorking: "close the context with browser_context, then open a new one" },
  AUTH_STAGE_IDENTITY_REFUSED: { thing: "browser output", probably: "the staged output file changed before mine read it, so mine refused it", look: "call desk_doctor to see Desk's runtime state", keepWorking: "run the command again" },
  AUTH_STAGE_CLOSE_FAILED: { thing: "browser output", probably: "the staged output file was not closed cleanly", look: "call desk_doctor to see Desk's runtime state", keepWorking: "run the command again" },
  AUTH_SNAPSHOT_FAILED: { thing: "browser page", probably: "the snapshot did not finish safely", look: SNAPSHOT_LOOK, keepWorking: REPEATS },
  AUTH_ARTIFACT_CLEANUP_FAILED: { thing: "browser output", probably: "a temporary output file was kept because it was not removed", look: "call desk_doctor to see Desk's runtime state", keepWorking: "close the context with browser_context and open a new one" },
  AUTH_OPERATION_FAILED: { thing: "browser command", probably: "the command did not finish safely", look: SNAPSHOT_LOOK, keepWorking: REPEATS },
  AUTH_CLOSE_FAILED: { thing: "browser context", probably: "the browser's cleanup is not confirmed, so its files were kept", look: "call desk_doctor to see Desk's runtime state", keepWorking: "if it repeats, report it with desk_doctor" }
};
var GENERAL_FAILURE = { thing: "browser command", probably: "mine did not complete this command safely", look: SNAPSHOT_LOOK, keepWorking: REPEATS };
var CLEANUP_MARK = "; retained cleanup uncertainty: ";

// The same rules as Ouro AX's errorLine (desk-failure.js uses it for the other Desk failures). This file loads synchronously
// and cannot import that ESM kit, so the rules are written here.
function sentence(text) {
  return text.trim().replace(/[.\s]+$/, "");
}

// The code leads the line, so callers can match it. `code` may carry retained cleanup codes after CLEANUP_MARK.
function fail(code, applied) {
  var codes = String(code).split(CLEANUP_MARK);
  var primary = codes[0];
  var entry = FAILURES[primary] || GENERAL_FAILURE;
  var probably = entry.probably +
    (applied ? ", and the action may have applied and its output was refused" : "") +
    (codes.length > 1 ? " (retained cleanup uncertainty: " + codes.slice(1).join(", ") + ")" : "");
  var problem = probably + "; to look further, " + entry.look + "; to file a bug with its evidence, call friction_add with {\"error_code\":\"" +
    primary.toLowerCase() + "\"}; " + entry.keepWorking;
  var message = (primary + ": desk-web: " + entry.thing + ": " + sentence(problem) + ".").replace(/\s*[\r\n]+\s*/g, " ");
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

// Playwright's wording for why an action could not run. Only these fixed substrings are matched: its text can carry page
// content, so it is never returned.
function actionTimeoutFailure(error) {
  var text = String(error.message);
  var code = text.indexOf("intercepts pointer events") !== -1 ? "AUTH_ACTION_COVERED" :
    /not visible|not stable|not enabled|disabled/.test(text) ? "AUTH_ACTION_NOT_READY" : "AUTH_ACTION_TIMEOUT";
  return fail(code, true);
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
  var reads = [];
  (outside || []).forEach(function (frame) {
    requireTrue(frame && typeof frame.frameId === "string" && frame.scope, "AUTH_FRAME_COVERAGE_REFUSED");
    // Two captures claiming one frame contradict each other: neither is shown, and both are still scrubbed.
    var read = rowsOf(frame.packet, frame.scope, frame.frameId, frame.key, secret, budget);
    reads.push(read);
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
  // The outermost element of each opaque region, in every capture: what a screenshot must cover. A frame whose content
  // was not read (its own read failed, or the browser gave no way in) is covered whole by its owner.
  var masks = [];
  [main].concat(reads).forEach(function (read) {
    read.rows.forEach(function (row) {
      var unread = row.frame && !row.content;
      if (row.type === 1 && (row.opaque || unread) && !row.excluded && !(row.parent && row.parent.opaque)) masks.push({ key: read.key, id: row.id });
    });
  });
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
    return { tree: tree, targets: targets, frames: frames, masks: masks };
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
  var entries = textLines(node);
  var keep = entries.map(function () { return !view; });
  var matches = 0;
  if (view && view.find !== undefined) {
    var found = matchLines(entries, view.find);
    keep = found.keep;
    matches = found.count;
  }
  if (view && view.interactive) entries.forEach(function (entry, index) { keep[index] = entry.ref || entry.key; });
  entries.forEach(function (entry, index) { if (entry.virtual) keep[index] = false; });
  var full = entries.reduce(function (sum, entry) {
    return entry.virtual ? sum : sum + entry.depth * 2 + entry.line.length + 1 + Math.max(0, entry.words.length - LINE_CHARS);
  }, 0);
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

// The lines of a snapshot in page order, each with the index of its parent line and the index just past its last
// descendant. A wrapper that gives way to several children gets a virtual line: it prints nothing, but it is where text
// split across those children is found (see matchLines).
function textLines(node) {
  var entries = [];
  function add(entry) { entries.push(entry); return entries.length - 1; }
  // A wrapper that gives way to the one thing it holds hands that thing its ref, so the text stays clickable.
  (function walk(n, depth, parent, carried) {
    var children = n.children || [];
    var plain = (n.role === "generic" && !n.name && n.text === undefined) || n.role === "text";
    var ref = n.ref || (plain ? carried : undefined);
    if (n.role === "text" && ref) {
      var leaf = add({ depth: depth, parent: parent, ref: true, key: false, field: false, virtual: false, words: n.text, line: "- generic [ref=" + ref + "]: " + quote(n.text) });
      entries[leaf].end = entries.length;
      return;
    }
    if (n.role === "generic" && plain) {
      if (!children.length) return;
      if (children.length === 1) { walk(children[0], depth, parent, ref); return; }
      if (!ref) {
        var wrapper = add({ depth: depth, parent: parent, ref: false, key: false, field: false, virtual: true, words: "", line: "" });
        children.forEach(function (child) { walk(child, depth, wrapper); });
        entries[wrapper].end = entries.length;
        return;
      }
    }
    var line = "- " + n.role;
    if (ref) line += " [ref=" + ref + "]";
    if (n.name) line += " " + quote(n.name);
    if (n.text !== undefined) line += ": " + quote(n.text);
    var index = add({ depth: depth, parent: parent, ref: Boolean(ref), key: Boolean(n.name) || ["generic", "text"].indexOf(n.role) === -1,
      field: ["textbox", "combobox", "heading"].indexOf(n.role) !== -1, virtual: false,
      words: [n.name, n.text].filter(function (value) { return typeof value === "string"; }).join(" "), line: line });
    children.forEach(function (child) { walk(child, depth + 1, index); });
    entries[index].end = entries.length;
  })(node, 0, -1);
  return entries;
}

// Whitespace runs (no-break spaces and line breaks included) read as one space, and case does not matter.
function normalizeText(text) { return text.replace(/\s+/g, " ").trim().toLowerCase(); }

// Which lines hold the text. A line holds it when its own words do. A line whose words, with everything under it read
// in page order, hold it (text split across elements) holds it too, but only the innermost such line counts, so one
// split name counts once; that line and everything under it is kept, so the split text shows. Lines holding the text
// are kept with their ancestors.
function matchLines(entries, find) {
  var needle = normalizeText(find);
  var direct = entries.map(function (entry) { return normalizeText(entry.words).indexOf(needle) !== -1; });
  var holds = direct.slice();
  entries.forEach(function (entry, index) {
    if (direct[index] || entry.end - index < 2) return;
    var words = [];
    for (var at = index; at < entry.end; at++) words.push(entries[at].words);
    holds[index] = normalizeText(words.join(" ")).indexOf(needle) !== -1;
  });
  var nested = entries.map(function () { return false; });
  entries.forEach(function (entry, index) {
    if (!holds[index]) return;
    for (var at = entry.parent; at !== -1 && !nested[at]; at = entries[at].parent) nested[at] = true;
  });
  var count = 0;
  var selected = entries.map(function () { return false; });
  entries.forEach(function (entry, index) {
    if (direct[index]) { count++; selected[index] = true; }
    else if (holds[index] && !nested[index]) {
      count++;
      for (var at = index; at < entry.end; at++) selected[at] = true;
    }
  });
  var ancestor = entries.map(function () { return false; });
  selected.forEach(function (on, index) {
    if (!on) return;
    for (var at = entries[index].parent; at !== -1 && !ancestor[at]; at = entries[at].parent) ancestor[at] = true;
  });
  return { count: count, keep: selected.map(function (on, index) { return on || ancestor[index]; }) };
}

function shows(node, text) {
  return matchLines(textLines(node), text).count > 0;
}

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
  // A screenshot reads `strict`: it shows the frame, so a frame read that fails (a closed shadow) refuses the picture.
  async function readOutside(reader, strict) {
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
        if (strict) throw knownFailure(error) ? error : fail("AUTH_FRAME_COVERAGE_REFUSED");
      }
    }
    return found;
  }
  // Whether the browser names that node at its path now, in the document it is in; one DOM round trip.
  // Each frame owner on the way is checked too: its path still names that owner, and the frame it shows still holds
  // the document the read found there, so the handle reached through them is in the frame the ref was read in.
  async function names(target, entry, scope) {
    try {
      var doc = await send(target, "DOM.getDocument", entry.chain.length ? { depth: -1, pierce: true } : { depth: 0 });
      var steps = entry.chain.map(function (id) { return scope.nodes.get(id); }).concat([entry]);
      var container = doc.root;
      for (var i = 0; i < steps.length; i++) {
        if (!container || container.backendNodeId !== steps[i].doc) return false;
        var found = await send(target, "DOM.querySelector", { nodeId: container.nodeId, selector: steps[i].path });
        var resolved = found.nodeId ? (await send(target, "DOM.describeNode", { nodeId: found.nodeId })).node.backendNodeId : 0;
        if (resolved !== steps[i].id) return false;
        if (i < steps.length - 1) container = (findNode(container, steps[i].id) || {}).contentDocument;
      }
      return true;
    } finally { if (target.epoch !== undefined) target.epoch++; }
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
        confirmed = reader.epoch === quiet && actorId === record.id && target === reader && !actor.chain.length ? true : await names(target, actor, now.scope);
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
  // Every opaque region of the tab as one read sees it, each with the element that covers it: itself, or the nearest
  // ancestor the browser can name (an open shadow's host, or the frame owner of a frame it cannot reach). A closed
  // shadow anywhere fails the read, so a picture is never taken of what no mask can cover.
  async function opaqueRegions(reader) {
    var before = await qualify(reader);
    var packet = await send(reader, "DOMSnapshot.captureSnapshot", { computedStyles: STYLES.slice() });
    var outside = await readOutside(reader, true);
    var prepared;
    var counter = 0;
    try {
      prepared = prepare(packet, before.scope, before.frameId, function () { return ++counter; }, outside.map(function (frame) {
        return { packet: frame.packet, scope: frame.read.scope, frameId: frame.read.frameId, key: frame };
      }));
    } finally {
      packet = null;
      outside.forEach(function (frame) { frame.packet = null; });
    }
    return prepared.masks.map(function (mask) {
      var session = mask.key ? mask.key.session : reader;
      var scope = mask.key ? mask.key.read.scope : before.scope;
      var entry = scope.nodes.get(mask.id);
      var region = entry;
      while (region && !(region.path && region.reach)) region = scope.nodes.get(region.parent);
      // The capture has a region the DOM read lacks: the page changed between the two, so the read is tried again.
      requireTrue(region, "AUTH_SNAPSHOT_INVALIDATED");
      var marked = region === entry && (entry.name === "INPUT" || entry.name === "TEXTAREA" ||
        entry.raw.attributes.some(function (name, index) { return index % 2 === 0 && name === "contenteditable"; }));
      return { session: session, scope: scope, id: mask.id, region: region, marked: marked };
    });
  }
  function maskOf(reader, found) {
    var at = found.session === reader ? reader.page.mainFrame() : found.session.frame;
    found.region.chain.forEach(function (id) { at = at.frameLocator("css=" + found.scope.nodes.get(id).path); });
    return at.locator("css=" + found.region.path);
  }
  // A picture of the tab, or of one element, in the context's private files folder. Every input, textarea and editable
  // region is painted over in every frame, as a snapshot redacts them. The tab is read before and after the picture; an
  // opaque region the first read did not mask (one markup alone does not mark) means the picture is taken again.
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
      for (var attempt = 1; ; attempt++) {
        var regions = await opaqueRegions(reader);
        checkRuntime();
        var mask = reader.page.frames().map(function (frame) { return frame.locator(OPAQUE_FIELDS); })
          .concat(regions.map(function (found) { return maskOf(reader, found); }));
        var options = { path: file, mask: mask, timeout: timeoutMs };
        written = true;
        if (bound) await bound.handle.screenshot(options);
        else await reader.page.screenshot(Object.assign(options, { fullPage: args.indexOf("--full") !== -1 }));
        checkRuntime();
        // What markup marks was masked by selector even if it is new; anything else must have been masked by the read.
        var after = await opaqueRegions(reader);
        var covered = after.every(function (found) {
          return found.marked || regions.some(function (old) { return old.session === found.session && old.region.id === found.region.id; });
        });
        if (covered) break;
        await fs.promises.unlink(file);
        written = false;
        requireTrue(attempt < BIND_ATTEMPTS, "AUTH_SNAPSHOT_INVALIDATED");
      }
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
        // Steps share one deadline inside the command's time, so Playwright fails a stalled one first and the context stays open.
        var actionDeadline = Date.now() + Math.min(ACTION_MAX_MS, Math.floor(timeoutMs / 2));
        var actionOptions = function () { return { timeout: Math.max(1, actionDeadline - Date.now()) }; };
        var actionError;
        var typed;
        try {
          checkRuntime();
          applied = true;
          // Playwright waits for an element to be enabled before scrolling it into view, but some pages enable a control
          // only once it has been seen (GitHub's OAuth "Authorize" button), so it would wait forever. Scroll first.
          await bound.handle.scrollIntoViewIfNeeded(actionOptions());
          checkRuntime();
          var method = command === "select" ? "selectOption" : command;
          if (command === "type") {
            // Keys go wherever focus is, and a page can move it (an autofocus box, a timer after focus): the target must
            // hold it before each key. Focus taken before the first is taken back once; taken again, or taken while
            // typing, stops the typing with nothing more sent.
            for (var tries = 0; ; tries++) {
              await bound.handle.focus();
              checkRuntime();
              if ((await bound.handle.evaluate(FOCUSED)) === true) break;
              checkRuntime();
              requireTrue(tries < 1, "AUTH_FOCUS_MOVED");
            }
            var keys = Array.from(args[2]);
            for (var at = 0; at < keys.length; at++) {
              if (at) requireTrue((await bound.handle.evaluate(FOCUSED)) === true, "AUTH_FOCUS_MOVED");
              checkRuntime();
              await page.keyboard.type(keys[at]);
            }
          } else if (args.length === 3) await bound.handle[method](args[2], actionOptions());
          else await bound.handle[method](actionOptions());
          checkRuntime();
          // Typed text is redacted from every snapshot, so the field itself says whether it now holds it; only the
          // verdict comes back, never the field's text.
          if (command === "fill" || command === "type") typed = { verified: (await bound.handle.evaluate(HOLDS, [args[2], command])) === true };
          checkRuntime();
        } catch (error) {
          actionError = error;
          if (error && error.name === "TimeoutError") throw actionTimeoutFailure(error);
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

module.exports = { create: create, prepare: prepare, inspect: inspect, fingerprint: fingerprint, HOLDS: HOLDS, FOCUSED: FOCUSED, checkArgs: checkArgs, fail: fail, safeFailure: safeFailure, FAILURES: FAILURES, renderText: renderText, TEXT_BUDGET: TEXT_BUDGET, FAILURE_CODES: Object.keys(FAILURES) };
