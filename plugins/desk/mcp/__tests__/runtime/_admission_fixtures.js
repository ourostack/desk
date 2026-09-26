// Fixtures for the admission tests: temporary desks that are Git checkouts with an origin, isolated environments, and a spawned Desk session.
//
// Everything lives under the OS temp dir: a bare origin, a clone that is the desk, a temporary HOME whose ~/.cache and ~/.local/state receive Desk's readiness and state files. Nothing touches a real desk, real host config or the real readiness cache.

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { bootstrapPath, isolatedEnv, makeIsolatedHome, indexPath, pluginRoot } from "../launch/_mcp_handshake.js"
import { openSession } from "../launch/_mcp_session.js"

export const HANDSHAKE_BUDGET_MS = 3000

export function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Desk Test", "-c", "user.email=desk-test@example.invalid", "-c", "init.defaultBranch=main", "-c", "advice.detachedHead=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`)
  return result.stdout.trim()
}

export function writeFile(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, text)
}

/**
 * A temporary HOME plus a desk that is a clone of a bare origin: `main` holds a small desk, and `feature` is a pushed branch one commit ahead.
 * Returns the isolated-home fixture with `desk`, `origin`, `stateDir` (Desk's state directory) and `readinessHome`.
 */
export async function makeGitDesk(prefix = "desk-admission-") {
  const fixture = await makeIsolatedHome(prefix)
  const origin = path.join(fixture.root, "origin.git")
  const seed = path.join(fixture.root, "seed")
  mkdirSync(seed, { recursive: true })
  git(fixture.root, "init", "--bare", origin)
  git(seed, "init")
  writeFile(path.join(seed, "_meta", "friction.md"), "# Friction\n")
  writeFile(path.join(seed, "_archive", ".keep"), "")
  writeFile(path.join(seed, ".gitignore"), ".state/\n")
  writeFile(path.join(seed, "ops", "harbor-lights", "task.md"), "---\nschema_version: 1\ntitle: Harbor lights\nstatus: active\n---\n\n# Harbor lights\n\nThe lighthouse keeper logs every ferry crossing.\n")
  git(seed, "add", "-A")
  git(seed, "commit", "-m", "seed desk")
  git(seed, "remote", "add", "origin", origin)
  git(seed, "push", "origin", "main")
  git(seed, "switch", "-c", "feature")
  writeFile(path.join(seed, "ops", "feature-note.md"), "feature\n")
  git(seed, "add", "-A")
  git(seed, "commit", "-m", "feature work")
  git(seed, "push", "origin", "feature")
  // The desk replaces the empty folder makeIsolatedHome made.
  rmSync(fixture.desk, { recursive: true, force: true })
  git(fixture.root, "clone", origin, fixture.desk)
  git(fixture.desk, "fetch", "origin", "feature:refs/remotes/origin/feature")
  return {
    ...fixture,
    origin,
    stateDir: path.join(fixture.home, ".local", "state", "ouroboros-skills", "desk"),
    readinessHome: path.join(fixture.home, ".cache", "ouroboros-skills", "desk", "readiness"),
  }
}

/** An activation config next to the fixture: lexical only, so no test ever reaches an embedding service. */
export function writeActivation(fixture, deskRuntime = { semantic: "unsupported" }, extra = {}) {
  const configPath = path.join(fixture.root, "desk.activation.json")
  writeFile(configPath, JSON.stringify({ schema_version: 1, desk: { root: fixture.desk, ...extra }, desk_runtime: deskRuntime }))
  return configPath
}

/** The Claude `.mcp.json` inline launcher: `node -e <script>`, which finds mcp/bootstrap.cjs from DESK_PLUGIN_ROOT and runs it in its own process. */
export function inlineLauncherScript() {
  const config = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"))
  const server = config.mcpServers.desk
  return server.args[server.args.indexOf("-e") + 1]
}

/**
 * Start Desk over stdio the way a host does, with the fixture's isolated environment.
 * `entry` picks the launch path: "index" (node index.js), "bootstrap" (node bootstrap.cjs, which runs index.js in its own process when this Node fits a shipped pack, or re-runs it under a Node that does) or "launcher" (the `.mcp.json` inline launcher). `node` is the Node that starts it.
 */
export function startDesk(fixture, { args = [], env = {}, nodeArgs = [], entry = "index", node = process.execPath } = {}) {
  // `node -e` leaves its first extra argument out of process.argv.slice(2), so the launcher gets a placeholder first, as a host's empty argument list would.
  const entryArgs = { index: [indexPath], bootstrap: [bootstrapPath], launcher: ["-e", inlineLauncherScript(), "desk-launcher"] }[entry]
  return openSession({
    command: node,
    args: [...nodeArgs, ...entryArgs, ...args],
    cwd: fixture.root,
    env: isolatedEnv(fixture, {
      DESK: undefined,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ...(entry === "launcher" ? { DESK_PLUGIN_ROOT: pluginRoot } : {}),
      ...env,
    }),
  })
}

export function readLastStart(fixture) {
  return JSON.parse(readFileSync(path.join(fixture.stateDir, "last-start.json"), "utf8"))
}

export const settled = (payload) => payload.state !== "admitting"
