#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const GENERATOR = "scripts/superpowers-hook-compat.cjs";
const RAW = "plugins/superpowers/hooks/upstream/run-hook.cmd";
const CMD = "plugins/superpowers/hooks/run-hook.cmd";
const UNIX = "plugins/superpowers/hooks/run-hook-unix";
const PROVENANCE = "plugins/superpowers/hooks/run-hook-compat.provenance.json";
const OUTPUT_PATHS = [CMD, UNIX, PROVENANCE];
const defaultRoot = path.resolve(__dirname, "..");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function transform(raw) {
  const text = raw.toString("utf8");
  const opening = ": << 'CMDBLOCK'\n";
  const closing = "\nCMDBLOCK\n";
  const end = text.indexOf(closing);
  if (!Buffer.from(text).equals(raw) || !text.startsWith(opening) || end < opening.length
    || text.indexOf(closing, end + closing.length) !== -1) {
    throw new Error("Superpowers hook compatibility: unknown raw wrapper layout; requalify the downstream transform");
  }
  const batch = text.slice(opening.length, end);
  const unix = text.slice(end + closing.length);
  if (!batch.startsWith("@echo off\n") || !/\nexit \/b (?:0|%ERRORLEVEL%)$/u.test(batch)
    || !unix.startsWith("\n# Unix: run the named script directly\n") || !/\nexec [^\n]+\n$/u.test(unix)) {
    throw new Error("Superpowers hook compatibility: unknown batch/Unix layout; requalify the downstream transform");
  }
  // CMD ignores the label; Unix replaces itself before parsing any batch text.
  const trampoline = ':; d="${0%[/\\\\]*}"; if [ "$d" = "$0" ]; then d=.; fi; exec "${BASH:-bash}" "$d/run-hook-unix" "$@"; exit $?\n';
  return { cmd: trampoline + batch + "\n", unix };
}

function readRegular(file, io = fs) {
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Superpowers hook compatibility: not a regular single-link file: ${file}`);
  return io.readFileSync(file);
}

function snapshot({ root, paths, io = fs }) {
  const states = new Map();
  for (const relative of [...new Set(paths)]) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Superpowers compatibility: out-of-root path: ${relative}`);
    let directory = path.dirname(file);
    while (directory !== path.resolve(root)) {
      try {
        if (!io.lstatSync(directory).isDirectory()) throw new Error(`Superpowers compatibility: nonregular directory: ${directory}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = path.dirname(directory);
    }
    let stat;
    try {
      stat = io.lstatSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      states.set(relative, null);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Superpowers hook compatibility: not a regular output file: ${file}`);
    const content = io.readFileSync(file);
    const after = io.lstatSync(file);
    if (stat.ino !== after.ino || stat.dev !== after.dev || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) {
      throw new Error(`Superpowers compatibility: concurrent read change: ${file}`);
    }
    states.set(relative, { content, stat: after, mode: after.mode & 0o777 });
  }
  return states;
}

function matches(current, expected) {
  if (current === null || expected === null) return current === expected;
  return current.stat.ino === expected.stat.ino && current.stat.dev === expected.stat.dev
    && current.mode === expected.mode && current.content.equals(expected.content);
}

function directoryIdentity(file, io = fs) {
  const stat = io.lstatSync(file);
  if (!stat.isDirectory()) throw new Error(`Superpowers compatibility: not an owned directory: ${file}`);
  return { ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777, birthtimeMs: stat.birthtimeMs };
}

function sameDirectory(file, identity, io = fs) {
  const current = directoryIdentity(file, io);
  return Object.keys(identity).every((key) => current[key] === identity[key]);
}

function journalIdentity(stat) {
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("guard journal must be a regular single-link file");
  return { ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777, birthtimeMs: stat.birthtimeMs };
}

function admitJournalStat(stat, expected) {
  const identity = journalIdentity(stat);
  if (expected && Object.keys(expected).some((key) => identity[key] !== expected[key])) {
    throw new Error("original guard journal file identity changed");
  }
  return identity;
}

function readOwnedJournal(file, expected, io = fs) {
  admitJournalStat(io.lstatSync(file), expected);
  const fd = io.openSync(file, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW ?? 0));
  try {
    const identity = admitJournalStat(io.fstatSync(fd), expected);
    const content = io.readFileSync(fd);
    admitJournalStat(io.lstatSync(file), identity);
    admitJournalStat(io.fstatSync(fd), identity);
    return { content, identity };
  } finally {
    io.closeSync(fd);
  }
}

