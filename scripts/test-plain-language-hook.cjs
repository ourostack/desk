#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const hook = path.join(repoRoot, "plugins", "plain-language", "hooks", "inject.cjs");

function run(file, event) {
  return spawnSync(process.execPath, [file, event], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
}

for (const event of ["SessionStart", "SubagentStart"]) {
  const result = run(hook, event);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, event);
  assert.match(output.hookSpecificOutput.additionalContext, /^\[PLAIN_LANGUAGE_CONTRACT\]/u);
  assert.match(output.hookSpecificOutput.additionalContext, /## Serve the reader/u);
  assert.match(output.hookSpecificOutput.additionalContext, /## Translate internal identifiers/u);
  assert.match(output.hookSpecificOutput.additionalContext, /every first mention[\s\S]+reader-facing name/iu);
  assert.match(output.hookSpecificOutput.additionalContext, /identifier is not needed[\s\S]+omit it/iu);
  assert.match(output.hookSpecificOutput.additionalContext, /never make the reader decode[\s\S]+identifier/iu);
  assert.match(output.hookSpecificOutput.additionalContext, /## Report work precisely/u);
  assert.match(output.hookSpecificOutput.additionalContext, /## Check before sending/u);
  assert.match(output.hookSpecificOutput.additionalContext, /The integration test is still running/u);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /^---/u);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /vendor|upstream-sources|conformance/iu);
}

// Byte-for-byte output: the skill body after its frontmatter, behind the contract tag, in each host's envelope.
{
  const skill = fs.readFileSync(path.join(repoRoot, "plugins", "plain-language", "skills", "plain-language", "SKILL.md"), "utf8");
  const contract = `[PLAIN_LANGUAGE_CONTRACT]\n${skill.replace(/^---[\s\S]*?---\s*/u, "")}`;
  for (const event of ["SessionStart", "SubagentStart"]) {
    const result = run(hook, event);
    assert.equal(result.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: contract } }));
    assert.equal(result.stderr, "");
  }
  const copilot = run(hook, "sessionStart");
  assert.equal(copilot.stdout, JSON.stringify({ additionalContext: contract }));
  assert.equal(copilot.stderr, "");
}

// One function reads the skill, strips its frontmatter and adds the tag; both host paths call it.
{
  const source = fs.readFileSync(hook, "utf8");
  assert.equal(source.split("readFileSync(").length - 1, 1, "the hook reads the skill in one place");
  assert.equal(source.split("[PLAIN_LANGUAGE_CONTRACT]").length - 1, 1, "the hook adds the contract tag in one place");
}

const missingEvent = run(hook, "");
assert.notEqual(missingEvent.status, 0);
assert.match(missingEvent.stderr, /unsupported Plain Language hook event/u);

// Copilot's sessionStart event: a top-level `additionalContext` field (no
// `hookSpecificOutput` wrapper), the shape Copilot's hook merge expects.
{
  const result = run(hook, "sessionStart");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.additionalContext, /^\[PLAIN_LANGUAGE_CONTRACT\]/u);
  assert.match(output.additionalContext, /## Serve the reader/u);
  assert.match(output.additionalContext, /## Translate internal identifiers/u);
  assert.match(output.additionalContext, /every first mention[\s\S]+reader-facing name/iu);
  assert.match(output.additionalContext, /identifier is not needed[\s\S]+omit it/iu);
  assert.match(output.additionalContext, /never make the reader decode[\s\S]+identifier/iu);
  assert.match(output.additionalContext, /## Report work precisely/u);
  assert.match(output.additionalContext, /## Check before sending/u);
  assert.match(output.additionalContext, /The integration test is still running/u);
  assert.doesNotMatch(output.additionalContext, /^---/u);
  assert.doesNotMatch(output.additionalContext, /vendor|upstream-sources|conformance/iu);
}

const flattened = fs.mkdtempSync(path.join(os.tmpdir(), "plain-language-hook-"));
fs.mkdirSync(path.join(flattened, "hooks"), { recursive: true });
fs.copyFileSync(hook, path.join(flattened, "hooks", "inject.cjs"));
const missingSkill = run(path.join(flattened, "hooks", "inject.cjs"), "SessionStart");
assert.notEqual(missingSkill.status, 0);
assert.match(missingSkill.stderr, /^Plain Language hook could not load \S+SKILL\.md: ENOENT[^\n]*\n$/u);
assert.equal(missingSkill.stdout, "");

// Copilot's sessionStart fails open: a one-line diagnostic as
// `additionalContext`, exit 0, so one broken plugin never blocks the merged
// session-start context Copilot assembles from every installed plugin.
const missingSkillCopilot = run(path.join(flattened, "hooks", "inject.cjs"), "sessionStart");
assert.equal(missingSkillCopilot.status, 0, missingSkillCopilot.stderr);
const copilotDiagnostic = JSON.parse(missingSkillCopilot.stdout);
assert.equal(typeof copilotDiagnostic.additionalContext, "string");
assert.match(copilotDiagnostic.additionalContext, /could not load/u);
assert.equal(copilotDiagnostic.additionalContext.includes("\n"), false);

console.log("plain-language hook tests passed.");
