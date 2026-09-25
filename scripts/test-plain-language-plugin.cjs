#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootArg = process.argv.indexOf("--repo-root");
const repoRoot = rootArg >= 0 ? path.resolve(process.argv[rootArg + 1]) : path.resolve(__dirname, "..");
const vendorRoot = path.join(repoRoot, "plugins", "plain-language", "vendor");
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "upstream-sources.lock.json"), "utf8"));
// The loose-skill catalog is optional; when present it must point at the plugin's skill.
const skillManifestPath = path.join(repoRoot, "manifest.json");
const skillManifest = fs.existsSync(skillManifestPath) ? JSON.parse(fs.readFileSync(skillManifestPath, "utf8")) : null;
const pluginSkill = fs.readFileSync(path.join(repoRoot, "plugins", "plain-language", "skills", "plain-language", "SKILL.md"), "utf8");
const manifests = [
  "plugins/plain-language/plugin.json",
  "plugins/plain-language/.claude-plugin/plugin.json",
  "plugins/plain-language/.codex-plugin/plugin.json",
].map((file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")));
const rootPlugin = manifests[0];
const claudePlugin = manifests[1];
const copilotHooksPath = path.join(repoRoot, "plugins", "plain-language", "hooks", "copilot-hooks.json");
const copilotHooks = JSON.parse(fs.readFileSync(copilotHooksPath, "utf8"));
const vendorFiles = fs.existsSync(vendorRoot)
  ? fs.readdirSync(vendorRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  : [];

assert.equal(fs.existsSync(path.join(repoRoot, "skills", "plain-language", "SKILL.md")), false);
if (skillManifest !== null) {
  assert.equal(
    skillManifest.skills.find((skill) => skill.name === "plain-language")?.path,
    "plugins/plain-language/skills/plain-language/SKILL.md",
  );
}
assert.equal(vendorFiles.length, 0);
assert.equal(lock.sources.some((source) => source.files.some((file) => file.generatedPath.startsWith("plugins/plain-language/"))), false);
for (const manifest of manifests) {
  assert.equal(manifest.version, "0.2.4");
  assert.match(manifest.description, /first-party output policy/u);
}
assert.match(pluginSkill, /## Serve the reader/u);
assert.match(pluginSkill, /## Make the answer easy to find/u);
assert.match(pluginSkill, /## Translate internal identifiers/u);
assert.match(pluginSkill, /reader-facing name[\s\S]+internal identifier/iu);
assert.match(pluginSkill, /every first mention[\s\S]+reader-facing name/iu);
assert.match(pluginSkill, /identifier is not needed[\s\S]+omit it/iu);
assert.match(pluginSkill, /never make the reader decode[\s\S]+identifier/iu);
assert.match(pluginSkill, /## Report work precisely/u);
assert.match(pluginSkill, /## Preserve meaning/u);
assert.match(pluginSkill, /## Check before sending/u);
assert.match(pluginSkill, /The integration test is still running/u);
// Plain Language owns the hard-wrap rule for every agent, including subagents.
const voiceAndFormat = pluginSkill.split("## Keep the right voice and format\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
assert.match(voiceAndFormat, /Never hard-wrap authored prose/u);
assert.match(voiceAndFormat, /one physical line/u);
assert.match(voiceAndFormat, /genuine structure/u);
assert.match(voiceAndFormat, /changed in the current task/u);
assert.match(voiceAndFormat, /source-preserved/u);
assert.doesNotMatch(pluginSkill, /vendor|upstream-sources|conformance/iu);

// Copilot injects the plugin's own hook (root plugin.json points at
// copilot-hooks.json); the Claude manifest carries no `hooks` key so Claude
// auto-discovers hooks/hooks.json instead, unaffected by this change.
assert.equal(rootPlugin.hooks, "./hooks/copilot-hooks.json");
assert.equal(Object.hasOwn(claudePlugin, "hooks"), false);
assert.equal(copilotHooks.version, 1);
assert.equal(Array.isArray(copilotHooks.hooks?.sessionStart), true);
assert.equal(copilotHooks.hooks.sessionStart.length, 1);
const [sessionStartHook] = copilotHooks.hooks.sessionStart;
assert.equal(sessionStartHook.type, "command");
assert.equal(sessionStartHook.bash, "node \"${PLUGIN_ROOT}/hooks/inject.cjs\" sessionStart");
assert.equal(sessionStartHook.powershell, "node \"${PLUGIN_ROOT}\\hooks\\inject.cjs\" sessionStart");
assert.equal(typeof sessionStartHook.timeoutSec, "number");
assert.equal(sessionStartHook.timeoutSec > 0, true);
assert.equal(sessionStartHook.timeoutSec <= 10, true);

console.log("plain-language first-party plugin verified.");
