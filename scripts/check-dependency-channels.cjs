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
const RELEASE_CHANNELS = ["main", "release"];
// Plugins that ship only through a release, so a dependency on them tracks that channel and nothing else. Desk's release
// workflow moves `release` to each stable release after main's full CI passed; `main` also carries merged, unreleased changes.
const PLUGIN_CHANNELS = { "ourostack/desk:plugins/desk": "release" };
// Repositories whose plugins must come from the canonical owner, not a fork.
const CANONICAL_OWNERS = { desk: "ourostack" };
// Repositories whose plugins now live elsewhere, mapped to their new home.
const MOVED_REPOSITORIES = { "ouroboros-skills": "ourostack/desk" };

function channelFor(key) {
  return Object.hasOwn(PLUGIN_CHANNELS, key) ? PLUGIN_CHANNELS[key] : null;
}

function parseGithubDependency(spec) {
  const match = /^github:([^/:@]+)\/([^/:@]+)(?::([^@]*))?(?:@(.+))?$/u.exec(spec);
  if (!match) return null;
  return { owner: match[1], repo: match[2], path: match[3] ?? "", ref: match[4] ?? null };
}

function dependencyProblem(spec) {
  if (typeof spec !== "string" || !spec.startsWith("github:")) return null;
  const dependency = parseGithubDependency(spec);
  if (dependency === null) return "is not a github:<owner>/<repo>[:<path>][@<branch>] dependency";
  // Own-property lookups only: a repository named like a built-in property
  // (constructor, toString, __proto__) must not match an inherited member.
  const movedTo = Object.hasOwn(MOVED_REPOSITORIES, dependency.repo) ? MOVED_REPOSITORIES[dependency.repo] : null;
  if (movedTo) {
    const channel = channelFor(`${movedTo}:${dependency.path}`) ?? RELEASE_CHANNELS[0];
    return `moved to ${movedTo}; use github:${movedTo}${dependency.path ? `:${dependency.path}` : ""}@${channel}`;
  }
  const canonicalOwner = Object.hasOwn(CANONICAL_OWNERS, dependency.repo) ? CANONICAL_OWNERS[dependency.repo] : null;
  if (canonicalOwner && dependency.owner !== canonicalOwner) {
    return `points at a fork (${dependency.owner}); use ${canonicalOwner}/${dependency.repo}`;
  }
  const required = channelFor(`${dependency.owner}/${dependency.repo}:${dependency.path}`);
  if (dependency.ref !== null && /^[0-9a-f]{7,40}$/iu.test(dependency.ref)) {
    return `pins exact commit ${dependency.ref}; track a release channel (${required ?? RELEASE_CHANNELS[0]}) instead`;
  }
  if (required !== null && dependency.ref !== required) {
    return `tracks ${dependency.ref ?? "the default branch"}; this plugin ships through releases, so track ${required}`;
  }
  if (dependency.ref === null || dependency.ref === required) return null;
  if (RELEASE_CHANNELS.includes(dependency.ref) && dependency.ref !== RELEASE_CHANNELS[0]) {
    return `tracks ${dependency.ref}, which only plugins that ship through releases use; track ${RELEASE_CHANNELS[0]}`;
  }
  if (dependency.ref !== RELEASE_CHANNELS[0]) {
    return `tracks ${dependency.ref}, which is not a release channel (${RELEASE_CHANNELS[0]})`;
  }
  return null;
}

function agencyManifests(repoRoot) {
  const pluginsDir = path.join(repoRoot, "plugins");
  return fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join("plugins", entry.name, "agency.json"))
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

module.exports = { CANONICAL_OWNERS, checkDependencyChannels, dependencyProblem, MOVED_REPOSITORIES, parseGithubDependency, PLUGIN_CHANNELS, RELEASE_CHANNELS, runCli };
