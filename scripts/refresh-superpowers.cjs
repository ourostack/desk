#!/usr/bin/env node
"use strict";

// Refreshes the vendored Superpowers payload from an upstream Git checkout and, when any selected byte changed,
// releases it: Superpowers takes upstream's declared version (or the next patch when upstream changed the payload
// without a new version) on every surface that names it, and Desk gains a changelog fragment, like any other pull
// request, from which the release workflow takes Desk's next alpha once the refresh merges. When upstream crosses a
// major version, Desk's compatibility floor moves to it, so CI qualifies Desk against the new major rather than
// failing every refresh on the old floor; the report carries upstream's release notes since the version Desk shipped,
// so the pull request and any issue say what changed. The upstream payload itself is never edited; only Ourostack
// packaging files and release surfaces are.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const { compareVersions, parseVersion } = require("./check-release-integrity.cjs");
const { createGitTreeReader, updateSource, sha256 } = require("./check-upstream-sources.cjs");
const { FRAGMENT_DIR, replaceVersion, versionToken } = require("./release-desk.cjs");
const { satisfiesVersion } = require("./validate-skills.cjs");
const hookCompat = require("./superpowers-hook-compat.cjs");

const SOURCE_ID = "obra-superpowers";

// Every surface that names the shipped Superpowers version. A caret range such as `^6.3.0` is a compatibility
// floor, not the shipped version; it moves only when the new version falls outside it (SUPERPOWERS_RANGE_FILES).
const SUPERPOWERS_VERSION_FILES = [
  ".claude-plugin/marketplace.json",
  "plugins/superpowers/plugin.json",
  "plugins/superpowers/.claude-plugin/plugin.json",
  "plugins/desk/plugin.json",
  "plugins/desk/activation/desk.activation.json",
  "plugins/desk/activation/copilot-root.flattened-bundle.json",
];

// Where Desk declares the Superpowers versions it works with, and how to find the declaration in each.
const SUPERPOWERS_RANGE_FILES = [
  { file: "plugins/desk/.claude-plugin/plugin.json", find: (json) => json.dependencies.find((dependency) => dependency.name === "superpowers"), key: "version" },
  { file: "plugins/desk/activation/desk.activation.json", find: (json) => json.dependencies.find((dependency) => dependency.id === "superpowers"), key: "version_range" },
];

const SUPERPOWERS_README = "plugins/superpowers/README.md";
const UPSTREAM_NOTES = "RELEASE-NOTES.md";

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

// Upstream's version only when it is above the shipped one; otherwise the next patch, so a refresh always ships a higher
// version, including after a packaging-only release put the shipped version ahead of upstream.
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

