#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const {
  SUPERPOWERS_VERSION_FILES,
  chooseSuperpowersVersion,
  main,
  refresh: refreshSource,
  upstreamVersion,
  versionToken,
} = require("./refresh-superpowers.cjs");
const { DESK_VERSION_FILES, FRAGMENT_DIR, nextAlpha, nextReleaseVersion, replaceVersion } = require("./release-desk.cjs");
const hookCompat = require("./superpowers-hook-compat.cjs");

const repoRoot = path.resolve(__dirname, "..");
const readRepoJson = (file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
const currentSuperpowers = readRepoJson("plugins/superpowers/.claude-plugin/plugin.json").version;
const currentDesk = readRepoJson("plugins/desk/.claude-plugin/plugin.json").version;
const lock = readRepoJson("upstream-sources.lock.json");
const superpowersSource = lock.sources.find((source) => source.id === "obra-superpowers");

function refresh(options) {
  const created = [];
  const original = fs.mkdtempSync;
  const originalMkdir = fs.mkdirSync;
  const makeTemp = (...args) => {
    const root = original(...args);
    created.push(root);
    return root;
  };
  const requestedMkdir = options.io?.mkdirSync ?? originalMkdir;
  const makeDirectory = (root, ...args) => {
    const allocation = path.basename(root).startsWith("superpowers-hook-candidate-") || path.basename(root).startsWith(".superpowers-hook-transaction-");
    if (allocation) created.push(root);
    return requestedMkdir(root, ...args);
  };
  fs.mkdtempSync = makeTemp;
  let failure;
  try {
    return refreshSource({ ...options, io: { ...(options.io ?? fs), mkdtempSync: makeTemp, mkdirSync: makeDirectory } });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    fs.mkdtempSync = original;
    for (const root of created) {
      if (failure?.retainedRoots?.includes(root)) {
        assert.equal(fs.existsSync(root), true, `retained recovery root must exist: ${root}`);
        console.log(`Verified retained owned recovery root: ${root}`);
      } else {
        assert.equal(fs.existsSync(root), false, `owned refresh candidate/transaction cleanup: ${root}`);
        console.log(`Verified owned candidate/transaction absence: ${root}`);
      }
    }
  }
}

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);
}

// A release surface names the shipped version; a stated minimum ("3.2.0-alpha.58 or later") is a floor that stays.
function filesNaming(version, files, root = repoRoot) {
  return files.filter((file) => {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    return versionToken(version).test(text.replaceAll(`${version} or later`, ""));
  });
}

// The shipped Superpowers version appears only on these surfaces outside tests and history. The README names the
// upstream version separately, tests derive the shipped version instead of hard-coding it, and changelog fragments,
// including the one each refresh adds, are history the Desk release folds into the changelog.
function superpowersSurfaces(version, files, root = repoRoot) {
  return filesNaming(version, files, root).filter((file) => (
    file !== "plugins/desk/CHANGELOG.md"
    && !file.startsWith(`${FRAGMENT_DIR}/`)
    && file !== "plugins/superpowers/README.md"
    && !file.includes("/__tests__/")
    && !/^scripts\/test-[^/]+\.cjs$/u.test(file)
  )).sort();
}

// ---- Release-surface contracts over the real repository ----

{
  // A Desk release names its version in exactly these files; the changelog keeps history and gains an entry instead.
  // Hand-written test files use their own sample versions, which a later release may coincide with, so they are never
  // release surfaces unless DESK_VERSION_FILES declares them. Generated fixtures stay in the check: one that names the
  // current version and is not declared fails here, in its own PR, instead of after the next release.
  const isTest = (file) => /\.test\.[cm]?js$/u.test(file) || /^scripts\/test-[^/]+\.cjs$/u.test(file);
  const naming = filesNaming(currentDesk, trackedFiles()).filter((file) => (
    file !== "plugins/desk/CHANGELOG.md" && !file.endsWith("package-lock.json") && (!isTest(file) || DESK_VERSION_FILES.includes(file))
  ));
  assert.deepEqual(naming.sort(), [...DESK_VERSION_FILES].sort(), "every surface naming the Desk version must be bumped by the Desk release");

  assert.deepEqual(superpowersSurfaces(currentSuperpowers, trackedFiles()), [...SUPERPOWERS_VERSION_FILES].sort(), "every surface naming the Superpowers version must be bumped by the refresh");
}

