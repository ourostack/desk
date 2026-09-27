#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  compactSources,
  createGitHubClient,
  createGitTreeReader,
  formatLock,
  inspectSource,
  inspectSources,
  main,
  selectedPayloadDigest,
  updateSource,
} = require("./check-upstream-sources.cjs");

const repoRoot = path.resolve(__dirname, "..");
const lockedCommit = "1".repeat(40);
const candidateCommit = "2".repeat(40);

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

const checkedInLock = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "upstream-sources.lock.json"), "utf8"),
);

for (const lockedSource of checkedInLock.sources) {
  for (const file of lockedSource.files) {
    const generated = path.join(repoRoot, file.generatedPath);
    assert.equal(fs.statSync(generated).isFile(), true);
    assert.equal(hash(fs.readFileSync(generated)), file.sha256, `${file.generatedPath} hash drifted`);
  }
}

function source(content = "locked") {
  return {
    id: "example",
    repository: "owner/repo",
    commit: lockedCommit,
    license: "MIT",
    files: [
      {
        sourcePath: "skills/example/SKILL.md",
        generatedPath: "plugins/example/skills/example/SKILL.md",
        sha256: hash(content),
      },
    ],
  };
}

function github({
  actualContent = "locked",
  candidate = lockedCommit,
  compareStatus = "ahead",
  releaseCandidate = candidate,
  releaseCompareStatus = compareStatus,
  fullName = "owner/repo",
  license = "MIT",
  release = null,
  failure = null,
  files = {},
  topLevel = null,
} = {}) {
  return {
    repository() {
      if (failure === "repository") throw new Error("HTTP 403 rate limit");
      return {
        full_name: fullName,
        default_branch: "main",
        html_url: "https://github.com/owner/repo",
        license: { spdx_id: license },
      };
    },
    latestRelease() {
      return release;
    },
    commit(_repository, ref) {
      assert.ok(ref === "main" || ref === release?.tag_name);
      return { sha: release && ref === release.tag_name ? releaseCandidate : candidate };
    },
    compare(_repository, base, head) {
      assert.equal(base, lockedCommit);
      if (release && head === releaseCandidate) return { status: releaseCompareStatus };
      assert.equal(head, candidate);
      return { status: compareStatus };
    },
    topLevel(_repository, ref) {
      // Only the approved Gauntlet source reads its tree; every other source must not.
      assert.notEqual(topLevel, null, "topLevel was not expected for this source");
      assert.equal(ref, candidate);
      return topLevel;
    },
    file(_repository, sourcePath, ref) {
      assert.equal(ref, candidate);
      if (Object.hasOwn(files, sourcePath)) return Buffer.from(files[sourcePath]);
      assert.equal(sourcePath, "skills/example/SKILL.md");
      return Buffer.from(actualContent);
    },
  };
}

{
  const result = inspectSource(source(), github());
  assert.equal(result.classification, "current");
  assert.equal(result.tracking.strategy, "default-branch");
  assert.deepEqual(result.changed_paths, []);
}

{
  const endpoints = [];
  const client = createGitHubClient((command, args, options) => {
    assert.equal(command, "gh");
    assert.equal(args[0], "api");
    assert.equal(options.encoding, "utf8");
    assert.equal(options.maxBuffer, 20 * 1024 * 1024);
    const endpoint = args[1];
    endpoints.push(endpoint);
    if (endpoint.includes("/releases?")) {
      return {
        status: 0,
        stdout: JSON.stringify([{
          endpoint,
          draft: false,
          prerelease: false,
          tag_name: "v1.0.0",
          html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
        }]),
        stderr: "",
      };
    }
    if (endpoint.includes("/contents/")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          type: "file",
          encoding: "base64",
          content: `${Buffer.from("content").toString("base64")}\n`,
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: JSON.stringify({ endpoint }), stderr: "" };
  });
  assert.match(client.repository("owner/repo").endpoint, /repos\/owner\/repo$/u);
  assert.match(client.latestRelease("owner/repo").endpoint, /releases\?per_page=100$/u);
  assert.match(client.commit("owner/repo", "v 1").endpoint, /commits\/v%201$/u);
  assert.match(client.compare("owner/repo", lockedCommit, candidateCommit).endpoint, /compare/u);
  assert.equal(client.file("owner/repo", "path with space/file.md", candidateCommit).toString(), "content");
  assert.equal(endpoints.length, 5);
  const tree = createGitHubClient((_command, args) => ({
    status: 0, stderr: "",
    stdout: JSON.stringify(args[1].endsWith("/git/trees/complete") ? { tree: [{ path: "LICENSE" }, { path: "NOTICE" }] } : { tree: [], truncated: true }),
  }));
  assert.deepEqual(tree.topLevel("owner/repo", "complete"), ["LICENSE", "NOTICE"]);
  assert.throws(() => tree.topLevel("owner/repo", "partial"), /did not return a complete top-level tree/u);
  const noTree = createGitHubClient(() => ({ status: 0, stdout: "{}", stderr: "" }));
  assert.throws(() => noTree.topLevel("owner/repo", "x"), /complete top-level tree/u);

  const noReleases = createGitHubClient(() => ({
    status: 0,
    stdout: "[]",
    stderr: "",
  }));
  assert.equal(noReleases.latestRelease("owner/repo"), null);
}

