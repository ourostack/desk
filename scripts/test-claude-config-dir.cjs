#!/usr/bin/env node
"use strict";

// Claude Code keeps its user configuration in $CLAUDE_CONFIG_DIR when that is set, and only otherwise in ~/.claude.
// A setup step, skill or script that names ~/.claude on its own would edit the operator's real profile while a
// throwaway or alternate profile is active. Every such reference must resolve the variable first, on the same line.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");

// Prose and shell name the directory as a home path; code builds it from a ".claude" path segment.
const HOME_PATH = /(?:~|\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE)[/\\]\.claude(?![\w-])/u;
const CODE_SEGMENT = /["'`]\.claude(?:["'`]|[/\\])|\}[/\\]\.claude(?![\w-])/u;
const CODE_FILE = /\.(?:[cm]?js|ts)$/u;
const SCANNED = /\.(?:md|[cm]?js|ts|sh|ps1|ya?ml|toml)$/u;

function isScanned(file) {
  if (!SCANNED.test(file)) return false;
  // The vendored upstream payload stays byte-identical, tests build sandboxed profiles on purpose, and changelogs
  // and planning records are history.
  if (file.startsWith("plugins/superpowers/")) return false;
  if (file.includes("/__tests__/") || /^scripts\/test-[^/]+\.cjs$/u.test(file)) return false;
  if (file.endsWith("CHANGELOG.md") || file.startsWith("desk/")) return false;
  return true;
}

function hardCodedLines(file, text) {
  const pattern = CODE_FILE.test(file) ? new RegExp(`${HOME_PATH.source}|${CODE_SEGMENT.source}`, "u") : HOME_PATH;
  return text.split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => pattern.test(line) && !line.includes("CLAUDE_CONFIG_DIR"))
    .map(({ line, number }) => `${file}:${number}: ${line.trim()}`);
}

// The detector itself: bare references fail, references beside the variable pass, and look-alikes are ignored.
for (const [file, line, flagged] of [
  ["SETUP.md", "Merge these keys into `~/.claude/settings.json`.", true],
  ["SETUP.md", "Copy it outside `~/.claude` first.", true],
  ["run.sh", 'cp x "$HOME/.claude/CLAUDE.md"', true],
  ["run.sh", 'cp x "${HOME}/.claude/CLAUDE.md"', true],
  ["run.ps1", 'Copy-Item x "$env:USERPROFILE\\.claude\\CLAUDE.md"', true],
  ["hook.cjs", 'const settings = path.join(os.homedir(), ".claude", "settings.json")', true],
  ["hook.cjs", "const settings = `${home}/.claude/settings.json`", true],
  ["SETUP.md", 'CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"', false],
  ["hook.cjs", 'const dir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")', false],
  ["SETUP.md", "Older installs used `~/.claude-plugin/plugins/`.", false],
  ["SKILL.md", "harness-specific file paths like `.claude/settings.json`", false],
]) {
  assert.equal(hardCodedLines(file, line).length > 0, flagged, `${file}: ${line}`);
}

const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "" && isScanned(file));
assert.ok(files.includes("SETUP.md") && files.includes("plugins/desk/hooks/factory-end.cjs"), "the scan must cover setup docs and shipped hooks");
const violations = files.flatMap((file) => hardCodedLines(file, fs.readFileSync(path.join(repoRoot, file), "utf8")));
assert.deepEqual(violations, [], `hard-coded Claude config directory without the CLAUDE_CONFIG_DIR fallback:\n${violations.join("\n")}`);

{
  // SETUP.md resolves the directory once, up front, and every Claude Code step uses that one name for it.
  const setup = fs.readFileSync(path.join(repoRoot, "SETUP.md"), "utf8");
  const definition = setup.indexOf('CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"');
  assert.notEqual(definition, -1, "SETUP.md must define CLAUDE_DIR from CLAUDE_CONFIG_DIR with the ~/.claude fallback");
  assert.ok(definition < setup.indexOf("## Claude Code"), "SETUP.md must resolve the Claude config directory before the first step");
  for (const target of ["settings.json", "CLAUDE.md", "agents/", "projects/", "plugins/data/desk-ourostack/desk.activation.json"]) {
    assert.ok(setup.includes(`$CLAUDE_DIR/${target}`), `SETUP.md must reach ${target} through $CLAUDE_DIR`);
  }
  // Desk forbids AI attribution (using-desk's "Durable context and attribution"), so the settings step must turn
  // it off in the profile SETUP.md produces, not rely on the operator noticing later. The three-field object form,
  // not the `attribution: false` shorthand, is what stays readable to the Claude Code versions SETUP.md still
  // supports: the shorthand needs v2.1.281+, and an older version rejects the whole settings file that holds it.
  assert.ok(
    setup.includes('"attribution": { "commit": "", "pr": "", "sessionUrl": false }'),
    "SETUP.md step 3 must merge an empty attribution (commit, pr and sessionUrl) into $CLAUDE_DIR/settings.json, so a profile it sets up never adds AI attribution — including a claude.ai session link — to commits or pull requests",
  );
}

console.log("Claude config directory contract passed.");
