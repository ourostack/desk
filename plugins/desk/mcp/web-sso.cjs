// Enterprise SSO for the owned browser: GitHub sends a managed (EMU) account's page to an SSO page whose one
// "Continue" button goes through Entra and comes back to the page. desk-web presses it once, and says in the reply
// whether the person's Entra session renewed by itself or Entra asked for a person.

"use strict";

var SSO_PATH = /^\/enterprises\/[^/]+\/sso\/?$/u;
var ENTRA_HOSTS = ["login.microsoftonline.com", "login.windows.net"];

function isSsoPage(url) {
  return !!url && url.hostname === "github.com" && SSO_PATH.test(url.pathname);
}

function onEntra(url) {
  return !!url && ENTRA_HOSTS.indexOf(url.hostname) !== -1;
}

function nameOf(node) {
  if (node.name) return node.name;
  var words = [];
  (function collect(n) {
    if (n.role === "text") { if (typeof n.text === "string" && n.text !== "[redacted]") words.push(n.text); return; }
    (n.children || []).forEach(collect);
  })(node);
  return words.join(" ");
}

// The SSO page's Continue button in a snapshot tree: { ref, name }, or null.
function continueIn(tree) {
  var found = null;
  (function walk(node) {
    if (found) return;
    if (node.ref && node.visible !== false && node.role === "button" && /^continue$/iu.test(String(nameOf(node)).replace(/\s+/g, " ").trim())) found = { ref: node.ref, name: "Continue" };
    (node.children || []).forEach(walk);
  })(tree);
  return found;
}

// `state` is "renewed" (back on GitHub), "needs_person" (Entra asked for a sign-in) or "stalled" (neither).
function report(state) {
  if (state === "renewed") return { state: state, note: "desk-web pressed the enterprise SSO page's Continue; Entra renewed the session without a person and GitHub returned to the page." };
  if (state === "needs_person") {
    return {
      state: state,
      note: "desk-web pressed the enterprise SSO page's Continue, but Entra did not accept this profile copy's session and asked to sign in. That needs the person once (a sign-in or MFA in their own browser); desk-web never types a password or copies a token.",
      keepWorking: "work on pages that do not need the enterprise account, or read the same content through the API; after the person signs in, open a new context with browser_context so the copy has it"
    };
  }
  return { state: state, note: "desk-web pressed the enterprise SSO page's Continue, and the page did not leave it in time.", keepWorking: "run [\"wait\",\"3\"] and read the page again, or press Continue once more" };
}

module.exports = { isSsoPage: isSsoPage, onEntra: onEntra, continueIn: continueIn, report: report };
