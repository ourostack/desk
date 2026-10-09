// Desk's own session-start migrations, checked by the startup hooks instead
// of left to the agent's diligence.
//
// Ruling (2026-09-27, M4-7-F2): a normal session skipped the one-time tidy
// (`02-tidy-desk`) because running it depended on the agent choosing to follow
// a skill step. The startup hooks therefore run every Detect block in Desk's
// own `migrations/` folder themselves and put one `Desk migrations:` line in
// the startup context when anything is pending:
//
// - A migration with `agent_work: true` (the tidy) is work the agent does
//   with the Desk tools. The line names it and gives the exact command that
//   prints the work, and it returns at every session start until Detect stops
//   firing.
// - A Detect that does not fire but prints `held: <reason>` names a migration
//   that is pending but cannot make progress now (the tidy while another
//   session holds its claim, or after it stopped for a reason that has not
//   changed). The line gives that reason in one sentence and asks for
//   nothing.
// - A `safety: safe` migration with `needs_restart: false` and no agent work
//   runs right in the hook (Safety check, then Migrate), and the line gives
//   the agent its announcement to relay.
// - A migration with `needs_restart: true` changes what this session has
//   already loaded, and the hook cannot restart the session, so the line
//   tells the agent to run it, relay the announcement and ask for a restart.
// - A migration whose safety is not `safe`, or whose Safety check or Migrate
//   fails or runs out of time in the hook, gets the command too, so the agent
//   runs it and sees why.
//
// With nothing pending the hooks add nothing. Other plugins' migrations stay
// with `desk:session-start-migrations`, which walks every plugin root.
//
// `scripts/migrations.js run <id>` is the one command the lines name: it runs
// one migration the way `desk:session-start-migrations` describes (Detect,
// Safety check, Migrate, Announce). Everything here keeps to what Node 16 has
// and imports nothing outside Node's built-ins, because the hooks run in
// whatever Node the host puts first on PATH.

import { readdirSync, readFileSync } from "node:fs"
import { spawn as spawnChild, spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import { diffStagedPaths, formatDeskProblem, formatIndexDriftProblem, snapshotStagedPaths } from "./index-drift.js"
import { isGitRepository } from "../util/git-stage.js"

// All Detect blocks together, plus any Safety check and Migrate the hook runs,
// get this long. The Copilot hook has 5 s in all and the registry's boot
// checks take up to 300 ms of that.
export const MIGRATION_BUDGET_MS = 2_000
const OUTPUT_MAX_CHARS = 1_200
const BASH_SECTIONS = ["Detect", "Safety check", "Migrate"]

const oneLine = (value) => String(value).replace(/[\x00-\x1f\x7f]+/gu, " ").trim()

/** `'value'` for a POSIX shell, so a path with spaces or quotes stays one word. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`
}

/**
 * parseMigration(text, id) -> { id, description, safety, needsRestart, agentWork, blocks } | null
 *
 * `blocks` holds the three bash blocks and the Announce text. A file that does
 * not have that shape is not a migration Desk can run, so it is left out.
 */
export function parseMigration(text, id) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(String(text).replace(/\r\n/gu, "\n"))
  if (!match) return null
  const frontmatter = {}
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":")
    if (index > 0) frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  const blocks = {}
  const parts = match[2].split(/^## (.+)$/mu)
  for (let index = 1; index < parts.length; index += 2) {
    const heading = parts[index].trim()
    const body = parts[index + 1].trim()
    if (BASH_SECTIONS.includes(heading)) {
      const fence = /^```bash\n([\s\S]*?)\n```$/u.exec(body)
      if (fence) blocks[heading] = fence[1]
    } else if (heading === "Announce") {
      blocks.Announce = body
    }
  }
  if (frontmatter.id !== id || [...BASH_SECTIONS, "Announce"].some((section) => typeof blocks[section] !== "string")) return null
  return {
    id,
    description: frontmatter.description ?? "",
    safety: frontmatter.safety ?? "",
    needsRestart: frontmatter.needs_restart === "true",
    agentWork: frontmatter.agent_work === "true",
    blocks,
  }
}

