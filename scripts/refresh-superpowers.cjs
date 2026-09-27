#!/usr/bin/env node
"use strict";

// Refreshes the vendored Superpowers payload from an upstream Git checkout and, when any selected byte changed,
// releases it: Superpowers takes upstream's declared version (or the next patch when upstream changed the payload
// without a new version) on every surface that names it, and Desk gains a changelog fragment, like any other pull
// request, from which the release workflow takes Desk's next alpha once the refresh merges. The upstream payload
// itself is never edited; only Ourostack packaging files and release surfaces are.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { compareVersions, parseVersion } = require("./check-release-integrity.cjs");
const { createGitTreeReader, updateSource } = require("./check-upstream-sources.cjs");
const { FRAGMENT_DIR, replaceVersion, versionToken } = require("./release-desk.cjs");

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

const SUPERPOWERS_README = "plugins/superpowers/README.md";

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function nextPatch(version) {
  const { core } = parseVersion(version);
  return `${core[0]}.${core[1]}.${core[2] + 1}`;
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

function fragmentText({ superpowers, upstream, report }) {
  const counts = [
    [report.updated_paths.length, "changed"],
    [report.added_paths.length, "added"],
    [report.removed_paths.length, "removed"],
    [report.mode_changed_paths.length, "with a changed file mode"],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(", ");
  return `Superpowers refresh: Desk now ships Superpowers ${superpowers}, the selected payload of [obra/superpowers](https://github.com/obra/superpowers/commit/${report.commit}) (upstream version ${upstream}) copied byte for byte. Selected files: ${counts}. [upstream-sources.lock.json](../../upstream-sources.lock.json) records every path and SHA-256.\n`;
}

function release({ root, report, upstream }) {
  const currentSuperpowers = readJson(root, "plugins/superpowers/.claude-plugin/plugin.json").version;
  const superpowers = chooseSuperpowersVersion(currentSuperpowers, upstream);
  const fragment = `${FRAGMENT_DIR}/superpowers-${superpowers}.md`;

  replaceVersion(root, SUPERPOWERS_VERSION_FILES, currentSuperpowers, superpowers);
  updateReadme(root, { upstream, commit: report.commit, tree: report.tree });
  fs.mkdirSync(path.join(root, FRAGMENT_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, fragment), fragmentText({ superpowers, upstream, report }));

  return { superpowers: { from: currentSuperpowers, to: superpowers, upstream }, fragment };
}

function refresh({ root, upstream }) {
  const report = updateSource({
    lockPath: path.join(root, "upstream-sources.lock.json"),
    sourceId: SOURCE_ID,
    upstream,
  });
  if (!report.changed) return { ...report, release: null };
  return { ...report, release: release({ root, report, upstream: upstreamVersion(upstream) }) };
}

function parseArgs(argv) {
  const options = { ref: "HEAD", root: path.resolve(__dirname, "..") };
  const values = { "--upstream-dir": "upstreamDir", "--ref": "ref", "--root": "root" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = values[argv[index]];
    if (!key || !argv[index + 1]) throw new Error(`unknown or incomplete argument: ${argv[index]}`);
    options[key] = argv[index + 1];
    index += 1;
  }
  if (!options.upstreamDir) throw new Error("--upstream-dir <git checkout of obra/superpowers> is required");
  return options;
}

function main(argv = process.argv.slice(2), { stdout = process.stdout, run = spawnSync } = {}) {
  const options = parseArgs(argv);
  const upstream = createGitTreeReader({ dir: path.resolve(options.upstreamDir), ref: options.ref, run });
  const result = refresh({ root: path.resolve(options.root), upstream });
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
  SUPERPOWERS_VERSION_FILES,
  chooseSuperpowersVersion,
  main,
  refresh,
  upstreamVersion,
  versionToken,
};
