#!/usr/bin/env node
"use strict";

// Hosts pick up plugin changes differently. Agency refreshes by bytes: it
// re-resolves a branch ref and fetches when the commit changes. Native Claude
// Code refreshes by version string: an unchanged version is never updated,
// whatever changed underneath. To serve both, every change to a plugin's
// files ships with a version bump, and every manifest agrees on the version.
//
// A plugin whose base has a changelog.d/ folder (Desk) is released on main
// instead: a pull request that changes it adds a changelog fragment there and
// leaves its version alone, and the release workflow bumps every surface and
// folds the fragments into the changelog after the merge
// (scripts/release-desk.cjs). Parallel pull requests then never conflict on
// the version or the changelog.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fragmentProblem } = require("./release-desk.cjs");

const VERSIONED_MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "agency.json"];
const MARKETPLACE = ".claude-plugin/marketplace.json";
const FRAGMENT_DIR = "changelog.d";
const FRAGMENT_README = "README.md";

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(String(version));
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split(".") : [] };
}

// Semantic-version precedence: a release outranks its prereleases, and
// numeric prerelease identifiers compare numerically (alpha.10 > alpha.9).
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/u.test(x) && /^\d+$/u.test(y);
    if (x !== y) return numeric ? Number(x) - Number(y) : x < y ? -1 : 1;
  }
  return 0;
}

// Node's default `maxBuffer` is 1 MiB, and a pull request that adds a large tree (a committed node_modules, say) lists
// more file names than that, so `git diff --name-only` died with ENOBUFS, a failure about output size and not about
// versions. 512 MiB is far beyond any real diff; if even that is exceeded, say so instead of a bare ENOBUFS.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

function defaultGit(repoRoot, maxBuffer = GIT_MAX_BUFFER) {
  return (args) => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer });
    } catch (error) {
      if (error?.code === "ENOBUFS") {
        throw new Error(`git ${args.join(" ")} printed more than ${maxBuffer} bytes, which is more than this release check will read; the pull request changes an implausibly large number of files`, { cause: error });
      }
      throw error;
    }
  };
}

function readJsonAt({ git, ref, file, repoRoot }) {
  try {
    const text = ref === null ? fs.readFileSync(path.join(repoRoot, file), "utf8") : git(["show", `${ref}:${file}`]);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function existsAt({ git, ref, file }) {
  try {
    git(["cat-file", "-e", `${ref}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

function checkReleaseIntegrity({ repoRoot = process.cwd(), base = null, git = defaultGit(repoRoot) } = {}) {
  const problems = [];
  const marketplace = readJsonAt({ git, ref: null, file: MARKETPLACE, repoRoot });
  for (const entry of marketplace.plugins) {
    const dir = path.posix.normalize(entry.source.replace(/^\.\//u, ""));
    const versions = { [`${MARKETPLACE} ${entry.name} entry`]: entry.version };
    for (const manifest of VERSIONED_MANIFESTS) {
      const json = readJsonAt({ git, ref: null, file: `${dir}/${manifest}`, repoRoot });
      if (json?.version !== undefined) versions[`${dir}/${manifest}`] = json.version;
    }
    const distinct = [...new Set(Object.values(versions))];
    if (distinct.length > 1) {
      problems.push(`${entry.name}: manifests disagree on the version (${Object.entries(versions).map(([file, version]) => `${file}=${version}`).join(", ")})`);
      continue;
    }
    if (base === null) continue;
    // Tests do not change what users run, so they need no release.
    const changed = git(["diff", "--name-only", `${base}...HEAD`, "--", dir])
      .split("\n")
      .filter((file) => file !== "" && !/(^|\/)__tests__\//u.test(file));
    if (changed.length === 0) continue;
    const baseVersion = readJsonAt({ git, ref: base, file: `${dir}/.claude-plugin/plugin.json`, repoRoot })?.version;
    if (baseVersion === undefined) continue;
    const [version] = distinct;
    // The rule in force is the base's: the pull request that introduces changelog.d/ still releases the old way.
    if (existsAt({ git, ref: base, file: `${dir}/${FRAGMENT_DIR}` })) {
      problems.push(...checkFragmentRelease({ git, repoRoot, base, dir, name: entry.name, version }));
      continue;
    }
    if (parseVersion(version) === null || compareVersions(version, baseVersion) <= 0) {
      problems.push(`${entry.name}: files under ${dir}/ changed since ${base} but its version ${version} is not above ${baseVersion}; bump it in every manifest and the marketplace entry, and add a changelog entry`);
    }
  }
  return problems;
}

// A fragment-released plugin keeps the version its branch started from, and the pull request adds at least one
// fragment the release will accept (release-desk.cjs fragmentProblem, the one definition both sides use). Every other
// path the pull request adds under changelog.d/ must be a valid fragment too, because the release would otherwise fail
// on it or leave it behind. Pending fragments belong to other merged changes: only the release removes them. The
// version and the diffs are read from where the branch left the base, so a branch that is merely behind a release on
// main is not blamed for it.
function checkFragmentRelease({ git, repoRoot, base, dir, name, version }) {
  const problems = [];
  const forkPoint = git(["merge-base", base, "HEAD"]).trim();
  const forkVersion = readJsonAt({ git, ref: forkPoint, file: `${dir}/.claude-plugin/plugin.json`, repoRoot })?.version;
  if (version !== forkVersion) {
    problems.push(`${name}: its version changed from ${forkVersion} to ${version}, but ${dir}/ is released from changelog fragments; leave every version surface alone, and the release workflow assigns the next version after the merge`);
  }
  const fragmentDir = `${dir}/${FRAGMENT_DIR}`;
  const readme = `${fragmentDir}/${FRAGMENT_README}`;
  const changed = (filter) => git(["diff", "--name-only", "--no-renames", `--diff-filter=${filter}`, `${base}...HEAD`, "--", `${fragmentDir}/`])
    .split("\n")
    .filter((file) => file !== "" && file !== readme);
  const added = changed("A");
  const invalid = added.map((file) => fragmentProblem(repoRoot, file, fragmentDir)).filter(Boolean);
  problems.push(...invalid.map((problem) => `${name}: ${problem}`));
  // An invalid fragment already says what to fix; the generic request is only for a pull request that added none.
  if (added.length === 0) {
    problems.push(`${name}: files under ${dir}/ changed since ${base}; add a changelog fragment, ${fragmentDir}/<short-slug>.md, that says what changed`);
  }
  for (const file of changed("DM")) {
    problems.push(`${name}: ${file} is a pending fragment from another merged change; leave it alone, because only the release removes fragments when it folds them into the changelog`);
  }
  return problems;
}

function resolveBase(env) {
  if (env.DESK_RELEASE_BASE) return env.DESK_RELEASE_BASE;
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`;
  return null;
}

function runCli({ repoRoot = process.cwd(), env = process.env, git, log = console.log, error = console.error } = {}) {
  const base = resolveBase(env);
  const problems = checkReleaseIntegrity({ repoRoot, base, ...(git ? { git } : {}) });
  if (problems.length > 0) {
    error(`Release integrity failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    return 1;
  }
  log(base === null
    ? "Plugin manifests agree on their versions (no base ref, so bumps were not checked)."
    : `Plugin manifests agree, and every plugin changed since ${base} has a higher version.`);
  return 0;
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = { checkReleaseIntegrity, defaultGit, compareVersions, parseVersion, resolveBase, runCli };
