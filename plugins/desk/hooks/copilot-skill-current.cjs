#!/usr/bin/env node
"use strict";

// Copilot postToolUse for the `skill` tool. The host reads a plugin's skills when the app starts, so a skill the agent loads is
// the text of the release the session began on. When a newer release of that skill's plugin is on disk (Agency's cache, Desk's
// release copies) and the text differs, this hands the agent the current text and where its docs are. Output is `{}` when there
// is nothing newer; it always exits 0.

if (require("./lib/current-release.cjs").delegate(__filename)) return;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let output = {};
  try {
    const payload = JSON.parse(input);
    let args = payload.toolArgs;
    if (typeof args === "string") args = JSON.parse(args);
    if (payload.toolName === "skill" && args && typeof args.skill === "string") {
      const additionalContext = require("./lib/current-release.cjs").currentSkill({ pluginRoot: require("node:path").resolve(__dirname, ".."), name: args.skill });
      if (additionalContext !== null) output = { additionalContext };
    }
  } catch {
    // Nothing to add; the skill's own text stands.
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
});
