#!/usr/bin/env node
"use strict";

// Desk's naming hook: a Claude Code `UserPromptSubmit` hook. Controller
// ruling 3 -- "named by the operator" is read from every operator message,
// not only the first, and a surface it names stays allowed for the rest of
// the session. This is the recording half; `host-enforcement.cjs`'s
// `PreToolUse` hook is the deny half that reads what this hook records.
//
// Never blocks, and never delays the prompt: an internal error here records
// nothing and lets the prompt through untouched, exactly like `ask-gate.cjs`
// fails open on its own catch-all today. There is no deterministic fix to
// attempt for "could not record a naming" -- unlike a boot check or a sync
// failure, the worst case is simply that this one surface stays denied a
// little longer, which the agent's own judgment (the documented fallback)
// already covers.

const { pathToFileURL } = require("node:url");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const {
      loadSessionAllowlist, namedSurfaceFrom, recordNamedSurface, saveSessionAllowlist,
    } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/naming-allowlist.js")).href);
    const payload = JSON.parse(input);
    const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
    const sessionId = payload?.session_id;
    const surfaceId = namedSurfaceFrom(prompt);
    if (surfaceId !== null && typeof sessionId === "string" && sessionId !== "") {
      const sessionState = loadSessionAllowlist({ sessionId });
      recordNamedSurface(sessionState, surfaceId);
      saveSessionAllowlist({ sessionId, sessionState });
    }
  } catch (error) {
    process.stderr.write(`Desk naming hook could not record this message, recording nothing: ${error.message}\n`);
  }
  // No decision to make: this hook never blocks or alters the prompt.
  process.stdout.write("{}\n");
});