{
  // The token matches an exact version, never a range floor or a longer version.
  assert.equal("^6.3.0 ~6.3.0 >=6.3.0 6.3.0.1 6.3.01 v6.3.0x 16.3.0".replace(versionToken("6.3.0"), "X"), "^6.3.0 ~6.3.0 >=6.3.0 6.3.0.1 6.3.01 v6.3.0x 16.3.0");
  assert.equal('"6.3.0", Superpowers 6.3.0 payload, desk@6.3.0'.replace(versionToken("6.3.0"), "X"), '"X", Superpowers X payload, desk@X');
  assert.equal("3.2.0-alpha.4 3.2.0-alpha.49".replace(versionToken("3.2.0-alpha.4"), "X"), "X 3.2.0-alpha.49");
  assert.equal(chooseSuperpowersVersion("6.3.0", "6.4.2"), "6.4.2");
  assert.equal(chooseSuperpowersVersion("6.4.2", "6.4.2"), "6.4.3");
  assert.equal(chooseSuperpowersVersion("6.4.3", "6.4.2"), "6.4.4");
  // A packaging-only release can put the shipped version ahead of upstream; when upstream then reaches it, the refresh still moves up.
  assert.equal(chooseSuperpowersVersion("6.4.3", "6.4.3"), "6.4.4");
  assert.equal(nextAlpha("3.2.0-alpha.9"), "3.2.0-alpha.10");
  assert.throws(() => nextAlpha("3.2.0"), /Desk version 3.2.0 is not an alpha release/u);
}

{
  // The scheduled workflow refreshes from the upstream default branch, then gates the merge on every CI workflow.
  // Monday reruns CI; every other day is a cheap check that reruns CI only when upstream moved.
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/superpowers-upstream.yml"), "utf8");
  const crons = [...workflow.matchAll(/\n {4}- cron: "([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(crons, ["23 7 * * 1", "23 7 * * 0,2-6"]);
  assert.match(workflow, /\n {8}if: steps\.refresh\.outputs\.changed == 'true' && github\.event\.schedule == '23 7 \* \* 0,2-6'\n {8}id: gate\n/u);
  assert.match(workflow, /node scripts\/superpowers-upstream-pr\.cjs pending/u);
  for (const step of ["Commit and push the refresh branch", "Open the pull request, run CI and merge on green"]) {
    assert.match(workflow, new RegExp(`- name: ${step}\\n {8}if: steps\\.refresh\\.outputs\\.changed == 'true' && steps\\.gate\\.outputs\\.rerun != 'false'\\n`, "u"), step);
  }
  // A publish that filed its own issue, or a pending check, is not reported twice.
  assert.match(workflow, /\n {8}id: publish\n/u);
  assert.match(workflow, /if: failure\(\) && steps\.gate\.outcome != 'failure' && steps\.publish\.outputs\.issue == ''\n/u);
  for (const required of [
    /\n {2}schedule:\n {4}- cron: "[^"]+"\n/u,
    /\n {2}workflow_dispatch:\n/u,
    /\npermissions: \{\}\n/u,
    /\n {6}actions: write\n {6}contents: write\n {6}issues: write\n {6}pull-requests: write\n/u,
    /BRANCH: superpowers-upstream/u,
    /node scripts\/refresh-superpowers\.cjs --upstream-dir/u,
    /node scripts\/superpowers-upstream-pr\.cjs publish/u,
    /git clone --quiet --no-checkout "https:\/\/github\.com\/\$UPSTREAM\.git"/u,
    /merge-base --is-ancestor/u,
    /upstream-refresh/u,
  ]) {
    assert.match(workflow, required);
  }
  const dispatched = /CI_WORKFLOWS: ([^\n]+)\n/u.exec(workflow)[1].split(",").sort();
  const gating = fs.readdirSync(path.join(repoRoot, ".github/workflows"))
    .filter((file) => /\n {2}pull_request:/u.test(fs.readFileSync(path.join(repoRoot, ".github/workflows", file), "utf8")))
    .sort();
  assert.deepEqual(dispatched, gating, "the refresh must dispatch every workflow that gates a pull request");
  for (const file of gating) {
    assert.match(fs.readFileSync(path.join(repoRoot, ".github/workflows", file), "utf8"), /\n {2}workflow_dispatch:\n/u, `${file} must accept workflow_dispatch`);
  }
}

// ---- A refresh over a fixture copy of the release surfaces ----

function copyIntoFixture(root, file) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, file), target);
  fs.chmodSync(target, fs.statSync(path.join(repoRoot, file)).mode & 0o777);
}

function buildFixture(tempRoot, deskVersion = currentDesk) {
  const root = path.join(tempRoot, "desk");
  for (const file of new Set([
    ...SUPERPOWERS_VERSION_FILES,
    ...DESK_VERSION_FILES,
    "plugins/desk/CHANGELOG.md",
    "plugins/superpowers/README.md",
    "upstream-sources.lock.json",
    ...hookCompat.OUTPUT_PATHS,
    ...superpowersSource.files.map((file) => file.upstreamPath ?? file.generatedPath),
  ])) {
    copyIntoFixture(root, file);
  }
  if (deskVersion !== currentDesk) replaceVersion(root, DESK_VERSION_FILES, currentDesk, deskVersion);

  // The fixture upstream starts at exactly the vendored payload, with upstream's own manifest version.
  const upstreamDir = path.join(tempRoot, "upstream");
  fs.mkdirSync(upstreamDir);
  git(upstreamDir, "init", "--quiet");
  git(upstreamDir, "config", "user.name", "Fixture");
  git(upstreamDir, "config", "user.email", "fixture@example.invalid");
  git(upstreamDir, "config", "core.autocrlf", "false");
  git(upstreamDir, "config", "commit.gpgsign", "false");
  for (const file of superpowersSource.files) {
    const target = path.join(upstreamDir, file.sourcePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file.upstreamPath ?? file.generatedPath), target);
  }
  const writeManifest = (version) => {
    fs.mkdirSync(path.join(upstreamDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(upstreamDir, ".claude-plugin/plugin.json"), `${JSON.stringify({ name: "superpowers", version })}\n`);
  };
  writeManifest(currentSuperpowers);
  git(upstreamDir, "add", "--all");
  for (const file of superpowersSource.files) {
    const executable = (fs.statSync(path.join(repoRoot, file.upstreamPath ?? file.generatedPath)).mode & 0o111) !== 0;
    git(upstreamDir, "update-index", `--chmod=${executable ? "+" : "-"}x`, file.sourcePath);
  }
  git(upstreamDir, "commit", "--quiet", "--message", "locked payload");
  const base = git(upstreamDir, "rev-parse", "HEAD");
  const lockPath = path.join(root, "upstream-sources.lock.json");
  fs.writeFileSync(lockPath, fs.readFileSync(lockPath, "utf8").replace(superpowersSource.commit, base));
  hookCompat.generate({ root });
  return { root, upstreamDir, base, writeManifest };
}