/** Desk's own migrations under `pluginRoot`, in id order. An unreadable folder has none. */
export function readMigrations(pluginRoot) {
  const dir = path.join(pluginRoot, "migrations")
  let names
  try {
    names = readdirSync(dir).filter((name) => /^\d{2,}-[a-z0-9-]+\.md$/u.test(name)).sort()
  } catch {
    return []
  }
  const migrations = []
  for (const name of names) {
    const file = path.join(dir, name)
    let migration
    try {
      migration = parseMigration(readFileSync(file, "utf8"), name.slice(0, -3))
    } catch {
      migration = null
    }
    if (migration !== null) migrations.push({ ...migration, file })
  }
  return migrations
}

/**
 * runBlock(block, { env, cwd, timeoutMs, outputChars, spawn, platform }) -> Promise<{ status, stdout, stderr, timedOut, unavailable }>
 *
 * Runs one bash block without blocking the event loop, so the hooks' boot
 * checks run alongside it. `unavailable` means bash could not start at all (a
 * host without bash); `timedOut` means the block ran out of time, and then its
 * whole process group is killed, so a `node` it started does not outlive it.
 * Each stream stops growing once it reaches `outputChars`: the hooks keep a
 * bounded amount for one line, and the command line keeps everything.
 */
export function runBlock(block, { env, cwd, timeoutMs, outputChars = OUTPUT_MAX_CHARS * 4, spawn = spawnChild, platform = process.platform }) {
  return new Promise((resolve) => {
    // On Windows there are no process groups to kill; the block itself is killed.
    const posix = platform !== "win32"
    const child = spawn("bash", ["-c", block], { env, cwd, detached: posix, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const keep = (text, chunk) => (text.length < outputChars ? text + chunk : text)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout = keep(stdout, chunk) })
    child.stderr.on("data", (chunk) => { stderr = keep(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(posix ? -child.pid : child.pid, "SIGKILL")
      } catch {
        // Already gone between the timer and its close event.
      }
    }, Math.max(1, Math.floor(timeoutMs)))
    child.once("error", () => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr, timedOut: false, unavailable: true })
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ status: timedOut ? null : code, stdout, stderr, timedOut, unavailable: false })
    })
  })
}

/** The command that runs one migration, for the agent to copy. `desk_status` supplies the bracketed values. */
export function migrationCommand(pluginRoot, id, { tools = false } = {}) {
  const script = path.join(pluginRoot, "mcp", "scripts", "migrations.js")
  const base = `node ${shellQuote(script)} run ${id}`
  return tools ? `${base} --tools-root <root.path> --tools-person <write_scope.person; leave out when none>` : base
}

/**
 * pendingMigrations({ pluginRoot, env, cwd, budgetMs, blockLimitMs, spawn, now, spawnGit, onIndexDrift }) -> Promise<[{ id, state, ... }]>
 *
 * Runs every migration's Detect at once within one budget (and each block
 * within `blockLimitMs`, when that is smaller), then handles the ones that
 * fired in id order. `state` is:
 *   "agent_work"  Detect fired; the agent does the work in this session
 *   "restart"     Detect fired; the migration needs a restart afterwards
 *   "ran"         the hook ran it; `report` and `announce` are for the agent
 *   "run"         Detect fired but the hook could not run it; `reason` says why
 *   "unchecked"   Detect did not finish in time
 *   "held"        Detect did not fire but printed `held: <reason>`
 * A migration whose Detect does not fire otherwise, or that bash cannot run,
 * is left out.
 *
 * Index tracing (spec.md §3): none of these bash blocks is meant to touch the
 * Git index — a migration's own contract is that Detect/Safety
 * check/Migrate change no desk content — so a `git diff --cached --name-only`
 * snapshot taken immediately before and after each one, against `cwd` (only
 * when it is itself a Git repository), catches a block that stages a path it
 * never should. `onIndexDrift(block)` (a no-op by default) receives the
 * `Desk problem: index-drift — ...` block for every drift found, tagged
 * `<migration id>:<block name>` (`detect` names the whole batch: those run
 * concurrently, so a drift there cannot be pinned to one migration). It never
 * undoes the staging and never fails this function. Each snapshot is bounded
 * to a short timeout of its own (`index-drift.js`) and fails toward `null` —
 * skipping the diff, never guessing — so it can never hang this function nor
 * manufacture a false drift out of its own failure; `spawnGit` is a test-only
 * seam over `node:child_process`'s `spawnSync`.
 */