{
  const notFound = createGitHubClient(() => ({
    status: 1,
    stdout: "",
    stderr: "gh: Not Found (HTTP 404)",
  }));
  assert.throws(() => notFound.latestRelease("owner/repo"), /HTTP 404/u);

  for (const result of [
    { status: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)" },
    { status: 1, stdout: "stdout failure", stderr: "" },
    { status: null, stdout: "", stderr: "", error: new Error("spawn gh ENOENT") },
    { status: 7, stdout: "", stderr: "" },
  ]) {
    const failing = createGitHubClient(() => result);
    assert.throws(() => failing.repository("owner/repo"), /gh api .* failed/u);
  }

  const invalidJson = createGitHubClient(() => ({
    status: 0,
    stdout: "not json",
    stderr: "",
  }));
  assert.throws(() => invalidJson.repository("owner/repo"), /returned invalid JSON/u);

  const invalidReleases = createGitHubClient(() => ({
    status: 0,
    stdout: JSON.stringify({ tag_name: "v1.0.0" }),
    stderr: "",
  }));
  assert.throws(() => invalidReleases.latestRelease("owner/repo"), /did not return an array/u);

  const malformedRelease = createGitHubClient(() => ({
    status: 0,
    stdout: JSON.stringify([{ draft: false }]),
    stderr: "",
  }));
  assert.throws(
    () => malformedRelease.latestRelease("owner/repo"),
    /malformed release metadata/u,
  );

  const missingPublishedEvidence = createGitHubClient(() => ({
    status: 0,
    stdout: JSON.stringify([{ draft: false, prerelease: false }]),
    stderr: "",
  }));
  assert.throws(
    () => missingPublishedEvidence.latestRelease("owner/repo"),
    /missing tag or URL evidence/u,
  );

  const filteredReleases = createGitHubClient(() => {
    const releases = [
      {
        draft: true,
        prerelease: false,
        tag_name: "draft",
        html_url: "https://github.com/owner/repo/releases/draft",
      },
      {
        draft: false,
        prerelease: true,
        tag_name: "v2.0.0-rc.1",
        html_url: "https://github.com/owner/repo/releases/tag/v2.0.0-rc.1",
      },
      {
        draft: false,
        prerelease: false,
        tag_name: "v1.9.0",
        html_url: "https://github.com/owner/repo/releases/tag/v1.9.0",
      },
    ];
    return { status: 0, stdout: JSON.stringify(releases), stderr: "" };
  });
  assert.equal(filteredReleases.latestRelease("owner/repo").tag_name, "v1.9.0");

  const invalidFile = createGitHubClient(() => ({
    status: 0,
    stdout: JSON.stringify({ type: "dir", encoding: "none" }),
    stderr: "",
  }));
  assert.throws(
    () => invalidFile.file("owner/repo", "file.md", lockedCommit),
    /did not resolve to base64 file content/u,
  );

  assert.equal(typeof createGitHubClient().repository, "function");
}

for (const [mutate, expected] of [
  [(value) => { value.repository = "invalid"; }, /invalid repository identity/u],
  [(value) => { value.commit = "invalid"; }, /invalid locked commit/u],
  [(value) => { value.files = []; }, /has no selected files/u],
]) {
  const value = source();
  mutate(value);
  assert.throws(() => inspectSource(value, github()), expected);
}

