// The factory as the Desk MCP tools see it: the host's plugin set, read the
// way the end hook reads it, and the local status and report link built on
// it (`src/factory/local-status.js`).
//
// The host is the one that started this server. Claude Code sets
// `CLAUDE_PLUGIN_ROOT` for a plugin's MCP server and Copilot does not, so
// with it set the scan reads Claude's plugin registry, and without it the
// folders beside Desk's plugin root (`DESK_PLUGIN_ROOT`, which the launcher
// sets on both hosts, else this checkout's own plugin folder). The scan is
// the end hook's own `metadata`, loaded from that plugin root because an
// installed server runs from a source mirror without `hooks/`, so the tools,
// the hooks and the boot check route a desk to the same store. A scan that
// fails is incomplete, which holds routing unless the desk declares its own
// store.

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { readSmallText } from "../factory/marker.js"
import { PATTERNS } from "../factory/schema.js"
import { factoryLocalStatus, factoryReportLink } from "../factory/local-status.js"

const OWN_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const require = createRequire(import.meta.url)

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value : null)

/** `{ dirs, incomplete }`: the plugin folders installed beside Desk for this server's host; see the header. */
export function factoryPluginScan(env) {
  const claudeRoot = text(env.CLAUDE_PLUGIN_ROOT)
  const pluginRoot = path.resolve(text(env.DESK_PLUGIN_ROOT) ?? claudeRoot ?? OWN_PLUGIN_ROOT)
  // An installed server runs from a source mirror in the cache, where `hooks/` is not beside this file, so the end hook
  // comes from the plugin root the launcher names; a checkout run without one uses its own.
  const hook = [pluginRoot, OWN_PLUGIN_ROOT].map((root) => path.join(root, "hooks", "factory-end.cjs")).find((file) => existsSync(file))
  try {
    const { metadata } = require(hook)
    const { dirs, incomplete } = metadata({ host: claudeRoot === null ? "copilot" : "claude", pluginRoot, home: text(env.HOME) ?? os.homedir(), env, readSmallText, PATTERNS })
    return { dirs, incomplete }
  } catch {
    return { dirs: [], incomplete: true }
  }
}

/** `factoryLocalStatus` for `deskRoot` (or no desk) with this host's plugin set. */
export function factoryStatus({ env, deskRoot }) {
  const { dirs, incomplete } = factoryPluginScan(env)
  return factoryLocalStatus({ env, deskRoot, pluginDirs: dirs, pluginScanIncomplete: incomplete })
}

/** `factoryReportLink` with this host's plugin set: the task card's `factory_report`, or `null` without consent. */
export function reportLink({ env, deskRoot, deskRemote, personPrefix, track, slug }) {
  const { dirs, incomplete } = factoryPluginScan(env)
  return factoryReportLink({ env, deskRoot, deskRemote, personPrefix, track, slug, pluginDirs: dirs, pluginScanIncomplete: incomplete })
}

/** The human-readable "Factory" section desk_doctor adds to its summary: store names, codes and counts only. */
export function factorySummary(status) {
  const lines = ["Factory"]
  if (status.store === null) {
    lines.push(`  no store resolved (${status.source}); facts are held on this machine`)
  } else if (status.consent === "undecided") {
    lines.push(`  this desk reports to ${status.store} (${status.source}); contribution not decided yet: ask the operator once (desk:session-start)`)
  } else {
    lines.push(`  this desk reports to ${status.store} (${status.source}); contribution: ${status.consent}`)
  }
  for (const entry of status.stores) {
    lines.push(`  ${entry.store}: ${entry.consent}, ${entry.pending} pending, ${entry.quarantined} quarantined, ${entry.last_flush === null ? "no flush yet" : `last flush ${entry.last_flush}`}`)
  }
  if (status.warnings.length > 0) lines.push(`  plugin manifests skipped: ${status.warnings.join(", ")}`)
  return lines.join("\n")
}
