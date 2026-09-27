#!/usr/bin/env node
"use strict";

// Releases Desk from the changelog fragments that merged pull requests left on main. A pull request that changes
// Desk adds one fragment under plugins/desk/changelog.d/ and never touches a version surface, so parallel pull
// requests no longer conflict on the changelog head or on the next free alpha. After a merge, the release workflow
// runs this script on main: it takes the next alpha on every release surface, folds every pending fragment into one
// changelog entry, removes the fragments, and the workflow commits the result back to main. Every merged change
// therefore still ships as a new version.

const fs = require("node:fs");
const path = require("node:path");

const FRAGMENT_DIR = "plugins/desk/changelog.d";
const FRAGMENT_README = "README.md";
const CHANGELOG = "plugins/desk/CHANGELOG.md";
const CHANGELOG_HEADER = "# desk plugin — changelog\n\n";
const RELEASE_COUPLING_TEST = "plugins/desk/mcp/__tests__/release/release_coupling.test.js";
const DESK_MANIFEST = "plugins/desk/.claude-plugin/plugin.json";
const MCP_PACKAGE = "plugins/desk/mcp/package.json";

// Every surface that names the Desk version. The changelog gains a new entry instead.
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Matches an exact version token: not part of a range (`^6.3.0`), a longer version (`6.3.0.1`, `alpha.490`) or a word.
function versionToken(version) {
  return new RegExp(`(?<![\\w.^~<>=-])${escapeRegExp(version)}(?![\\w.+-])`, "gu");
}

// Every surface is read and rewritten in memory first, so a stale surface list changes no file.
function replaceVersion(root, files, from, to) {
  const rewritten = files.map((file) => {
    const target = path.join(root, file);
    const text = fs.readFileSync(target, "utf8");
    const next = text.replace(versionToken(from), to);
    if (next === text) throw new Error(`${file} does not name version ${from}; the release surface list is stale`);
    return [target, next];
  });
  for (const [target, next] of rewritten) fs.writeFileSync(target, next);
}

function nextAlpha(version) {
  const match = /^(\d+\.\d+\.\d+-alpha\.)(\d+)$/u.exec(version);
  if (!match) throw new Error(`Desk version ${version} is not an alpha release`);
  return `${match[1]}${Number(match[2]) + 1}`;
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

/** The fragments waiting for a release, as repository-relative paths in name order. */
function pendingFragments(root) {
  const dir = path.join(root, FRAGMENT_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== FRAGMENT_README)
    .sort()
    .map((name) => `${FRAGMENT_DIR}/${name}`);
}

/**
 * Why a path cannot be released as a changelog fragment, or null when it can. The release and the pull request check
 * (scripts/check-release-integrity.cjs) both use this, so a fragment that passes review is one the release accepts.
 * A fragment is a regular Markdown file directly in its changelog.d/ folder, other than README.md, whose text is not
 * empty and has no `#` or `##` heading, because the release writes the version heading.
 */
function fragmentProblem(root, file, fragmentDir = FRAGMENT_DIR) {
  const name = path.posix.basename(file);
  if (path.posix.dirname(file) !== fragmentDir) return `${file} is not directly in ${fragmentDir}/; the release reads only fragments at the top of that folder`;
  if (!name.endsWith(".md") || name === FRAGMENT_README) return `${file} is not a changelog fragment; a fragment is a Markdown file named after the change`;
  const stat = fs.lstatSync(path.join(root, file), { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return `${file} is not a regular file; a changelog fragment is one Markdown file`;
  const body = fs.readFileSync(path.join(root, file), "utf8").trim();
  if (body === "") return `${file} is empty; a changelog fragment says what changed`;
  if (/^#{1,2} /mu.test(body)) return `${file} has a # or ## heading; the release writes the version heading, so use ### or plain paragraphs`;
  return null;
}

function releaseDesk({ root, date }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`the release date must be YYYY-MM-DD: ${date}`);
  const fragments = pendingFragments(root);
  if (fragments.length === 0) return { released: false, fragments };
  // Everything is read and checked before any file is written, so a bad fragment leaves the tree untouched.
  const bodies = fragments.map((file) => {
    const problem = fragmentProblem(root, file);
    if (problem) throw new Error(problem);
    return fs.readFileSync(path.join(root, file), "utf8").trim();
  });
  const changelogPath = path.join(root, CHANGELOG);
  const changelog = fs.readFileSync(changelogPath, "utf8");
  if (!changelog.startsWith(CHANGELOG_HEADER)) throw new Error(`${CHANGELOG} must begin with its title`);
  const from = readJson(root, DESK_MANIFEST).version;
  const to = nextAlpha(from);
  const mcpVersion = readJson(root, MCP_PACKAGE).version;

  replaceVersion(root, DESK_VERSION_FILES, from, to);
  const couplingPath = path.join(root, RELEASE_COUPLING_TEST);
  const coupling = fs.readFileSync(couplingPath, "utf8");
  fs.writeFileSync(couplingPath, coupling.replace(/const expectedReleaseDate = "[^"]*"/u, `const expectedReleaseDate = "${date}"`));
  fs.writeFileSync(changelogPath, `${CHANGELOG_HEADER}## ${to} — ${date}\n\n${bodies.join("\n\n")}\n\nShips \`desk-mcp@${mcpVersion}\`.\n\n${changelog.slice(CHANGELOG_HEADER.length)}`);
  for (const file of fragments) fs.rmSync(path.join(root, file));
  return { released: true, from, to, fragments };
}

function parseArgs(argv) {
  const options = { date: new Date().toISOString().slice(0, 10), root: path.resolve(__dirname, "..") };
  const values = { "--date": "date", "--root": "root" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = values[argv[index]];
    if (!key || !argv[index + 1]) throw new Error(`unknown or incomplete argument: ${argv[index]}`);
    options[key] = argv[index + 1];
  }
  return options;
}

function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseArgs(argv);
  stdout.write(`${JSON.stringify(releaseDesk({ root: path.resolve(options.root), date: options.date }), null, 2)}\n`);
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
  CHANGELOG,
  CHANGELOG_HEADER,
  DESK_VERSION_FILES,
  FRAGMENT_DIR,
  FRAGMENT_README,
  fragmentProblem,
  main,
  nextAlpha,
  parseArgs,
  pendingFragments,
  releaseDesk,
  replaceVersion,
  versionToken,
};