function commitChange(upstreamDir, message) {
  git(upstreamDir, "add", "--all");
  git(upstreamDir, "commit", "--quiet", "--message", message);
  return git(upstreamDir, "rev-parse", "HEAD");
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
  console.log(`Removed owned refresh fixture: ${root}`);
}

function snapshot(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return files;
}

function readFixture(root, file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

const skillFile = superpowersSource.files.find((file) => file.sourcePath === "skills/using-superpowers/SKILL.md");
const [major, minor] = currentSuperpowers.split(".").map(Number);
const newerUpstream = `${major}.${minor + 1}.0`;

for (const fixtureDeskVersion of new Set([currentDesk, "3.2.0-alpha.9", "3.2.0-rc.7"])) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-"));
  try {
    const { root, upstreamDir, base, writeManifest } = buildFixture(tempRoot, fixtureDeskVersion);

    // Nothing selected changed: no file is touched and no release is cut.
    const before = snapshot(root);
    fs.writeFileSync(path.join(upstreamDir, "README.md"), "an unselected upstream change\n");
    commitChange(upstreamDir, "unselected");
    let output = "";
    assert.equal(main(["--upstream-dir", upstreamDir, "--root", root], {
      stdout: { write(value) { output += value; } },
    }), 0);
    const unchanged = JSON.parse(output);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.release, null);
    assert.deepEqual(snapshot(root), before);

    // Upstream changes a selected skill, adds a script to it and releases a new version.
    fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "\nAn upstream addition.\n");
    fs.writeFileSync(path.join(upstreamDir, "skills/using-superpowers/scripts-new-helper"), "#!/bin/sh\necho helper\n");
    writeManifest(newerUpstream);
    git(upstreamDir, "add", "--all");
    git(upstreamDir, "update-index", "--chmod=+x", "skills/using-superpowers/scripts-new-helper");
    const executableHead = commitChange(upstreamDir, "upstream release");
    const tree = git(upstreamDir, "rev-parse", "HEAD^{tree}");
    const result = refresh({ root, upstream: require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir }) });
    hookCompat.verify({ root });
    assert.equal(result.changed, true);
    assert.equal(result.previous_commit, base);
    assert.equal(result.commit, executableHead);
    assert.deepEqual(result.updated_paths, [skillFile.sourcePath]);
    assert.deepEqual(result.added_paths, ["skills/using-superpowers/scripts-new-helper"]);
    const fragment = `plugins/desk/changelog.d/superpowers-${newerUpstream}.md`;
    // A minor upstream release stays inside Desk's compatibility floor; an upstream without release notes has none to carry.
    assert.deepEqual(result.release, {
      superpowers: { from: currentSuperpowers, to: newerUpstream, upstream: newerUpstream },
      fragment,
      range: null,
      notes: [],
    });

    // The payload is byte-identical to upstream and the lock records it.
    const fixtureLock = JSON.parse(readFixture(root, "upstream-sources.lock.json"));
    const refreshed = fixtureLock.sources.find((source) => source.id === "obra-superpowers");
    assert.equal(refreshed.commit, executableHead);
    for (const file of refreshed.files) {
      const blob = execFileSync("git", ["-C", upstreamDir, "cat-file", "blob", `HEAD:${file.sourcePath}`]);
      assert.equal(Buffer.compare(fs.readFileSync(path.join(root, file.upstreamPath ?? file.generatedPath)), blob), 0, file.sourcePath);
      assert.equal(file.sha256, hash(blob));
    }
    assert.deepEqual(fixtureLock.sources.filter((source) => source.id !== "obra-superpowers"), lock.sources.filter((source) => source.id !== "obra-superpowers"));

    // Every Superpowers surface ships the new version; compatibility ranges are untouched.
    for (const file of SUPERPOWERS_VERSION_FILES) {
      const text = readFixture(root, file);
      assert.doesNotMatch(text, versionToken(currentSuperpowers), file);
      assert.match(text, versionToken(newerUpstream), file);
    }
    assert.equal(JSON.parse(readFixture(root, "plugins/superpowers/.claude-plugin/plugin.json")).version, newerUpstream);
    assert.equal(JSON.parse(readFixture(root, ".claude-plugin/marketplace.json")).plugins.find((plugin) => plugin.name === "superpowers").version, newerUpstream);
    const activation = JSON.parse(readFixture(root, "plugins/desk/activation/desk.activation.json"));
    const declared = activation.dependencies.find((dependency) => dependency.id === "superpowers");
    assert.equal(declared.lock.version, newerUpstream);
    assert.equal(declared.version_range, readRepoJson("plugins/desk/activation/desk.activation.json").dependencies.find((dependency) => dependency.id === "superpowers").version_range);
    assert.deepEqual(JSON.parse(readFixture(root, "plugins/desk/.claude-plugin/plugin.json")).dependencies, readRepoJson("plugins/desk/.claude-plugin/plugin.json").dependencies);
    const readme = readFixture(root, "plugins/superpowers/README.md");
    assert.match(readme, new RegExp(`version ${newerUpstream.replaceAll(".", "\\.")}, commit \`${executableHead}\``, "u"));
    assert.match(readme, new RegExp(`the upstream tree is \`${tree}\``, "u"));

    // Desk gains a changelog fragment like any other pull request and keeps its version and changelog; the Desk
    // release workflow follows the current alpha/RC line once the refresh merges.
    assert.equal(readFixture(root, fragment), `Superpowers refresh: Desk now ships Superpowers ${newerUpstream}, the selected payload of [obra/superpowers](https://github.com/obra/superpowers/commit/${executableHead}) (upstream version ${newerUpstream}) copied byte for byte. Selected files: 1 changed, 1 added. [upstream-sources.lock.json](../../upstream-sources.lock.json) records every path and SHA-256.\n`);
    for (const file of DESK_VERSION_FILES) {
      const text = readFixture(root, file);
      assert.match(text, versionToken(fixtureDeskVersion), file);
      assert.doesNotMatch(text, versionToken(nextReleaseVersion(fixtureDeskVersion)), file);
    }
    assert.equal(readFixture(root, "plugins/desk/CHANGELOG.md"), fs.readFileSync(path.join(repoRoot, "plugins/desk/CHANGELOG.md"), "utf8"));
    // The refreshed tree passes the repository's own surface contract, fragment included, so the refresh's CI can pass.
    assert.deepEqual(superpowersSurfaces(newerUpstream, Object.keys(snapshot(root)), root), [...SUPERPOWERS_VERSION_FILES].sort());

    // Upstream changes the payload again without a new version: Superpowers takes the next patch and gets its own fragment.
    fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "A second addition.\n");
    fs.rmSync(path.join(upstreamDir, "skills/using-superpowers/scripts-new-helper"));
    const second = commitChange(upstreamDir, "unreleased change");
    fs.mkdirSync(path.join(root, "plugins/desk/skills/fixture-adapter"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugins/desk/skills/fixture-adapter/SKILL.md"), "Run using-superpowers/scripts-new-helper first.\n");
    output = "";
    assert.equal(main(["--upstream-dir", upstreamDir, "--root", root, "--ref", second], {
      stdout: { write(value) { output += value; } },
    }), 0);
    const patch = JSON.parse(output);
    assert.deepEqual(patch.removed_paths, ["skills/using-superpowers/scripts-new-helper"]);
    // Desk text that still names a removed upstream file is reported, so the pull request says what to fix.
    assert.deepEqual(patch.desk_references, [{ path: "skills/using-superpowers/scripts-new-helper", files: ["plugins/desk/skills/fixture-adapter/SKILL.md"] }]);
    assert.equal(patch.release.superpowers.to, `${major}.${minor + 1}.1`);
    assert.equal(patch.release.fragment, `plugins/desk/changelog.d/superpowers-${major}.${minor + 1}.1.md`);
    assert.match(readFixture(root, patch.release.fragment), /Selected files: 1 changed, 1 removed\./u);
    assert.equal(JSON.parse(readFixture(root, "plugins/desk/.claude-plugin/plugin.json")).version, fixtureDeskVersion);
  } finally {
    removeFixture(tempRoot);
  }
}

