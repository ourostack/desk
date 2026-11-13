// Runs the released Desk's `drains.js` with the arguments given. `drains.js` installs a copy of this file at
// `<state>/ouroboros-skills/desk/drains/run.mjs`, the one stable path a wake runner needs, so nothing depends on a Desk checkout.
// The script is found through Agency's plugin cache: the newest entry for ourostack/desk's plugins/desk@release. When that cannot be
// resolved, the last path that worked is used, or the private copy of the last released Desk this file keeps in `release/` next to it
// (Agency can drop a cache entry and its index line while it refreshes), and one line is logged to stderr and to resolve.log.
// This file must stay standalone: the installed copy has no neighbours to import.
import { spawnSync } from "node:child_process"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const RELEASE = /:github:ourostack\/desk:plugins\/desk@release$/u

function stateDir(env, home) {
  const configured = typeof env.XDG_STATE_HOME === "string" ? env.XDG_STATE_HOME.trim() : ""
  const stateHome = path.isAbsolute(configured) ? configured : path.join(home, ".local", "state")
  return path.join(stateHome, "ouroboros-skills", "desk", "drains")
}

function released(cache) {
  const entries = Object.values(JSON.parse(readFileSync(path.join(cache, "cache_index.json"), "utf8")).entries ?? {})
  const found = entries
    .filter((entry) => typeof entry.spec === "string" && RELEASE.test(entry.spec))
    .sort((a, b) => (b.fetched_at ?? 0) - (a.fetched_at ?? 0))
    .map((entry) => path.join(cache, "entries", entry.dir_name, "mcp", "scripts", "drains.js"))
    .find((script) => existsSync(script))
  if (!found) throw new Error("no released Desk entry with scripts/drains.js in the cache index")
  return found
}

/** Keeps a private copy of the resolved release (the files `drains.js` runs from), so a cache entry Agency drops does not stop the poll. */
function keep(script, dir) {
  const target = path.join(dir, "release")
  const marker = path.join(target, "source")
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === script) return
  const mcp = path.dirname(path.dirname(script))
  rmSync(target, { recursive: true, force: true })
  for (const part of ["scripts", "src", "package.json"]) if (existsSync(path.join(mcp, part))) cpSync(path.join(mcp, part), path.join(target, "mcp", part), { recursive: true })
  writeFileSync(marker, `${script}\n`)
}

/** Resolves the script, runs it and returns its exit status. */
export function launch({ argv, env = process.env, home = homedir(), spawn = spawnSync, stderr = process.stderr, execPath = process.execPath, now = () => new Date() }) {
  const dir = stateDir(env, home)
  const cache = env.AGENCY_PLUGIN_CACHE ?? path.join(home, ".local", "agency", "plugins", "cache")
  const lastGood = path.join(dir, "last-good-script")
  let script
  try {
    script = released(cache)
    if (!existsSync(lastGood) || readFileSync(lastGood, "utf8").trim() !== script) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(lastGood, `${script}\n`)
    }
    keep(script, dir)
  } catch (error) {
    const remembered = existsSync(lastGood) ? readFileSync(lastGood, "utf8").trim() : null
    script = [remembered, path.join(dir, "release", "mcp", "scripts", "drains.js")].find((candidate) => candidate && existsSync(candidate)) ?? remembered
    const line = `${now().toISOString()} could not resolve the released Desk (${error.message}); ${script ? `using ${script === remembered ? "the last good path" : "the kept copy"} ${script}` : "no last good path"}`
    stderr.write(`${line}\n`)
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, "resolve.log"), `${line}\n`)
    if (!script || !existsSync(script)) return 1
  }
  return spawn(execPath, [script, ...argv], { stdio: "inherit", windowsHide: true }).status ?? 1
}

/* istanbul ignore next -- the entry line: tests call launch() directly and run the installed copy as a program. */
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = launch({ argv: process.argv.slice(2) })
