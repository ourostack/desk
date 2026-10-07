import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/u

// The one resolver for "the Desk version": the plugin release in plugin.json, never this package's own version (which names the runtime pack). The handshake, desk_status, desk_doctor, the factory and the feedback store all call it, so they cannot disagree. DESK_PLUGIN_ROOT finds the plugin folder from a source mirror, which has no plugin.json beside it. `null` when plugin.json is unreadable or names no valid version.
export function deskVersion(env = process.env) {
  const root = env.DESK_PLUGIN_ROOT || fileURLToPath(new URL("../../", import.meta.url))
  try {
    const version = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8")).version
    return typeof version === "string" && VERSION_PATTERN.test(version) ? version : null
  } catch {
    return null
  }
}
