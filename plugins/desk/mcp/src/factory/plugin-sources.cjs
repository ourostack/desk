"use strict";

// The install-source lookups and the plugin scan the end hook, the factory tools and the plugin registry share. They live under
// `mcp/src` so every caller imports them by name, whichever plugin root the server runs from.
const fs = require("node:fs");
const path = require("node:path");

const MAX_INPUT = 1024 * 1024;

const MAX_SOURCE_ENTRIES = 256;
// What a detailed source lookup answers instead of a repository: nothing is installed at the name and version, or something is but its source is not one GitHub repository.
const ABSENT = Symbol("absent");
const CONFLICT = Symbol("conflict");

// The one GitHub repository a plugin was installed from, as `owner/repo`, or null when that is unknown or ambiguous.
// Every lookup below fails closed: anything it cannot read, reach or tell apart gives null, and a null source is never named in a public store.
const githubRepo = (value, PATTERNS) => (typeof value === "string" && PATTERNS.prRepo.test(value) ? value : null);
const objectOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);
const parseSmall = (readSmallText, file, limit) => {
  try {
    return objectOf(JSON.parse(readSmallText(file, limit)));
  } catch {
    return null;
  }
};
// Copilot's config.json opens with `//` comment lines.
const parseCommented = (readSmallText, file) => {
  try {
    return objectOf(JSON.parse(readSmallText(file, MAX_INPUT).replace(/^(?:\s*\/\/[^\n]*\n)+/u, "")));
  } catch {
    return null;
  }
};
const githubSource = (value, PATTERNS) => {
  const source = objectOf(value);
  return source?.source === "github" ? githubRepo(source.repo, PATTERNS) : null;
};

// A marketplace manifest's plugins, as name -> the repository each is published from: the marketplace's own repository for a relative path inside it, the entry's own GitHub repository, and null for anything else or a name listed twice with different sources.
function listedPlugins(manifest, marketplaceRepo, PATTERNS) {
  const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : null;
  if (plugins === null || plugins.length > MAX_SOURCE_ENTRIES) return null;
  const listed = new Map();
  for (const entry of plugins) {
    const plugin = objectOf(entry);
    if (typeof plugin?.name !== "string") continue;
    const from = typeof plugin.source === "string"
      ? plugin.source.startsWith("./") && !plugin.source.split("/").includes("..") ? marketplaceRepo : null
      : githubSource(plugin.source, PATTERNS);
    listed.set(plugin.name, listed.has(plugin.name) && listed.get(plugin.name) !== from ? null : from);
  }
  return listed;
}

// Claude Code: `installed_plugins.json` keys are `name@marketplace`, and `known_marketplaces.json` says where each marketplace came from and where its copy is cached. A plugin has a source only when a GitHub marketplace's cached manifest lists it; the source is then the repository that manifest says the plugin comes from.
function claudeSources(configDir, readSmallText, PATTERNS, late) {
  const known = parseSmall(readSmallText, path.join(configDir, "plugins", "known_marketplaces.json"), MAX_INPUT) ?? {};
  const listings = new Map();
  const listing = (marketplace) => {
    if (!listings.has(marketplace)) {
      const entry = Object.hasOwn(known, marketplace) ? objectOf(known[marketplace]) : null;
      const repo = githubSource(entry?.source, PATTERNS);
      const location = entry?.installLocation;
      listings.set(marketplace, repo === null || typeof location !== "string" || !path.isAbsolute(location)
        ? null
        : listedPlugins(parseSmall(readSmallText, path.join(location, ".claude-plugin", "marketplace.json"), MAX_INPUT), repo, PATTERNS));
    }
    return listings.get(marketplace);
  };
  return (key) => {
    const at = key.indexOf("@");
    if (at < 1 || late()) return null;
    return listing(key.slice(at + 1))?.get(key.slice(0, at)) ?? null;
  };
}

// Plain Copilot: `config.json` `installedPlugins` records each plugin's marketplace, and `settings.json` `extraKnownMarketplaces` says which repository that marketplace is. A plugin has a source only when exactly one install record matches its name and version and that record's marketplace is a GitHub repository.
function copilotSources(copilotHome, readSmallText, PATTERNS, late, detailed = false) {
  const config = parseCommented(readSmallText, path.join(copilotHome, "config.json"));
  const settings = parseCommented(readSmallText, path.join(copilotHome, "settings.json"));
  const installed = Array.isArray(config?.installedPlugins) && config.installedPlugins.length <= MAX_SOURCE_ENTRIES ? config.installedPlugins : [];
  const marketplaces = objectOf(settings?.extraKnownMarketplaces) ?? {};
  // `detailed` (the install-source backfill) tells a plugin with no record (ABSENT) from one whose record names no GitHub source (CONFLICT); the hook itself only ever wants the repository or null.
  const answer = (outcome) => (detailed || typeof outcome === "string" ? outcome : null);
  return (name, version) => {
    if (late()) return answer(CONFLICT);
    const records = installed.map(objectOf).filter((record) => record?.name === name && record.version === version);
    if (records.length === 0) return answer(ABSENT);
    if (records.length !== 1 || typeof records[0].marketplace !== "string" || !Object.hasOwn(marketplaces, records[0].marketplace)) return answer(CONFLICT);
    return answer(githubSource(objectOf(marketplaces[records[0].marketplace])?.source, PATTERNS) ?? CONFLICT);
  };
}

