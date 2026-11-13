#!/usr/bin/env node
"use strict";

// Plain Language is a skill an agent loads when it writes for people. Injecting it at session or subagent start
// would put its whole contract into every turn, so the plugin must register no hooks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.resolve(__dirname, "..", "plugins", "plain-language");

assert.equal(fs.existsSync(path.join(pluginRoot, "hooks")), false, "the plugin ships no hooks folder");
for (const manifest of ["plugin.json", path.join(".claude-plugin", "plugin.json")]) {
  const parsed = JSON.parse(fs.readFileSync(path.join(pluginRoot, manifest), "utf8"));
  assert.equal(Object.hasOwn(parsed, "hooks"), false, `${manifest} registers no hooks`);
}

console.log("plain-language registers no hooks.");