function writeOwnedJournal(file, expected, previous, next, initial, io = fs) {
  if (!initial) {
    if (!expected || !readOwnedJournal(file, expected, io).content.equals(previous)) throw new Error("original guard journal changed");
  }
  const flags = io.constants.O_RDWR | (io.constants.O_NOFOLLOW ?? 0)
    | (initial ? io.constants.O_CREAT | io.constants.O_EXCL : 0);
  const fd = io.openSync(file, flags, 0o600);
  try {
    const identity = admitJournalStat(io.fstatSync(fd), initial ? null : expected);
    admitJournalStat(io.lstatSync(file), identity);
    if (!initial && !io.readFileSync(fd).equals(previous)) throw new Error("guard journal descriptor bytes changed");
    io.ftruncateSync(fd, 0);
    // Positional writes do not depend on the prior descriptor read offset.
    let offset = 0;
    while (offset < next.length) {
      const written = io.writeSync(fd, next, offset, next.length - offset, offset);
      if (written <= 0) throw new Error("guard journal write made no progress");
      offset += written;
    }
    admitJournalStat(io.fstatSync(fd), identity);
    admitJournalStat(io.lstatSync(file), identity);
    if (!readOwnedJournal(file, identity, io).content.equals(next)) throw new Error("guard journal qualified readback changed");
    return identity;
  } finally {
    io.closeSync(fd);
  }
}

function assertNoPendingRecovery(root, io = fs, heldGuard, ownedTransaction) {
  if (heldGuard) {
    try {
      if (!heldGuard.identity || !heldGuard.journalIdentity || !Buffer.isBuffer(heldGuard.content)
        || !sameDirectory(heldGuard.path, heldGuard.identity, io)
        || !readOwnedJournal(path.join(heldGuard.path, "journal.json"), heldGuard.journalIdentity, io).content.equals(heldGuard.content)) {
        throw new Error("held guard identity or captured journal changed");
      }
    } catch (cause) {
      throw new Error(`Superpowers compatibility: original held guard is not admitted: ${heldGuard.path}`, { cause });
    }
  }
  const pending = io.readdirSync(root).find((name) => {
    if (!name.startsWith(".superpowers-hook-transaction-")) return false;
    const file = path.join(root, name);
    if (ownedTransaction?.path === file && sameDirectory(file, ownedTransaction.identity, io)) return false;
    return heldGuard?.path !== file || !sameDirectory(file, heldGuard.identity, io);
  });
  if (pending) throw new Error(`Superpowers compatibility: unresolved transaction; inspect recovery evidence before retry: ${path.join(root, pending)}`);
}

function allocateDirectory({ parent, prefix, io = fs, state }) {
  state.path = path.join(parent, `${prefix}${crypto.randomUUID()}`);
  state.status = "creation-attempted";
  io.mkdirSync(state.path);
  state.identity = directoryIdentity(state.path, io);
  state.status = "creation-observed";
  return state.path;
}