// A major upstream release moves Desk's compatibility floor with it, so CI qualifies Desk against the new major
// instead of failing every refresh, and carries upstream's notes for each version since the one Desk shipped.
{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-major-"));
  try {
    const { root, upstreamDir, writeManifest } = buildFixture(tempRoot);
    const shippedUpstream = /version (\S+), commit `/u.exec(readFixture(root, "plugins/superpowers/README.md"))[1];
    const nextMajor = `${major + 1}.0.1`;
    const rangeFiles = ["plugins/desk/.claude-plugin/plugin.json", "plugins/desk/activation/desk.activation.json"];
    const floor = readRepoJson("plugins/desk/activation/desk.activation.json").dependencies.find((dependency) => dependency.id === "superpowers").version_range;
    const originals = Object.fromEntries(rangeFiles.map((file) => [file, readFixture(root, file)]));
    fs.writeFileSync(path.join(upstreamDir, "RELEASE-NOTES.md"), [
      "# Superpowers Release Notes",
      "",
      `## v${nextMajor} (2026-11-03)`,
      "",
      "Fewer questions.",
      "",
      "### Hooks",
      "",
      "- A hook fix.",
      "",
      `## v${major + 1}.0.0 (2026-10-09)`,
      "",
      "Rebuilt from scratch.",
      "",
      `## v${shippedUpstream} (2026-09-25)`,
      "",
      "Already shipped.",
      "",
    ].join("\n"));
    fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "\nA major addition.\n");
    writeManifest(nextMajor);
    commitChange(upstreamDir, "major release");
    const result = refresh({ root, upstream: require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir }) });
    hookCompat.verify({ root });
    assert.deepEqual(result.release.range, { from: floor, to: `^${nextMajor}`, files: rangeFiles });
    assert.deepEqual(result.release.notes, [
      { version: nextMajor, heading: `v${nextMajor} (2026-11-03)`, body: "Fewer questions.\n\n### Hooks\n\n- A hook fix." },
      { version: `${major + 1}.0.0`, heading: `v${major + 1}.0.0 (2026-10-09)`, body: "Rebuilt from scratch." },
    ]);
    // Only the floor and the shipped version change in each file; its formatting is kept.
    for (const file of rangeFiles) {
      const expected = originals[file].replace(versionToken(currentSuperpowers), nextMajor).replace(`"${floor}"`, `"^${nextMajor}"`);
      assert.equal(readFixture(root, file), expected, file);
    }
    assert.equal(JSON.parse(readFixture(root, "plugins/desk/.claude-plugin/plugin.json")).dependencies.find((dependency) => dependency.name === "superpowers").version, `^${nextMajor}`);
  } finally {
    removeFixture(tempRoot);
  }
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-compat-"));
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    const upstream = () => require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir });
    const sibling = path.join(root, "plugins/superpowers/hooks/run-hook-unix");
    fs.writeFileSync(sibling, "stale downstream bytes\n");
    const before = snapshot(root);
    assert.throws(() => refresh({ root, upstream: upstream() }), /run-hook-unix.*drift/u);
    assert.deepEqual(snapshot(root), before, "a no-change refresh must not repair or write through a freshness failure");
    hookCompat.generate({ root });

    const hook = path.join(upstreamDir, "hooks/run-hook.cmd");
    const original = fs.readFileSync(hook, "utf8");
    const changed = original.replace("where bash >nul 2>nul", 'for /f "delims=" %%B in (\'where bash\') do set "BASH_EXE=%%B"\nwhere bash >nul 2>nul');
    fs.writeFileSync(hook, changed);
    commitChange(upstreamDir, "fixture batch apostrophe");
    const rawPath = path.join(root, "plugins/superpowers/hooks/upstream/run-hook.cmd");
    const rawBefore = fs.readFileSync(rawPath);
    fs.writeFileSync(rawPath, "distinct current raw drift\n");
    const drifted = snapshot(root);
    assert.throws(() => refresh({ root, upstream: upstream() }), /raw.*SHA-256/u);
    assert.deepEqual(snapshot(root), drifted, "current raw drift must not be overwritten by incoming valid bytes");
    fs.writeFileSync(rawPath, rawBefore);

    const beforeRefusal = snapshot(root);
    const failingRead = { ...fs, readFileSync(file, ...args) {
      if (file === sibling) throw Object.assign(new Error("injected unreadable destination"), { code: "EACCES" });
      return fs.readFileSync(file, ...args);
    } };
    assert.throws(() => refresh({ root, upstream: upstream(), io: failingRead }), /unreadable destination/u);
    assert.deepEqual(snapshot(root), beforeRefusal, "incoming refresh must read every existing destination before writing raw/lock");
    if (process.platform !== "win32") {
      const bytes = fs.readFileSync(sibling);
      fs.unlinkSync(sibling);
      fs.symlinkSync(path.join(tempRoot, "missing-forbidden-target"), sibling);
      assert.throws(() => refresh({ root, upstream: upstream() }), /regular output/u);
      assert.equal(fs.lstatSync(sibling).isSymbolicLink(), true);
      assert.deepEqual(fs.readFileSync(rawPath), rawBefore);
      assert.equal(fs.existsSync(path.join(tempRoot, "missing-forbidden-target")), false);
      fs.unlinkSync(sibling);
      fs.writeFileSync(sibling, bytes);
      assert.deepEqual(snapshot(root), beforeRefusal);
    }
    let publishFailed = false;
    const failingPublish = { ...fs, renameSync(from, to) {
      if (!publishFailed && to === path.join(root, "plugins/superpowers/hooks/run-hook-compat.provenance.json")) {
        publishFailed = true;
        throw new Error("injected refresh publish failure");
      }
      return fs.renameSync(from, to);
    } };
    assert.throws(() => refresh({ root, upstream: upstream(), io: failingPublish }), (error) => {
      assert.equal(error.recoveryStatus, "restored");
      return true;
    });
    assert.deepEqual(snapshot(root), beforeRefusal, "late refresh failure must restore raw/lock/artifacts/versions together");
    const refreshed = refresh({ root, upstream: upstream() });
    assert.equal(refreshed.changed, true);
    assert.notEqual(refreshed.release, null, "retry must publish the skipped release, not strand it in verify-only");
    hookCompat.verify({ root });
    assert.equal(fs.readFileSync(rawPath, "utf8"), changed);
    assert.ok(fs.readFileSync(path.join(root, "plugins/superpowers/hooks/run-hook.cmd"), "utf8").includes("('where bash')"));
    const stable = snapshot(root);
    assert.equal(refresh({ root, upstream: upstream() }).changed, false);
    assert.deepEqual(snapshot(root), stable);

    fs.writeFileSync(hook, "unknown future raw hook layout\n");
    commitChange(upstreamDir, "fixture unknown layout");
    const prior = snapshot(root);
    assert.throws(() => refresh({ root, upstream: upstream() }), /layout/u);
    assert.deepEqual(snapshot(root), prior, "unknown input must fail before modifying the raw payload or release surfaces");
  } finally {
    removeFixture(tempRoot);
  }
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-v3-nested-"));
  let retainedCandidate;
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    const hook = path.join(upstreamDir, "hooks/run-hook.cmd");
    fs.writeFileSync(hook, fs.readFileSync(hook, "utf8").replace("REM Try Git", "REM Updated Git"));
    commitChange(upstreamDir, "fixture nested UNKNOWN input");
    const upstream = require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir });
    const before = snapshot(root);
    const io = { ...fs, renameSync(from, to) {
      if (to.includes("superpowers-hook-candidate-") && to.endsWith("run-hook-compat.provenance.json")) {
        fs.writeFileSync(path.join(path.dirname(to), "run-hook.cmd"), "foreign nested candidate\n");
        throw new Error("nested candidate publication failure");
      }
      return fs.renameSync(from, to);
    } };
    assert.throws(() => refresh({ root, upstream, io }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN");
      retainedCandidate = error.candidateCleanupPath;
      assert.equal(fs.existsSync(retainedCandidate), true);
      assert.equal(fs.existsSync(path.join(error.recoveryPath, "before-0")), true);
      assert.equal(error.candidateRecoveryState.nested_recovery.status, "UNKNOWN");
      assert.equal(fs.existsSync(error.consumerGuardPath), true);
      assert.throws(() => refresh({ root, upstream }), /unresolved transaction/u);
      return true;
    });
    for (const [file, text] of Object.entries(before)) assert.equal(readFixture(root, file), text);
  } finally {
    if (retainedCandidate) removeFixture(retainedCandidate);
    removeFixture(tempRoot);
  }
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-v3-cleanup-"));
  let retainedCandidate;
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "\nIncoming cleanup fixture.\n");
    commitChange(upstreamDir, "fixture candidate cleanup fault");
    const upstream = require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir });
    const io = { ...fs, rmSync(file, ...args) {
      if (path.basename(file).startsWith("superpowers-hook-candidate-")) throw new Error("candidate cleanup IO failure");
      return fs.rmSync(file, ...args);
    } };
    assert.throws(() => refresh({ root, upstream, io }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN");
      retainedCandidate = error.candidateCleanupPath;
      assert.equal(fs.existsSync(retainedCandidate), true);
      assert.equal(fs.existsSync(error.consumerGuardPath), true);
      assert.equal(error.candidateRecoveryState.unresolved.some((entry) => entry.reason === "candidate cleanup IO failure"), true);
      assert.throws(() => refresh({ root, upstream }), /unresolved transaction/u);
      return true;
    });
  } finally {
    if (retainedCandidate) removeFixture(retainedCandidate);
    removeFixture(tempRoot);
  }
}

