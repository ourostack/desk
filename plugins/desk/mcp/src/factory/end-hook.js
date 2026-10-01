import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// Where the end hook (`hooks/factory-end.cjs`) is found. An installed server runs from a source mirror in the runtime
// cache, where `hooks/` is not beside this code, so the hook comes from the plugin root the launcher names
// (`DESK_PLUGIN_ROOT`, else Claude's `CLAUDE_PLUGIN_ROOT`); a checkout run without one uses its own.
const OWN_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const require = createRequire(import.meta.url)

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value : null)

/** The plugin folder this server serves: `DESK_PLUGIN_ROOT`, else `CLAUDE_PLUGIN_ROOT`, else this checkout's own. */
export function pluginRootFor(env) {
  return path.resolve(text(env.DESK_PLUGIN_ROOT) ?? text(env.CLAUDE_PLUGIN_ROOT) ?? OWN_PLUGIN_ROOT)
}

/** The end hook's module from the named plugin root, else this checkout's own; null when neither loads. Never throws. */
export function loadEndHook(env) {
  try {
    const file = [pluginRootFor(env), OWN_PLUGIN_ROOT].map((root) => path.join(root, "hooks", "factory-end.cjs")).find((candidate) => existsSync(candidate))
    return require(file) // no file at all throws here, and answers null below
  } catch {
    return null
  }
}
