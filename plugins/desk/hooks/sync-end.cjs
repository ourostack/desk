#!/usr/bin/env node
"use strict";

// SessionEnd/sessionEnd's own safety net (M4-6 "agents never fight the desk"
// Part 3, spec.md §2 "the offline rule"). A push failure never re-raises on
// every turn — the background worker (`runtime/sync-worker.js`) owns pushing
// and only records its own state locally. This hook runs `finalUnpushedCheck`
// exactly once, at genuine session end, so a desk that still has unpushed
// commits then gets that fact recorded for `desk_status`'s sync section to
// surface next time, instead of staying silently invisible forever.
//
// Binds only to `SessionEnd`/`sessionEnd`, never `Stop`/`agentStop`, for the
// same reason `factory-end.cjs`'s own top comment gives: "the Stop hook runs
// after every turn" — a check that fires every turn is noise, one that never
// fires is a silent data-loss risk (spec.md §2).
//
// Deliberately much smaller than `factory-end.cjs`: no plugin-metadata scan,
// no marker file, no derive/finalize job — just resolve this session's desk
// root and run one local, no-network check against it.


const headless = (env) => { try { return require("../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(env); } catch { const v = String(env?.DESK_FACTORY_HEADLESS ?? ""); return v !== "" && v !== "0"; } };
const MAX_INPUT = 1024 * 1024;

async function readInput(stream, timeoutMs = 150) {
  return new Promise((resolve) => {
    let bytes = 0;
    const chunks = [];
    const finish = (value) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      stream.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT) finish(null);
      else chunks.push(Buffer.from(chunk));
    });
    stream.once("error", () => finish(null));
    stream.once("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * `{ host, payload, env? }` -> `"checked" | "clean" | "unpushed" | "invalid" |
 * "unavailable"`. Never throws, never blocks the session-end event: any
 * failure to even resolve the desk root or run the check degrades to
 * `"unavailable"`, the same fail-open shape every other hook in this plugin
 * uses (see `factory-end.cjs`'s own `runHook`).
 */
async function runHook({ host, payload, env = process.env } = {}) {
  try {
    // A headless evaluator session writes no sync record and runs no git.
    if (headless(env)) return "headless";
    const { isPlainObject } = await import("../mcp/src/factory/schema.js");
    if (!["claude", "copilot"].includes(host) || !isPlainObject(payload)) return "invalid";
    const claude = host === "claude";
    const event = claude ? payload.hook_event_name : Object.hasOwn(payload, "reason") ? "sessionEnd" : null;
    if (event !== (claude ? "SessionEnd" : "sessionEnd")) return "invalid";
    const cwd = payload.cwd;
    if (typeof cwd !== "string" || cwd === "") return "invalid";
    const [{ resolveHookDeskRoot }, { finalUnpushedCheck }] = await Promise.all([
      import("../mcp/scripts/resolve-desk-root.js"),
      import("../mcp/src/runtime/sync-worker.js"),
    ]);
    const { root: deskRoot } = resolveHookDeskRoot({ env, cwd });
    if (deskRoot === null) return "unavailable";
    const result = finalUnpushedCheck({ root: deskRoot, env });
    return result.state === "unpushed" ? "unpushed" : "clean";
  } catch {
    // Hooks cannot veto lifecycle events. desk_status carries this forward.
    return "unavailable";
  }
}

module.exports = { readInput, runHook };

if (require.main === module) {
  readInput(process.stdin)
    .then((payload) => runHook({ host: process.argv[2], payload }))
    .then(() => process.exit(0), () => process.exit(0));
}
