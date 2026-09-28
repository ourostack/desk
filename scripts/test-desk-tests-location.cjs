#!/usr/bin/env node
"use strict";

// Hosts copy (Claude Code) or download file by file through the GitHub API (Agency and Copilot) everything under
// plugins/desk, so a test or fixture there ships to every user and costs every refresh. The Desk tests live in
// tests/desk, which mirrors plugins/desk: a test for plugins/desk/<package> goes in tests/desk/<package>.

const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const PLUGIN = "plugins/desk/";

// A test folder anywhere in the path, or a test or spec file by name.
function isTestPath(file) {
  const inside = file.slice(PLUGIN.length);
  return /(^|\/)(__tests__|tests?|specs?)\//u.test(inside) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(inside);
}

for (const [file, flagged] of [
  ["plugins/desk/mcp/__tests__/a.test.js", true],
  ["plugins/desk/browser-context-broker/test/fixtures/x.mjs", true],
  ["plugins/desk/hooks/boot-checks.test.cjs", true],
  ["plugins/desk/mcp/src/coverage/runner.js", false],
  ["plugins/desk/mcp/src/testing-notes.js", false],
]) {
  assert.equal(isTestPath(file), flagged, file);
}

const shipped = execFileSync("git", ["ls-files", "-z", "--", PLUGIN], { cwd: repoRoot, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
assert.ok(shipped.includes("plugins/desk/mcp/index.js"), "the scan must cover the shipped Desk plugin");
const misplaced = shipped.filter(isTestPath);
assert.deepEqual(
  misplaced,
  [],
  [
    "Test files must not ship inside the Desk plugin, because every host copies or downloads everything under plugins/desk.",
    "Move each one to the mirrored place under tests/desk/: plugins/desk/<package>/<path> becomes tests/desk/<package>/<path>, for example plugins/desk/mcp/__tests__/x/y.test.js becomes tests/desk/mcp/__tests__/x/y.test.js.",
    "Then rewrite its relative imports into the plugin, which do not survive the move: from tests/desk/mcp/__tests__/x/, \"../../src/a.js\" becomes \"../../../../../plugins/desk/mcp/src/a.js\". Imports of other tests and fixtures under tests/desk stay as they are.",
    "Misplaced files:",
    ...misplaced,
  ].join("\n"),
);

console.log(`Desk tests location passed: no test files among ${shipped.length} shipped plugin files; tests live in tests/desk/.`);
