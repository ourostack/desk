// Session-start's own sync step. It fetches the remote and catches the checkout up when it is only behind, the way
// `git checkout` would: a file another session changed, or an untracked file in the way, leaves the checkout where it
// was and is named. It never rebases, stashes or resets the shared checkout (a desk is often one checkout several
// sessions write to), so a pull cannot leave it conflicted or mid-rebase. Local commits the remote lacks are delivered
// from a clean copy by the push worker (`runtime/deliver.js`), which moves the checkout afterwards.
//
// `syncWorkspace` never throws. Every Git call is bounded by a timeout and runs with `GIT_TERMINAL_PROMPT=0`;
// `spawnGit` is an injectable seam over `spawnSync`, for tests only.

import { spawn, spawnSync } from "node:child_process"

import { commandArgument } from "./pr-publication.js"
import { deskFailure } from "./desk-failure.js"
import { hasRemoteConfigured, readSyncStatus, recordPullOutcome, schedulePush, updateSyncStatus } from "./sync-worker.js"
import { readUpstreamRefs } from "./fast-refs.js"
import { catchUpBehind, classifyPullFailure, undeliveredCommits, upstreamOf } from "./deliver.js"
import { remoteIdentityEnv } from "./remote-identity.js"
import { applyPublicationMode } from "./publication-mode.js"
import { commitWaitingLogs } from "./append-lane.js"
import { defineCli, defineCommand } from "../lib/ouro-ui/registry/ouro/ax/command.ts"
import { runCli } from "../lib/ouro-ui/registry/ouro/ax/cli.ts"

const GIT_TIMEOUT_MS = 10_000
// The whole sequence's own wall-clock budget: session start cannot afford an unbounded sync step, so each git call gets
// whatever of this remains, capped at `GIT_TIMEOUT_MS`, and the sequence gives up (as `unresolved`, never a hang) once it is gone.
const SYNC_WORKSPACE_DEADLINE_MS = 20_000
// A fetch this recent (this worker's, a save's delivery or an earlier pull) is what a pull reads instead of asking the remote again.
export const FETCH_FRESH_MS = 15_000


// `GIT_SSH_COMMAND` gets the same treatment `GIT_TERMINAL_PROMPT=0` already
// gives the HTTPS credential prompt: `-o BatchMode=yes` disables every
// interactive SSH prompt so an SSH-remote desk can never hang session start
// either. A caller's own `GIT_SSH_COMMAND` is extended, never replaced.
function gitEnv() {
  const existing = process.env.GIT_SSH_COMMAND
  const sshCommand = typeof existing === "string" && existing.trim() !== "" ? `${existing} -o BatchMode=yes` : "ssh -o BatchMode=yes"
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: sshCommand }
}

// Every call site threads its own budgeted, positive timeout through explicitly, so `timeoutMs` has no default of its own.
function run(spawnGit, root, args, timeoutMs) {
  return spawnGit("git", ["-C", root, ...args], { windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
    env: remoteIdentityEnv({ root, args, env: gitEnv(), spawn: spawnGit }),
  })
}

/**
 * `spawnSync`'s result shape, without blocking the event loop: the fetch is the one network call here and can take
 * seconds, and boot's own network checks run while it does. A timeout ends the child with SIGTERM, as `spawnSync` does.
 */
export function spawnGitAsync(command, args, { timeout, env, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const stdout = []
    const stderr = []
    let timedOut = false
    const child = spawnImpl(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeout)
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ status: null, signal: null, stdout: "", stderr: "", error })
    })
    child.on("close", (status, signal) => {
      clearTimeout(timer)
      const result = { status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
      resolve(timedOut ? { ...result, error: Object.assign(Object.assign(new Error("Run it again: git timed out"), { code: "session_sync_run_it_again_git_timed" }), { code: "ETIMEDOUT" }) } : result)
    })
  })
}

