#!/usr/bin/env node
"use strict";

// Plugin dependencies track a release channel branch, never an exact commit
// or a fork. A pinned commit silently freezes every consumer downstream: fixes
// on the channel never reach them, and each pin has to be found and moved by
// hand. Exact commits belong in qualification evidence, not in dependency
// declarations.

const fs = require("node:fs");
const path = require("node:path");

// The branches a dependency may track. No ref means the default branch.
const RELEASE_CHANNELS = ["main"];
// Repositories whose plugins must come from the canonical owner, not a fork.
const CANONICAL_OWNERS = { desk: "ourostack" };
// Repositories whose plugins now live elsewhere, mapped to their new home.
const MOVED_REPOSITORIES = { "ouroboros-skills": "ourostack/desk" };

function parseGithubDependency(spec) {
  const match = /^github:([^/:@]+)\/([^/:@]+)(?::([^@]*))?(?:@(.+))?$/u.exec(spec);
  if (!match) return null;
  return { owner: match[1], repo: match[2], path: match[3] ?? "", ref: match[4] ?? null };
}

function dependencyProblem(spec) {
  if (typeof spec !== "string" || !spec.startsWith("github:")) return null;
  const dependency = parseGithubDependency(spec);
  if (dependency === null) return "is not a github:<owner>/<repo>[:<path>][@<branch>] dependency";
  const movedTo = MOVED_REPOSITORIES[dependency.repo];
  if (movedTo) {
    return `moved to ${movedTo}; use github:${movedTo}${dependency.path ? `:${dependency.path}` : ""}@${RELEASE_CHANNELS[0]}`;
  }
  const canonicalOwner = CANONICAL_OWNERS[dependency.repo];
  if (canonicalOwner && dependency.owner !== canonicalOwner) {
    return `points at a fork (${dependency.owner}); use ${canonicalOwner}/${dependency.repo}`;
  }
  if (dependency.ref === null) return null;
  if (/^[0-9a-f]{7,40}$/iu.test(dependency.ref)) {
    return `pins exact commit ${dependency.ref}; track a release channel (${RELEASE_CHANNELS.join(", ")}) instead`;
  }
  if (!RELEASE_CHANNELS.includes(dependency.ref)) {
    return `tracks ${dependency.ref}, which is not a release channel (${RELEASE_CHANNELS.join(", ")})`;
  }
  return null;
}

function agencyManifests(repoRoot) {
  const pluginsDir = path.join(repoRoot, "plugins");
  return fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("plugins", entry.name, "agency.json"))
    .filter((relative) => fs.existsSync(path.join(repoRoot, relative)));
}

function checkDependencyChannels({ repoRoot = process.cwd() } = {}) {
  const problems = [];
  for (const relative of agencyManifests(repoRoot)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8"));
    for (const spec of manifest.dependencies ?? []) {
      const problem = dependencyProblem(spec);
      if (problem !== null) problems.push(`${relative}: ${spec} ${problem}`);
    }
  }
  return problems;
}

function runCli({ repoRoot = process.cwd(), log = console.log, error = console.error } = {}) {
  const problems = checkDependencyChannels({ repoRoot });
  if (problems.length > 0) {
    error(`Plugin dependencies must track a release channel branch:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    return 1;
  }
  log("Plugin dependencies track release channels.");
  return 0;
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = { CANONICAL_OWNERS, checkDependencyChannels, dependencyProblem, MOVED_REPOSITORIES, parseGithubDependency, RELEASE_CHANNELS, runCli };
