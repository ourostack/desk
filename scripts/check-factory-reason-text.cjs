#!/usr/bin/env node
"use strict";

// Every reason Desk can put in a published number has to have display text in the factory store (ourostack/factory),
// because the store's site build stops on a reason it has no words for. The store went red for hours when Desk added
// `no_turn_records` and the store had no text for it. This check reads the store's text table (a shallow, read-only
// fetch of site/src/format.js at main) and fails, naming each reason, when Desk can emit one the store does not carry.
//
// Exit codes: 0 every reason has text, or the store could not be read (reported as NOT CHECKED, never as passed);
// 1 a reason has no text, or the store's file no longer has a reason table this check can read.

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_URL = "https://raw.githubusercontent.com/ourostack/factory/main/site/src/format.js";
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 20_000;

/** The reason codes the store's `REASON_TEXT` table carries, or null when the file has no such table. */
function storeReasonCodes(source) {
  const table = /const REASON_TEXT = \{([\s\S]*?)\n\s*\};/u.exec(String(source));
  if (table === null) return null;
  const codes = new Set([...table[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gmu)].map((match) => match[1]));
  return codes.size === 0 ? null : codes;
}

/** `{ state: "checked", missing }` or `{ state: "unreadable" }` for Desk's reason codes against the store's source text. */
function compareReasons({ deskReasons, storeSource }) {
  const codes = storeReasonCodes(storeSource);
  if (codes === null) return { state: "unreadable" };
  return { state: "checked", missing: [...deskReasons].filter((reason) => !codes.has(reason)).sort() };
}

/** Every reason Desk can emit with display text of its own: the table the pipeline's reports and rollups read. */
async function deskReasonCodes(root = repoRoot) {
  const report = await import(pathToFileURL(path.join(root, "plugins", "desk", "mcp", "src", "factory", "pipeline", "report.js")).href);
  return Object.keys(report.REASON_TEXT);
}

/** The store's file text, or `{ error }` when it cannot be fetched after a few attempts. */
async function fetchStoreSource({ url, fetchImpl = fetch, attempts = FETCH_ATTEMPTS, timeoutMs = FETCH_TIMEOUT_MS }) {
  let error = "no attempt was made";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return { source: await response.text() };
      error = `HTTP ${response.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return { error };
}

/** Runs the check and returns `{ code, lines, summary }`; `lines` are workflow log lines. */
async function run({ env = process.env, root = repoRoot, fetchImpl, attempts, timeoutMs } = {}) {
  const url = env.FACTORY_REASON_TEXT_URL || DEFAULT_URL;
  const deskReasons = await deskReasonCodes(root);
  let storeSource;
  if (env.FACTORY_REASON_TEXT_FILE) {
    storeSource = fs.readFileSync(env.FACTORY_REASON_TEXT_FILE, "utf8");
  } else {
    const fetched = await fetchStoreSource({ url, fetchImpl, attempts, timeoutMs });
    if (fetched.error !== undefined) {
      const message = `Factory store reason text NOT CHECKED: could not read ${url} (${fetched.error}). Desk's ${deskReasons.length} reasons were not compared with the store, so this is not a pass.`;
      return { code: 0, lines: [`::warning title=Factory store reason text not checked::${message}`], summary: `## Factory store reason text: NOT CHECKED\n\n${message}\n` };
    }
    storeSource = fetched.source;
  }
  const result = compareReasons({ deskReasons, storeSource });
  if (result.state === "unreadable") {
    const message = `Factory store reason text could not be read: ${url} has no \`const REASON_TEXT = {...}\` table this check understands. The store moved or renamed its reason table; update scripts/check-factory-reason-text.cjs to read the new place, so Desk reasons are checked again.`;
    return { code: 1, lines: [`::error title=Factory store reason text unreadable::${message}`], summary: `## Factory store reason text: NOT CHECKED\n\n${message}\n` };
  }
  if (result.missing.length > 0) {
    const lines = result.missing.map((reason) => `::error title=Factory store has no text for a Desk reason::Desk can emit the reason \`${reason}\`, and the factory store (${url}) has no display text for it, so the store's site build will stop on it. Add \`${reason}\` to REASON_TEXT in ourostack/factory site/src/format.js before this merges.`);
    return { code: 1, lines, summary: `## Factory store reason text: FAILED\n\nThe store has no display text for: ${result.missing.map((reason) => `\`${reason}\``).join(", ")}.\n` };
  }
  return { code: 0, lines: [`Factory store reason text: all ${deskReasons.length} Desk reasons have display text in the store.`], summary: `## Factory store reason text: checked\n\nAll ${deskReasons.length} Desk reasons have display text in the store.\n` };
}

module.exports = { compareReasons, deskReasonCodes, fetchStoreSource, run, storeReasonCodes };

if (require.main === module) {
  run().then(({ code, lines, summary }) => {
    for (const line of lines) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    process.exitCode = code;
  }).catch((error) => {
    console.error(`::error title=Factory store reason text check failed::${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
