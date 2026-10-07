#!/usr/bin/env node
"use strict";

// Copilot userPromptSubmitted: on the first prompt of a session, hand the model the boot direction as context beside the message
// (see promptBootDirection for why sessionStart alone is not enough). Copilot runs this hook before sessionStart on a new session, so it
// claims the session itself and needs no record. A folder that resolves to no usable desk, later prompts and any failure answer `{}` and claim nothing; it always exits 0.


let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    // A headless evaluator session gets no boot direction and claims nothing (mcp/src/factory/headless-flag.cjs); a missing rule file falls back to the same exact comparison.
    let headless;
    try { headless = require("../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(process.env); } catch { const v = String(process.env.DESK_FACTORY_HEADLESS ?? ""); headless = v !== "" && v !== "0"; }
    if (headless) {
      process.stdout.write("{}\n");
      return;
    }
    const { sessionId, cwd } = JSON.parse(input);
    // The text first, then the root check, then the claim last: a failure before the claim must not use it up.
    const { copilotPromptPointer } = await import("../mcp/src/util/startup-direction.js");
    const { markBootDirected } = await import("../mcp/src/runtime/copilot-session.js");
    const sessionFolder = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
    const pointer = copilotPromptPointer({ env: process.env, sessionFolder });
    if (pointer === null || !markBootDirected({ sessionId, env: process.env })) {
      process.stdout.write("{}\n");
      return;
    }
    process.stdout.write(`${JSON.stringify({ additionalContext: pointer })}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
});
