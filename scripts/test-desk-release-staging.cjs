#!/usr/bin/env node
"use strict";

// The Desk release bumps the version in every file scripts/release-desk.cjs lists, some of them test fixtures under
// tests/desk, and the release then commits only the paths its `git add` names. A bumped file outside those
// paths stays uncommitted: the release's own checks pass on its working tree, and main goes red afterwards.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DESK_VERSION_FILES } = require("./release-desk.cjs");

const repoRoot = path.resolve(__dirname, "..");
// The staging lives in the script the release workflow and the pull request dry run share.
const WORKFLOW = "scripts/build-and-check-release.sh";

// Every pathspec after `git add ... --` on a staging line of the workflow.
function stagedPathspecs(text) {
  return text.split("\n")
    .map((line) => /\bgit add\b[^\n]*?\s--\s+(.+)$/u.exec(line.trim()))
    .filter(Boolean)
    .flatMap((match) => match[1].split(/\s+/u).filter((spec) => spec !== "" && !spec.startsWith("#")))
    .map((spec) => spec.replace(/^["']|["']$/gu, "").replace(/\/+$/u, ""));
}

function isStaged(file, specs) {
  return specs.some((spec) => spec === "." || file === spec || file.startsWith(`${spec}/`));
}

assert.deepEqual(stagedPathspecs("  git add --all -- .claude-plugin plugins/desk tests/desk/\n  git add x"), [".claude-plugin", "plugins/desk", "tests/desk"]);
assert.equal(isStaged("tests/desk/mcp/__tests__/a.js", ["plugins/desk"]), false);
assert.equal(isStaged("tests/desk/mcp/__tests__/a.js", ["tests/desk"]), true);
assert.equal(isStaged("plugins/desktop/a.js", ["plugins/desk"]), false);

const specs = stagedPathspecs(fs.readFileSync(path.join(repoRoot, WORKFLOW), "utf8"));
assert.ok(specs.length > 0, `${WORKFLOW} must stage the release with git add --all -- <paths>`);
assert.ok(DESK_VERSION_FILES.length > 0, "release-desk.cjs must list the files the release bumps");
const unstaged = DESK_VERSION_FILES.filter((file) => !isStaged(file, specs));
assert.deepEqual(unstaged, [], `${WORKFLOW} stages ${specs.join(" ")}, but the release bumps these files outside those paths, so they would never be committed; add their folder to the git add:\n${unstaged.join("\n")}`);

console.log(`Desk release staging passed: all ${DESK_VERSION_FILES.length} bumped files are inside ${specs.join(", ")}.`);