// Before-images, staged candidates and a journal survive any unresolved rollback.
function publish({ root, artifacts, before, io = fs, heldGuard }) {
  assertNoPendingRecovery(root, io, heldGuard);
  before ??= snapshot({ root, paths: artifacts.map((file) => file.path), io });
  const changes = artifacts.filter((file) => {
    if (!before.has(file.path)) throw new Error(`Superpowers compatibility: missing before-image: ${file.path}`);
    const prior = before.get(file.path);
    return file.content === null ? prior !== null : prior === null || !prior.content.equals(file.content)
      || (file.mode !== undefined && prior.mode !== file.mode);
  });
  for (const [file, expected] of before) {
    if (!matches(snapshot({ root, paths: [file], io }).get(file), expected)) {
      throw new Error(`Superpowers compatibility: concurrent pre-publish change: ${file}`);
    }
  }
  if (changes.length === 0) return;
  let recoveryPath;
  let recoveryIdentity;
  let journalPath;
  const allocation = { status: "not-attempted", path: null, identity: null };
  const entries = [];
  const directories = [];
  const inputs = [...before].map(([file, current], index) => ({
    path: file, sha256: current === null ? null : hash(current.content),
    before_image: current === null ? null : `input-${index}`,
    identity: current === null ? null : { ino: current.stat.ino, dev: current.stat.dev, mode: current.mode },
  }));
  const journal = { status: "prepared", root: path.resolve(root), entries, inputs, directories, allocation };
  const admitRecovery = () => {
    if (!recoveryPath || !recoveryIdentity || !sameDirectory(recoveryPath, recoveryIdentity, io)) {
      throw new Error("captured recovery root ownership is not admitted");
    }
  };
  const saveJournal = () => {
    admitRecovery();
    io.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");
  };
  const recoveryState = () => ({
    ...JSON.parse(JSON.stringify(journal)),
    beforeImages: [...before].map(([file, current]) => ({
      path: file, content: current === null ? null : current.content.toString("base64"), mode: current?.mode ?? null,
    })),
    candidates: artifacts.map((file) => ({
      path: file.path, content: file.content === null ? null : file.content.toString("base64"), mode: file.mode ?? null,
    })),
  });
  const checkFinalMap = () => {
    assertNoPendingRecovery(root, io, heldGuard, { path: recoveryPath, identity: recoveryIdentity });
    const divergences = [];
    for (const [file, prior] of before) {
      try {
        const current = snapshot({ root, paths: [file], io }).get(file);
        const index = changes.findIndex((entry) => entry.path === file);
        const expected = index < 0 ? prior : changes[index].content === null ? null
          : { content: changes[index].content, stat: entries[index].installedIdentity, mode: entries[index].installedIdentity.mode };
        if (!matches(current, expected)) divergences.push({ path: file, reason: "complete final map diverged",
          current_sha256: current === null ? null : hash(current.content) });
      } catch (error) {
        divergences.push({ path: file, reason: error.message });
      }
    }
    if (divergences.length) {
      const error = new Error("Superpowers compatibility: complete final map diverged before settlement");
      error.divergences = divergences;
      throw error;
    }
  };
  try {
    recoveryPath = allocateDirectory({ parent: root, prefix: ".superpowers-hook-transaction-", io, state: allocation });
    recoveryIdentity = allocation.identity;
    journalPath = path.join(recoveryPath, "journal.json");
    admitRecovery();
    for (const [index, current] of [...before.values()].entries()) {
      if (current !== null) {
        admitRecovery();
        io.writeFileSync(path.join(recoveryPath, `input-${index}`), current.content);
      }
    }
    for (const [index, file] of changes.entries()) {
      admitRecovery();
      const prior = before.get(file.path);
      const entry = { path: file.path, before: prior === null ? null : hash(prior.content),
        after: file.content === null ? null : hash(file.content), attempted: false };
      entries.push(entry);
      if (prior !== null) {
        admitRecovery();
        io.writeFileSync(path.join(recoveryPath, `before-${index}`), prior.content);
        admitRecovery();
        io.chmodSync(path.join(recoveryPath, `before-${index}`), prior.mode);
      }
      if (file.content !== null) {
        const staged = path.join(recoveryPath, `after-${index}`);
        admitRecovery();
        io.writeFileSync(staged, file.content);
        admitRecovery();
        io.chmodSync(staged, file.mode ?? prior?.mode ?? 0o644);
        admitRecovery();
        entry.installedIdentity = { ino: io.lstatSync(staged).ino, dev: io.lstatSync(staged).dev, mode: io.lstatSync(staged).mode & 0o777 };
      }
    }
    saveJournal();
    for (const [index, file] of changes.entries()) {
      assertNoPendingRecovery(root, io, heldGuard, { path: recoveryPath, identity: recoveryIdentity });
      admitRecovery();
      const target = path.join(root, file.path);
      if (!matches(snapshot({ root, paths: [file.path], io }).get(file.path), before.get(file.path))) {
        throw new Error(`Superpowers compatibility: concurrent publish change: ${file.path}`);
      }
      const missing = [];
      let directory = path.dirname(target);
      while (!io.existsSync(directory)) {
        missing.push(directory);
        directory = path.dirname(directory);
      }
      for (const next of missing.reverse()) {
        const record = { path: next, status: "creation-attempted", identity: null };
        directories.push(record);
        io.mkdirSync(next);
        const stat = io.lstatSync(next);
        if (!stat.isDirectory()) throw new Error(`Superpowers compatibility: created directory changed type: ${next}`);
        record.identity = { ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777, birthtimeMs: stat.birthtimeMs };
        record.status = "creation-observed";
      }
      admitRecovery();
      assertNoPendingRecovery(root, io, heldGuard, { path: recoveryPath, identity: recoveryIdentity });
      if (!matches(snapshot({ root, paths: [file.path], io }).get(file.path), before.get(file.path))) {
        throw new Error(`Superpowers compatibility: destination changed during publication preparation: ${file.path}`);
      }
      entries[index].attempted = true;
      if (file.content === null) io.renameSync(target, path.join(recoveryPath, `removed-${index}`));
      else io.renameSync(path.join(recoveryPath, `after-${index}`), target);
      saveJournal();
    }
    checkFinalMap();
    journal.status = "committed";
    saveJournal();
    checkFinalMap();
  } catch (cause) {
    const unresolved = [...(cause.divergences ?? [])];
    recoveryPath ??= allocation.path;
    journalPath ??= recoveryPath ? path.join(recoveryPath, "journal.json") : null;
    let rootAdmitted = true;
    try {
      admitRecovery();
    } catch (rootError) {
      rootAdmitted = false;
      unresolved.push({ path: recoveryPath, reason: rootError.message });
    }
    for (const [index, input] of inputs.entries()) {
      if (!unresolved.some((item) => item.path === input.path)) continue;
      try {
        admitRecovery();
        io.writeFileSync(path.join(recoveryPath, `current-input-${index}`), readRegular(path.join(root, input.path), io));
      } catch (error) {
        unresolved.push({ path: input.path, evidence_error: error.message });
      }
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry.attempted) continue;
      const prior = before.get(entry.path);
      const target = path.join(root, entry.path);
      try {
        admitRecovery();
        const current = snapshot({ root, paths: [entry.path], io }).get(entry.path);
        if (matches(current, prior)) continue;
        let owned;
        if (entry.after === null) {
          const removed = snapshot({ root: recoveryPath, paths: [`removed-${index}`], io }).get(`removed-${index}`);
          owned = current === null && matches(removed, prior);
        } else {
          owned = current !== null && current.stat.ino === entry.installedIdentity.ino
            && current.stat.dev === entry.installedIdentity.dev && current.mode === entry.installedIdentity.mode
            && hash(current.content) === entry.after;
        }
        if (!owned) throw new Error("current file is not the attributable installed candidate");
        if (prior === null) {
          admitRecovery();
          if (!matches(snapshot({ root, paths: [entry.path], io }).get(entry.path), current)) {
            throw new Error("rollback destination changed before removal");
          }
          io.unlinkSync(target);
        }
        else {
          const restore = path.join(recoveryPath, `restore-${index}`);
          admitRecovery();
          io.writeFileSync(restore, prior.content);
          admitRecovery();
          io.chmodSync(restore, prior.mode);
          admitRecovery();
          const stagedRestore = snapshot({ root: recoveryPath, paths: [`restore-${index}`], io }).get(`restore-${index}`);
          if (stagedRestore === null || !stagedRestore.content.equals(prior.content) || stagedRestore.mode !== prior.mode) {
            throw new Error("trusted restore bytes or mode changed before publication");
          }
          admitRecovery();
          if (!matches(snapshot({ root, paths: [entry.path], io }).get(entry.path), current)) {
            throw new Error("rollback destination changed during restore preparation");
          }
          io.renameSync(restore, target);
        }
        const restored = snapshot({ root, paths: [entry.path], io }).get(entry.path);
        if (prior === null ? restored !== null : restored === null || !restored.content.equals(prior.content) || restored.mode !== prior.mode) {
          throw new Error("restored before-image readback failed");
        }
      } catch (error) {
        unresolved.push({ path: entry.path, reason: error.message });
        try {
          admitRecovery();
          io.writeFileSync(path.join(recoveryPath, `current-${index}`), readRegular(target, io));
        } catch (evidenceError) {
          unresolved.push({ path: entry.path, evidence_error: evidenceError.message });
        }
      }
    }
    for (const directory of [...directories].reverse()) {
      try {
        if (!rootAdmitted) throw new Error("recovery root unqualified; directory cleanup withheld");
        if (directory.identity === null) throw new Error("directory creation outcome was not observed");
        const current = io.lstatSync(directory.path);
        const identity = directory.identity;
        if (!current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev
          || (current.mode & 0o777) !== identity.mode || current.birthtimeMs !== identity.birthtimeMs) {
          throw new Error("current directory is not the attributable created directory");
        }
        io.rmdirSync(directory.path);
        directory.status = "removal-observed";
      } catch (error) {
        unresolved.push({ path: directory.path, reason: error.message });
      }
    }
    journal.status = unresolved.length ? "UNKNOWN" : "restored";
    journal.failure = cause.message;
    journal.unresolved = unresolved;
    try {
      saveJournal();
    } catch (error) {
      journal.status = "UNKNOWN";
      journal.unresolved.push({ path: journalPath, reason: error.message });
    }
    if (journal.status === "restored") {
      try {
        if (!sameDirectory(recoveryPath, recoveryIdentity, io)) {
          throw Object.assign(new Error("recovery directory identity changed"), { code: "RECOVERY_IDENTITY_CHANGED" });
        }
        io.rmSync(recoveryPath, { recursive: true });
      } catch (cleanupError) {
        journal.status = "UNKNOWN";
        journal.unresolved.push({ path: recoveryPath, reason: cleanupError.message });
        try {
          saveJournal();
        } catch (journalError) {
          journal.unresolved.push({ path: journalPath, reason: journalError.message });
        }
      }
    }
    const error = new Error(`Superpowers compatibility publish failed (${journal.status}): ${cause.message}; recovery: ${recoveryPath ?? "creation outcome unknown"}`, { cause });
    error.recoveryStatus = journal.status;
    error.recoveryPath = recoveryPath;
    error.recoveryState = recoveryState();
    throw error;
  }
  try {
    if (!sameDirectory(recoveryPath, recoveryIdentity, io)) {
      throw Object.assign(new Error("recovery directory identity changed"), { code: "RECOVERY_IDENTITY_CHANGED" });
    }
    io.rmSync(recoveryPath, { recursive: true });
  } catch (cause) {
    const error = new Error(`Superpowers compatibility committed, but recovery cleanup failed: ${recoveryPath}`, { cause });
    error.recoveryStatus = cause.code === "RECOVERY_IDENTITY_CHANGED" ? "UNKNOWN" : "committed-cleanup-pending";
    error.recoveryPath = recoveryPath;
    error.recoveryState = { ...recoveryState(), status: error.recoveryStatus, publicationStatus: "committed",
      unresolved: [{ path: recoveryPath, reason: cause.message }] };
    throw error;
  }
}