// Copilot under Agency: each session copies its plugins from Agency's cache, whose index maps a spec such as `copilot:github:owner/repo:plugins/x@ref` to a cached folder. Every entry counts, whatever its origin: a non-GitHub entry is an unknown source for its plugin name. A plugin has a source only when the scan read the whole index and every cached entry at the plugin's exact name and version came from one GitHub repository. A cut-short scan, an entry whose name cannot be read and a name-only match all give no source.
const UNKNOWN_ORIGIN = Symbol("unknown origin");
function agencySources(home, readSmallText, PATTERNS, late, detailed = false) {
  const cache = path.join(home, ".local", "agency", "plugins", "cache");
  const answer = (outcome) => (detailed || typeof outcome === "string" ? outcome : null);
  const none = () => answer(CONFLICT);
  // The install-source backfill (`detailed`) treats an index that is there but cannot be read, parsed or shaped as `{entries: {...}}` as a conflict, since it could name anything; only a missing index means Agency holds nothing.
  let index;
  try {
    index = JSON.parse(readSmallText(path.join(cache, "cache_index.json"), MAX_INPUT));
  } catch (error) {
    if (detailed && error.code !== "ENOENT") return none;
  }
  if (detailed && index !== undefined && objectOf(objectOf(index)?.entries) === null) return none;
  const entries = Object.entries(objectOf(objectOf(index)?.entries) ?? {});
  if (entries.length > MAX_SOURCE_ENTRIES) return none;
  const byName = new Map();
  for (const [spec, entry] of entries) {
    if (late()) return none;
    const origin = githubRepo(/^[a-z-]+:github:([^:]+):/u.exec(spec)?.[1], PATTERNS) ?? UNKNOWN_ORIGIN;
    const dir = objectOf(entry)?.dir_name;
    // An entry whose folder cannot be read could be any plugin, so the index says nothing for certain.
    if (typeof dir !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(dir)) return none;
    let named = false;
    for (const file of ["plugin.json", "agency.json"]) {
      const manifest = parseSmall(readSmallText, path.join(cache, "entries", dir, file));
      if (typeof manifest?.name !== "string") continue;
      named = true;
      const versions = byName.get(manifest.name) ?? new Map();
      byName.set(manifest.name, versions);
      // An entry with no readable version could be any version of its plugin.
      const key = typeof manifest.version === "string" ? manifest.version : null;
      versions.set(key, (versions.get(key) ?? new Set()).add(origin));
    }
    if (!named) return none;
  }
  return (name, version) => {
    const versions = byName.get(name);
    const origins = new Set([...(versions?.get(version) ?? []), ...(versions?.get(null) ?? [])]);
    if (origins.size === 0) return answer(ABSENT);
    if (versions.get(version) === undefined || origins.size !== 1) return answer(CONFLICT);
    const [origin] = origins;
    return answer(origin === UNKNOWN_ORIGIN ? CONFLICT : origin);
  };
}