export async function pendingMigrations({
  pluginRoot, env = process.env, cwd, budgetMs = MIGRATION_BUDGET_MS, blockLimitMs = Infinity, spawn, now = () => performance.now(),
  spawnGit = spawnSync, onIndexDrift = () => {}, host,
}) {
  const started = now()
  const left = () => budgetMs - (now() - started)
  const limit = () => Math.min(left(), blockLimitMs)
  const blockEnv = { ...env, DESK_PLUGIN_ROOT: pluginRoot }
  // The hook does not know the Desk tools' person yet; the migration's own
  // resolution stands in for it, the way the Desk MCP resolves its desk.
  delete blockEnv.DESK_TOOLS_ROOT
  delete blockEnv.DESK_TOOLS_PERSON
  const pending = []
  const migrations = readMigrations(pluginRoot)
  const tracksIndex = typeof cwd === "string" && isGitRepository(cwd, spawnGit)
  const watchIndex = async (tag, run) => {
    const before = tracksIndex ? snapshotStagedPaths({ root: cwd, spawnGit }) : null
    const result = await run()
    // A failed or timed-out "before" makes any diff meaningless — skip the
    // after-snapshot too, rather than risk the same hang twice.
    if (tracksIndex && before !== null) {
      const after = snapshotStagedPaths({ root: cwd, spawnGit })
      if (after !== null) {
        const drift = diffStagedPaths(before, after)
        if (drift.length > 0) onIndexDrift(await formatIndexDriftProblem({ kind: "migration block", label: tag, drift, env, host }))
      }
    }
    return result
  }
  // Detect blocks are pure predicates, so they run at once: session start
  // waits for the slowest, not their sum.
  const detects = await watchIndex("detect", () => Promise.all(migrations.map((migration) => (left() < 1
    ? { timedOut: true }
    : runBlock(migration.blocks.Detect, { env: blockEnv, cwd, timeoutMs: limit(), spawn })))))
  for (const [index, migration] of migrations.entries()) {
    const { id, blocks } = migration
    const detect = detects[index]
    if (detect.timedOut) {
      pending.push({ id, state: "unchecked" })
      continue
    }
    if (detect.unavailable) continue
    if (detect.status !== 0) {
      const held = /^held: (.+)$/mu.exec(detect.stdout)
      if (held) pending.push({ id, state: "held", reason: oneLine(held[1]).slice(0, OUTPUT_MAX_CHARS) })
      continue
    }
    if (migration.agentWork) {
      pending.push({ id, state: "agent_work" })
      continue
    }
    if (migration.needsRestart) {
      pending.push({ id, state: "restart", description: migration.description })
      continue
    }
    if (migration.safety !== "safe") {
      pending.push({ id, state: "run", reason: `its safety is ${migration.safety || "not set"}, so it does not run on its own` })
      continue
    }
    const safety = left() < 1 ? { timedOut: true } : await watchIndex(`${id}:safety-check`, () => runBlock(blocks["Safety check"], { env: blockEnv, cwd, timeoutMs: limit(), spawn }))
    if (safety.timedOut || safety.status !== 0) {
      pending.push({ id, state: "run", reason: safety.timedOut ? "its Safety check did not finish in time" : `its Safety check stopped it: ${oneLine(safety.stdout || safety.stderr).slice(0, OUTPUT_MAX_CHARS) || "no reason given"}` })
      continue
    }
    const migrate = left() < 1 ? { timedOut: true } : await watchIndex(`${id}:migrate`, () => runBlock(blocks.Migrate, { env: blockEnv, cwd, timeoutMs: limit(), spawn }))
    if (migrate.timedOut || migrate.status !== 0) {
      pending.push({ id, state: "run", reason: migrate.timedOut ? "its Migrate did not finish in time" : "its Migrate failed" })
      continue
    }
    pending.push({ id, state: "ran", report: oneLine(migrate.stdout).slice(0, OUTPUT_MAX_CHARS), announce: oneLine(blocks.Announce) })
  }
  return pending
}