function prepare({ root = defaultRoot, io = fs } = {}) {
  const lock = JSON.parse(readRegular(path.join(root, "upstream-sources.lock.json"), io).toString());
  const sources = lock.sources.filter((entry) => entry.id === "obra-superpowers");
  const source = sources[0];
  if (sources.length !== 1 || source.repository !== "obra/superpowers" || source.license !== "MIT"
    || !/^[0-9a-f]{40}$/u.test(source.commit)) {
    throw new Error("Superpowers hook compatibility: invalid upstream source identity");
  }
  const files = source.files.filter((entry) => entry.sourcePath === "hooks/run-hook.cmd");
  const file = files[0];
  if (files.length !== 1 || file.generatedPath !== CMD || file.upstreamPath !== RAW || !/^[0-9a-f]{64}$/u.test(file.sha256)) {
    throw new Error("Superpowers hook compatibility: missing or ambiguous raw hook lock entry");
  }
  const raw = readRegular(path.join(root, RAW), io);
  if (hash(raw) !== file.sha256) throw new Error("Superpowers hook compatibility: raw hook SHA-256 does not match upstream lock");
  const transformed = transform(raw);
  const outputs = [
    { path: CMD, content: Buffer.from(transformed.cmd) },
    { path: UNIX, content: Buffer.from(transformed.unix) },
  ];
  const provenance = {
    schema_version: 1,
    source: { repository: source.repository, commit: source.commit, source_path: file.sourcePath, path: RAW, sha256: file.sha256 },
    transform: { id: "split-batch-unix-v1", generator: GENERATOR, sha256: hash(readRegular(__filename)) },
    outputs: outputs.map((output) => ({ path: output.path, sha256: hash(output.content) })),
  };
  return { outputs, provenance, artifacts: [...outputs, { path: PROVENANCE, content: Buffer.from(JSON.stringify(provenance, null, 2) + "\n") }] };
}

