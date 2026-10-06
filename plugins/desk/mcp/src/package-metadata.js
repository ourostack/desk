import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The Desk version an agent sees is the plugin release in plugin.json, never this package's own version (which names the runtime pack). DESK_PLUGIN_ROOT finds it from a source mirror, which has no plugin.json beside it.
export function deskVersion(env = process.env) {
  const root = env.DESK_PLUGIN_ROOT || fileURLToPath(new URL("../../", import.meta.url))
  try {
    const version = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8")).version
    return typeof version === "string" ? version : null
  } catch {
    return null
  }
}
