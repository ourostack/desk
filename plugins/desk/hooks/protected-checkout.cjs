#!/usr/bin/env node
"use strict";

const { pathToFileURL } = require("node:url");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const { protectedCheckoutHook } = await import(pathToFileURL(path.join(__dirname, "../mcp/src/runtime/protected-checkout.js")).href);
    const output = await protectedCheckoutHook(JSON.parse(input), process.argv[2]);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`Desk protected-checkout guard could not inspect this command: ${error.message}\n`);
    process.exitCode = 2;
  }
});
