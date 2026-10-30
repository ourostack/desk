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
  assert.equal(manifest.version, "0.2.10");
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
const workAttribution = pluginSkill.split("## Attribute work to the person\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
assert.match(workAttribution, /person the ordinary actor/u);
assert.match(workAttribution, /Ownership does not claim manual execution/u);
assert.match(workAttribution, /agent speaks in its own role/u);
assert.match(workAttribution, /actual acting identity/u);
assert.match(workAttribution, /say when that identity is unverified/u);
assert.match(workAttribution, /line-by-line reading/u);
assert.match(workAttribution, /sending or publication authority/u);
assert.match(workAttribution, /relays a person's views, feedback or decisions to another person[\s\S]+writes as itself[\s\S]+paraphrase as its own reading/u);
assert.match(workAttribution, /link the source where one exists[\s\S]+send the reader to the person/u);
assert.match(workAttribution, /Never write a relay as if the person wrote it[\s\S]+marked, attributed quotation/u);
assert.match(workAttribution, /use a person's voice only for messages they send themselves or approve for sending in their name/iu);
const understand = pluginSkill.split("## Make the answer easy to understand\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
assert.match(understand, /Spell out chat shorthand such as `wdyt`, `lmk` or `imo`/u);
assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, "plugins/desk/skills/operator-voice-comments/SKILL.md"), "utf8"), /Soften recommendations[^\n]*wdyt/u);
for (const file of ["SKILL.md", "human-voice.md"]) {
  const application = fs.readFileSync(path.join(repoRoot, "plugins/desk/skills/operator-voice-comments", file), "utf8");
  assert.match(application, /plain-language\/SKILL\.md#attribute-work-to-the-person/u);
}
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
assert.match(voiceAndFormat, /Let the layout set line width in rendered text[\s\S]+covers the styles you write[\s\S]+never cap text width with a fixed measure/u);
assert.doesNotMatch(pluginSkill, /vendor|upstream-sources|conformance/iu);

// Copilot injects the plugin's own hook (root plugin.json points at
// copilot-hooks.json); the Claude manifest carries no `hooks` key so Claude
// auto-discovers hooks/hooks.json instead, unaffected by this change.
assert.equal(rootPlugin.hooks, "./hooks/copilot-hooks.json");
assert.equal(Object.hasOwn(claudePlugin, "hooks"), false);
assert.equal(copilotHooks.version, 1);
// Copilot gets the contract at session start and in every subagent, as Claude does through SessionStart and SubagentStart.
assert.deepEqual(Object.keys(copilotHooks.hooks).sort(), ["sessionStart", "subagentStart"]);
for (const event of ["sessionStart", "subagentStart"]) {
  assert.equal(copilotHooks.hooks[event].length, 1);
  const [hook] = copilotHooks.hooks[event];
  assert.equal(hook.type, "command");
  assert.equal(hook.bash, `node "\${PLUGIN_ROOT}/hooks/inject.cjs" ${event}`);
  assert.equal(hook.powershell, `node "\${PLUGIN_ROOT}\\hooks\\inject.cjs" ${event}`);
  assert.equal(typeof hook.timeoutSec, "number");
  assert.equal(hook.timeoutSec > 0, true);
  assert.equal(hook.timeoutSec <= 10, true);
}

console.log("plain-language first-party plugin verified.");
