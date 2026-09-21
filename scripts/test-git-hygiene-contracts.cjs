#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const skillPath = path.join(repoRoot, "plugins", "desk", "skills", "git-hygiene", "SKILL.md");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function section(markdown, title) {
  const heading = `## ${title}\n\n`;
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `git-hygiene must include the ${title} section`);
  const contentStart = start + heading.length;
  const nextLevelTwo = markdown.indexOf("\n## ", contentStart);
  const nextLevelOne = markdown.indexOf("\n# ", contentStart);
  const candidates = [nextLevelTwo, nextLevelOne].filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : markdown.length;
  return markdown.slice(contentStart, end).trim();
}

function main() {
  const skill = read(skillPath);
  const codeRepos = section(skill, "Code repos");
  const neverLeaveStateBehind = section(skill, "Never leave state behind");

  for (const phrase of [
    "Pinned or frozen task refs are the authority for that task",
    "before the first write or worktree",
    "verify the exact ref identity",
    "branch relationship",
    "relevant version surface",
    "frozen SHA",
    "do not rebase or move publication refs to follow the normal-main recipe below",
  ]) {
    assert.match(codeRepos, new RegExp(escapeRegExp(phrase), "iu"), `Code repos must mention "${phrase}"`);
  }

  for (const phrase of [
    "Never reconcile a dirty checked-out state repository by moving the branch ref in place with `git update-ref` or an equivalent ref move under the existing index/worktree",
    "clean temporary worktree based on the current remote destination",
    "replay only the exact task-owned change",
    "explicit staged-path allowlist",
    "git diff --cached --name-status",
    "full staged diff",
  ]) {
    assert.match(
      neverLeaveStateBehind,
      new RegExp(escapeRegExp(phrase), "iu"),
      `Never leave state behind must mention "${phrase}"`,
    );
  }

  console.log("git-hygiene contract passed.");
}

main();
