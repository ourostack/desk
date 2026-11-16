#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const CANONICAL_RFC = "plugins/desk/docs/agentic-engineering-v2-rfc.md";
const OPERATIONAL_ONBOARDING_SKILLS = [
  "plugins/desk/skills/first-run-bootstrap/SKILL.md",
  "plugins/desk/skills/session-start/SKILL.md",
  "plugins/desk/skills/session-start-migrations/SKILL.md",
];
const PATH_1_HEADINGS = [
  "Entrance A — new to Desk",
  "Entrance B — existing Epoch 1 Desk",
  "Converged endpoint",
];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function parseHeadings(markdown) {
  return [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gmu)].map((match) => ({
    level: match[1].length,
    title: match[2].trim(),
    index: match.index,
  }));
}

function findHeading(headings, level, title) {
  return headings.find((heading) => heading.level === level && heading.title === title);
}

function sectionBounds(headings, heading) {
  const start = heading.index;
  const startIndex = headings.findIndex((candidate) => candidate === heading);
  const nextPeerOrAncestor = headings
    .slice(startIndex + 1)
    .find((candidate) => candidate.level <= heading.level);
  return {
    start,
    end: nextPeerOrAncestor?.index ?? Number.POSITIVE_INFINITY,
  };
}

function sectionText(markdown, headings, heading) {
  const { start, end } = sectionBounds(headings, heading);
  return markdown.slice(start, end === Number.POSITIVE_INFINITY ? undefined : end);
}

function childHeadingTitles(markdown, headings, heading, level) {
  const { start, end } = sectionBounds(headings, heading);
  return headings
    .filter((candidate) => candidate.level === level && candidate.index > start && candidate.index < end)
    .map((candidate) => candidate.title);
}

function assertOrderedPhrases(body, label, phrases) {
  let cursor = -1;
  for (const phrase of phrases) {
    const index = body.indexOf(phrase);
    assert.ok(index > cursor, `${label} must contain "${phrase}" in executable order`);
    cursor = index;
  }
}

function listTrackedMarkdownFiles() {
  return execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry.endsWith(".md"));
}

function findCanonicalRfcCopies() {
  return listTrackedMarkdownFiles().filter((file) => /^# Agentic Engineering Epoch 2\s*$/mu.test(read(file)));
}

function main() {
  const rfc = read(CANONICAL_RFC);
  const firstRun = read("plugins/desk/skills/first-run-bootstrap/SKILL.md");
  const sessionStart = read("plugins/desk/skills/session-start/SKILL.md");
  const sessionStartMigrations = read("plugins/desk/skills/session-start-migrations/SKILL.md");
  const firstRunHeadings = parseHeadings(firstRun);
  const sessionStartHeadings = parseHeadings(sessionStart);

  assert.deepStrictEqual(findCanonicalRfcCopies(), [CANONICAL_RFC]);
  assert.deepStrictEqual(
    OPERATIONAL_ONBOARDING_SKILLS.flatMap((file) =>
      parseHeadings(read(file))
        .filter((heading) => heading.level === 2 && /^Path\b/u.test(heading.title))
        .map((heading) => ({ file, title: heading.title })),
    ),
    [
      {
        file: "plugins/desk/skills/first-run-bootstrap/SKILL.md",
        title: "Path 1 — start or upgrade a Desk",
      },
    ],
    "Operational onboarding skills must expose exactly Path 1, with no other top-level path heading.",
  );

  const path1 = findHeading(firstRunHeadings, 2, "Path 1 — start or upgrade a Desk");
  assert.ok(path1, "first-run-bootstrap must expose Path 1");
  assert.deepStrictEqual(childHeadingTitles(firstRun, firstRunHeadings, path1, 3), PATH_1_HEADINGS);
  const entranceA = findHeading(firstRunHeadings, 3, "Entrance A — new to Desk");
  assert.ok(entranceA, "Path 1 must define Entrance A");
  const entranceAText = sectionText(firstRun, firstRunHeadings, entranceA);
  assert.match(entranceAText, /remote discovery/iu);
  assert.match(entranceAText, /clone or fresh-create/iu);
  assert.match(entranceAText, /operator-provided path/iu);
  assert.match(entranceAText, /skip/iu);
  const entranceB = findHeading(firstRunHeadings, 3, "Entrance B — existing Epoch 1 Desk");
  assert.ok(entranceB, "Path 1 must define Entrance B");
  const entranceBText = sectionText(firstRun, firstRunHeadings, entranceB);
  assertOrderedPhrases(entranceBText, "Entrance B", [
    "1. Detect and inventory",
    "2. Record rollback evidence",
    "3. Preserve the same workspace",
    "4. Replace Epoch 1 declarations",
    "5. Reconcile retired Epoch 1-only capabilities",
    "6. Activate and verify Epoch 2",
    "7. Resume the existing task or start the first Epoch 2 job",
  ]);
  for (const phrase of [
    "workspace and Git state",
    "durable task state",
    "rollback ref",
    "reviewed Epoch 2 chain",
    "selected roots",
    "MCP readiness",
    "startup readiness",
  ]) {
    assert.match(entranceBText, new RegExp(phrase, "iu"), `Entrance B must bind ${phrase}`);
  }
  assert.doesNotMatch(entranceBText, /\bclone\b|\bfresh-create\b|operator-provided path|\bskip\b/iu);
  const convergedEndpoint = findHeading(firstRunHeadings, 3, "Converged endpoint");
  assert.ok(convergedEndpoint, "Path 1 must define a converged endpoint");
  assert.match(sectionText(firstRun, firstRunHeadings, convergedEndpoint), /same durable workspace/iu);

  // session-start routes an existing Epoch 1 workspace by content, not by "Step N" labels (#146 removed them: the boot script now does the sync, and one workspace check remains).
  const existingWorkspaceUpgrade = sessionStartHeadings.find((heading) => heading.level === 3 && heading.title === "Existing-workspace Epoch 1 upgrade branch");
  assert.ok(existingWorkspaceUpgrade, "session-start must route existing Epoch 1 workspaces explicitly");
  const workspaceCheck = [...sessionStartHeadings].reverse().find((heading) => heading.level === 2 && heading.index < existingWorkspaceUpgrade.index);
  assert.match(workspaceCheck?.title ?? "", /workspace/iu, "the Epoch 1 upgrade branch must sit under the workspace check, which routes an existing workspace");
  assert.deepStrictEqual(childHeadingTitles(sessionStart, sessionStartHeadings, workspaceCheck, 3), ["Existing-workspace Epoch 1 upgrade branch"]);
  const existingWorkspaceUpgradeText = sectionText(sessionStart, sessionStartHeadings, existingWorkspaceUpgrade);
  assert.match(existingWorkspaceUpgradeText, /first-run-bootstrap/iu, "the branch must hand off to first-run-bootstrap");
  assert.match(existingWorkspaceUpgradeText, /Entrance B/iu);
  assert.match(existingWorkspaceUpgradeText, /same workspace/iu);
  assert.match(existingWorkspaceUpgradeText, /never clones or creates a parallel Desk/iu);
  assert.match(existingWorkspaceUpgradeText, /do not continue into ordinary resumption/iu);
  assert.match(existingWorkspaceUpgradeText, /later runs skip this branch/iu);

  assert.match(sessionStartMigrations, /before any path-dependent startup scans/iu);
  assert.match(sessionStartMigrations, /completed onboarding is not replayed during normal resumption/iu);

  console.log("Epoch 2 onboarding path contract passed.");
}

main();