for (const fault of ["missing", "changed-journal", "rearm-failure"]) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-v4-guard-"));
  let retainedCandidate;
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "\nGuard fixture input.\n");
    commitChange(upstreamDir, "fixture guard fault");
    const upstream = require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir });
    const before = snapshot(root);
    let removedGuard = false;
    const io = { ...fs, renameSync(from, file) {
      if (file.includes("superpowers-hook-candidate-") && file.endsWith("run-hook-compat.provenance.json") && !removedGuard) {
        const guard = fs.readdirSync(root).find((entry) => entry.startsWith(".superpowers-hook-transaction-guard-"));
        if (fault === "changed-journal") fs.writeFileSync(path.join(root, guard, "journal.json"), "foreign journal\n");
        else fs.rmSync(path.join(root, guard), { recursive: true });
        removedGuard = true;
      }
      return fs.renameSync(from, file);
    }, mkdirSync(file, ...args) {
      if (fault === "rearm-failure" && removedGuard && path.basename(file).startsWith(".superpowers-hook-transaction-guard-")) {
        throw new Error("guard rearm allocation refused");
      }
      return fs.mkdirSync(file, ...args);
    } };
    assert.throws(() => refresh({ root, upstream, io }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN");
      retainedCandidate = error.candidateCleanupPath;
      if (fault === "rearm-failure") {
        assert.equal(error.retryBlockingEstablished, false);
        assert.match(error.message, /BLOCKING NOT ESTABLISHED/u);
        assert.match(error.guardCreationError, /guard rearm allocation refused/u);
        assert.equal(error.retainedRoots.includes(error.consumerGuardPath), false);
        assert.equal(fs.existsSync(error.consumerGuardPath), false);
      } else {
        assert.equal(error.retryBlockingEstablished, true);
        assert.throws(() => refresh({ root, upstream }), /unresolved transaction/u);
      }
      return true;
    });
    for (const [file, bytes] of Object.entries(before)) assert.equal(readFixture(root, file), bytes, "guard refusal precedes consumer writes");
  } finally {
    if (retainedCandidate && fs.existsSync(retainedCandidate)) removeFixture(retainedCandidate);
    removeFixture(tempRoot);
  }
}

