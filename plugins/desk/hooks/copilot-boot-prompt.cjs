#!/usr/bin/env node
"use strict";

// Copilot userPromptSubmitted: hands the model the session boot's result as context beside the message. Copilot weighs sessionStart
// context lightly (boot acceptance rounds F and G), and it runs this hook before sessionStart on a new session, so this hook starts
// the boot itself (mcp/src/runtime/startup-boot.js), waits for it within its budget and delivers it once; the sessionStart hook and
// the first Desk tool reply deliver it when it was not ready here. A folder that resolves to no usable desk, a boot already delivered
// and any failure answer `{}`; it always exits 0.

// The hook's limit is 11 s (copilot-hooks.json); the boot takes 3 to 10 s on a busy machine and has a 15 s budget of its own, so a slow one finishes later and is delivered then.
// The wait ends this long after the hook's process started, so a slow Node start (Windows can spend several seconds on it) shortens the wait instead of overrunning the limit.
const WAIT_UNTIL_MS = process.platform === "win32" ? 5500 : 8000;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    // A headless evaluator session gets no boot and claims nothing (mcp/src/factory/headless-flag.cjs); a missing rule file falls back to the same exact comparison.
    let headless;
    try { headless = require("../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(process.env); } catch { const v = String(process.env.DESK_FACTORY_HEADLESS ?? ""); headless = v !== "" && v !== "0"; }
    if (headless) {
      process.stdout.write("{}\n");
      return;
    }
    const { sessionId, cwd } = JSON.parse(input);
    const boot = await import("../mcp/src/runtime/startup-boot.js");
    const { copilotBootRoot } = await import("../mcp/src/util/startup-direction.js");
    const { markBootDirected } = await import("../mcp/src/runtime/copilot-session.js");
    const sessionFolder = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
    const key = boot.bootKey({ sessionId });
    if (key === null || !boot.autoBootEnabled(process.env) || copilotBootRoot({ env: process.env, sessionFolder }) === null) {
      process.stdout.write("{}\n");
      return;
    }
    const { paths } = boot.startBoot({ key, folder: sessionFolder, sessionId, env: process.env });
    if (paths === null || boot.wasDelivered(paths)) {
      process.stdout.write("{}\n");
      return;
    }
    const result = await boot.awaitBoot({ paths, waitMs: Math.max(0, WAIT_UNTIL_MS - performance.now()) });
    let context = "";
    if (result.boot !== null) {
      if (boot.claimDelivery(paths)) context = boot.bootContext({ boot: result.boot }).text;
    } else if (result.reason === "running" && markBootDirected({ sessionId, env: process.env })) {
      // Said once: the next message or the first Desk tool reply carries the result.
      context = boot.pendingBootLine({ seconds: boot.bootAgeSeconds(paths) });
    }
    process.stdout.write(context === "" ? "{}\n" : `${JSON.stringify({ additionalContext: context })}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
});