/**
 * The one `Desk migrations:` startup line for `pending`, addressed to the
 * agent, or "" when nothing is pending.
 */
export function migrationLine(pending, pluginRoot) {
  const parts = pending.map((entry) => {
    const run = (options) => `run \`${migrationCommand(pluginRoot, entry.id, options)}\``
    switch (entry.state) {
      case "agent_work":
        return `${entry.id} is pending. Do it now, before other work and without asking: call desk_status, then ${run({ tools: true })} and do what it prints.`
      case "held":
        return `${entry.id} is on hold because ${entry.reason}. Nothing to do for it now; mention it to the human in one line if it matters to them.`
      case "restart":
        return `${entry.id} is pending (${oneLine(entry.description)}). Run it now, before other work and without waiting for anyone to answer: ${run()}. It runs to completion on its own; when it is done, tell the human what it printed and ask them to start a new session — with no human in this session, just say in your own output that a restart is needed and carry on.`
      case "ran":
        return `${entry.id} ran at startup. Tell the human in one line: ${entry.report ? `${entry.report} ` : ""}${entry.announce}`
      case "run":
        return `${entry.id} is pending but did not run at startup because ${entry.reason}. Before other work, ${run()} and follow what it prints.`
      default:
        return `${entry.id} could not be checked in time at startup. Before other work, ${run({ tools: true })}; it prints that nothing is needed when that is so, and otherwise what to do.`
    }
  })
  return parts.length ? `Desk migrations: ${parts.join(" ")}` : ""
}

/** The honest, no-op filing step -- see the doc comment above. */
async function defaultFileProblem() {
  return { file: "not filed: filer_unavailable" }
}

/**
 * The startup line for this session, or "". Never rejects. Any index-drift
 * blocks `pendingMigrations` finds (spec.md §3) are appended after it, each on
 * its own line; `spawnGit` is a test-only seam, passed through unchanged.
 *
 * Migrated onto the failure contract (spec.md §1, Part 5): an internal error
 * in the migration *registry* itself (not one migration's own reported
 * states, which already carry decent messaging through `migrationLine`) now
 * emits a full `Desk problem:` block instead of silently returning only the
 * index-drift lines found before the error. Filing is never done here, and
 * never awaited past this call: `fileProblem` is an injectable hook (default:
 * the honest `not filed: filer_unavailable`), which `boot-checks.cjs`'s `migrationLine`
 * supplies for real, queuing the same detached `file-desk-problem.js` run
 * every other migrated mechanism uses.
 */
export async function startupMigrationLine({
  pluginRoot, env = process.env, cwd = process.cwd(), budgetMs, spawn, spawnGit, host, fileProblem = defaultFileProblem,
}) {
  const drifts = []
  try {
    const pending = await pendingMigrations({ pluginRoot, env, cwd, budgetMs, spawn, spawnGit, host, onIndexDrift: (block) => drifts.push(block) })
    return [migrationLine(pending, pluginRoot), ...drifts].filter((part) => part !== "").join("\n")
  } catch (error) {
    const reason = oneLine(error?.message ?? String(error))
    let file = "not filed: filer_unavailable"
    try {
      ({ file } = await fileProblem({ env, host, reason }))
    } catch {
      // stays "not filed: filer_unavailable" -- this function must never throw, whatever fileProblem does.
    }
    const block = formatDeskProblem({
      mechanism: "pending-migrations",
      symptom: "the migration registry failed internally",
      broke: reason,
      means: "Desk could not check whether any of its own migrations are pending this session",
      fix: "not fixable automatically -- the migration registry itself needs investigation",
      file,
      tell: `Desk's migration check failed internally this session (${reason}). Filing this now so it gets fixed.`,
    })
    return [...drifts, block].filter((part) => part !== "").join("\n")
  }
}

// ---------------------------------------------------------------------------
// `scripts/migrations.js roots [--engine <prefix>]`: other plugins' migration folders in the Agency cache
// ---------------------------------------------------------------------------

