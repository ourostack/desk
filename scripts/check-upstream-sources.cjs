#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const ancestryStates = new Set(["identical", "ahead", "behind", "diverged"]);
// SHA-256 of the Gauntlet LICENSE (Apache-2.0) reviewed for the evaluation leaves exception.
const APPROVED_GAUNTLET_LICENSE_SHA256 = "bab74adbfbcdc79e08e43573584ef6e0bc067354e8306aa4128c245967ee549f";

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function selectedPayloadDigest(files) {
  const content = [...files]
    .sort((left, right) => left.source_path.localeCompare(right.source_path))
    .map((file) => `${file.source_path}\0${file.candidate_sha256}\n`)
    .join("");
  return sha256(content);
}

function createGitHubClient(run = spawnSync) {
  function get(endpoint) {
    const result = run("gh", ["api", endpoint], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const error = String(
        result.stderr || result.stdout || result.error?.message || `exit ${result.status}`,
      ).trim();
      throw new Error(`gh api ${endpoint} failed: ${error}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`gh api ${endpoint} returned invalid JSON: ${error.message}`);
    }
  }

  function repository(repository) {
    return get(`repos/${repository}`);
  }

  function latestRelease(repository) {
    const releases = get(`repos/${repository}/releases?per_page=100`);
    if (!Array.isArray(releases)) {
      throw new Error(`${repository} releases endpoint did not return an array`);
    }
    for (const release of releases) {
      if (
        typeof release?.draft !== "boolean" ||
        typeof release?.prerelease !== "boolean"
      ) {
        throw new Error(`${repository} releases endpoint returned malformed release metadata`);
      }
    }
    const published = releases.find((release) => !release.draft && !release.prerelease) ?? null;
    if (
      published &&
      (typeof published.tag_name !== "string" || typeof published.html_url !== "string")
    ) {
      throw new Error(`${repository} published release is missing tag or URL evidence`);
    }
    return published;
  }

  function commit(repository, ref) {
    return get(`repos/${repository}/commits/${encodeURIComponent(ref)}`);
  }

  function compare(repository, base, head) {
    return get(`repos/${repository}/compare/${base}...${head}`);
  }

  function file(repository, sourcePath, ref) {
    const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
    const response = get(`repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    if (response.type !== "file" || response.encoding !== "base64" || typeof response.content !== "string") {
      throw new Error(`${repository}:${sourcePath}@${ref} did not resolve to base64 file content`);
    }
    return Buffer.from(response.content.replace(/\s/gu, ""), "base64");
  }

  // The names at the top of a commit's tree, where a repository keeps its NOTICE or COPYING file.
  function topLevel(repository, ref) {
    const response = get(`repos/${repository}/git/trees/${encodeURIComponent(ref)}`);
    if (!Array.isArray(response.tree) || response.truncated === true) {
      throw new Error(`${repository}@${ref} did not return a complete top-level tree`);
    }
    return response.tree.map((entry) => entry.path);
  }

  return { repository, latestRelease, commit, compare, file, topLevel };
}

// Apache-2.0 section 4(d) makes a NOTICE file's contents part of what a redistributor must carry, and a COPYING file can
// add terms, so one that the lock does not vendor needs a person's review even when LICENSE itself is unchanged.
const LICENSE_NOTICE = /^(?:NOTICE|COPYING)(?:\.|$)/iu;

function compareAncestry(github, repository, base, head) {
  const status = github.compare(repository, base, head).status;
  if (!ancestryStates.has(status)) {
    throw new Error(`unknown ancestry status for ${repository}: ${status ?? "missing"}`);
  }
  return status;
}

function inspectSource(source, github) {
  if (!/^[^/]+\/[^/]+$/u.test(source.repository)) {
    throw new Error(`invalid repository identity: ${source.repository}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(source.commit)) {
    throw new Error(`invalid locked commit for ${source.id}: ${source.commit}`);
  }
  if (!Array.isArray(source.files) || source.files.length === 0) {
    throw new Error(`source ${source.id} has no selected files`);
  }
  // The Apache-2.0 exception was approved for the Gauntlet files under the license text reviewed at commit
  // 187a9af979a7cf096c0890d0eeb998cc3008343a, so it follows those LICENSE bytes rather than one commit: an upstream
  // move that leaves the license alone keeps the approval, and one that changes it lists LICENSE as a changed path.
  const approvedGauntlet = source.id === "prime-radiant-inc-gauntlet-evaluation-leaves"
    && source.repository === "prime-radiant-inc/gauntlet"
    && source.files.some((file) => file.sourcePath === "LICENSE" && file.sha256 === APPROVED_GAUNTLET_LICENSE_SHA256);
  if (approvedGauntlet && source.license !== "Apache-2.0") {
    throw new Error(`approved Gauntlet source must lock Apache-2.0: got ${source.license ?? "missing"}`);
  }
  if (source.license !== "MIT" && !approvedGauntlet) {
    throw new Error(`unsupported locked license for ${source.id}: ${source.license ?? "missing"}`);
  }

  const repository = github.repository(source.repository);
  if (repository.full_name !== source.repository) {
    throw new Error(`repository identity mismatch: expected ${source.repository}, got ${repository.full_name}`);
  }
  const actualLicense = repository.license?.spdx_id ?? null;
  if (actualLicense !== source.license) {
    throw new Error(`${source.license} license evidence missing for ${source.repository}: got ${actualLicense ?? "unknown"}`);
  }

  const release = github.latestRelease(source.repository);
  let candidateRef = repository.default_branch;
  let candidateRefType = "default-branch";
  let candidateCommit;
  let releaseConsidered = null;
  if (release) {
    const releaseCommit = github.commit(source.repository, release.tag_name).sha;
    const releaseAncestry = releaseCommit === source.commit
      ? "identical"
      : compareAncestry(github, source.repository, source.commit, releaseCommit);
    releaseConsidered = {
      ref: release.tag_name,
      commit: releaseCommit,
      ancestry: releaseAncestry,
      url: release.html_url,
    };
    if (releaseAncestry === "identical" || releaseAncestry === "ahead") {
      candidateRef = release.tag_name;
      candidateRefType = "latest-release";
      candidateCommit = releaseCommit;
    }
  }
  candidateCommit ??= github.commit(source.repository, candidateRef).sha;
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    throw new Error(`invalid candidate commit for ${source.repository}:${candidateRef}`);
  }

  const ancestry = candidateCommit === source.commit
    ? "identical"
    : compareAncestry(github, source.repository, source.commit, candidateCommit);

  const selectedFiles = source.files.map((file) => {
    const candidateSha256 = sha256(github.file(source.repository, file.sourcePath, candidateCommit));
    return {
      source_path: file.sourcePath,
      generated_path: file.generatedPath,
      locked_sha256: file.sha256,
      candidate_sha256: candidateSha256,
      changed: candidateSha256 !== file.sha256,
    };
  });
  const changedPaths = selectedFiles.filter((file) => file.changed).map((file) => file.source_path);
  const vendored = new Set(source.files.map((file) => file.sourcePath));
  const unvendoredNotices = approvedGauntlet
    ? github.topLevel(source.repository, candidateCommit).filter((name) => LICENSE_NOTICE.test(name) && !vendored.has(name)).sort()
    : [];

  let classification;
  let reason;
  if (candidateCommit === source.commit && changedPaths.length === 0) {
    classification = "current";
    reason = "candidate and selected payload match the lock";
  } else if (candidateCommit === source.commit) {
    classification = "blocked";
    reason = "selected payload at the locked commit does not match the recorded hashes";
  } else if (ancestry !== "ahead") {
    classification = "blocked";
    reason = `candidate is not a forward update from the locked commit (${ancestry})`;
  } else if (changedPaths.length === 0) {
    classification = "candidate-no-selected-payload-change";
    reason = "repository advanced without changing selected payload";
  } else {
    classification = "needs-human-approval";
    reason = "forward candidate changes selected payload";
  }
  if (classification !== "blocked" && unvendoredNotices.length > 0) {
    classification = "needs-human-approval";
    reason = `upstream has license notice files the lock does not vendor (${unvendoredNotices.join(", ")}); review them and add them to the lock`;
  }

  return {
    id: source.id,
    repository: source.repository,
    repository_identity: repository.full_name,
    license: actualLicense,
    tracking: {
      strategy: candidateRefType,
      ref: candidateRef,
      url: candidateRefType === "latest-release"
        ? release.html_url
        : `${repository.html_url}/commit/${candidateCommit}`,
      release_considered: releaseConsidered,
    },
    locked_commit: source.commit,
    candidate_commit: candidateCommit,
    ancestry,
    selected_payload_digest: selectedPayloadDigest(selectedFiles),
    changed_paths: changedPaths,
    unvendored_license_notices: unvendoredNotices,
    classification,
    reason,
    selected_files: selectedFiles,
  };
}

function inspectSources(lock, github) {
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources) || lock.sources.length === 0) {
    throw new Error("upstream source lock must use schemaVersion 1 with a non-empty sources array");
  }
  return lock.sources.map((source) => {
    try {
      return inspectSource(source, github);
    } catch (error) {
      return {
        id: source?.id ?? null,
        repository: source?.repository ?? null,
        locked_commit: source?.commit ?? null,
        classification: "blocked",
        reason: error.message,
      };
    }
  });
}

const REGULAR_FILE_MODES = new Map([["100644", 0o644], ["100755", 0o755]]);

// Reads an upstream tree from the Git object store, not a working tree, so the vendored bytes are the committed
// blobs: a checkout's end-of-line or attribute conversion can never leak into the pristine copy.
function createGitTreeReader({ dir, ref = "HEAD", run = spawnSync }) {
  function git(args, encoding = "utf8") {
    const result = run("git", ["-C", dir, ...args], {
      encoding,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const error = String(result.stderr || result.error?.message || `exit ${result.status}`).trim();
      throw new Error(`git ${args.join(" ")} failed: ${error}`);
    }
    return result.stdout;
  }
  const commit = git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  const tree = git(["rev-parse", "--verify", `${commit}^{tree}`]).trim();
  const entries = new Map();
  for (const record of git(["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, object] = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), { mode, type, object });
  }
  return {
    commit,
    tree,
    entries,
    read(sourcePath) {
      return git(["cat-file", "blob", entries.get(sourcePath).object], "buffer");
    },
  };
}

function skillDirectory(sourcePath) {
  return /^skills\/[^/]+\//u.exec(sourcePath)?.[0] ?? null;
}

function generatedPrefix(source) {
  const prefixes = new Set(source.files.map((file) => {
    if (!file.generatedPath.endsWith(`/${file.sourcePath}`)) {
      throw new Error(`${source.id}: ${file.generatedPath} does not mirror ${file.sourcePath}`);
    }
    return file.generatedPath.slice(0, -file.sourcePath.length);
  }));
  if (prefixes.size !== 1) {
    throw new Error(`${source.id}: generated paths do not share one vendored root`);
  }
  return [...prefixes][0];
}

function selectedUpstreamPaths(source, upstream) {
  const selectedSkills = new Set();
  const explicit = [];
  for (const file of source.files) {
    const skill = skillDirectory(file.sourcePath);
    if (skill) selectedSkills.add(skill);
    else explicit.push(file.sourcePath);
  }
  const selected = new Set();
  for (const sourcePath of explicit) {
    if (!upstream.entries.has(sourcePath)) {
      throw new Error(`selected upstream file was removed: ${sourcePath}`);
    }
    selected.add(sourcePath);
  }
  // A skill is vendored as its whole directory, so a file upstream adds to a selected skill (a script or reference
  // its SKILL.md now names) arrives with it, and a file upstream deletes leaves with it. A new skill is never
  // selected automatically; it is reported for a person or agent to decide.
  for (const skill of selectedSkills) {
    const files = [...upstream.entries.keys()].filter((sourcePath) => sourcePath.startsWith(skill));
    if (files.length === 0) throw new Error(`selected upstream skill was removed: ${skill}`);
    for (const sourcePath of files) selected.add(sourcePath);
  }
  for (const sourcePath of selected) {
    const entry = upstream.entries.get(sourcePath);
    if (entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode)) {
      throw new Error(`selected upstream path is not a regular file: ${sourcePath} (${entry.mode} ${entry.type})`);
    }
  }
  const unselectedSkills = [...new Set([...upstream.entries.keys()]
    .map(skillDirectory)
    .filter((skill) => skill && !selectedSkills.has(skill)))]
    .map((skill) => skill.slice(0, -1))
    .sort();
  // Default sort orders by UTF-16 code unit, the byte order of these ASCII paths, which the checked-in lock uses.
  return { selected: [...selected].sort(), unselectedSkills };
}

function formatFileEntry(file, compact) {
  if (compact) {
    return `{"sourcePath": ${JSON.stringify(file.sourcePath)}, "generatedPath": ${JSON.stringify(file.generatedPath)}, "sha256": ${JSON.stringify(file.sha256)}}`;
  }
  return JSON.stringify(file, null, 2).replace(/\n/gu, "\n        ");
}

function indentJson(value, indent) {
  return JSON.stringify(value, null, 2).replace(/\n/gu, `\n${indent}`);
}

// Reproduces the checked-in lock layout exactly: each source keeps the file-entry style it already uses (one line per
// file, or expanded), so a refresh diff shows only the entries that actually changed.
function formatLock(lock, compactSourceIds) {
  const sources = lock.sources.map((source) => {
    const fields = Object.entries(source).map(([key, value]) => {
      if (key !== "files") return `      ${JSON.stringify(key)}: ${indentJson(value, "      ")}`;
      const compact = compactSourceIds.has(source.id);
      const files = value.map((file) => `        ${formatFileEntry(file, compact)}`).join(",\n");
      return `      "files": [\n${files}\n      ]`;
    });
    return `    {\n${fields.join(",\n")}\n    }`;
  });
  const top = Object.entries(lock).map(([key, value]) => (key === "sources"
    ? `  "sources": [\n${sources.join(",\n")}\n  ]`
    : `  ${JSON.stringify(key)}: ${indentJson(value, "  ")}`));
  return `{\n${top.join(",\n")}\n}\n`;
}

function compactSources(lockText, lock) {
  return new Set(lock.sources
    .filter((source) => source.files.length > 0 && lockText.includes(formatFileEntry(source.files[0], true)))
    .map((source) => source.id));
}

const defaultFsOps = {
  read: (filePath) => fs.readFileSync(filePath),
  exists: (filePath) => fs.existsSync(filePath),
  write(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  },
  mode: (filePath) => fs.statSync(filePath).mode & 0o777,
  chmod: (filePath, mode) => fs.chmodSync(filePath, mode),
  remove: (filePath) => fs.rmSync(filePath, { force: true }),
  pruneEmptyParents(filePath, stopAt) {
    let directory = path.dirname(filePath);
    while (directory.startsWith(`${stopAt}${path.sep}`) && fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
      directory = path.dirname(directory);
    }
  },
};

// Refreshes one locked source from an upstream tree: every selected file is copied byte for byte with its executable
// bit, removed files are deleted, and the lock records the new commit and hashes. When no selected byte or mode
// changed, nothing is written, so an upstream commit that touches only unselected files is not a refresh.
function updateSource({ lockPath, sourceId, upstream, fsOps = defaultFsOps }) {
  const lockText = fs.readFileSync(lockPath, "utf8");
  const lock = JSON.parse(lockText);
  const source = lock.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`upstream source lock has no source ${sourceId}`);
  const root = path.dirname(lockPath);
  const prefix = generatedPrefix(source);
  const { selected, unselectedSkills } = selectedUpstreamPaths(source, upstream);
  const locked = new Map(source.files.map((file) => [file.sourcePath, file]));
  const report = {
    source_id: source.id,
    repository: source.repository,
    previous_commit: source.commit,
    commit: upstream.commit,
    tree: upstream.tree,
    changed: false,
    added_paths: [],
    updated_paths: [],
    mode_changed_paths: [],
    removed_paths: [],
    unselected_skills: unselectedSkills,
  };
  const files = [];
  const writes = [];
  for (const sourcePath of selected) {
    const content = upstream.read(sourcePath);
    const file = { sourcePath, generatedPath: `${prefix}${sourcePath}`, sha256: sha256(content) };
    files.push(file);
    const target = path.join(root, file.generatedPath);
    const mode = REGULAR_FILE_MODES.get(upstream.entries.get(sourcePath).mode);
    const present = fsOps.exists(target);
    if (!locked.has(sourcePath)) report.added_paths.push(sourcePath);
    else if (locked.get(sourcePath).sha256 !== file.sha256 || !present || sha256(fsOps.read(target)) !== file.sha256) {
      report.updated_paths.push(sourcePath);
    } else if ((fsOps.mode(target) & 0o111) !== (mode & 0o111)) {
      report.mode_changed_paths.push(sourcePath);
    } else {
      continue;
    }
    writes.push({ target, content, mode });
  }
  report.removed_paths = source.files
    .map((file) => file.sourcePath)
    .filter((sourcePath) => !selected.includes(sourcePath));
  report.changed = writes.length > 0 || report.removed_paths.length > 0;
  if (!report.changed) return report;

  for (const { target, content, mode } of writes) {
    fsOps.write(target, content);
    fsOps.chmod(target, mode);
  }
  const vendoredRoot = path.join(root, prefix);
  for (const sourcePath of report.removed_paths) {
    const target = path.join(root, locked.get(sourcePath).generatedPath);
    fsOps.remove(target);
    fsOps.pruneEmptyParents(target, path.resolve(vendoredRoot));
  }
  const compact = compactSources(lockText, lock);
  source.commit = upstream.commit;
  source.files = files;
  fs.writeFileSync(lockPath, formatLock(lock, compact));
  return report;
}

function parseArgs(argv) {
  const options = { lockPath: path.join(repoRoot, "upstream-sources.lock.json"), update: false };
  const values = { "--lock": "lockPath", "--source": "sourceId", "--upstream-dir": "upstreamDir", "--ref": "ref" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--update") {
      options.update = true;
      continue;
    }
    const key = values[argv[index]];
    if (key && argv[index + 1]) {
      options[key] = argv[index] === "--lock" || argv[index] === "--upstream-dir"
        ? path.resolve(argv[index + 1])
        : argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown or incomplete argument: ${argv[index]}`);
  }
  if (options.update && (!options.sourceId || !options.upstreamDir)) {
    throw new Error("--update requires --source <id> and --upstream-dir <git checkout>");
  }
  return options;
}

function main(
  argv = process.argv.slice(2),
  {
    github = createGitHubClient(),
    now = () => new Date().toISOString(),
    stdout = process.stdout,
    run = spawnSync,
  } = {},
) {
  const options = parseArgs(argv);
  if (options.update) {
    const upstream = createGitTreeReader({ dir: options.upstreamDir, ref: options.ref, run });
    const report = updateSource({ lockPath: options.lockPath, sourceId: options.sourceId, upstream });
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const { lockPath } = options;
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const sources = inspectSources(lock, github);
  const summary = sources.reduce((counts, source) => {
    counts[source.classification] = (counts[source.classification] ?? 0) + 1;
    return counts;
  }, {});
  const report = {
    schema_version: 1,
    checked_at: now(),
    lock_path: path.relative(repoRoot, lockPath),
    summary,
    sources,
  };
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (sources.some((source) => source.classification === "blocked")) return 1;
  if (sources.some((source) => source.classification === "needs-human-approval")) return 2;
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
  createGitHubClient,
  createGitTreeReader,
  formatLock,
  compactSources,
  inspectSource,
  inspectSources,
  main,
  selectedPayloadDigest,
  sha256,
  updateSource,
};