function verify({ root = defaultRoot } = {}) {
  assertNoPendingRecovery(root);
  const prepared = prepare({ root });
  for (const artifact of prepared.artifacts) {
    if (!readRegular(path.join(root, artifact.path)).equals(artifact.content)) {
      throw new Error(`Superpowers hook compatibility: ${artifact.path} drift; regenerate the downstream artifacts`);
    }
  }
  return prepared.provenance;
}

function generate({ root = defaultRoot, io = fs } = {}) {
  assertNoPendingRecovery(root, io);
  const before = snapshot({ root, paths: ["upstream-sources.lock.json", RAW, ...OUTPUT_PATHS], io });
  const prepared = prepare({ root, io });
  publish({ root, artifacts: prepared.artifacts, before, io });
  return prepared.provenance;
}

if (require.main === module) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (!["generate", "verify"].includes(action) || args.length !== 0) {
      throw new Error("usage: node scripts/superpowers-hook-compat.cjs generate|verify");
    }
    process.stdout.write(JSON.stringify(action === "generate" ? generate() : verify(), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { OUTPUT_PATHS, transform, prepare, generate, verify, snapshot, publish, assertNoPendingRecovery, directoryIdentity, sameDirectory, allocateDirectory,
  readOwnedJournal, writeOwnedJournal };