function fetchUpstream(root, upstream, spawnFetch, timeoutMs) {
  return run(spawnFetch, root, ["fetch", "--quiet", "--no-tags", upstream.remote, `+${upstream.merge}:${upstream.tracking}`], timeoutMs)
}

// Why a failed fetch failed (refused credentials, an unreachable remote, a ran-out budget or something else) is decided by
// `classifyPullFailure`, shared with delivery (runtime/deliver.js).
export { classifyPullFailure }

// The first meaningful line of git's own complaint, without any credentials a remote URL carried.
function firstErrorLine(stderr) {
  const line = String(stderr ?? "").split(/\r?\n/u).map((value) => value.trim()).find((value) => value !== "" && !/^hint:/iu.test(value)) ?? ""
  return line.replace(/\/\/[^/@\s]+@/gu, "//").slice(0, 200)
}

function originUrl(root, spawnGit, timeoutMs) {
  const result = run(spawnGit, root, ["remote", "get-url", "origin"], timeoutMs)
  const url = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : ""
  return url === "" ? null : url.replace(/\/\/[^/@\s]+@/u, "//")
}


// Causes that stop delivery too: no push is started for them.
const OFFLINE = new Set(["unreachable", "auth_failed"])

// Each cause's failure: what probably happened, how to look further, how to keep working and the fix. `git status` reads clean when the remote could not be asked.
function syncFailure({ cause, root, remote, reason, paths }) {
  const git = (...args) => `\`git -C ${commandArgument(root)} ${args.join(" ")}\``
  const delivery = "Desk's own writes still publish from a clean copy of the remote, so keep working, and never stash, rebase or reset the shared checkout for this"
  const bug = "if it keeps happening, file a bug with desk_problem"
  const causes = {
    auth_failed: {
      probably: `the remote refused this host's credentials, probably because no GitHub account signed in to gh can reach ${remote ?? "the desk's remote"}`,
      look: `run ${git("ls-remote", "origin")} to see git's own answer`,
      keepWorking: "the remote cannot be used from this machine right now, so nothing was fetched or pushed and `git status` will read clean; local work continues and Desk retries with every write",
      fix: "gh auth login --hostname github.com",
    },
    unreachable: {
      probably: "the remote could not be reached, probably because this machine is offline or the host is down",
      look: `run ${git("ls-remote", "origin")} to see whether it answers`,
      keepWorking: "the remote cannot be used from this machine right now, so `git status` will read clean; work continues on local state, and Desk delivers its local commits once it can",
      fix: null,
    },
    deadline: {
      probably: "sync ran out of time before it finished, probably because the remote or the network was slow",
      look: "call desk_status and read its sync section",
      keepWorking: "retry sync before pushing; local work is untouched",
      fix: null,
    },
    local_changes: {
      probably: "files the remote also changed are modified or untracked in this checkout, so it was left where it was instead of overwriting them",
      look: `run ${git("status")} to see them`,
      keepWorking: `nothing of yours was touched, and the next sync catches the checkout up once those files are committed or moved; ${bug}; ${delivery}`,
      fix: null,
    },
  }
  const found = causes[cause] ?? {
    probably: "`git fetch` did not finish",
    look: `run ${git("fetch")} to see git's own answer`,
    keepWorking: `the checkout itself was not changed; ${bug}; ${delivery}`,
    fix: null,
  }
  const what = `${reason}${paths.length ? `; in the way: ${paths.join(", ")}` : ""}`
  return deskFailure({ code: "session_sync_unresolved", thing: "sync", ...found, probably: `${found.probably} (${what})` })
}

function unresolved({ root, reason, cause, failed, paths = [], spawnGit, timeoutMs }) {
  const remote = originUrl(root, spawnGit, timeoutMs)
  const error = firstErrorLine(failed?.stderr)
  const diagnostic = syncFailure({ cause, root, remote, reason, paths })
  return { state: "unresolved", reason, diagnostic, cause, remote, error, conflicted: paths }
}

