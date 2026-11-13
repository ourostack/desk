"use strict";

// Sites that try to open a desktop app (Zoom, Teams, Slack, Figma, Spotify, Discord, Notion, Microsoft 365) all do the
// same two things: they point the page at an app address (zoommtg:, msteams:, slack:), and they offer a web option for when
// that fails. desk-web refuses the launch, so the page sees "no app" and runs its own fallback; when it only offers a
// button, this finds that button by what it says, not by which site it is on.

// What a web option names, and the verb that makes it an invitation to use it.
var TARGET = /\b(?:browser|web ?app|web ?version|web ?client|web ?player|on (?:the )?web)\b/u;
var VERB = /\b(?:continue|open|use|join|launch|stay|proceed|view|try|run|listen|play|start|sign in|log in|browse|keep)\b/u;
// Controls that mention a browser or the web without being a way into the page.
var NOT = /\b(?:download|install|get the|add to|extension|store|update|upgrade|unsupported|supported|other browsers?|change browser|switch|learn|help|how to|why|desktop|mobile)\b/u;
var NAME_CHARS = 100;

function nameOf(node) {
  if (node.name) return node.name;
  var words = [];
  (function collect(n) {
    if (n.role === "text") { if (typeof n.text === "string" && n.text !== "[redacted]") words.push(n.text); return; }
    n.children.forEach(collect);
  })(node);
  return words.join(" ");
}

function plain(name) { return name.replace(/\s+/gu, " ").trim(); }

function isWebOption(name) {
  var lower = name.toLowerCase();
  return name.length > 0 && name.length <= NAME_CHARS && TARGET.test(lower) && VERB.test(lower) && !NOT.test(lower);
}

// The best candidate: a link or button before a styled element, then the shorter name, then page order.
function best(found) {
  return found.map(function (entry, index) { return { entry: entry, index: index }; }).sort(function (a, b) {
    return (b.entry.tier - a.entry.tier) || (a.entry.name.length - b.entry.name.length) || (a.index - b.index);
  })[0].entry;
}

// The page's own web option in a snapshot tree: { ref, role, name }, or null. Only what the page shows has a ref.
function webOptionIn(tree) {
  var found = [];
  (function walk(node) {
    if (node.ref && node.visible !== false) {
      var tier = node.role === "link" || node.role === "button" ? 2 : node.role === "generic" ? 1 : 0;
      var name = plain(nameOf(node));
      if (tier && isWebOption(name)) found.push({ ref: node.ref, role: tier === 2 ? node.role : "control", name: name, tier: tier });
    }
    (node.children || []).forEach(walk);
  })(tree);
  if (!found.length) return null;
  var chosen = best(found);
  return { ref: chosen.ref, role: chosen.role, name: chosen.name };
}

// The same, in a fresh browser's snapshot text (`- button "Join from browser" [ref=e5]`), which keeps no tree.
function webOptionInText(text) {
  var found = [];
  String(text).split("\n").forEach(function (line) {
    var match = /^\s*- (link|button)\s+"((?:[^"\\]|\\.)*)".*\[ref=(e\d+)\]/u.exec(line);
    if (!match) return;
    var name = plain(match[2].replace(/\\(.)/gu, "$1"));
    if (isWebOption(name)) found.push({ ref: match[3], role: match[1], name: name, tier: 2 });
  });
  if (!found.length) return null;
  var chosen = best(found);
  return { ref: chosen.ref, role: chosen.role, name: chosen.name };
}

var APP_ROUTE = "Opening the app itself needs its own explicit route, which desk-web does not offer yet.";

function schemeList(schemes) {
  return schemes.map(function (scheme) { return scheme + ":"; }).join(", ");
}

// What a reply says about an app launch the page tried: which app, what desk-web did, and what the agent can do next.
// `how` is "followed" (desk-web clicked the page's web option), "page" (the page took its own web path) or "none".
function report(input) {
  var schemes = input.schemes;
  var by = input.host && input.host !== "unknown" ? input.host : "the page";
  var refused = "desk-web refused " + by + "'s attempt to open an app (" + schemeList(schemes) + "); desk-web never opens desktop apps.";
  var option = input.option;
  var look = option ? option.role + " " + JSON.stringify(option.name) : "";
  var out = { refused: schemes, by: input.host, how: input.how };
  if (input.how === "followed") {
    out.followed = { role: option.role, name: option.name };
    out.note = refused + " It then followed the page's own web option, the " + look + ", and the page is now " + input.url + ". " + APP_ROUTE;
  } else if (input.how === "page") {
    out.note = refused + " The page then took its own web path, and it is now " + input.url + ". " + APP_ROUTE;
  } else if (option) {
    out.webOption = { ref: option.ref, role: option.role, name: option.name };
    out.next = [["click", option.ref]];
    out.note = refused + " The page offers a web option, the " + look + (input.problem ? ", but following it did not work: " + input.problem : "") +
      ". Click it with [\"click\",\"" + option.ref + "\"]. " + APP_ROUTE;
  } else {
    out.next = [["wait", "<text you expect>"], ["snapshot", "--interactive"]];
    out.note = refused + " The page has not moved on and shows no web option desk-web can find. Run [\"wait\",\"<text you expect>\"] to let the page's own fallback run, or [\"snapshot\",\"--interactive\"] to look for the option by hand. " + APP_ROUTE;
  }
  return out;
}

module.exports = { webOptionIn: webOptionIn, webOptionInText: webOptionInText, report: report, APP_ROUTE: APP_ROUTE };