assert.throws(
  () => inspectSource(source(), github({ license: "Apache-2.0" })),
  /MIT license evidence missing/u,
);
assert.throws(
  () => inspectSource(source(), github({ license: null })),
  /got unknown/u,
);
for (const license of ["Apache-2.0", null]) {
  const value = source();
  value.license = license;
  assert.throws(
    () => inspectSource(value, github({ license })),
    /unsupported locked license/u,
  );
}
assert.throws(
  () => inspectSource(source(), github({ candidate: "invalid" })),
  /invalid candidate commit/u,
);

{
  const result = inspectSource(source(), github({
    candidate: candidateCommit,
    release: {
      tag_name: "v2.0.0",
      html_url: "https://github.com/owner/repo/releases/tag/v2.0.0",
    },
  }));
  assert.equal(result.classification, "candidate-no-selected-payload-change");
  assert.equal(result.ancestry, "ahead");
  assert.equal(result.tracking.strategy, "latest-release");
  assert.equal(result.tracking.ref, "v2.0.0");
}

{
  const result = inspectSource(source(), github({
    release: {
      tag_name: "v1.0.0",
      html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
    },
    releaseCandidate: lockedCommit,
  }));
  assert.equal(result.classification, "current");
  assert.equal(result.tracking.strategy, "latest-release");
  assert.equal(result.tracking.release_considered.ancestry, "identical");
}

{
  const result = inspectSource(source(), github({
    release: {
      tag_name: "v0.9.0",
      html_url: "https://github.com/owner/repo/releases/tag/v0.9.0",
    },
    releaseCandidate: "0".repeat(40),
    releaseCompareStatus: "behind",
  }));
  assert.equal(result.classification, "current");
  assert.equal(result.tracking.strategy, "default-branch");
  assert.equal(result.tracking.release_considered.ancestry, "behind");
}

{
  const result = inspectSource(source(), github({
    actualContent: "changed",
    candidate: candidateCommit,
  }));
  assert.equal(result.classification, "needs-human-approval");
  assert.deepEqual(result.changed_paths, ["skills/example/SKILL.md"]);
  assert.notEqual(result.selected_files[0].locked_sha256, result.selected_files[0].candidate_sha256);
  assert.equal(
    result.selected_payload_digest,
    selectedPayloadDigest(result.selected_files),
  );
}

{
  const result = inspectSource(source(), github({
    candidate: candidateCommit,
    compareStatus: "diverged",
  }));
  assert.equal(result.classification, "blocked");
  assert.match(result.reason, /not a forward update/u);
}

{
  const results = inspectSources(
    { schemaVersion: 1, sources: [source()] },
    github({ fullName: "new-owner/repo" }),
  );
  assert.equal(results[0].classification, "blocked");
  assert.match(results[0].reason, /repository identity mismatch/u);
}

{
  const results = inspectSources(
    { schemaVersion: 1, sources: [source()] },
    github({ failure: "repository" }),
  );
  assert.equal(results[0].classification, "blocked");
  assert.match(results[0].reason, /HTTP 403 rate limit/u);
}

{
  const result = inspectSource(source(), github({ actualContent: "drifted" }));
  assert.equal(result.classification, "blocked");
  assert.match(result.reason, /locked commit does not match/u);
}

{
  const results = inspectSources(
    { schemaVersion: 1, sources: [null] },
    github(),
  );
  assert.equal(results[0].id, null);
  assert.equal(results[0].repository, null);
  assert.equal(results[0].locked_commit, null);
  assert.equal(results[0].classification, "blocked");
  assert.match(results[0].reason, /null|repository/iu);
}

{
  const results = inspectSources(
    { schemaVersion: 1, sources: [source()] },
    github({
      candidate: candidateCommit,
      compareStatus: null,
    }),
  );
  assert.equal(results[0].classification, "blocked");
  assert.match(results[0].reason, /unknown ancestry status/u);
}

assert.throws(
  () => inspectSources({ schemaVersion: 2, sources: [] }, github()),
  /schemaVersion 1/u,
);
assert.throws(
  () => inspectSources({ schemaVersion: 1, sources: [] }, github()),
  /non-empty sources array/u,
);