// Agency stores `fetched_at` as integer epoch seconds; an ISO date string is accepted too so a format change cannot make the oldest fetch look newest. Anything else counts as 0.
function fetchedSeconds(value) {
  const number = Number(value)
  if (Number.isFinite(number)) return number
  const parsed = Date.parse(value) / 1000
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The plugin folders under Agency's cache whose `migrations/` the driver should walk, one per plugin. Agency keeps
 * every fetch of every plugin source under `~/.local/agency/plugins/cache/entries/<dir_name>/` and maps each source
 * spec to its folder in `cache_index.json` (`entries[spec].dir_name`, `fetched_at`). The rule:
 *   - only specs that start with the running engine's prefix (`copilot:` by default);
 *   - never Desk's own plugin (its migrations run from the startup hooks, and the cache holds several old copies);
 *   - one folder per plugin name (from the folder's `plugin.json`, else its `agency.json`), the one with the newest `fetched_at`;
 *   - only folders that have a `migrations/` folder.
 * An unreadable index has no roots. Result is sorted by plugin name.
 */
export function agencyMigrationRoots({ home, engine = "copilot" }) {
  const cache = path.join(home, ".local", "agency", "plugins", "cache")
  let entries
  try {
    entries = Object.entries(JSON.parse(readFileSync(path.join(cache, "cache_index.json"), "utf8")).entries)
  } catch {
    return []
  }
  const newest = new Map()
  for (const [spec, entry] of entries) {
    const dirName = entry?.dir_name
    if (!spec.startsWith(`${engine}:`) || typeof dirName !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(dirName)) continue
    const dir = path.join(cache, "entries", dirName)
    let name
    for (const manifest of ["plugin.json", "agency.json"]) {
      try {
        name = JSON.parse(readFileSync(path.join(dir, manifest), "utf8")).name
      } catch {
        name = undefined
      }
      if (typeof name === "string") break
    }
    try {
      readdirSync(path.join(dir, "migrations"))
    } catch {
      continue
    }
    const fetched = fetchedSeconds(entry.fetched_at)
    if (typeof name === "string" && name !== "desk" && !(newest.get(name)?.fetched >= fetched)) newest.set(name, { dir, fetched })
  }
  return [...newest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, { dir }]) => dir)
}

// ---------------------------------------------------------------------------
// `scripts/migrations.js run <id> [--tools-root <path>] [--tools-person <alias>]`
// ---------------------------------------------------------------------------

function parseRunArgs(argv) {
  const [command, id, ...rest] = argv
  if (command !== "run" || typeof id !== "string" || id === "") throw new Error("usage: migrations.js run <id> [--tools-root <path>] [--tools-person <alias>]")
  const args = { id, toolsRoot: "", toolsPerson: "" }
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!["--tools-root", "--tools-person"].includes(flag) || typeof value !== "string") throw new Error(`migrations.js: unknown or incomplete argument ${JSON.stringify(flag)}`)
    args[flag === "--tools-root" ? "toolsRoot" : "toolsPerson"] = value
  }
  return args
}

/**
 * Runs one of Desk's own migrations the way `desk:session-start-migrations`
 * describes, with no time limit, and returns the exit code. It prints Detect's
 * verdict when nothing is needed, the Safety check's reason when it stops,
 * Migrate's output, and then the Announce text: verbatim for a migration that
 * changed the machine, as the template to fill in for agent work that printed
 * steps, and followed by the restart request when the migration needs one.
 *
 * Index tracing (spec.md §3): the same before/after staged-path snapshot
 * `pendingMigrations` takes, around each of this run's own Detect/Safety
 * check/Migrate blocks, against `cwd` (only when it is itself a Git
 * repository). This is the path that matters most: an `agent_work: true`
 * migration's Safety check and Migrate blocks (the real `02-tidy-desk` is the
 * only one today) run only here — `pendingMigrations` stops after Detect for
 * those — so this is where the incident behind this design actually
 * happened. A drift found here is printed straight to `io.stdout`, tagged
 * `<id>:detect`/`<id>:safety-check`/`<id>:migrate`; it never changes the exit
 * code and never undoes the staging. `spawnGit` is a test-only seam, passed
 * through unchanged.
 */