for (const fault of ["mkdir-after-effect", "identity-read"]) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-v4-allocation-"));
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    const upstream = require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir });
    const before = snapshot(root);
    let allocation;
    const io = { ...fs, mkdirSync(file, ...args) {
      fs.mkdirSync(file, ...args);
      if (path.basename(file).startsWith(".superpowers-hook-transaction-guard-")) {
        allocation = file;
        if (fault === "mkdir-after-effect") throw new Error("guard mkdir completed before failure");
      }
    }, lstatSync(file, ...args) {
      if (file === allocation && fault === "identity-read") throw new Error("guard initial identity read failed");
      return fs.lstatSync(file, ...args);
    } };
    assert.throws(() => refresh({ root, upstream, io }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN");
      assert.equal(error.consumerGuardPath, allocation);
      assert.equal(error.candidateRecoveryState.guardAllocation.status, "creation-attempted");
      assert.ok(error.candidateRecoveryState.beforeImages.length > 0);
      assert.equal(error.retainedRoots.includes(allocation), true);
      return true;
    });
    for (const [file, bytes] of Object.entries(before)) assert.equal(readFixture(root, file), bytes);
  } finally {
    removeFixture(tempRoot);
  }
}

for (const fault of ["journal", "directory"]) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-v5-transition-"));
  let retainedCandidate;
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    const before = snapshot(root);
    let altered = false;
    let foreignGuard;
    const io = { ...fs, mkdirSync(file, ...args) {
      fs.mkdirSync(file, ...args);
      if (!altered && path.basename(file).startsWith("superpowers-hook-candidate-")) {
        foreignGuard = path.join(root, fs.readdirSync(root).find((name) => name.startsWith(".superpowers-hook-transaction-guard-")));
        if (fault === "directory") {
          fs.rmSync(foreignGuard, { recursive: true });
          fs.mkdirSync(foreignGuard);
        }
        fs.writeFileSync(path.join(foreignGuard, "journal.json"), "foreign guard transition content\n");
        altered = true;
      }
    } };
    assert.throws(() => refresh({ root,
      upstream: require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir }), io }), (error) => {
      retainedCandidate = error.candidateCleanupPath;
      assert.equal(readFixture(root, path.relative(root, path.join(foreignGuard, "journal.json"))), "foreign guard transition content\n");
      assert.equal(error.recoveryStatus, "UNKNOWN");
      return true;
    });
    for (const [file, bytes] of Object.entries(before)) assert.equal(readFixture(root, file), bytes);
  } finally {
    if (retainedCandidate && fs.existsSync(retainedCandidate)) removeFixture(retainedCandidate);
    removeFixture(tempRoot);
  }
}

