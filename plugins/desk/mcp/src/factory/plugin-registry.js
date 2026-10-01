import { lstatSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"
import { loadEndHook } from "./end-hook.js"
import { readSmallText } from "./marker.js"
import { PATTERNS } from "./schema.js"

// The end hook finds each plugin's install source from the host's plugin registry. This reads the same registry
// the same way by calling the hook's own lookups, so the two cannot drift. The hook is loaded when a source is
// looked up, from the plugin root the environment names (`end-hook.js`); without it no source is found.
const never = () => false

// Claude Code keeps every version it has installed at cache/<marketplace>/<plugin>/<version>/, so a version that was
// upgraded away is still there. The source is what the hook reports for a plugin installed from that marketplace.
// Exactly one marketplace may hold the name and version; two make it ambiguous.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u

// A symlink does not count: the folder must really be there, not point at something else.
function isRealDirectory(directory) {
  try {
    return lstatSync(directory).isDirectory()
  } catch {
    return false
  }
}

function claudeSources(hook, name, version, { env, home }) {
  if (!PATTERNS.pluginName.test(name) || !PATTERNS.semver.test(version)) return []
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")
  const cache = path.join(configDir, "plugins", "cache")
  const marketplaces = readdirSync(cache, { withFileTypes: true }).filter((entry) => entry.isDirectory() && SEGMENT.test(entry.name))
  const holding = marketplaces.filter((entry) => isRealDirectory(path.join(cache, entry.name, name)) && isRealDirectory(path.join(cache, entry.name, name, version)))
  if (holding.length !== 1) return []
  return [hook.claudeSources(configDir, readSmallText, PATTERNS, never)(`${name}@${holding[0].name}`)]
}

// Copilot CLI: a plain install records its marketplace in config.json; an Agency session copies from Agency's cache.
// Each lookup answers ABSENT (nothing at the exact name and version), CONFLICT (something there whose source is not one
// GitHub repository, or ambiguous) or the repository. A source is used only when nothing conflicts and every lookup
// that found one names the same repository.
function copilotSources(hook, name, version, { env, home }) {
  const copilotHome = env.COPILOT_HOME || path.join(home, ".copilot")
  const answers = [hook.copilotSources(copilotHome, readSmallText, PATTERNS, never, true)(name, version), hook.agencySources(home, readSmallText, PATTERNS, never, true)(name, version)]
  if (answers.includes(hook.CONFLICT)) return []
  return answers.filter((answer) => answer !== hook.ABSENT)
}

/**
 * The install source for a marker plugin with no `source` key. For Claude Code, the `owner/repo` of the one marketplace
 * whose plugin cache holds the exact name and version. For Copilot CLI, the one repository that the plain install
 * record and Agency's cache agree on, with neither reporting a conflicting entry. Null when nothing matches, when the
 * match is ambiguous, or when the files are missing or unreadable. Never throws.
 */
export function registrySource(host, name, version, { env }) {
  try {
    const hook = loadEndHook(env)
    if (hook === null) return null
    const context = { env, home: env.HOME || homedir() }
    const found = host === "claude-code" ? claudeSources(hook, name, version, context) : host === "copilot-cli" ? copilotSources(hook, name, version, context) : []
    if (host === "claude-code") return found.length === 1 ? found[0] : null
    const known = new Set(found)
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