// `deadline` (a `performance.now()` value, optional) stops the scan early for the session-start boot check; the result is then incomplete and `timedOut`.
// `sources: false` skips the install-source lookup, for callers that need only the plugin folders.
// `sourceDeadline` (a `performance.now()` value, optional) bounds the install-source lookup alone: past it every source is null, and the plugins are still recorded.
function metadata({ host, pluginRoot, home, env, readSmallText, PATTERNS, deadline = Infinity, sources = true, sourceDeadline = Infinity }) {
  const plugins = [];
  const dirs = [];
  let incomplete = false;
  let timedOut = false;
  // Why the scan is incomplete, the first reason found, for the doctor: it names the hold and its remedy.
  let reason = null;
  const hold = (code) => { incomplete = true; reason ??= code; };
  const late = () => {
    if (performance.now() <= deadline) return false;
    timedOut = true;
    hold("scan_deadline");
    return true;
  };
  // Each plugin records where it was installed from (`source`), which decides whether a public store may name it.
  const add = (name, version, source) => {
    if (typeof name === "string" && PATTERNS.pluginName.test(name) && typeof version === "string" && PATTERNS.semver.test(version)
      && plugins.length < 64 && !plugins.some((p) => p.name === name && p.version === version)) plugins.push({ name, version, source: source(name, version) });
  };
  const unknown = () => null;
  // Codex has no plugin registry Desk reads, so a Codex marker records no plugins and routes by the desk alone.
  if (host === "codex") return { plugins, dirs, incomplete, timedOut, reason };
  const sourceLate = () => performance.now() > sourceDeadline;
  if (host === "copilot") {
    // opendir bounds the enumeration as well as the number of file reads.
    const dir = fs.opendirSync(path.dirname(pluginRoot));
    try {
      let entry;
      let scanned = 0;
      while ((entry = dir.readSync()) !== null) {
        if (++scanned > 128 || dirs.length === 64) { hold("too_many_plugins"); break; }
        // A plugin installed as a link to its folder is a plugin too: the route reads it through the link, and a link that does not resolve
        // to a folder holds the route (`store-route.js`).
        if (entry.isDirectory() || entry.isSymbolicLink()) dirs.push(path.join(path.dirname(pluginRoot), entry.name));
      }
    } finally { dir.closeSync(); }
    // Agency sessions copy their plugins from Agency's cache; plain Copilot installs them from a marketplace.
    const agency = path.join(home, ".local", "agency", "plugins", "sessions") + path.sep;
    const underAgency = path.resolve(pluginRoot).startsWith(agency);
    const copilotHome = env.COPILOT_HOME || path.join(home, ".copilot");
    const source = !sources ? unknown
      : underAgency ? agencySources(home, readSmallText, PATTERNS, sourceLate)
        : copilotSources(copilotHome, readSmallText, PATTERNS, sourceLate);
    for (const folder of dirs) {
      if (late()) break;
      try {
        const plugin = JSON.parse(readSmallText(path.join(folder, "plugin.json")));
        add(plugin.name, plugin.version, source);
      } catch {
        // The plugin is left out of the facts; resolveStore reads the manifest again and holds the route when it is unreadable.
      }
    }
  } else {
    try {
      const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
      const registry = path.join(configDir, "plugins", "installed_plugins.json");
      let installed;
      try {
        installed = JSON.parse(readSmallText(registry, MAX_INPUT));
      } catch (error) {
        throw new Error(error.code === "ENOENT" ? "registry_missing" : "registry_unreadable");
      }
      if (!installed?.plugins || typeof installed.plugins !== "object" || Array.isArray(installed.plugins)) throw new Error("registry_unreadable");
      if (Object.keys(installed.plugins).length > 64) hold("too_many_plugins");
      const deskInstalls = [];
      const marketplaceOf = sources ? claudeSources(configDir, readSmallText, PATTERNS, sourceLate) : unknown;
      for (const [key, records] of Object.entries(installed.plugins).slice(0, 64)) {
        const source = () => marketplaceOf(key);
        if (late()) break;
        if (!Array.isArray(records)) { hold("registry_unreadable"); continue; }
        if (records.length > 64) hold("too_many_plugins");
        for (const record of records.slice(0, 64)) {
          if (!record || typeof record !== "object") { hold("registry_unreadable"); continue; }
          add(key.split("@")[0], record.version, source);
          if (typeof record.installPath !== "string" || !path.isAbsolute(record.installPath)) { hold("registry_unreadable"); continue; }
          if (key.split("@")[0] === "desk") deskInstalls.push(record.installPath);
          if (dirs.includes(record.installPath)) continue;
          if (dirs.length === 64) hold("too_many_plugins");
          else dirs.push(record.installPath);
        }
      }
      // A Desk the registry does not list was loaded another way (`claude --plugin-dir`), and so may any overlay beside it: the registry
      // does not name the plugin set, so the route is held. A Desk record in the same cache folder as the running one is another version of
      // it (Desk updated while this session ran, which keeps the old version's folder): that Desk is listed.
      const sibling = (install) => samePath(path.dirname(install), path.dirname(pluginRoot));
      if (!late() && !dirs.some((dir) => samePath(dir, pluginRoot)) && !deskInstalls.some(sibling)) hold("desk_not_in_registry");
    } catch (error) {
      // Missing metadata is represented by no plugin facts, never invented. A registry that is missing or unreadable could have named an
      // overlay that declares a private store, so the scan is incomplete and the route is held (fail closed, ruling 2026-10-06).
      hold(error.message === "registry_missing" ? "registry_missing" : "registry_unreadable");
    }
  }
  late();
  return { plugins, dirs, incomplete, timedOut, reason };
}

// Whether two paths name the same folder, following links; a path that cannot be resolved is compared as written.
function samePath(left, right) {
  const real = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  return real(left) === real(right);
}

module.exports = { ABSENT, CONFLICT, claudeSources, copilotSources, agencySources, metadata };
