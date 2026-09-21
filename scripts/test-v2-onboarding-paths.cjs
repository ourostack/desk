#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function main() {
  const firstRun = read("plugins/desk/skills/first-run-bootstrap/SKILL.md");
  const joinCrew = read("plugins/crew/skills/join-crew/SKILL.md");
  const sessionStartMigrations = read("plugins/desk/skills/session-start-migrations/SKILL.md");

  assert.match(firstRun, /new to Desk/i);
  assert.match(firstRun, /existing V1 Desk/i);
  assert.match(firstRun, /same workspace/i);
  assert.match(firstRun, /first real job/i);
  assert.match(firstRun, /Converged endpoint/i);

  assert.match(joinCrew, /migrate.*repository.*before.*member/i);
  assert.match(joinCrew, /existing member/i);
  assert.match(joinCrew, /new member/i);
  assert.match(joinCrew, /preserve.*history/i);
  assert.match(joinCrew, /no parallel/i);

  assert.match(sessionStartMigrations, /before any path-dependent startup scans/i);
  assert.match(sessionStartMigrations, /completed onboarding is not replayed during normal resumption/i);

  assert.doesNotMatch(firstRun + joinCrew, /read the RFC every session/i);

  console.log("V2 onboarding path contract passed.");
}

main();
