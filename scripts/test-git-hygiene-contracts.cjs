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

function subsection(markdown, title) {
  const heading = `### ${title}\n`;
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `git-hygiene must include the ${title} subsection`);
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /u);
  return end === -1 ? rest : rest.slice(0, end);
}

function main() {
  const skill = read(skillPath);
  const codeRepos = section(skill, "Code repos");
  const neverLeaveStateBehind = section(skill, "Never leave state behind");

  for (const phrase of [
    "The task's recorded source is its channel",
    "before the first write or worktree",
    "verify the checkout is on that channel",
    "branch relationship",
    "relevant version surface",
    "A commit hash is evidence only",
    "There is no frozen candidate",
  ]) {
    assert.match(codeRepos, new RegExp(escapeRegExp(phrase), "iu"), `Code repos must mention "${phrase}"`);
  }
  assert.doesNotMatch(codeRepos, /frozen (?:task )?refs?|frozen base|frozen SHA|pinned or frozen/iu, "Code repos must not treat a frozen ref as task authority");

  const attribution = subsection(skill, "AI-attribution strip");
  for (const phrase of [
    "Operator authorship overrides repository conventions",
    "flag it on first encounter",
    "`Co-Authored-By:` naming any agent",
    "`Generated with Copilot`",
    "`Built by Copilot`",
    "`Generated with Claude Code`",
  ]) {
    assert.match(attribution, new RegExp(escapeRegExp(phrase), "iu"), `AI-attribution strip must mention "${phrase}"`);
  }
  for (const trailer of ["Co-Authored-By: GitHub Copilot <x>", "Generated with Copilot", "Built by Copilot", "Generated with Claude Code", "Co-authored with Claude"]) {
    const scan = attribution.match(/grep -[a-zA-Z]*E "([^"]+)"/u);
    assert.ok(scan, "AI-attribution strip must ship a grep scan");
    assert.match(trailer, new RegExp(scan[1], "iu"), `the scan must catch "${trailer}"`);
  }

  const diffScope = subsection(skill, "Diff-scope scan");
  for (const phrase of ["exactly the lines required", "Polish is a separate, named activity", "slower review"]) {
    assert.match(diffScope, new RegExp(escapeRegExp(phrase), "iu"), `Diff-scope scan must mention "${phrase}"`);
  }
  assert.doesNotMatch(skill, /principles\.md|Invariant \d/u, "git-hygiene must own its rules, not cite principles.md");

  // The prose stays unwrapped: outside code fences, no line continues the prose unit above it.
  let inCode = false;
  let previousProse = false;
  const continuations = [];
  for (const [index, line] of skill.split("\n").entries()) {
    if (/^\s*```/u.test(line)) { inCode = !inCode; previousProse = false; continue; }
    if (inCode) continue;
    const structural = /^\s*$|^\s*(#|\||>|<|[-*+] |\d+\. |---\s*$)/u.test(line);
    if (!structural && previousProse && index > 0) continuations.push(index + 1);
    previousProse = line.trim() !== "" && !/^\s*(#|\||>|<|---\s*$)/u.test(line);
  }
  assert.deepEqual(continuations.filter((line) => line > 10), [], "git-hygiene prose must not be hard-wrapped");
  assert.doesNotMatch(skill, /\b(?:safe|force)- (?:conditions|push)/u, "git-hygiene must not keep hyphen-join artifacts from the unwrap");

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