for (const alias of ["symlink", "hardlink", "regular-replacement"]) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-v6-journal-"));
  let retainedCandidate;
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    const before = snapshot(root);
    let outside;
    let originalBytes;
    const io = { ...fs, mkdirSync(file, ...args) {
      fs.mkdirSync(file, ...args);
      if (!outside && path.basename(file).startsWith("superpowers-hook-candidate-")) {
        const guard = path.join(root, fs.readdirSync(root).find((name) => name.startsWith(".superpowers-hook-transaction-guard-")));
        const journal = path.join(guard, "journal.json");
        outside = path.join(tempRoot, "outside-journal");
        originalBytes = fs.readFileSync(journal);
        if (alias === "regular-replacement") {
          fs.renameSync(journal, outside);
          fs.writeFileSync(journal, originalBytes);
        } else {
          fs.renameSync(journal, outside);
          if (alias === "symlink") fs.symlinkSync(outside, journal);
          else fs.linkSync(outside, journal);
        }
      }
    } };
    assert.throws(() => refresh({ root,
      upstream: require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir }), io }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN");
      retainedCandidate = error.candidateCleanupPath;
      assert.deepEqual(fs.readFileSync(outside), originalBytes, "outside original journal must not be overwritten");
      const journal = path.join(error.consumerGuardPath, "journal.json");
      assert.deepEqual(fs.readFileSync(journal), originalBytes, "substituted journal stays unchanged");
      if (alias === "symlink") assert.equal(fs.lstatSync(journal).isSymbolicLink(), true);
      if (alias === "hardlink") assert.equal(fs.lstatSync(journal).nlink, 2);
      return true;
    });
    for (const [file, bytes] of Object.entries(before)) assert.equal(readFixture(root, file), bytes);
  } finally {
    if (retainedCandidate && fs.existsSync(retainedCandidate)) removeFixture(retainedCandidate);
    removeFixture(tempRoot);
  }
}

