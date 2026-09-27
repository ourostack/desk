#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const {
  DESK_VERSION_FILES,
  SUPERPOWERS_VERSION_FILES,
  chooseSuperpowersVersion,
  main,
  nextAlpha,
  refresh,
  upstreamVersion,
  versionToken,
} = require("./refresh-superpowers.cjs");

const repoRoot = path.resolve(__dirname, "..");
const readRepoJson = (file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
const currentSuperpowers = readRepoJson("plugins/superpowers/.claude-plugin/plugin.json").version;
const currentDesk = readRepoJson("plugins/desk/.claude-plugin/plugin.json").version;
const mcpVersion = readRepoJson("plugins/desk/mcp/package.json").version;
const lock = readRepoJson("upstream-sources.lock.json");
const superpowersSource = lock.sources.find((source) => source.id === "obra-superpowers");

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
function filesNaming(version, files) {
  return files.filter((file) => {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    return versionToken(version).test(text.replaceAll(`${version} or later`, ""));
  });
}

// ---- Release-surface contracts over the real repository ----

{
  // A Desk release names its version in exactly these files; the changelog keeps history and gains an entry instead.
  // Root test scripts use their own fixture versions, which may coincide with the current one.
  const naming = filesNaming(currentDesk, trackedFiles())
    .filter((file) => file !== "plugins/desk/CHANGELOG.md" && !/^scripts\/test-[^/]+\.cjs$/u.test(file));
  assert.deepEqual(naming.sort(), [...DESK_VERSION_FILES].sort(), "every surface naming the Desk version must be bumped by the refresh");

  // The shipped Superpowers version appears only on these surfaces outside tests and history. The README names the
  // upstream version separately, and tests derive the shipped version instead of hard-coding it.
  const shipped = filesNaming(currentSuperpowers, trackedFiles()).filter((file) => (
    file !== "plugins/desk/CHANGELOG.md"
    && file !== "plugins/superpowers/README.md"
    && !file.includes("/__tests__/")
    && !/^scripts\/test-[^/]+\.cjs$/u.test(file)
  ));
  assert.deepEqual(shipped.sort(), [...SUPERPOWERS_VERSION_FILES].sort(), "every surface naming the Superpowers version must be bumped by the refresh");
}

{
  // The token matches an exact version, never a range floor or a longer version.
  assert.equal("^6.3.0 ~6.3.0 >=6.3.0 6.3.0.1 6.3.01 v6.3.0x 16.3.0".replace(versionToken("6.3.0"), "X"), "^6.3.0 ~6.3.0 >=6.3.0 6.3.0.1 6.3.01 v6.3.0x 16.3.0");
  assert.equal('"6.3.0", Superpowers 6.3.0 payload, desk@6.3.0'.replace(versionToken("6.3.0"), "X"), '"X", Superpowers X payload, desk@X');
  assert.equal("3.2.0-alpha.4 3.2.0-alpha.49".replace(versionToken("3.2.0-alpha.4"), "X"), "X 3.2.0-alpha.49");
  assert.equal(chooseSuperpowersVersion("6.3.0", "6.4.2"), "6.4.2");
  assert.equal(chooseSuperpowersVersion("6.4.2", "6.4.2"), "6.4.3");
  assert.equal(chooseSuperpowersVersion("6.4.3", "6.4.2"), "6.4.4");
  assert.equal(nextAlpha("3.2.0-alpha.9"), "3.2.0-alpha.10");
  assert.throws(() => nextAlpha("3.2.0"), /Desk version 3.2.0 is not an alpha release/u);
}

{
  // The scheduled workflow refreshes from the upstream default branch, then gates the merge on every CI workflow.
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/superpowers-upstream.yml"), "utf8");
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

function buildFixture(tempRoot) {
  const root = path.join(tempRoot, "desk");
  for (const file of new Set([
    ...SUPERPOWERS_VERSION_FILES,
    ...DESK_VERSION_FILES,
    "plugins/desk/CHANGELOG.md",
    "plugins/desk/mcp/package.json",
    "plugins/superpowers/README.md",
    "upstream-sources.lock.json",
    ...superpowersSource.files.map((file) => file.generatedPath),
  ])) {
    copyIntoFixture(root, file);
  }

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
    fs.copyFileSync(path.join(repoRoot, file.generatedPath), target);
  }
  const writeManifest = (version) => {
    fs.mkdirSync(path.join(upstreamDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(upstreamDir, ".claude-plugin/plugin.json"), `${JSON.stringify({ name: "superpowers", version })}\n`);
  };
  writeManifest(currentSuperpowers);
  git(upstreamDir, "add", "--all");
  for (const file of superpowersSource.files) {
    const executable = (fs.statSync(path.join(repoRoot, file.generatedPath)).mode & 0o111) !== 0;
    git(upstreamDir, "update-index", `--chmod=${executable ? "+" : "-"}x`, file.sourcePath);
  }
  git(upstreamDir, "commit", "--quiet", "--message", "locked payload");
  const base = git(upstreamDir, "rev-parse", "HEAD");
  const lockPath = path.join(root, "upstream-sources.lock.json");
  fs.writeFileSync(lockPath, fs.readFileSync(lockPath, "utf8").replace(superpowersSource.commit, base));
  return { root, upstreamDir, base, writeManifest };
}

function commitChange(upstreamDir, message) {
  git(upstreamDir, "add", "--all");
  git(upstreamDir, "commit", "--quiet", "--message", message);
  return git(upstreamDir, "rev-parse", "HEAD");
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

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-"));
  try {
    const { root, upstreamDir, base, writeManifest } = buildFixture(tempRoot);

    // Nothing selected changed: no file is touched and no release is cut.
    const before = snapshot(root);
    fs.writeFileSync(path.join(upstreamDir, "README.md"), "an unselected upstream change\n");
    commitChange(upstreamDir, "unselected");
    let output = "";
    assert.equal(main(["--upstream-dir", upstreamDir, "--root", root, "--date", "2026-01-02"], {
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
    const result = refresh({ root, upstream: require("./check-upstream-sources.cjs").createGitTreeReader({ dir: upstreamDir }), date: "2026-01-03", deskVersion: null });
    assert.equal(result.changed, true);
    assert.equal(result.previous_commit, base);
    assert.equal(result.commit, executableHead);
    assert.deepEqual(result.updated_paths, [skillFile.sourcePath]);
    assert.deepEqual(result.added_paths, ["skills/using-superpowers/scripts-new-helper"]);
    assert.deepEqual(result.release, {
      superpowers: { from: currentSuperpowers, to: newerUpstream, upstream: newerUpstream },
      desk: { from: currentDesk, to: nextAlpha(currentDesk) },
    });

    // The payload is byte-identical to upstream and the lock records it.
    const fixtureLock = JSON.parse(readFixture(root, "upstream-sources.lock.json"));
    const refreshed = fixtureLock.sources.find((source) => source.id === "obra-superpowers");
    assert.equal(refreshed.commit, executableHead);
    for (const file of refreshed.files) {
      const blob = execFileSync("git", ["-C", upstreamDir, "cat-file", "blob", `HEAD:${file.sourcePath}`]);
      assert.equal(Buffer.compare(fs.readFileSync(path.join(root, file.generatedPath)), blob), 0, file.sourcePath);
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

    // Every Desk surface ships the next alpha, with a changelog entry and release date the coupling test reads.
    const deskVersion = nextAlpha(currentDesk);
    for (const file of DESK_VERSION_FILES) {
      const text = readFixture(root, file);
      assert.doesNotMatch(text, versionToken(currentDesk), file);
      assert.match(text, versionToken(deskVersion), file);
    }
    const changelog = readFixture(root, "plugins/desk/CHANGELOG.md");
    assert.ok(changelog.startsWith(`# desk plugin — changelog\n\n## ${deskVersion} — 2026-01-03\n\nSuperpowers refresh: Desk now ships Superpowers ${newerUpstream}`), changelog.slice(0, 300));
    assert.match(changelog.split("\n## ")[1], new RegExp(`Selected files: 1 changed, 1 added\\. .*desk-mcp@${mcpVersion.replaceAll(".", "\\.")}`, "u"));
    assert.ok(changelog.includes(fs.readFileSync(path.join(repoRoot, "plugins/desk/CHANGELOG.md"), "utf8").slice("# desk plugin — changelog\n\n".length)));
    assert.match(readFixture(root, "plugins/desk/mcp/__tests__/release/release_coupling.test.js"), /const expectedReleaseDate = "2026-01-03"/u);

    // Upstream changes the payload again without a new version: Superpowers takes the next patch, Desk the chosen alpha.
    fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "A second addition.\n");
    fs.rmSync(path.join(upstreamDir, "skills/using-superpowers/scripts-new-helper"));
    const second = commitChange(upstreamDir, "unreleased change");
    output = "";
    assert.equal(main(["--upstream-dir", upstreamDir, "--root", root, "--date", "2026-01-04", "--desk-version", `${currentDesk.split("-")[0]}-alpha.900`, "--ref", second], {
      stdout: { write(value) { output += value; } },
    }), 0);
    const patch = JSON.parse(output);
    assert.deepEqual(patch.removed_paths, ["skills/using-superpowers/scripts-new-helper"]);
    assert.equal(patch.release.superpowers.to, `${major}.${minor + 1}.1`);
    assert.equal(patch.release.desk.to, `${currentDesk.split("-")[0]}-alpha.900`);
    assert.match(readFixture(root, "plugins/desk/CHANGELOG.md"), /Selected files: 1 changed, 1 removed\./u);

    // A chosen Desk version must move forward.
    fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "A third addition.\n");
    commitChange(upstreamDir, "third");
    assert.throws(
      () => main(["--upstream-dir", upstreamDir, "--root", root, "--desk-version", currentDesk], { stdout: { write() {} } }),
      new RegExp(`Desk version ${currentDesk.replaceAll(".", "\\.")} must be above`, "u"),
    );
    assert.throws(
      () => main(["--upstream-dir", upstreamDir, "--root", root, "--desk-version", "not-a-version"], { stdout: { write() {} } }),
      /Desk version not-a-version must be above/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

{
  // A stale surface list, a reworded README or a changelog without its title stops the release loudly.
  for (const [breakFixture, pattern] of [
    [(root) => fs.writeFileSync(path.join(root, "plugins/superpowers/plugin.json"), "{}\n"), /plugins\/superpowers\/plugin\.json does not name version .*; the release surface list is stale/u],
    [(root) => fs.writeFileSync(path.join(root, "plugins/superpowers/README.md"), "# Superpowers provider\n"), /README\.md no longer states the upstream version, commit and tree/u],
    [(root) => fs.writeFileSync(path.join(root, "plugins/desk/CHANGELOG.md"), "# Changes\n"), /CHANGELOG\.md must begin with its title/u],
  ]) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-superpowers-stale-"));
    try {
      const { root, upstreamDir } = buildFixture(tempRoot);
      fs.appendFileSync(path.join(upstreamDir, skillFile.sourcePath), "\nChanged.\n");
      commitChange(upstreamDir, "change");
      breakFixture(root);
      assert.throws(() => main(["--upstream-dir", upstreamDir, "--root", root], { stdout: { write() {} } }), pattern);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
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
    [["--upstream-dir", ".", "--date", "tomorrow"], /--date must be YYYY-MM-DD: tomorrow/u],
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
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log("Superpowers refresh tests passed.");
