#!/usr/bin/env node
"use strict";

// Refreshes the vendored Superpowers payload from an upstream Git checkout and, when any selected byte changed,
// releases it: Superpowers takes upstream's declared version (or the next patch when upstream changed the payload
// without a new version), and Desk takes its next alpha, on every surface a manual release touches. The upstream
// payload itself is never edited; only Ourostack packaging files and release surfaces are.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { compareVersions, parseVersion } = require("./check-release-integrity.cjs");
const { createGitTreeReader, updateSource } = require("./check-upstream-sources.cjs");

const SOURCE_ID = "obra-superpowers";

// Every surface that names the shipped Superpowers version. A caret range such as `^6.3.0` is a compatibility
// floor, not the shipped version, and is left alone.
const SUPERPOWERS_VERSION_FILES = [
  ".claude-plugin/marketplace.json",
  "plugins/superpowers/plugin.json",
  "plugins/superpowers/.claude-plugin/plugin.json",
  "plugins/superpowers/.codex-plugin/plugin.json",
  "plugins/desk/plugin.json",
  "plugins/desk/.codex-plugin/plugin.json",
  "plugins/desk/activation/desk.activation.json",
  "plugins/desk/activation/copilot-root.flattened-bundle.json",
];

// Every surface a Desk release bumps, matching the manual release commits. The changelog gains a new entry instead.
const DESK_VERSION_FILES = [
  ".claude-plugin/marketplace.json",
  "plugins/desk/plugin.json",
  "plugins/desk/.claude-plugin/plugin.json",
  "plugins/desk/.codex-plugin/plugin.json",
  "plugins/desk/agency.json",
  "plugins/desk/activation/desk.activation.json",
  "plugins/desk/activation/copilot-root.flattened-bundle.json",
  "plugins/desk/mcp/__tests__/activation/copilot_packaging.test.js",
  "plugins/desk/mcp/__tests__/release/release_coupling.test.js",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-config.toml",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-instructions.md",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/manual-only/generated-config.toml",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-config.toml",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-instructions.md",
];

