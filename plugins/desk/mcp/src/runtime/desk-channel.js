// Which channel this Desk follows, so boot compares it with the newest version on that channel and names that channel's own
// refresh. An Agency install of `plugins/desk@release` follows the `release` branch (stable releases only); an install from
// before the release channel (`@main`), and Claude Code or Copilot installs from the marketplace, follow `main`. Comparing a
// `@release` install with `main` would call it stale whenever `main` carries a release candidate it will never receive.

import { readFileSync } from "node:fs"
import * as path from "node:path"

export const DESK_CHANNELS = ["release", "main"]

function text(value) {
  return typeof value === "string" && value.trim() !== ""
}

function agencyPluginsDir({ pluginRoot, homeDir }) {
  // A session copy lives at <agency data>/plugins/sessions/agency-plugin-*/desk, so the cache is its sibling.
  const parts = path.resolve(pluginRoot).split(path.sep)
  const at = parts.lastIndexOf("sessions")
  if (at > 0 && parts[at - 1] === "plugins" && /^agency-/u.test(parts[at + 1] ?? "")) return parts.slice(0, at).join(path.sep)
  return path.join(homeDir, ".local", "agency", "plugins")
}

/** True when this session was launched through Agency: it sets `AGENCY_ENGINE` and `AGENCY_SESSION_ID`, and runs plugins from a session copy under `plugins/sessions/agency-plugin-*`. */
export function isAgencySession({ env, pluginRoot }) {
  if (text(env.AGENCY_ENGINE) || text(env.AGENCY_SESSION_ID)) return true
  return /[\\/]plugins[\\/]sessions[\\/]agency-plugin-[^\\/]+[\\/]/u.test(`${path.resolve(pluginRoot)}${path.sep}`)
}

/**
 * The Agency cache spec this Desk was loaded from, from Agency's own cache index: the `ourostack/desk` plugin on `@release`
 * (or `@main`, for an install from before the release channel) for this session's engine (`AGENCY_ENGINE`, else the agent
 * host: Claude under Agency has its own `claude:` entries), whose cached copy has the running version. Anything else is null.
 */
export function deriveAgencySpec({ env, agentHost, pluginRoot, running, homeDir, readFile = (file) => readFileSync(file, "utf8") }) {
  try {
    const engine = text(env.AGENCY_ENGINE) ? env.AGENCY_ENGINE.trim() : agentHost
    if (engine !== "copilot" && engine !== "claude") return null
    const cacheDir = path.join(agencyPluginsDir({ pluginRoot, homeDir }), "cache")
    const entries = JSON.parse(readFile(path.join(cacheDir, "cache_index.json"))).entries ?? {}
    for (const channel of DESK_CHANNELS) {
      const spec = `${engine}:github:ourostack/desk:plugins/desk@${channel}`
      const entry = entries[spec]
      if (!text(entry?.dir_name)) continue
      if (JSON.parse(readFile(path.join(cacheDir, "entries", entry.dir_name, "plugin.json"))).version === running) return spec
    }
    return null
  } catch {
    return null
  }
}

/**
 * `{ channel, spec, agency }` for this Desk: `agency` says Agency launched it, `spec` is the Agency cache spec it was loaded from, when `deriveAgencySpec` finds it, and
 * `channel` is that spec's branch. An Agency session whose spec cannot be found is treated as `release`, the older of the two
 * channels, so a guess can only miss a warning, never give a false one; any other host follows `main`.
 */
export function resolveDeskChannel({ env, agentHost, pluginRoot, running, homeDir, readFile }) {
  if (!isAgencySession({ env, pluginRoot })) return { channel: "main", spec: null, agency: false }
  const spec = deriveAgencySpec({ env, agentHost, pluginRoot, running, homeDir, readFile })
  return { channel: spec === null ? "release" : spec.slice(spec.lastIndexOf("@") + 1), spec, agency: true }
}
