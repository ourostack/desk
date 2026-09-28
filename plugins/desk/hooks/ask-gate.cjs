#!/usr/bin/env node
"use strict";

const { pathToFileURL } = require("node:url");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const { askGateHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/ask-gate.js")).href);
    const output = await askGateHook(JSON.parse(input), process.argv[2]);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    // Fail open: an internal error here must never block a real setup. Only
    // exit code 2 blocks a PreToolUse hook's tool call; every other code,
    // including this one, lets the call proceed with no JSON decision.
    process.stderr.write(`Desk ask-gate could not inspect this call, allowing it: ${error.message}\n`);
    process.exitCode = 1;
  }
});
