"use strict";

// Keeps a running session on the current release. The host fixes a plugin's skills, hooks and agents when it starts, from the
// copy Agency made for that session (`<agency data>/plugins/sessions/agency-plugin-*/root-N/<plugin>`), while Agency's cache
// (`<agency data>/plugins/cache`) and Desk's own release copies (`<cache>/ouroboros-skills/desk/release-copies/<version>`) already
// hold the newer release. Hooks are scripts the host starts afresh for every event, so a hook can run the newer script, and a
// skill's text can be handed over once the agent has asked for it. Everything here is a few local reads: no network, no throw.
//
// Plain CommonJS and synchronous: a hook runs it before reading its input, and it must work on any Node that runs a hook.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

// <...>/agency-plugin-<id>[.p<pid>]/root-N/<plugin>: the layout of a session's plugin roots.
const SESSION_ROOT = /^(.*[\\/]agency-plugin-[^\\/]+)[\\/]root-\d+[\\/][^\\/]+$/u;
const PINNED = /@[0-9a-f]{40}$/u;
const MAX_SKILL_BYTES = 64 * 1024;

const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

function core(version) {
  const found = /^(\d+)\.(\d+)\.(\d+)$/u.exec(typeof version === "string" ? version.trim() : "");
  return found === null ? null : [Number(found[1]), Number(found[2]), Number(found[3])];
}

/** Is `a` a newer plain release than `b`? A prerelease or unreadable version is never newer. */
function isNewer(a, b) {
  const left = core(a);
  const right = core(b);
  if (left === null || right === null) return false;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

function manifest(dir) {
  for (const file of [path.join(dir, "plugin.json"), path.join(dir, ".claude-plugin", "plugin.json")]) {
    const found = readJson(file);
    if (found !== null && typeof found.name === "string" && core(found.version) !== null) return { name: found.name, version: found.version.trim() };
  }
  return null;
}

/** The session folder a plugin root belongs to, or null when it is not an Agency session copy (a source checkout never follows a cache). */
const sessionFolder = (pluginRoot) => (SESSION_ROOT.exec(path.resolve(pluginRoot)) ?? [])[1] ?? null;

/** The plugins this session loaded: [{ name, version, dir }]. */
function loadedPlugins(session) {
  const out = [];
  for (const root of list(session).filter((entry) => /^root-\d+$/u.test(entry))) {
    for (const plugin of list(path.join(session, root))) {
      const dir = path.join(session, root, plugin);
      const found = manifest(dir);
      if (found !== null) out.push({ ...found, dir });
    }
  }
  return out;
}

function releaseCopiesDir(env, home) {
  const cacheHome = typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME.trim() !== "" ? env.XDG_CACHE_HOME : path.join(env.HOME || home, ".cache");
  return path.join(cacheHome, "ouroboros-skills", "desk", "release-copies");
}

/** Every release of plugin `name` on disk beyond the session copy: Agency's unpinned cache entries and, for Desk, Desk's complete release copies. */
function releasesOf({ name, session, env, home }) {
  const found = [];
  const cache = path.join(path.dirname(path.dirname(session)), "cache");
  const entries = readJson(path.join(cache, "cache_index.json"))?.entries;
  for (const entry of Object.values(entries && typeof entries === "object" ? entries : {})) {
    if (typeof entry?.spec !== "string" || PINNED.test(entry.spec) || typeof entry.dir_name !== "string" || !/^[\w.-]+$/u.test(entry.dir_name)) continue;
    const dir = path.join(cache, "entries", entry.dir_name);
    const there = manifest(dir);
    if (there !== null && there.name === name) found.push({ ...there, dir });
  }
  if (name === "desk") {
    const copies = releaseCopiesDir(env, home);
    for (const version of list(copies)) {
      const dir = path.join(copies, version);
      if (!fs.existsSync(path.join(dir, ".complete.json"))) continue;
      const there = manifest(dir);
      if (there !== null) found.push({ ...there, dir });
    }
  }
  return found;
}

/** The newest release of plugin `name` that is newer than `loaded` and passes `usable(dir)`, or null. The first of equal versions wins. */
function newestBeyond({ name, loaded, session, env, home, usable }) {
  let best = null;
  for (const release of releasesOf({ name, session, env, home })) {
    if (!isNewer(release.version, loaded) || !usable(release.dir)) continue;
    if (best === null || isNewer(release.version, best.version)) best = release;
  }
  return best;
}

/** The newest Desk release beyond the copy at `pluginRoot` that has the hook script `hookFile`, or null. */
function currentDesk({ pluginRoot, hookFile, env = process.env, home = os.homedir() }) {
  const session = sessionFolder(pluginRoot);
  const own = manifest(pluginRoot);
  if (session === null || own === null) return null;
  return newestBeyond({ name: "desk", loaded: own.version, session, env, home, usable: (dir) => fs.existsSync(path.join(dir, "hooks", hookFile)) });
}

/**
 * Runs `file` (a hook entry script) from the newest Desk release on disk, with this process's input, output and arguments, and
 * returns true when it did; the caller then returns. False means nothing ran, and the caller runs its own copy. Off with
 * `DESK_HOOKS_CURRENT=0`.
 */
function delegate(file) {
  try {
    if (process.env.DESK_HOOK_DELEGATED === "1" || String(process.env.DESK_HOOKS_CURRENT ?? "").trim() === "0") return false;
    const pluginRoot = path.resolve(path.dirname(file), "..");
    const hookFile = path.basename(file);
    const current = currentDesk({ pluginRoot, hookFile });
    if (current === null) return false;
    const env = { ...process.env, DESK_HOOK_DELEGATED: "1" };
    for (const name of ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "COPILOT_PLUGIN_ROOT", "DESK_PLUGIN_ROOT"]) if (typeof env[name] === "string" && env[name] !== "") env[name] = current.dir;
    const ran = childProcess.spawnSync(process.execPath, [path.join(current.dir, "hooks", hookFile), ...process.argv.slice(2)], { stdio: "inherit", env, windowsHide: true });
    if (ran.error) return false;
    process.exitCode = ran.status === null ? 1 : ran.status;
    return true;
  } catch {
    return false;
  }
}

