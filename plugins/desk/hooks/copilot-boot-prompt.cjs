#!/usr/bin/env node
"use strict";

// Copilot userPromptSubmitted: on the first prompt of a session, hand the model the boot direction as context beside the message
// (see promptBootDirection for why sessionStart alone is not enough). Copilot runs this hook before sessionStart on a new session, so it
// claims the session itself and needs no record. Later prompts and any failure answer `{}`; it always exits 0.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const { sessionId } = JSON.parse(input);
    const root = path.join(__dirname, "../mcp/src");
    const { markBootDirected } = await import(pathToFileURL(path.join(root, "runtime/copilot-session.js")).href);
    if (!markBootDirected({ sessionId, env: process.env })) {
      process.stdout.write("{}\n");
      return;
    }
    const { promptBootDirection } = await import(pathToFileURL(path.join(root, "util/startup-direction.js")).href);
    process.stdout.write(`${JSON.stringify({ additionalContext: promptBootDirection() })}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
});