/**
 * `{ root, env, spawnGit? }` -> `{ state: "synced", nothingToSync? } | { state: "unresolved", reason, cause, diagnostic,
 * conflicted }`. Never throws.
 *
 * A desk with no remote at all, or whose current branch has no upstream yet, has nothing to sync against: an ordinary
 * state for a brand-new or purely-local desk, not a defect, so it is `synced` without ever fetching.
 *
 * The sequence shares one 20 s wall-clock budget (`SYNC_WORKSPACE_DEADLINE_MS`; `now` is a test seam): each git call gets
 * what remains, capped at `GIT_TIMEOUT_MS`, and running out ends it as `unresolved` (reason `sync_deadline_exceeded`).
 * A fetch that fails is `unresolved` with its cause (see `classifyPullFailure`). Once fetched, a checkout that is only
 * behind is moved to the remote's commit the way `git checkout` would; files in the way leave it where it was
 * (`unresolved`, reason `local_changes_in_the_way`, the paths in `conflicted`). A checkout that also holds commits the remote
 * lacks stays as it is: the delivery below replays them onto the remote and then moves the checkout.
 *
 * Nothing here holds back the desk's own commits (#396): whenever local commits are not on the remote, and the remote is
 * not known to be unreachable or refusing this machine, the detached push worker is started to deliver them from a clean
 * copy (runtime/deliver.js), and the result says so in `unpushed: { count, delivering, reason, paths }`, `reason` being
 * the last recorded push failure, if any. `scheduleDelivery` is a test seam.
 */
export async function syncWorkspace(options) {
  // Task log entries a server wrote and never committed (one that ended before its push worker committed them, or an older
  // Desk that committed them in-process) are committed first, so the pull carries them and the delivery below pushes them.
  commitWaitingLogs(options.root)
  const result = await runSync(options)
  // `desk_status` reads this back, so its health word carries a failed sync the way boot's does.
  recordPullOutcome({ root: options.root, env: options.env, result })
  return withDelivery(options, result)
}

function withDelivery({ root, env, spawnGit = spawnSync, scheduleDelivery = schedulePush }, result) {
  if (result.nothingToSync !== undefined) return result
  // Nothing the remote lacks: the checkout is exactly at its upstream, which two file reads can say without starting Git.
  const refs = spawnGit === spawnSync ? readUpstreamRefs(root) : null
  if (refs !== null && refs.head === refs.target) return result
  const recorded = readSyncStatus({ root, env })
  const left = undeliveredCommits({ root, spawnGit, delivered: Array.isArray(recorded?.delivered) ? recorded.delivered : [] })
  if (left === null || left.length === 0) return result
  const offline = result.state === "unresolved" && OFFLINE.has(result.cause)
  if (!offline) scheduleDelivery({ root, env, debounceMs: 0 })
  const reason = recorded?.blocked === true ? recorded.reason ?? null : offline ? result.cause : null
  const paths = recorded?.blocked === true && Array.isArray(recorded.paths) ? recorded.paths : []
  return { ...result, unpushed: { count: left.length, delivering: !offline, reason, paths } }
}