/**
 * When the skill the agent just loaded has newer text in a newer release of its plugin, the context that gives it: the current text
 * and where that release's docs are. Null when nothing newer differs. `name` may be `plugin:skill`.
 */
function currentSkill({ pluginRoot, name, env = process.env, home = os.homedir() }) {
  const session = sessionFolder(pluginRoot);
  if (session === null || typeof name !== "string") return null;
  const [plugin, skill] = name.includes(":") ? [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)] : [null, name];
  if (!/^[\w.-]+$/u.test(skill)) return null;
  for (const loaded of loadedPlugins(session)) {
    if (plugin !== null && plugin !== loaded.name) continue;
    const before = readText(path.join(loaded.dir, "skills", skill, "SKILL.md"));
    if (before === null) continue;
    const release = newestBeyond({ name: loaded.name, loaded: loaded.version, session, env, home, usable: (dir) => readText(path.join(dir, "skills", skill, "SKILL.md")) !== null });
    if (release === null) continue;
    const after = readText(path.join(release.dir, "skills", skill, "SKILL.md"));
    if (after === before) continue;
    const text = Buffer.byteLength(after) > MAX_SKILL_BYTES ? `(too long to repeat here; read ${path.join(release.dir, "skills", skill, "SKILL.md")})` : after;
    return [
      `The ${loaded.name} skill "${skill}" has a newer release (${release.version}) than the copy this session loaded (${loaded.version}), and its text changed, so the text the skill tool just returned is out of date.`,
      `Follow this current text instead. Anything it points to under the plugin folder (docs, references) is in ${release.dir}; read it there, not in ${loaded.dir}.`,
      "",
      text,
    ].join("\n");
  }
  return null;
}

module.exports = { currentSkill, delegate };