export async function runMigrationCli({ argv, env = process.env, io, pluginRoot, cwd, spawn, spawnGit = spawnSync, home = env.HOME || os.homedir() }) {
  if (argv[0] === "roots") {
    const engine = argv[1] === "--engine" && argv[2] ? argv[2] : "copilot"
    for (const root of agencyMigrationRoots({ home, engine })) io.stdout.write(`${root}\n`)
    return 0
  }
  let args
  try {
    args = parseRunArgs(argv)
  } catch (error) {
    io.stderr.write(`${error.message}\n`)
    return 2
  }
  const migration = readMigrations(pluginRoot).find((candidate) => candidate.id === args.id)
  if (migration === undefined) {
    io.stderr.write(`migrations.js: Desk has no migration ${args.id}\n`)
    return 2
  }
  const blockEnv = { ...env, DESK_PLUGIN_ROOT: pluginRoot, DESK_TOOLS_ROOT: args.toolsRoot, DESK_TOOLS_PERSON: args.toolsPerson }
  if (!args.toolsRoot) delete blockEnv.DESK_TOOLS_ROOT
  if (!args.toolsPerson) delete blockEnv.DESK_TOOLS_PERSON
  const tracksIndex = typeof cwd === "string" && isGitRepository(cwd, spawnGit)
  const blockTag = { Detect: "detect", "Safety check": "safety-check", Migrate: "migrate" }
  const watchIndex = async (tag, run) => {
    const before = tracksIndex ? snapshotStagedPaths({ root: cwd, spawnGit }) : null
    const result = await run()
    // A failed or timed-out "before" makes any diff meaningless — skip the
    // after-snapshot too, rather than risk the same hang twice.
    if (tracksIndex && before !== null) {
      const after = snapshotStagedPaths({ root: cwd, spawnGit })
      if (after !== null) {
        const drift = diffStagedPaths(before, after)
        // No fileProblem here: this CLI already prints the block straight to the
        // agent running it, with no time budget and nothing to lose past a
        // timeout, unlike the hook path -- the honest `file: not filed:
        // filer_unavailable` default is the right answer.
        if (drift.length > 0) io.stdout.write(`${await formatIndexDriftProblem({ kind: "migration block", label: tag, drift })}\n`)
      }
    }
    return result
  }
  // No time or output limit: the agent needs every line the migration prints.
  const run = (section) => watchIndex(`${args.id}:${blockTag[section]}`, () => runBlock(migration.blocks[section], { env: blockEnv, cwd, timeoutMs: 2 ** 31 - 1, outputChars: Infinity, spawn }))

  const detect = await run("Detect")
  if (detect.unavailable) {
    io.stderr.write("migrations.js: bash is required to run Desk's migrations\n")
    return 1
  }
  if (detect.status !== 0) {
    const held = /^held: (.+)$/mu.exec(detect.stdout)
    io.stdout.write(held ? `Migration ${args.id} is on hold because ${oneLine(held[1])}; nothing to do now.\n` : `Migration ${args.id} is not needed; nothing to do.\n`)
    return 0
  }
  if (migration.safety !== "safe") {
    io.stdout.write(`Migration ${args.id} has safety: ${migration.safety || "(none)"}, which is not implemented; skipping it.\n`)
    return 0
  }
  const safety = await run("Safety check")
  if (safety.status !== 0) {
    io.stdout.write(`${safety.stdout}${safety.stderr}`)
    io.stdout.write(`Migration ${args.id} cannot run yet; resolve the reason above first.\n`)
    return 1
  }
  const migrate = await run("Migrate")
  io.stdout.write(migrate.stdout)
  if (migrate.status !== 0) {
    io.stdout.write(migrate.stderr)
    io.stdout.write(`Migration ${args.id} failed mid-run; manual intervention needed.\n`)
    return 1
  }
  if (migration.agentWork) {
    // One line and no steps: the work cannot run this session, and that line
    // is what to say instead of the announcement.
    if (migrate.stdout.trim().split("\n").length > 1) {
      io.stdout.write(`\nAnnounce line, filled in with this run's own counts and commit link:\n${migration.blocks.Announce}\n`)
    }
    return 0
  }
  io.stdout.write(`${migration.blocks.Announce}\n`)
  if (migration.needsRestart) io.stdout.write("Please start a new session so my preamble loads against the migrated paths.\n")
  return 0
}