for (const changedPath of [
  "plugins/superpowers/hooks/upstream/run-hook.cmd",
  "plugins/superpowers/hooks/run-hook.cmd",
  "plugins/superpowers/plugin.json",
]) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-nochange-map-"));
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    const before = snapshot(root);
    let injected = false;
    const upstream = require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir });
    const read = upstream.read;
    upstream.read = (sourcePath) => {
      // First read is the incoming layout preflight; the second is in the prepared candidate updater.
      if (sourcePath === "hooks/run-hook.cmd") {
        upstream.hookReads = (upstream.hookReads ?? 0) + 1;
        if (upstream.hookReads === 2) {
          fs.writeFileSync(path.join(root, changedPath), "foreign no-change consumer content\n");
          injected = true;
        }
      }
      return read(sourcePath);
    };
    assert.throws(() => refresh({ root, upstream }), /concurrent|changed|diverged/u);
    assert.equal(injected, true);
    assert.equal(readFixture(root, changedPath), "foreign no-change consumer content\n");
    for (const [file, bytes] of Object.entries(before)) {
      if (path.normalize(file) !== path.normalize(changedPath)) {
        assert.equal(readFixture(root, file), bytes, "refusal leaves every other consumer file unchanged");
      }
    }
  } finally {
    removeFixture(tempRoot);
  }
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-nochange-cleanup-map-"));
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    const changedPath = "plugins/superpowers/hooks/run-hook.cmd";
    const io = { ...fs, rmSync(file, ...args) {
      const result = fs.rmSync(file, ...args);
      if (path.basename(file).startsWith("superpowers-hook-candidate-")) {
        fs.writeFileSync(path.join(root, changedPath), "foreign edit during candidate disposal\n");
      }
      return result;
    } };
    assert.throws(() => refresh({ root,
      upstream: require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir }), io }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN");
      assert.equal(readFixture(root, changedPath), "foreign edit during candidate disposal\n");
      assert.equal(fs.existsSync(error.consumerGuardPath), true);
      return true;
    });
  } finally {
    removeFixture(tempRoot);
  }
}

{
  // A stale surface list or a reworded README stops the release loudly.
  for (const [breakFixture, pattern] of [
    [(root) => fs.writeFileSync(path.join(root, "plugins/superpowers/plugin.json"), "{}\n"), /plugins\/superpowers\/plugin\.json does not name version .*; the release surface list is stale/u],
    [(root) => fs.writeFileSync(path.join(root, "plugins/superpowers/README.md"), "# Superpowers provider\n"), /README\.md no longer states the upstream version, commit and tree/u],
  ]) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-stale-"));
    try {
      const { root, upstreamDir } = buildFixture(tempRoot);
      fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "\nChanged.\n");
      commitChange(upstreamDir, "change");
      breakFixture(root);
      assert.throws(() => main(["--upstream-dir", upstreamDir, "--root", root], { stdout: { write() {} } }), pattern);
    } finally {
      removeFixture(tempRoot);
    }
  }
}

{
  // Upstream's version comes from its Claude manifest, then package.json; without either the refresh stops.
  const upstream = (files) => ({
    entries: new Map(Object.keys(files).map((file) => [file, {}])),
    read: (file) => Buffer.from(JSON.stringify(files[file])),
  });
  assert.equal(upstreamVersion(upstream({ ".claude-plugin/plugin.json": { version: "7.1.0" } })), "7.1.0");
  assert.equal(upstreamVersion(upstream({ ".claude-plugin/plugin.json": { version: "latest" }, "package.json": { version: "7.2.0" } })), "7.2.0");
  assert.equal(upstreamVersion(upstream({ "package.json": { version: "7.3.0" } })), "7.3.0");
  assert.throws(() => upstreamVersion(upstream({})), /upstream declares no semantic version/u);
}

{
  for (const [argv, pattern] of [
    [[], /--upstream-dir <git checkout of obra\/superpowers> is required/u],
    [["--upstream-dir"], /unknown or incomplete argument: --upstream-dir/u],
    [["--bogus", "x"], /unknown or incomplete argument: --bogus/u],
    [["--upstream-dir", ".", "--desk-version", "3.2.0-alpha.9"], /unknown or incomplete argument: --desk-version/u],
  ]) {
    assert.throws(() => main(argv, { stdout: { write() {} } }), pattern);
  }
  const cli = spawnSync(process.execPath, [path.join(__dirname, "refresh-superpowers.cjs")], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /--upstream-dir <git checkout of obra\/superpowers> is required/u);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-cli-"));
  try {
    const { root, upstreamDir } = buildFixture(tempRoot);
    const success = spawnSync(process.execPath, [path.join(__dirname, "refresh-superpowers.cjs"), "--upstream-dir", upstreamDir, "--root", root], { encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).changed, false);
  } finally {
    removeFixture(tempRoot);
  }
}

console.log("Superpowers refresh tests passed.");
