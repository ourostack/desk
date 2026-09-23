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
  "plugins/crew/skills/join-crew/SKILL.md",
  "plugins/desk/skills/session-start/SKILL.md",
  "plugins/desk/skills/session-start-migrations/SKILL.md",
];
const PATH_1_HEADINGS = [
  "Entrance A — new to Desk",
  "Entrance B — existing V1 Desk",
  "Converged endpoint",
];
const PATH_2_HEADINGS = [
  "Phase 1 — repository migration",
  "Phase 2 — existing member activation",
  "Phase 3 — new member join",
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
  return listTrackedMarkdownFiles().filter((file) => /^# Agentic Engineering V2\s*$/mu.test(read(file)));
}

function main() {
  const rfc = read(CANONICAL_RFC);
  const firstRun = read("plugins/desk/skills/first-run-bootstrap/SKILL.md");
  const joinCrew = read("plugins/crew/skills/join-crew/SKILL.md");
  const sessionStart = read("plugins/desk/skills/session-start/SKILL.md");
  const sessionStartMigrations = read("plugins/desk/skills/session-start-migrations/SKILL.md");
  const firstRunHeadings = parseHeadings(firstRun);
  const joinCrewHeadings = parseHeadings(joinCrew);
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
      {
        file: "plugins/crew/skills/join-crew/SKILL.md",
        title: "Path 2 — migrate the Crew workspace, then activate members",
      },
    ],
    "Operational onboarding skills must expose exactly Path 1 and Path 2, with no third top-level path heading.",
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
  const entranceB = findHeading(firstRunHeadings, 3, "Entrance B — existing V1 Desk");
  assert.ok(entranceB, "Path 1 must define Entrance B");
  const entranceBText = sectionText(firstRun, firstRunHeadings, entranceB);
  assertOrderedPhrases(entranceBText, "Entrance B", [
    "1. Detect and inventory",
    "2. Record rollback evidence",
    "3. Preserve the same workspace",
    "4. Replace V1 declarations",
    "5. Reconcile retired V1-only capabilities",
    "6. Activate and verify V2",
    "7. Resume the existing task or start the first V2 job",
  ]);
  for (const phrase of [
    "workspace and Git state",
    "durable task state",
    "rollback ref",
    "reviewed V2 chain",
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

  const path2 = findHeading(joinCrewHeadings, 2, "Path 2 — migrate the Crew workspace, then activate members");
  assert.ok(path2, "join-crew must expose Path 2");
  assert.deepStrictEqual(childHeadingTitles(joinCrew, joinCrewHeadings, path2, 3), PATH_2_HEADINGS);
  const repositoryMigration = findHeading(joinCrewHeadings, 3, "Phase 1 — repository migration");
  assert.ok(repositoryMigration, "Path 2 must begin with repository migration");
  const repositoryMigrationText = sectionText(joinCrew, joinCrewHeadings, repositoryMigration);
  assertOrderedPhrases(repositoryMigrationText, "Crew-v1 repository migration", [
    "1. Detect legacy layout and repository identity",
    "2. Inventory repository state",
    "3. Record rollback evidence",
    "4. Reconcile the V2 layout",
    "5. Reconcile V1-only machinery",
    "6. Declare the reviewed V2 dependency chain",
    "7. Verify preservation and authority",
    "8. Mark repository migration complete",
    "9. Continue directly to existing-member activation",
  ]);
  for (const phrase of [
    "tracked, ignored, and untracked state",
    "desks/<alias>/",
    "_shared/landscape/",
    "_shared/decisions/",
    "Git history",
    "origin",
    "read-across/write-own",
    "conflict-safe shared writes",
    "Only a workspace proven to be current V2",
  ]) {
    assert.match(repositoryMigrationText, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"), `Crew-v1 migration must bind ${phrase}`);
  }
  assert.match(repositoryMigrationText, /do not enter remote or workspace discovery/iu);
  assert.doesNotMatch(repositoryMigrationText, /\bclone\b/iu);

  const joinCrewStep1 = findHeading(joinCrewHeadings, 2, "Step 1: resolve the crew workspace");
  assert.ok(joinCrewStep1, "join-crew must keep Step 1 as the existing-workspace router");
  const joinCrewStep1Text = sectionText(joinCrew, joinCrewHeadings, joinCrewStep1);
  assert.match(joinCrewStep1Text, /legacy Crew-v1 local workspace/iu);
  assert.match(joinCrewStep1Text, /Phase 1 repository migration/iu);
  assert.match(joinCrewStep1Text, /current V2 layout/iu);
  assert.match(joinCrewStep1Text, /session-start sync\s+and\s+scan/iu);
  assert.match(joinCrewStep1Text, /do not continue to Step 2/iu);

  const step2 = findHeading(sessionStartHeadings, 2, "Step 2 — Workspace sync");
  assert.ok(step2, "session-start must keep Step 2 as the existing-workspace router");
  assert.deepStrictEqual(childHeadingTitles(sessionStart, sessionStartHeadings, step2, 3), ["Existing-workspace V1 upgrade branch"]);
  const step2Text = sectionText(sessionStart, sessionStartHeadings, step2);
  assert.equal((step2Text.match(/first-run-bootstrap/gu) ?? []).length, 2);
  const existingWorkspaceUpgrade = findHeading(sessionStartHeadings, 3, "Existing-workspace V1 upgrade branch");
  assert.ok(existingWorkspaceUpgrade, "session-start must route existing V1 workspaces explicitly");
  const existingWorkspaceUpgradeText = sectionText(sessionStart, sessionStartHeadings, existingWorkspaceUpgrade);
  assert.match(existingWorkspaceUpgradeText, /Entrance B/iu);
  assert.match(existingWorkspaceUpgradeText, /same workspace/iu);

  assert.match(sessionStartMigrations, /before any path-dependent startup scans/iu);
  assert.match(sessionStartMigrations, /completed onboarding is not replayed during normal resumption/iu);

  console.log("V2 onboarding path contract passed.");
}

main();
