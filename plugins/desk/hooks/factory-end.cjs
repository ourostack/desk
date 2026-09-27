#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
// Loaded only when a worker starts: the Stop hook runs after every turn.
const compatibleNode = (options) => require("./compatible-node.cjs").compatibleNode(options);
const ownRoot = path.resolve(__dirname, "..");
const runtime = (file) => import(pathToFileURL(path.join(ownRoot, "mcp", file)).href);
const MAX_INPUT = 1024 * 1024;

async function readInput(stream, timeoutMs = 150) {
  return new Promise((resolve) => {
    let bytes = 0;
    const chunks = [];
    const finish = (value) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      stream.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT) finish(null);
      else chunks.push(Buffer.from(chunk));
    });
    stream.once("error", () => finish(null));
    stream.once("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);
      } catch {
        finish(null);
      }
    });
  });
}

// factory.js loads Desk's MCP code, so it runs in a Node that satisfies the
// MCP's engines range, never simply in the hook's own Node. With none
// installed nothing starts, and the retained marker is the retry path.
async function launch(script, args, env, resolveNode = compatibleNode) {
  const { node } = resolveNode({ env });
  if (!node) return;
  await new Promise((resolve, reject) => {
    const child = spawn(node, [script, ...args], { detached: true, stdio: "ignore", windowsHide: true, env });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

const MAX_SOURCE_ENTRIES = 256;

// The one GitHub repository a plugin was installed from, as `owner/repo`, or null when that is unknown or ambiguous.
const githubRepo = (value, PATTERNS) => (typeof value === "string" && PATTERNS.prRepo.test(value) ? value : null);
const objectOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);
const parseSmall = (readSmallText, file, limit) => {
  try {
    return objectOf(JSON.parse(readSmallText(file, limit)));
  } catch {
    return null;
  }
};

// Claude Code: `installed_plugins.json` keys are `name@marketplace`, and `known_marketplaces.json` says where each marketplace came from. Only a GitHub marketplace names a repository.
function claudeMarketplaces(configDir, readSmallText, PATTERNS) {
  const known = parseSmall(readSmallText, path.join(configDir, "plugins", "known_marketplaces.json"), MAX_INPUT) ?? {};
  return (key) => {
    const at = key.indexOf("@");
    const marketplace = at < 0 ? null : key.slice(at + 1);
    const source = marketplace !== null && Object.hasOwn(known, marketplace) ? objectOf(objectOf(known[marketplace])?.source) : null;
    return source?.source === "github" ? githubRepo(source.repo, PATTERNS) : null;
  };
}

// Copilot under Agency: each session copies its plugins from Agency's cache, whose index maps a spec such as `copilot:github:owner/repo:plugins/x@ref` to a cached folder. A plugin's name and version pick its repository; a plugin the cache holds from two repositories, with no version to tell them apart, has no source.
function agencySources(home, readSmallText, PATTERNS, late) {
  const cache = path.join(home, ".local", "agency", "plugins", "cache");
  const entries = objectOf(parseSmall(readSmallText, path.join(cache, "cache_index.json"), MAX_INPUT)?.entries) ?? {};
  const byVersion = new Map();
  const byName = new Map();
  const note = (map, key, repo) => map.set(key, (map.get(key) ?? new Set()).add(repo));
  for (const [spec, entry] of Object.entries(entries).slice(0, MAX_SOURCE_ENTRIES)) {
    if (late()) break;
    const repo = githubRepo(/^[a-z-]+:github:([^:]+):/u.exec(spec)?.[1], PATTERNS);
    const dir = objectOf(entry)?.dir_name;
    if (repo === null || typeof dir !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(dir)) continue;
    for (const file of ["plugin.json", "agency.json"]) {
      const manifest = parseSmall(readSmallText, path.join(cache, "entries", dir, file));
      if (typeof manifest?.name !== "string") continue;
      note(byName, manifest.name, repo);
      if (typeof manifest.version === "string") note(byVersion, `${manifest.name}@${manifest.version}`, repo);
    }
  }
  return (name, version) => {
    const repos = byVersion.get(`${name}@${version}`) ?? byName.get(name);
    return repos?.size === 1 ? [...repos][0] : null;
  };
}

// `deadline` (a `performance.now()` value, optional) stops the scan early for the session-start boot check; the result is then incomplete and `timedOut`.
// `sources: false` skips the install-source lookup, for callers that need only the plugin folders.
function metadata({ host, pluginRoot, home, env, readSmallText, PATTERNS, deadline = Infinity, sources = true }) {
  const plugins = [];
  const dirs = [];
  let incomplete = false;
  let timedOut = false;
  const late = () => {
    if (performance.now() <= deadline) return false;
    timedOut = true;
    incomplete = true;
    return true;
  };
  // Each plugin records where it was installed from (`source`), which decides whether a public store may name it.
  const add = (name, version, source) => {
    if (typeof name === "string" && PATTERNS.pluginName.test(name) && typeof version === "string" && PATTERNS.semver.test(version)
      && plugins.length < 64 && !plugins.some((p) => p.name === name && p.version === version)) plugins.push({ name, version, source: source(name, version) });
  };
  const unknown = () => null;
  if (host === "copilot") {
    // opendir bounds the enumeration as well as the number of file reads.
    const dir = fs.opendirSync(path.dirname(pluginRoot));
    try {
      let entry;
      let scanned = 0;
      while ((entry = dir.readSync()) !== null) {
        if (++scanned > 128 || dirs.length === 64) { incomplete = true; break; }
        if (entry.isDirectory()) dirs.push(path.join(path.dirname(pluginRoot), entry.name));
      }
    } finally { dir.closeSync(); }
    // Plain Copilot records only a marketplace name, never a repository, so only Agency's cache gives a source.
    const agency = path.join(home, ".local", "agency", "plugins", "sessions") + path.sep;
    const source = sources && path.resolve(pluginRoot).startsWith(agency) ? agencySources(home, readSmallText, PATTERNS, late) : unknown;
    for (const folder of dirs) {
      if (late()) break;
      try {
        const plugin = JSON.parse(readSmallText(path.join(folder, "plugin.json")));
        add(plugin.name, plugin.version, source);
      } catch {
        // resolveStore records unreadable manifests as local status warnings.
      }
    }
  } else {
    try {
      const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
      const installed = JSON.parse(readSmallText(path.join(configDir, "plugins", "installed_plugins.json"), MAX_INPUT));
      if (!installed.plugins || typeof installed.plugins !== "object" || Array.isArray(installed.plugins)) throw new Error("registry_unreadable");
      incomplete = Object.keys(installed.plugins).length > 64;
      const marketplaceOf = sources ? claudeMarketplaces(configDir, readSmallText, PATTERNS) : unknown;
      for (const [key, records] of Object.entries(installed.plugins).slice(0, 64)) {
        const source = () => marketplaceOf(key);
        if (late()) break;
        if (!Array.isArray(records)) { incomplete = true; continue; }
        if (records.length > 64) incomplete = true;
        for (const record of records.slice(0, 64)) {
          if (!record || typeof record !== "object") { incomplete = true; continue; }
          add(key.split("@")[0], record.version, source);
          if (typeof record.installPath !== "string" || !path.isAbsolute(record.installPath)) { incomplete = true; continue; }
          if (dirs.includes(record.installPath)) continue;
          if (dirs.length === 64) incomplete = true;
          else dirs.push(record.installPath);
        }
      }
    } catch (error) {
      // Missing metadata is represented by no plugin facts, never invented.
      incomplete = error.code !== "ENOENT";
    }
  }
  late();
  return { plugins, dirs, incomplete, timedOut };
}

async function runHook({ host, payload, env = process.env, pluginRoot = ownRoot, launch: start = launch, supportsFinalize } = {}) {
  try {
    const [{ absolutePath, readSmallText, validMarker }, { ENUMS, PATTERNS, isPlainObject }] = await Promise.all([
      runtime("src/factory/marker.js"), runtime("src/factory/schema.js"),
    ]);
    if (!["claude", "copilot"].includes(host) || !isPlainObject(payload)) return "invalid";
    const claude = host === "claude";
    const event = claude ? payload.hook_event_name : Object.hasOwn(payload, "stopReason") ? "agentStop" : Object.hasOwn(payload, "reason") ? "sessionEnd" : null;
    if (!(claude ? ["Stop", "SessionEnd"] : ["agentStop", "sessionEnd"]).includes(event)) return "invalid";
    const id = claude ? payload.session_id : payload.sessionId;
    if (typeof id !== "string" || !PATTERNS.sessionId.test(id) || !absolutePath(payload.cwd)) return "invalid";
    const home = env.HOME || os.homedir();
    const log = claude ? payload.transcript_path : path.join(env.COPILOT_HOME || path.join(home, ".copilot"), "session-state", id, "events.jsonl");
    if (!absolutePath(log)) return "invalid";
    const [{ resolveHookDeskRoot }, outbox, { resolveStore }, cli] = await Promise.all([
      runtime("scripts/resolve-desk-root.js"), runtime("src/factory/outbox.js"), runtime("src/factory/store-route.js"), runtime("scripts/factory.js"),
    ]);
    const { root: deskRoot } = resolveHookDeskRoot({ env, cwd: payload.cwd });
    if (deskRoot === null) return "unavailable";
    const { plugins, dirs, incomplete } = metadata({ host, pluginRoot, home, env, readSmallText, PATTERNS });
    const ended = event === "SessionEnd" || event === "sessionEnd";
    const at = !claude && Number.isSafeInteger(payload.timestamp) && payload.timestamp >= 0 ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
    const agency = path.join(home, ".local", "agency", "plugins", "sessions") + path.sep;
    let routing = deskRoot === null ? { store: null, source: "invalid_declaration", warnings: [] } : resolveStore({ deskRoot, pluginDirs: dirs, read: (file) => readSmallText(file) });
    if (incomplete && routing.source !== "desk") routing = { store: null, source: "invalid_declaration", warnings: routing.warnings };
    const marker = {
      schema_version: 1, host: claude ? "claude-code" : "copilot-cli", session_id: id,
      log_path: log, cwd: payload.cwd, desk_root: deskRoot,
      end_reason: ended ? ENUMS.endReason.includes(payload.reason) ? payload.reason : "other" : null,
      ended_at: ended ? at : null, plugins, updated_at: new Date().toISOString(),
      entrypoint: claude ? "unknown" : path.resolve(pluginRoot).startsWith(agency) ? "launcher" : "cli",
      person_prefix: env.DESK_PERSON ? `desks/${env.DESK_PERSON.trim()}` : "",
      routing,
    };
    if (!validMarker(marker)) return "invalid";
    await outbox.writeMarker(env, marker);
    const script = path.join(ownRoot, "mcp", "scripts", "factory.js");
    // One Node search per hook run, however many jobs it starts.
    let resolved;
    const resolveOnce = (options) => (resolved ??= compatibleNode(options));
    if (ended) {
      const root = await outbox.factoryStateRoot(env);
      await start(script, ["derive", "--marker", path.join(root, "markers", `${marker.host}-${id}.json`), "--wait-quiet", "30000"], env, resolveOnce);
    } else if (supportsFinalize ?? cli.SUPPORTED_COMMANDS.includes("finalize")) {
      for (const job of await outbox.listFinalizeJobs(env)) await start(script, ["finalize", "--job", job], env, resolveOnce);
    }
    return "written";
  } catch {
    // Hooks cannot veto lifecycle events. The retained marker is the retry path.
    return "unavailable";
  }
}

module.exports = { readInput, runHook, launch, metadata };

async function runBoundedHook(host, input) {
  const deadline = Date.now() + 1500;
  const payload = await readInput(input);
  if (payload === null || Date.now() >= deadline) return;
  // A separate process makes the unchanged deadline effective even during synchronous OS calls.
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, host, "--factory-worker"], {
      stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env: process.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(0, deadline - Date.now()));
    const finish = () => { clearTimeout(timer); resolve(); };
    child.once("error", finish);
    child.once("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

if (require.main === module) {
  const work = process.argv[3] === "--factory-worker"
    ? readInput(process.stdin).then((payload) => runHook({ host: process.argv[2], payload }))
    : runBoundedHook(process.argv[2], process.stdin);
  work.then(() => process.exit(0), () => process.exit(0));
}