function shippedUpstream(root) {
  return /version (\S+), commit `/u.exec(fs.readFileSync(path.join(root, SUPERPOWERS_README), "utf8"))?.[1] ?? null;
}

// Upstream's notes for every version after the one Desk shipped, up to the one it ships now, newest first.
function releaseNotes(upstreamTree, { from, to }) {
  if (!upstreamTree.entries.has(UPSTREAM_NOTES)) return [];
  const text = upstreamTree.read(UPSTREAM_NOTES).toString("utf8").replace(/\r\n/gu, "\n");
  const sections = text.split(/^## /mu).slice(1);
  return sections.flatMap((section) => {
    const [heading, ...rest] = section.split("\n");
    const version = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(heading.trim())?.[1];
    if (!version || compareVersions(version, to) > 0 || (from && compareVersions(version, from) <= 0)) return [];
    return [{ version, heading: heading.trim(), body: rest.join("\n").trim() }];
  });
}

// Moves Desk's caret floor to the new version only when the new version falls outside it. The edit replaces the one
// quoted range string and is checked by re-parsing, so the rest of each file keeps its bytes.
function moveRange(root, version) {
  const ranges = SUPERPOWERS_RANGE_FILES.map((site) => ({ ...site, range: site.find(readJson(root, site.file))[site.key] }));
  const outside = ranges.filter((site) => !satisfiesVersion(version, site.range));
  if (outside.length === 0) return null;
  const floors = new Set(ranges.map((site) => site.range));
  if (floors.size !== 1) throw new Error(`Superpowers refresh: Desk declares different Superpowers ranges: ${[...floors].join(", ")}`);
  const [from] = floors;
  const to = `^${version}`;
  for (const site of ranges) {
    const target = path.join(root, site.file);
    const text = fs.readFileSync(target, "utf8");
    const quoted = JSON.stringify(from);
    if (text.split(quoted).length !== 2) throw new Error(`Superpowers refresh: ${site.file} names ${quoted} more than once; move its range by hand`);
    const next = text.replace(quoted, JSON.stringify(to));
    const expected = JSON.parse(text);
    site.find(expected)[site.key] = to;
    assert.deepStrictEqual(JSON.parse(next), expected, `Superpowers refresh: moving the range in ${site.file} changed more than the range`);
    fs.writeFileSync(target, next);
  }
  return { from, to, files: ranges.map((site) => site.file) };
}

function release({ root, report, upstream, upstreamTree }) {
  const currentSuperpowers = readJson(root, "plugins/superpowers/.claude-plugin/plugin.json").version;
  const superpowers = chooseSuperpowersVersion(currentSuperpowers, upstream);
  const fragment = `${FRAGMENT_DIR}/superpowers-${superpowers}.md`;
  const notes = releaseNotes(upstreamTree, { from: shippedUpstream(root), to: upstream });

  replaceVersion(root, SUPERPOWERS_VERSION_FILES, currentSuperpowers, superpowers);
  const range = moveRange(root, superpowers);
  updateReadme(root, { upstream, commit: report.commit, tree: report.tree });
  fs.mkdirSync(path.join(root, FRAGMENT_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, fragment), fragmentText({ superpowers, upstream, report }));

  return { superpowers: { from: currentSuperpowers, to: superpowers, upstream }, fragment, range, notes };
}

function refresh({ root, upstream, io = fs }) {
  // Build the entire source/packaging/release candidate away from the consumer.
  hookCompat.assertNoPendingRecovery(root, io);
  hookCompat.prepare({ root, io });
  hookCompat.transform(upstream.read("hooks/run-hook.cmd"));
  const lock = JSON.parse(io.readFileSync(path.join(root, "upstream-sources.lock.json")));
  const source = lock.sources.find((entry) => entry.id === SOURCE_ID);
  const version = upstreamVersion(upstream);
  const shipped = readJson(root, "plugins/superpowers/.claude-plugin/plugin.json").version;
  const fragment = `${FRAGMENT_DIR}/superpowers-${chooseSuperpowersVersion(shipped, version)}.md`;
  const skills = [...new Set(source.files.map((file) => /^skills\/[^/]+\//u.exec(file.sourcePath)?.[0]).filter(Boolean))];
  const incoming = [...upstream.entries.keys()]
    .filter((file) => skills.some((skill) => file.startsWith(skill)))
    .map((file) => `plugins/superpowers/${file}`);
  const paths = [...new Set([
    "upstream-sources.lock.json", ...source.files.flatMap((file) => [file.generatedPath, file.upstreamPath ?? file.generatedPath]),
    ...hookCompat.OUTPUT_PATHS, ...SUPERPOWERS_VERSION_FILES, ...SUPERPOWERS_RANGE_FILES.map((site) => site.file),
    SUPERPOWERS_README, fragment, ...incoming,
  ])];
  const before = hookCompat.snapshot({ root, paths, io });
  for (const file of source.files) {
    const rawPath = file.upstreamPath ?? file.generatedPath;
    const current = before.get(rawPath);
    if (current === null || sha256(current.content) !== file.sha256) {
      throw new Error(`Superpowers refresh: current raw SHA-256 drift: ${rawPath}`);
    }
  }
  const lockedPaths = new Set(source.files.map((file) => file.generatedPath));
  for (const file of incoming) {
    if (!lockedPaths.has(file) && before.get(file) !== null) throw new Error(`Superpowers refresh: occupied incoming source path: ${file}`);
  }
  const guard = { path: null, identity: null, content: null };
  const guardAllocation = { status: "not-attempted", path: null, identity: null };
  const candidateAllocation = { status: "not-attempted", path: null, identity: null };
  let guardJournal;
  let candidateRoot;
  let candidateIdentity;
  const guardState = { status: "candidate-preparing", guardAllocation, candidateAllocation };
  let guardContent = Buffer.from(JSON.stringify(guardState, null, 2) + "\n");
  const writeGuard = (next, initial = false) => {
    if (!guard.path || !guard.identity || !hookCompat.sameDirectory(guard.path, guard.identity, io)) {
      throw new Error("original guard directory changed before journal transition");
    }
    if (initial) {
      try {
        io.lstatSync(guardJournal);
        throw new Error("initial guard journal path occupied");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else if (!hookCompat.readOwnedJournal(guardJournal, guard.journalIdentity, io).content.equals(guard.content)) {
      throw new Error("original guard journal changed before transition");
    }
    const journalIdentity = hookCompat.writeOwnedJournal(guardJournal, guard.journalIdentity, guard.content, next, initial, io);
    if (!hookCompat.sameDirectory(guard.path, guard.identity, io)
      || !hookCompat.readOwnedJournal(guardJournal, journalIdentity, io).content.equals(next)) {
      throw new Error("guard journal transition readback changed");
    }
    guardContent = next;
    guard.content = next;
    guard.journalIdentity = journalIdentity;
  };
  let failure;
  let noChangeSettlement = false;
  const reAdmitUnchangedConsumer = () => {
    // An empty publish still qualifies every before-image and the original held guard, without writing.
    hookCompat.publish({ root, artifacts: [], before, io, heldGuard: guard });
    hookCompat.assertNoPendingRecovery(root, io, guard);
  };
  try {
    guard.path = hookCompat.allocateDirectory({ parent: root, prefix: ".superpowers-hook-transaction-guard-", io, state: guardAllocation });
    guard.identity = guardAllocation.identity;
    guardJournal = path.join(guard.path, "journal.json");
    guardContent = Buffer.from(JSON.stringify(guardState, null, 2) + "\n");
    writeGuard(guardContent, true);
    candidateRoot = hookCompat.allocateDirectory({ parent: os.tmpdir(), prefix: "superpowers-hook-candidate-", io, state: candidateAllocation });
    candidateIdentity = candidateAllocation.identity;
    Object.assign(guardState, { status: "candidate-prepared", candidateRoot, candidateIdentity });
    writeGuard(Buffer.from(JSON.stringify(guardState, null, 2) + "\n"));
    for (const [file, current] of before) {
      if (current === null) continue;
      const target = path.join(candidateRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, current.content);
      fs.chmodSync(target, current.mode);
    }
    const report = updateSource({
      lockPath: path.join(candidateRoot, "upstream-sources.lock.json"),
      sourceId: SOURCE_ID,
      upstream,
    });
    if (!report.changed) {
      const compatibility = hookCompat.verify({ root: candidateRoot });
      reAdmitUnchangedConsumer();
      noChangeSettlement = true;
      return { ...report, compatibility, release: null };
    }
    if (before.get(fragment) !== null) throw new Error(`Superpowers refresh: release fragment already exists: ${fragment}`);
    const compatibility = hookCompat.generate({ root: candidateRoot, io });
    const released = release({ root: candidateRoot, report, upstream: version, upstreamTree: upstream });
    const candidate = hookCompat.snapshot({ root: candidateRoot, paths });
    const artifacts = [...candidate].map(([file, current]) => ({
      path: file, content: current?.content ?? null, ...(current === null ? {} : { mode: current.mode }),
    }));
    hookCompat.publish({ root, artifacts, before, io, heldGuard: guard });
    return { ...report, compatibility, release: released };
  } catch (error) {
    guard.path ??= guardAllocation.path;
    candidateRoot ??= candidateAllocation.path;
    failure = error;
    throw error;
  } finally {
    try {
      if (!candidateRoot || !candidateIdentity) throw new Error("candidate creation outcome is not fully observed");
      hookCompat.assertNoPendingRecovery(candidateRoot, io);
      if (!hookCompat.sameDirectory(candidateRoot, candidateIdentity, io)) throw new Error("candidate directory identity changed");
      io.rmSync(candidateRoot, { recursive: true });
      if (io.existsSync(candidateRoot)) throw new Error(`candidate still exists: ${candidateRoot}`);
      if (noChangeSettlement) reAdmitUnchangedConsumer();
      if (!hookCompat.sameDirectory(guard.path, guard.identity, io)) throw new Error("consumer guard directory identity changed");
      if (!hookCompat.readOwnedJournal(guardJournal, guard.journalIdentity, io).content.equals(guardContent)) {
        throw new Error("consumer guard journal changed");
      }
      io.unlinkSync(guardJournal);
      io.rmdirSync(guard.path);
    } catch (cleanupError) {
      const error = failure ?? new Error(`Superpowers refresh completed, but candidate cleanup is unresolved: ${candidateRoot}`, { cause: cleanupError });
      if (guard.path && !io.existsSync(guard.path)) {
        try {
          const rearm = { status: "not-attempted", path: null, identity: null };
          guardState.rearmAllocation = rearm;
          try {
            guard.path = hookCompat.allocateDirectory({ parent: root, prefix: ".superpowers-hook-transaction-guard-", io, state: rearm });
          } catch (rearmError) {
            guard.path = rearm.path;
            guard.identity = rearm.identity;
            throw rearmError;
          }
          guard.identity = rearm.identity;
          guardJournal = path.join(guard.path, "journal.json");
          writeGuard(guardContent, true);
        } catch (guardError) {
          error.guardCreationError = guardError.message;
        }
      }
      let blockingEstablished = false;
      const observedRetainedRoots = [];
      try {
        for (const retained of [guard.path, candidateRoot,
          failure?.recoveryPath?.startsWith(`${candidateRoot}${path.sep}`) ? failure.recoveryPath : null].filter(Boolean)) {
          try {
            if (io.existsSync(retained)) observedRetainedRoots.push(retained);
          } catch (observationError) {
            if (observationError.code !== "ENOENT") {
              error.retainedObservationErrors ??= [];
              error.retainedObservationErrors.push({ path: retained, reason: observationError.message });
            }
          }
        }
        blockingEstablished = io.readdirSync(root).some((name) => name.startsWith(".superpowers-hook-transaction-")
          && observedRetainedRoots.includes(path.join(root, name)));
      } catch (blockingError) {
        error.guardCreationError = [error.guardCreationError, blockingError.message].filter(Boolean).join("; ");
      }
      error.retryBlockingEstablished = blockingEstablished;
      error.message += `; candidate recovery uncertain; ${blockingEstablished ? `retry blocked by retained consumer guard` : "retry BLOCKING NOT ESTABLISHED"}: ${cleanupError.message}`;
      error.candidateCleanupPath = candidateRoot;
      error.consumerGuardPath = guard.path;
      error.retainedRoots = observedRetainedRoots;
      error.candidateRecoveryState = {
        ...guardState, status: "UNKNOWN", primary_failure: failure?.message ?? null,
        nested_recovery: failure?.recoveryState ?? null, unresolved: [{ path: candidateRoot, reason: cleanupError.message }],
        retryBlockingEstablished: blockingEstablished,
        beforeImages: [...before].map(([file, current]) => ({
          path: file, content: current === null ? null : current.content.toString("base64"), mode: current?.mode ?? null,
        })),
        observationErrors: error.retainedObservationErrors ?? [],
      };
      if (error.guardCreationError) error.candidateRecoveryState.unresolved.push({ path: root, reason: error.guardCreationError });
      try {
        if (!guard.path || !guard.identity || !hookCompat.sameDirectory(guard.path, guard.identity, io)
          || !guardJournal || !hookCompat.readOwnedJournal(guardJournal, guard.journalIdentity, io).content.equals(guardContent)) {
          throw new Error("consumer guard changed; retained without overwriting");
        }
        writeGuard(Buffer.from(JSON.stringify(error.candidateRecoveryState, null, 2) + "\n"));
      } catch (journalError) {
        error.candidateRecoveryState.unresolved.push({ path: guardJournal, reason: journalError.message });
      }
      error.recoveryStatus = "UNKNOWN";
      error.recoveryState ??= error.candidateRecoveryState;
      error.recoveryPath ??= candidateRoot ?? guard.path;
      throw error;
    }
  }
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

// Desk's own text files: tracked files in a checkout, otherwise every file outside dot and dependency directories.
function deskFiles(root, run) {
  const listed = run("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  let files = listed.status === 0 ? listed.stdout.split("\0").filter(Boolean) : [];
  if (files.length === 0) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if ((entry.name.startsWith(".") && entry.isDirectory()) || entry.name === "node_modules") continue;
        const file = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) files.push(file);
      }
    };
    walk("");
  }
  return files.flatMap((file) => {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return [];
    const bytes = fs.readFileSync(full);
    return bytes.includes(0) ? [] : [{ path: file, text: bytes.toString("utf8") }];
  });
}

function main(argv = process.argv.slice(2), { stdout = process.stdout, run = spawnSync } = {}) {
  const options = parseArgs(argv);
  const root = path.resolve(options.root);
  const upstream = createGitTreeReader({ dir: path.resolve(options.upstreamDir), ref: options.ref, run });
  const result = refresh({ root, upstream });
  if (result.changed) {
    const { referencesToRemoved } = require("./superpowers-upstream-pr.cjs");
    result.desk_references = result.removed_paths.length === 0 ? [] : referencesToRemoved(result.removed_paths, deskFiles(root, run));
  }
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
  SUPERPOWERS_RANGE_FILES,
  SUPERPOWERS_VERSION_FILES,
  chooseSuperpowersVersion,
  main,
  refresh,
  upstreamVersion,
  versionToken,
};