const CHANGELOG = "plugins/desk/CHANGELOG.md";
const CHANGELOG_HEADER = "# desk plugin — changelog\n\n";
const RELEASE_COUPLING_TEST = "plugins/desk/mcp/__tests__/release/release_coupling.test.js";
const SUPERPOWERS_README = "plugins/superpowers/README.md";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Matches an exact version token: not part of a range (`^6.3.0`), a longer version (`6.3.0.1`, `alpha.490`) or a word.
function versionToken(version) {
  return new RegExp(`(?<![\\w.^~<>=-])${escapeRegExp(version)}(?![\\w.+-])`, "gu");
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function replaceVersion(root, files, from, to) {
  for (const file of files) {
    const target = path.join(root, file);
    const text = fs.readFileSync(target, "utf8");
    const next = text.replace(versionToken(from), to);
    if (next === text) throw new Error(`${file} does not name version ${from}; the release surface list is stale`);
    fs.writeFileSync(target, next);
  }
}

function nextPatch(version) {
  const { core } = parseVersion(version);
  return `${core[0]}.${core[1]}.${core[2] + 1}`;
}

function nextAlpha(version) {
  const match = /^(\d+\.\d+\.\d+-alpha\.)(\d+)$/u.exec(version);
  if (!match) throw new Error(`Desk version ${version} is not an alpha release`);
  return `${match[1]}${Number(match[2]) + 1}`;
}

function upstreamVersion(upstream) {
  for (const manifest of [".claude-plugin/plugin.json", "package.json"]) {
    if (!upstream.entries.has(manifest)) continue;
    const { version } = JSON.parse(upstream.read(manifest).toString("utf8"));
    if (parseVersion(version)) return version;
  }
  throw new Error("upstream declares no semantic version in .claude-plugin/plugin.json or package.json");
}

function chooseSuperpowersVersion(current, upstream) {
  return compareVersions(upstream, current) > 0 ? upstream : nextPatch(current);
}

function updateReadme(root, { upstream: version, commit, tree }) {
  const target = path.join(root, SUPERPOWERS_README);
  const text = fs.readFileSync(target, "utf8");
  const pattern = /version (\S+), commit `[0-9a-f]{40}`([\s\S]*?)the upstream tree is `[0-9a-f]{40}`/u;
  if (!pattern.test(text)) throw new Error(`${SUPERPOWERS_README} no longer states the upstream version, commit and tree`);
  fs.writeFileSync(target, text.replace(pattern, `version ${version}, commit \`${commit}\`$2the upstream tree is \`${tree}\``));
}

function changelogEntry({ desk, date, superpowers, upstream, report, mcpVersion }) {
  const counts = [
    [report.updated_paths.length, "changed"],
    [report.added_paths.length, "added"],
    [report.removed_paths.length, "removed"],
    [report.mode_changed_paths.length, "with a changed file mode"],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(", ");
  return `## ${desk} — ${date}\n\n`
    + `Superpowers refresh: Desk now ships Superpowers ${superpowers}, the selected payload of [obra/superpowers](https://github.com/obra/superpowers/commit/${report.commit}) (upstream version ${upstream}) copied byte for byte. Selected files: ${counts}. [upstream-sources.lock.json](../../upstream-sources.lock.json) records every path and SHA-256. Ships \`desk-mcp@${mcpVersion}\`; native dependency payload unchanged.\n\n`;
}

function release({ root, report, upstream, date, currentDesk, desk }) {
  const currentSuperpowers = readJson(root, "plugins/superpowers/.claude-plugin/plugin.json").version;
  const superpowers = chooseSuperpowersVersion(currentSuperpowers, upstream);
  const mcpVersion = readJson(root, "plugins/desk/mcp/package.json").version;

  replaceVersion(root, SUPERPOWERS_VERSION_FILES, currentSuperpowers, superpowers);
  updateReadme(root, { upstream, commit: report.commit, tree: report.tree });
  replaceVersion(root, DESK_VERSION_FILES, currentDesk, desk);

  const couplingPath = path.join(root, RELEASE_COUPLING_TEST);
  const coupling = fs.readFileSync(couplingPath, "utf8");
  fs.writeFileSync(couplingPath, coupling.replace(/const expectedReleaseDate = "[^"]*"/u, `const expectedReleaseDate = "${date}"`));

  const changelogPath = path.join(root, CHANGELOG);
  const changelog = fs.readFileSync(changelogPath, "utf8");
  if (!changelog.startsWith(CHANGELOG_HEADER)) throw new Error(`${CHANGELOG} must begin with its title`);
  fs.writeFileSync(changelogPath, CHANGELOG_HEADER
    + changelogEntry({ desk, date, superpowers, upstream, report, mcpVersion })
    + changelog.slice(CHANGELOG_HEADER.length));

  return {
    superpowers: { from: currentSuperpowers, to: superpowers, upstream },
    desk: { from: currentDesk, to: desk },
  };
}

function refresh({ root, upstream, date, deskVersion }) {
  // The Desk version is settled before any file is written, so a bad choice leaves the tree untouched.
  const currentDesk = readJson(root, "plugins/desk/.claude-plugin/plugin.json").version;
  const desk = deskVersion ?? nextAlpha(currentDesk);
  if (parseVersion(desk) === null || compareVersions(desk, currentDesk) <= 0) {
    throw new Error(`Desk version ${desk} must be above ${currentDesk}`);
  }
  const report = updateSource({
    lockPath: path.join(root, "upstream-sources.lock.json"),
    sourceId: SOURCE_ID,
    upstream,
  });
  if (!report.changed) return { ...report, release: null };
  return { ...report, release: release({ root, report, upstream: upstreamVersion(upstream), date, currentDesk, desk }) };
}

function parseArgs(argv) {
  const options = { ref: "HEAD", date: new Date().toISOString().slice(0, 10), deskVersion: null, root: path.resolve(__dirname, "..") };
  const values = { "--upstream-dir": "upstreamDir", "--ref": "ref", "--date": "date", "--desk-version": "deskVersion", "--root": "root" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = values[argv[index]];
    if (!key || !argv[index + 1]) throw new Error(`unknown or incomplete argument: ${argv[index]}`);
    options[key] = argv[index + 1];
    index += 1;
  }
  if (!options.upstreamDir) throw new Error("--upstream-dir <git checkout of obra/superpowers> is required");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.date)) throw new Error(`--date must be YYYY-MM-DD: ${options.date}`);
  return options;
}

function main(argv = process.argv.slice(2), { stdout = process.stdout, run = spawnSync } = {}) {
  const options = parseArgs(argv);
  const upstream = createGitTreeReader({ dir: path.resolve(options.upstreamDir), ref: options.ref, run });
  const result = refresh({ root: path.resolve(options.root), upstream, date: options.date, deskVersion: options.deskVersion });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DESK_VERSION_FILES,
  SUPERPOWERS_VERSION_FILES,
  chooseSuperpowersVersion,
  main,
  nextAlpha,
  refresh,
  upstreamVersion,
  versionToken,
};
