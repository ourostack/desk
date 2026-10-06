// The one place a hook that reads task cards restores the runtime dependencies (gray-matter) it needs.
//
// A card's nested `repos:` block, and any change to it, is only readable with gray-matter. Hooks run from the installed plugin folder, where no node_modules exists, so without this they fall back to
// the dependency-free reader that skips nested fields (boot acceptance round AA: the clone guard saw every card with no repositories). `session-boot.js` restores the runtime pack the same way
// (`boot-dependencies.js`); a hook calls `ensureHookDependencies` BEFORE it loads a module that reads cards, because those modules pick their card reader once, when they load. There is one parser: this only makes
// gray-matter loadable.
//
// A hook fails open, so a restore that fails (an unwritable cache, no pack for this machine) must not go unseen. It leaves a marker under Desk's state folder, and the boot check `hook-dependencies`
// (hooks/boot-checks.cjs) tells the next session which guard is degraded and files the problem. A later successful restore removes the marker.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureBootDependencies } from "./boot-dependencies.js"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

const MCP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const MARKER_DIR = "hook-degraded"
const markerFile = (env, hook) => path.join(resolveDeskStateDir({ env }), MARKER_DIR, `${hook.replace(/[^\w.-]/gu, "_")}.json`)

/**
 * Makes gray-matter loadable for the hook named `hook`, and returns `{ source, reason? }` (see `ensureBootDependencies`). Never throws. When the restore fails, a marker records which hook is degraded and why;
 * when it works, any earlier marker for the hook is removed. `ensure` and `mcpRoot` are test seams.
 */
export function ensureHookDependencies({ hook, env = process.env, mcpRoot = MCP_ROOT, ensure = ensureBootDependencies, now = () => new Date() }) {
  const result = ensure({ mcpRoot, env })
  const file = markerFile(env, hook)
  try {
    if (result.source === "none") {
      assertNotRealStateUnderTest(path.dirname(file), { env })
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ hook, reason: String(result.reason ?? "unknown").slice(0, 300), at: now().toISOString() })}\n`, { mode: 0o600 })
      renameSync(temporary, file)
    } else {
      rmSync(file, { force: true })
    }
  } catch {
    // The marker is a signal, never a requirement: a state folder that cannot be written changes nothing about the hook's own answer.
  }
  return result
}

/** The hooks that could not restore their dependencies, from the markers they left: `[{ hook, reason, at }]`, empty when none or when the folder cannot be read. */
export function degradedHooks({ env = process.env } = {}) {
  const dir = path.dirname(markerFile(env, "x"))
  let names
  try { names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort() } catch { return [] }
  const found = []
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(path.join(dir, name), "utf8"))
      if (typeof record.hook === "string") found.push({ hook: record.hook, reason: String(record.reason), at: String(record.at) })
    } catch {
      // An unreadable marker is skipped.
    }
  }
  return found
}