async function runSync({
  root, env, spawnGit = spawnSync, now = () => Date.now(),
  // The fetch runs asynchronously unless a caller supplies its own `spawnGit`, which then runs every call.
  spawnPull = spawnGit === spawnSync ? spawnGitAsync : spawnGit,
}) {
  // Nothing to sync against is "synced" for every caller, with `nothingToSync` saying which kind so boot never reports it as a sync that worked.
  // The real Git is asked only what the files cannot say; a caller's own `spawnGit` runs every call, as its tests expect.
  const read = spawnGit === spawnSync ? readUpstreamRefs(root) : null
  if (read === null && !hasRemoteConfigured(root, spawnGit)) return { state: "synced", nothingToSync: "no_remote" }
  const upstream = read ?? upstreamOf((args) => run(spawnGit, root, args, GIT_TIMEOUT_MS))
  if (upstream === null) return { state: "synced", nothingToSync: "no_upstream" }

  const deadlineAt = now() + SYNC_WORKSPACE_DEADLINE_MS
  const remaining = () => deadlineAt - now()
  const deadline = () => unresolved({ root, reason: "sync_deadline_exceeded", cause: "deadline", spawnGit, timeoutMs: GIT_TIMEOUT_MS })
  if (remaining() <= 0) return deadline()

  const stamp = read === null ? undefined : readSyncStatus({ root, env })?.fetchedAt
  const fresh = typeof stamp === "number" && now() - stamp >= 0 && now() - stamp < FETCH_FRESH_MS
  const fetched = fresh ? { status: 0 } : await fetchUpstream(root, upstream, spawnPull, Math.min(GIT_TIMEOUT_MS, remaining()))
  if (!fresh && fetched.status === 0 && read !== null) updateSyncStatus(root, env, { fetchedAt: now() })
  if (fetched.status !== 0) {
    const cause = classifyPullFailure({ stderr: fetched.stderr, timedOut: fetched.error?.code === "ETIMEDOUT" || fetched.signal === "SIGTERM" })
    return unresolved({ root, reason: "fetch_failed", cause, failed: fetched, spawnGit, timeoutMs: GIT_TIMEOUT_MS })
  }
  if (remaining() <= 0) return deadline()

  const after = read === null ? null : readUpstreamRefs(root)
  if (after !== null && after.head === after.target) return { state: "synced" }
  const moved = catchUpBehind({ root, spawnGit, known: after })
  if (moved.state === "behind" && moved.reason === "local_changes") {
    return unresolved({ root, reason: "local_changes_in_the_way", cause: "local_changes", paths: moved.paths, spawnGit, timeoutMs: GIT_TIMEOUT_MS })
  }
  return { state: "synced" }
}

// ---------------------------------------------------------------------------
// The CLI surface (`mcp/scripts/session-sync.js`).
// ---------------------------------------------------------------------------

/**
 * Session-start's own CLI entry point, kept here so it is unit-tested
 * directly rather than through a subprocess -- the script itself is one
 * line, the same shape as `sync-worker.js`'s own `runSyncPushCli`. Always
 * exits 0: a hook must not block session start. `--root` falls back to
 * `env.DESK`, matching every other Desk script's own root resolution.
 * `syncFn` is a test seam.
 */
export async function runSessionSyncCli({ argv = process.argv.slice(2), env = process.env, io = process, syncFn = syncWorkspace } = {}) {
  let lines = ""
  const cli = defineCli({
    name: "session-sync.js",
    about: ["Pulls the desk's remote into the bound desk at session start and prints a Desk problem block when it cannot."],
    command: defineCommand({
      name: "session-sync.js",
      summary: "Sync the desk with its remote; print the diagnostic when the sync does not resolve. Always exits 0 for a sync outcome.",
      effect: "private",
      output: "nothing when synced, else the diagnostic block",
      flags: {
        root: { type: "string", description: "The desk to sync; the DESK env var when left out." },
        publication: { type: "string", description: "How commits reach the remote; `deferred` leaves the push for later." },
      },
      text: () => lines,
      run: async (input) => {
        applyPublicationMode({ publication: input.publication }, env)
        const root = input.root ?? env.DESK
        if (typeof root !== "string" || root === "") {
          io.stderr.write("session-sync.js: Pass --root <path>: --root <path> (or the DESK env var) is required\n")
          return {}
        }
        const result = await syncFn({ root, env })
        if (result.state === "unresolved") lines = `${result.diagnostic}\n`
        return {}
      },
    }),
  })
  // A sync that resolved prints nothing; the kit would end it with an empty line.
  const stdout = { write: (text) => (lines === "" && text === "\n" ? true : io.stdout.write(text)) }
  const code = await runCli(cli, argv, { stdin: process.stdin, stdout, stderr: io.stderr }, { env })
  return code === 2 ? 2 : 0
}
