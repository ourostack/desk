import { createRequire } from "node:module"
import { homedir } from "node:os"
import * as path from "node:path"
import { readSmallText } from "./marker.js"
import { PATTERNS } from "./schema.js"

// The end hook finds each plugin's install source from the host's plugin registry. This reads the same registry
// the same way by calling the hook's own lookups (both ship in the installed plugin), so the two cannot drift.
const hook = createRequire(import.meta.url)("../../../hooks/factory-end.cjs")
const MAX_REGISTRY_BYTES = 1024 * 1024
const never = () => false

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

// The source of each installed record at a name and exact version (null for a record whose source is unknown).
// Claude Code: one entry per installed record whose key is `name@marketplace` and whose version matches.
function claudeSources(name, version, { env, home }) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")
  const installed = JSON.parse(readSmallText(path.join(configDir, "plugins", "installed_plugins.json"), MAX_REGISTRY_BYTES))
  if (!isObject(installed.plugins)) throw new Error("registry_unreadable")
  const marketplaceOf = hook.claudeSources(configDir, readSmallText, PATTERNS, never)
  const found = []
  for (const [key, records] of Object.entries(installed.plugins)) {
    if (key.split("@")[0] !== name || !Array.isArray(records)) continue
    for (const record of records) if (isObject(record) && record.version === version) found.push(marketplaceOf(key))
  }
  return found
}

// Copilot CLI: a plain install records its marketplace in config.json; an Agency session copies from Agency's cache.
// Each lookup already answers only for exactly one record at the name and version, and null otherwise.
function copilotSources(name, version, { env, home }) {
  const copilotHome = env.COPILOT_HOME || path.join(home, ".copilot")
  return [hook.copilotSources(copilotHome, readSmallText, PATTERNS, never)(name, version), hook.agencySources(home, readSmallText, PATTERNS, never)(name, version)]
}

/**
 * The install source for a marker plugin with no `source` key: the `owner/repo` of the one installed plugin with the
 * same name and exact version in the host's registry. Null when there is no such plugin, when the match is ambiguous,
 * or when the registry is missing or unreadable. Never throws.
 */
export function registrySource(host, name, version, { env }) {
  try {
    const context = { env, home: env.HOME || homedir() }
    const found = host === "claude-code" ? claudeSources(name, version, context) : host === "copilot-cli" ? copilotSources(name, version, context) : []
    if (host === "claude-code") return found.length === 1 ? found[0] : null
    const known = new Set(found.filter((source) => source !== null))
    return known.size === 1 ? [...known][0] : null
  } catch {
    return null
  }
}

/** The marker's plugins with `source` filled in for each plugin object that has no `source` key. The marker itself is not changed. */
export function backfillPluginSources(host, plugins, options) {
  return plugins.map((plugin) => {
    if (Object.hasOwn(plugin, "source")) return plugin
    const source = registrySource(host, plugin.name, plugin.version, options)
    return source === null ? plugin : { ...plugin, source }
  })
}