{
  const files = [
    { source_path: "b.md", candidate_sha256: "b" },
    { source_path: "a.md", candidate_sha256: "a" },
  ];
  assert.equal(selectedPayloadDigest(files), selectedPayloadDigest([...files].reverse()));
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-source-main-"));
  try {
    const lockPath = path.join(tempRoot, "lock.json");
    fs.writeFileSync(lockPath, JSON.stringify({
      schemaVersion: 1,
      sources: [source(), { ...source(), id: "example-2" }],
    }));

    let output = "";
    const currentStatus = main(
      ["--lock", lockPath],
      {
        github: github(),
        now: () => "2026-08-25T00:00:00.000Z",
        stdout: { write(value) { output += value; } },
      },
    );
    assert.equal(currentStatus, 0);
    const report = JSON.parse(output);
    assert.equal(report.checked_at, "2026-08-25T00:00:00.000Z");
    assert.equal(report.summary.current, 2);
    assert.match(report.lock_path, /upstream-source-main-/u);

    fs.writeFileSync(lockPath, JSON.stringify({
      schemaVersion: 1,
      sources: [source()],
    }));
    assert.equal(main(["--lock", lockPath], {
      github: github({ actualContent: "changed", candidate: candidateCommit }),
      stdout: { write() {} },
    }), 2);
    assert.equal(main(["--lock", lockPath], {
      github: github({ failure: "repository" }),
      stdout: { write() {} },
    }), 1);

    const fakeBin = path.join(tempRoot, "bin");
    fs.mkdirSync(fakeBin);
    const fakeGh = path.join(fakeBin, "gh");
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const endpoint = process.argv[3];
const locked = "${lockedCommit}";
let value;
if (endpoint === "repos/owner/repo") {
  value = { full_name: "owner/repo", default_branch: "main", html_url: "https://github.com/owner/repo", license: { spdx_id: "MIT" } };
} else if (endpoint === "repos/owner/repo/releases?per_page=100") {
  value = [];
} else if (endpoint === "repos/owner/repo/commits/main") {
  value = { sha: locked };
} else if (endpoint.startsWith("repos/owner/repo/contents/skills/example/SKILL.md?ref=")) {
  value = { type: "file", encoding: "base64", content: Buffer.from("locked").toString("base64") };
} else {
  process.stderr.write("gh: Not Found (HTTP 404)");
  process.exit(1);
}
process.stdout.write(JSON.stringify(value));
`);
    fs.chmodSync(fakeGh, 0o755);
    const cliSuccess = spawnSync(process.execPath, [
      path.join(__dirname, "check-upstream-sources.cjs"),
      "--lock",
      lockPath,
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(cliSuccess.status, 0, cliSuccess.stderr);
    assert.equal(JSON.parse(cliSuccess.stdout).summary.current, 1);

    assert.throws(
      () => main(["--unknown"], { github: github(), stdout: { write() {} } }),
      /unknown or incomplete argument/u,
    );
    assert.throws(
      () => main(["--lock"], { github: github(), stdout: { write() {} } }),
      /unknown or incomplete argument/u,
    );
    fs.writeFileSync(lockPath, "not json");
    assert.throws(
      () => main(["--lock", lockPath], { github: github(), stdout: { write() {} } }),
      /Unexpected token/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

{
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, "check-upstream-sources.cjs"),
    "--unknown",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /unknown or incomplete argument/u);
}

{
  // License-policy characterization uses the existing injected GitHub fixture,
  // not the evaluator payload or a new network harness.
  // The license exception follows the reviewed LICENSE bytes, which the vendored copy keeps.
  const licenseText = fs.readFileSync(path.join(repoRoot, "evals/offline/vendor/gauntlet/LICENSE"));
  const licenseEntry = { sourcePath: "LICENSE", generatedPath: "plugins/example/LICENSE", sha256: hash(licenseText) };
  const approved = {
    ...source(),
    id: "prime-radiant-inc-gauntlet-evaluation-leaves",
    repository: "prime-radiant-inc/gauntlet",
    license: "Apache-2.0",
  };
  approved.files = [...approved.files, licenseEntry];
  const remote = (overrides = {}) => github({
    fullName: approved.repository,
    candidate: approved.commit,
    license: "Apache-2.0",
    files: { LICENSE: licenseText },
    topLevel: ["LICENSE", "README.md", "src"],
    ...overrides,
  });

  const current = inspectSource(approved, remote());
  assert.equal(current.classification, "current");
  assert.equal(current.repository_identity, approved.repository);
  assert.equal(current.license, "Apache-2.0");
  assert.deepEqual(current.changed_paths, []);

  for (const license of ["MIT", null, "NOASSERTION"]) {
    assert.throws(
      () => inspectSource(approved, remote({ license })),
      { message: `Apache-2.0 license evidence missing for ${approved.repository}: got ${license ?? "unknown"}` },
    );
  }
  for (const license of ["MIT", null, "BSD-3-Clause"]) {
    assert.throws(
      () => inspectSource({ ...approved, license }, remote({ license })),
      { message: `approved Gauntlet source must lock Apache-2.0: got ${license ?? "missing"}` },
    );
  }
  // An upstream move that keeps the license keeps the approval; one that changes it needs a person.
  const moved = inspectSource(approved, remote({ candidate: candidateCommit }));
  assert.equal(moved.classification, "candidate-no-selected-payload-change");
  const relicensed = inspectSource(approved, remote({ candidate: candidateCommit, files: { LICENSE: "Other terms" } }));
  assert.equal(relicensed.classification, "needs-human-approval");
  assert.deepEqual(relicensed.changed_paths, ["LICENSE"]);
  assert.deepEqual(current.unvendored_license_notices, []);

  // A NOTICE or COPYING file upstream adds is part of the license terms, so it needs a person even when LICENSE is unchanged.
  const noticed = inspectSource(approved, remote({ candidate: candidateCommit, topLevel: ["LICENSE", "NOTICE", "src"] }));
  assert.equal(noticed.classification, "needs-human-approval");
  assert.deepEqual(noticed.changed_paths, []);
  assert.deepEqual(noticed.unvendored_license_notices, ["NOTICE"]);
  assert.match(noticed.reason, /license notice files the lock does not vendor \(NOTICE\)/u);
  const copying = inspectSource(approved, remote({ topLevel: ["notice.txt", "COPYING.md", "NOTICES", "src"] }));
  assert.equal(copying.classification, "needs-human-approval", "also at the locked commit");
  assert.deepEqual(copying.unvendored_license_notices, ["COPYING.md", "notice.txt"]);
  const vendoredNotice = { ...approved, files: [...approved.files, { sourcePath: "NOTICE", generatedPath: "plugins/example/NOTICE", sha256: hash("Attribution") }] };
  const withNotice = inspectSource(vendoredNotice, remote({ topLevel: ["LICENSE", "NOTICE"], files: { LICENSE: licenseText, NOTICE: "Attribution" } }));
  assert.equal(withNotice.classification, "current", "a NOTICE the lock vendors is covered by its hash");
  const blockedNotice = inspectSource(approved, remote({ compareStatus: "behind", candidate: candidateCommit, topLevel: ["NOTICE"] }));
  assert.equal(blockedNotice.classification, "blocked", "a blocked source stays blocked");

  for (const overrides of [
    { id: "unapproved-gauntlet-entry" },
    { repository: "another-owner/gauntlet" },
    { files: [source().files[0], { ...licenseEntry, sha256: hash("Other terms") }] },
    { files: source().files },
  ]) {
    const unapproved = { ...approved, ...overrides };
    assert.throws(
      () => inspectSource(unapproved, remote({ fullName: unapproved.repository, candidate: unapproved.commit })),
      { message: `unsupported locked license for ${unapproved.id}: Apache-2.0` },
    );
  }
  assert.throws(
    () => inspectSource(approved, remote({ fullName: "another-owner/gauntlet" })),
    /repository identity mismatch/u,
  );

  const drift = inspectSource(approved, remote({ actualContent: "tampered pinned payload" }));
  assert.equal(drift.classification, "blocked");
  assert.equal(drift.reason, "selected payload at the locked commit does not match the recorded hashes");
  assert.deepEqual(drift.changed_paths, ["skills/example/SKILL.md"]);
}

// ---- Update mode: a fixture upstream Git tree in, byte-identical selected files and a correct lock out. ----

{
  // The formatter reproduces the checked-in lock byte for byte, so a refresh diff shows only changed entries.
  const text = fs.readFileSync(path.join(repoRoot, "upstream-sources.lock.json"), "utf8");
  const lock = JSON.parse(text);
  const compact = compactSources(text, lock);
  assert.deepEqual([...compact], ["obra-superpowers"]);
  assert.equal(formatLock(lock, compact), text);
  assert.equal(compactSources("{}", { sources: [{ id: "empty", files: [] }] }).size, 0);
}

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Writes each fixture file, marks executables in the index, and commits, returning the commit.
function commitUpstream(dir, files, message) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry !== ".git") fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  for (const [file, { content }] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, "add", "--all");
  for (const [file, { executable = false }] of Object.entries(files)) {
    git(dir, "update-index", `--chmod=${executable ? "+" : "-"}x`, file);
  }
  git(dir, "commit", "--quiet", "--allow-empty", "--message", message);
  return git(dir, "rev-parse", "HEAD");
}

function initUpstream(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
}

const lockedUpstream = {
  "LICENSE": { content: "MIT fixture license\n" },
  "README.md": { content: "unselected root file\n" },
  "hooks/run-hook": { content: "#!/bin/sh\necho locked\n", executable: true },
  "hooks/extra.json": { content: "{}\n" },
  "skills/alpha/SKILL.md": { content: "alpha skill\r\nwith CRLF bytes\r\n" },
  "skills/alpha/old.md": { content: "removed upstream\n" },
  "skills/alpha/refs/gone.md": { content: "removed with its folder\n" },
  "skills/beta/SKILL.md": { content: "beta skill\n" },
  "skills/beta/tool": { content: "#!/bin/sh\necho tool\n", executable: true },
  "skills/beta/drifted.md": { content: "beta drift target\n" },
  "skills/beta/missing.md": { content: "beta missing target\n" },
};
const refreshedUpstream = {
  "LICENSE": lockedUpstream.LICENSE,
  "README.md": { content: "unselected root file, changed\n" },
  "hooks/run-hook": { content: "#!/bin/sh\necho refreshed\n", executable: true },
  "hooks/extra.json": { content: "{\"unselected\": true}\n" },
  "skills/alpha/SKILL.md": lockedUpstream["skills/alpha/SKILL.md"],
  "skills/alpha/new/script": { content: "#!/bin/sh\necho new\n", executable: true },
  "skills/beta/SKILL.md": lockedUpstream["skills/beta/SKILL.md"],
  "skills/beta/tool": { content: lockedUpstream["skills/beta/tool"].content, executable: false },
  "skills/beta/drifted.md": lockedUpstream["skills/beta/drifted.md"],
  "skills/beta/missing.md": lockedUpstream["skills/beta/missing.md"],
  "skills/gamma/SKILL.md": { content: "a new upstream skill\n" },
};
const selectedLocked = Object.keys(lockedUpstream).filter((file) => file !== "README.md" && file !== "hooks/extra.json").sort();

function fixtureLock(commit) {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: "fixture-superpowers",
        repository: "owner/superpowers",
        commit,
        license: "MIT",
        files: selectedLocked.map((sourcePath) => ({
          sourcePath,
          generatedPath: `plugins/fixture/${sourcePath}`,
          sha256: hash(lockedUpstream[sourcePath].content),
        })),
      },
      {
        id: "untouched",
        repository: "owner/other",
        commit: "3".repeat(40),
        license: "MIT",
        files: [{ sourcePath: "x.md", generatedPath: "vendor/x.md", sha256: hash("x") }],
      },
    ],
  };
}

function writeFixtureRoot(root, lock) {
  fs.mkdirSync(root, { recursive: true });
  const text = formatLock(lock, new Set(["fixture-superpowers"]));
  fs.writeFileSync(path.join(root, "upstream-sources.lock.json"), text);
  for (const sourcePath of selectedLocked) {
    const target = path.join(root, "plugins/fixture", sourcePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lockedUpstream[sourcePath].content);
    fs.chmodSync(target, lockedUpstream[sourcePath].executable ? 0o755 : 0o644);
  }
  return text;
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-source-update-"));
  try {
    const upstreamDir = path.join(tempRoot, "upstream");
    initUpstream(upstreamDir);
    const lockedCommitSha = commitUpstream(upstreamDir, lockedUpstream, "locked");
    const refreshedCommitSha = commitUpstream(upstreamDir, refreshedUpstream, "refreshed");
    const root = path.join(tempRoot, "desk");
    const originalLockText = writeFixtureRoot(root, fixtureLock(lockedCommitSha));
    const lockPath = path.join(root, "upstream-sources.lock.json");
    fs.writeFileSync(path.join(root, "plugins/fixture/skills/beta/drifted.md"), "local drift\n");
    fs.rmSync(path.join(root, "plugins/fixture/skills/beta/missing.md"));

    // The locked commit itself changes nothing that is committed, except the two local defects it repairs.
    const atLock = createGitTreeReader({ dir: upstreamDir, ref: lockedCommitSha });
    assert.equal(atLock.commit, lockedCommitSha);
    const repair = updateSource({ lockPath, sourceId: "fixture-superpowers", upstream: atLock });
    assert.deepEqual(repair.updated_paths, ["skills/beta/drifted.md", "skills/beta/missing.md"]);
    assert.equal(repair.changed, true);
    assert.equal(fs.readFileSync(lockPath, "utf8"), originalLockText);

    const upstream = createGitTreeReader({ dir: upstreamDir });
    assert.equal(upstream.commit, refreshedCommitSha);
    assert.equal(upstream.tree, git(upstreamDir, "rev-parse", "HEAD^{tree}"));
    const report = updateSource({ lockPath, sourceId: "fixture-superpowers", upstream });
    assert.deepEqual(report, {
      source_id: "fixture-superpowers",
      repository: "owner/superpowers",
      previous_commit: lockedCommitSha,
      commit: refreshedCommitSha,
      tree: upstream.tree,
      changed: true,
      added_paths: ["skills/alpha/new/script"],
      updated_paths: ["hooks/run-hook"],
      mode_changed_paths: ["skills/beta/tool"],
      removed_paths: ["skills/alpha/old.md", "skills/alpha/refs/gone.md"],
      unselected_skills: ["skills/gamma"],
    });

    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const refreshed = lock.sources[0];
    const expectedSelected = Object.keys(refreshedUpstream)
      .filter((file) => !["README.md", "hooks/extra.json", "skills/gamma/SKILL.md"].includes(file))
      .sort();
    assert.equal(refreshed.commit, refreshedCommitSha);
    assert.deepEqual(refreshed.files.map((file) => file.sourcePath), expectedSelected);
    for (const file of refreshed.files) {
      const blob = spawnSync("git", ["-C", upstreamDir, "cat-file", "blob", `HEAD:${file.sourcePath}`]).stdout;
      const vendored = fs.readFileSync(path.join(root, file.generatedPath));
      assert.equal(Buffer.compare(vendored, blob), 0, `${file.sourcePath} must be byte-identical to upstream`);
      assert.equal(file.sha256, hash(blob));
      assert.equal(file.generatedPath, `plugins/fixture/${file.sourcePath}`);
      if (process.platform !== "win32") {
        const executable = Boolean(refreshedUpstream[file.sourcePath].executable);
        assert.equal((fs.statSync(path.join(root, file.generatedPath)).mode & 0o111) !== 0, executable, file.sourcePath);
      }
    }
    assert.match(fs.readFileSync(path.join(root, "plugins/fixture/skills/alpha/SKILL.md"), "latin1"), /\r\n/u);
    assert.equal(fs.existsSync(path.join(root, "plugins/fixture/skills/alpha/old.md")), false);
    assert.equal(fs.existsSync(path.join(root, "plugins/fixture/skills/alpha/refs")), false);
    assert.equal(fs.existsSync(path.join(root, "plugins/fixture/skills/gamma")), false);
    assert.deepEqual(lock.sources[1], fixtureLock(lockedCommitSha).sources[1]);
    const lockText = fs.readFileSync(lockPath, "utf8");
    assert.equal(formatLock(lock, new Set(["fixture-superpowers"])), lockText);
    assert.match(lockText, /\{"sourcePath": "skills\/alpha\/new\/script", "generatedPath": "plugins\/fixture\/skills\/alpha\/new\/script", "sha256": "[0-9a-f]{64}"\}/u);

    // A second run over the same upstream is a no-op and writes nothing.
    const again = updateSource({ lockPath, sourceId: "fixture-superpowers", upstream });
    assert.equal(again.changed, false);
    assert.equal(again.previous_commit, refreshedCommitSha);
    assert.equal(fs.readFileSync(lockPath, "utf8"), lockText);

    // An upstream commit that touches only unselected files is not a refresh and leaves the lock at its commit.
    commitUpstream(upstreamDir, { ...refreshedUpstream, "README.md": { content: "only unselected changes\n" } }, "unselected");
    let output = "";
    assert.equal(main(["--update", "--source", "fixture-superpowers", "--upstream-dir", upstreamDir, "--lock", lockPath], {
      stdout: { write(value) { output += value; } },
    }), 0);
    assert.equal(JSON.parse(output).changed, false);
    assert.equal(fs.readFileSync(lockPath, "utf8"), lockText);

    // The CLI reads an explicit ref and exits cleanly.
    const cli = spawnSync(process.execPath, [
      path.join(__dirname, "check-upstream-sources.cjs"),
      "--update", "--source", "fixture-superpowers", "--upstream-dir", upstreamDir, "--lock", lockPath, "--ref", refreshedCommitSha,
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).commit, refreshedCommitSha);

    assert.throws(
      () => updateSource({ lockPath, sourceId: "missing", upstream }),
      /upstream source lock has no source missing/u,
    );
    assert.throws(() => createGitTreeReader({ dir: path.join(tempRoot, "not-a-repo") }), /git rev-parse --verify HEAD\^\{commit\} failed/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

{
  // Update refuses what it cannot copy faithfully, before writing anything.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-source-refuse-"));
  try {
    const entry = (mode = "100644", type = "blob") => ({ mode, type, object: "0".repeat(40) });
    const fake = (paths) => ({
      commit: candidateCommit,
      tree: "4".repeat(40),
      entries: new Map(Object.entries(paths)),
      read: () => Buffer.from("content"),
    });
    const refuse = (files, upstream, pattern) => {
      const lockPath = path.join(tempRoot, "lock.json");
      const text = JSON.stringify({ schemaVersion: 1, sources: [{ id: "s", repository: "o/r", commit: lockedCommit, license: "MIT", files }] });
      fs.writeFileSync(lockPath, text);
      assert.throws(() => updateSource({ lockPath, sourceId: "s", upstream }), pattern);
      assert.equal(fs.readFileSync(lockPath, "utf8"), text);
    };
    const file = (sourcePath, generatedPath = `vendor/${sourcePath}`) => ({ sourcePath, generatedPath, sha256: hash("content") });
    refuse([file("LICENSE", "vendor/COPYING")], fake({}), /does not mirror LICENSE/u);
    refuse([file("LICENSE"), file("hooks/a", "other/hooks/a")], fake({}), /do not share one vendored root/u);
    refuse([file("LICENSE")], fake({}), /selected upstream file was removed: LICENSE/u);
    refuse([file("skills/a/SKILL.md")], fake({ LICENSE: entry() }), /selected upstream skill was removed: skills\/a\//u);
    refuse([file("skills/a/SKILL.md")], fake({ "skills/a/SKILL.md": entry("120000") }), /not a regular file: skills\/a\/SKILL.md \(120000 blob\)/u);
    refuse([file("vendored")], fake({ vendored: entry("160000", "commit") }), /not a regular file: vendored \(160000 commit\)/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

{
  // Git failures surface their own message, then the spawn error, then the exit status.
  for (const [result, pattern] of [
    [{ status: 128, stderr: "fatal: not a git repository" }, /failed: fatal: not a git repository/u],
    [{ status: null, stderr: "", error: new Error("spawn git ENOENT") }, /failed: spawn git ENOENT/u],
    [{ status: 2, stderr: "" }, /failed: exit 2/u],
  ]) {
    assert.throws(() => createGitTreeReader({ dir: "/nowhere", run: () => result }), pattern);
  }
  for (const argv of [["--update"], ["--update", "--source", "s"], ["--update", "--upstream-dir", "."]]) {
    assert.throws(() => main(argv, { stdout: { write() {} } }), /--update requires --source <id> and --upstream-dir/u);
  }
  assert.throws(() => main(["--ref"], { stdout: { write() {} } }), /unknown or incomplete argument: --ref/u);
}


{
  // The check only helps if something runs it: a daily workflow keeps one issue open while it exits 1 or 2.
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/upstream-sources-check.yml"), "utf8");
  assert.match(workflow, /^on:\n  schedule:\n    - cron: "[^"]+"\n  workflow_dispatch:\n/mu);
  assert.match(workflow, /node scripts\/check-upstream-sources\.cjs > /u);
  assert.match(workflow, /^      issues: write$/mu);
  assert.match(workflow, /if: \$\{\{ steps\.check\.outputs\.code != '0' \}\}/u);
  assert.match(workflow, /gh issue edit "\$number"/u, "a later failure updates the open issue instead of adding one");
  assert.match(workflow, /if: \$\{\{ steps\.check\.outputs\.code == '0' \}\}\n[\s\S]*gh issue close/u);
}
console.log("upstream source steward tests passed.");
