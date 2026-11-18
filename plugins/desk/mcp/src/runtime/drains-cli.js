// The `drains` command line: `poll`, `ack`, `status`, `why`, `schedule`, `stalled`, `relays` and `runtimes`, defined once with Ouro AX, which
// parses the arguments, writes the help and prints a usage error as one line on stderr with its fix (exit 2). Output is one JSON value
// on stdout; a failure is the Desk failure line its code built on stderr (exit 1).
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import { AxError } from "../lib/ouro-ui/registry/ouro/ax/problem.ts"
import { defineCli, defineCommand } from "../lib/ouro-ui/registry/ouro/ax/command.ts"
import { runCli } from "../lib/ouro-ui/registry/ouro/ax/cli.ts"
import { allStuckSaves, stuckLine } from "./unmerged-saves.js"
import { pollRelays, readRelayConfig, readRelayStates, relayPaths, relayStatusLines, relaysOfPull, whyRelay } from "./relays.js"
import { findPluginlessRuntimes, listProcesses as psList, pluginlessRuntimeLines } from "./pluginless-runtimes.js"
import { ackStalled, pollStalled, stalledPaths, stalledStatus } from "./stalled.js"
import { ackSchedule, pollSchedules, readScheduleConfig, readScheduleStates, scheduleStatusLines, schedulePaths } from "./schedules.js"
import { signedInAccounts } from "../factory/flush.js"
import { ackWake, connectGithub, recoverDrainTarget, drainPaths, deskInUse, drainStatusLines, installLauncher, pollDrains, readDrainConfig, readDrainStates, whyOf, withDrainLock } from "./drains.js"

/** The Desk a poll ran from, for the history: its version, and the release commit when the launcher's own copy ran. */
const deskLabel = ({ version, release }) => (release ? `${version} ${release.slice(0, 8)}` : version)

/** The relays' status lines; a relays.json that cannot be read is one line saying so, never a reason to hide the drains. */
function relayLines(env, at) {
  const files = relayPaths({ env })
  try {
    return relayStatusLines(readRelayConfig(files.config), readRelayStates(files.state), at)
  } catch (error) {
    return [`relays: ${error.message}`]
  }
}

// A launcher that cannot be refreshed (a read-only state folder) never stops a poll; the output says so.
function refreshLauncher(env) {
  try {
    const { path: installed, sha256 } = installLauncher({ env })
    return { path: installed, sha256 }
  } catch (error) {
    return { error: String(error.code) }
  }
}

const CONFIG = { type: "string", description: "The config file to read instead of the default." }
const STATE = { type: "string", description: "The state file to keep instead of the default." }
const WAKE = { type: "string", required: true, description: "The id of the wake that was delivered, as poll printed it." }
const ERROR = { type: "string", description: "Why delivery failed; leave it out when the wake was delivered." }
const READ = { effect: "private", readOnly: true }
const ACK = (kind, flags) => ({ effect: "private", summary: `Record that a ${kind} wake was delivered (or failed, with --error).`, flags: { ...flags, wake: WAKE, error: ERROR, state: STATE } })
const text = (result) => JSON.stringify(result, null, 1)

const WHY_TARGET = /^([^#\s/]+\/[^#\s/]+)#(\d+)$/u
const WHY_NEEDS = "why needs an issue such as owner/name#123 or --relay <relay name>"
const usageError = (code, problem, fix) => new AxError({ code, exit: 2, thing: "why", problem, fix })

/** The paths for a command's files, with `--config` and `--state` taking the place of the defaults. */
const pathsOf = (defaults, flags) => ({
  ...defaults,
  ...(flags.config ? { config: path.resolve(flags.config) } : {}),
  ...(flags.state ? { state: path.resolve(flags.state), lock: `${path.resolve(flags.state)}.lock` } : {}),
})

/** A poll or status result with the Desk it ran from, its status line first and the refreshed launcher. */
function withDesk(result, { script, env }) {
  const { line, ...desk } = deskInUse({ script, env })
  return { ...result, desk, status: [line, ...result.status], launcher: refreshLauncher(env) }
}

/** The github.com logins signed in to the GitHub CLI, active first; empty when it cannot be asked. */
function ghSignedIn() {
  const cleaned = { ...process.env, PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":") }
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"]) delete cleaned[name]
  const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { encoding: "utf8", timeout: 10_000, env: cleaned, windowsHide: true })
  return signedInAccounts(`${result.stdout}\n${result.stderr}`)
}

function drainsCli({ script, env, now, connect, listProcesses, signedIn }) {
  const ackFlags = (flags, paths) => (flags.state ? ["--state", paths.state] : [])
  const ackCommand = [process.execPath, path.resolve(script)]
  const command = (name, def, run) => defineCommand({ name, output: "one JSON value", text, ...def, run })
  return defineCli({
    name: "drains",
    about: [
      "poll lists each configured repository's open issues, records what changed and prints the wakes to deliver.",
      "A runner delivers each wake's message to its session, then runs the wake's `done` command, adding --error <text> when delivery failed.",
    ],
    groups: {
      schedule: "The prompts due to a session (schedules.json), at most one per schedule however many intervals were missed; see docs/schedules.md.",
      stalled: "The nudges due to sessions that went idle with their focused task card unfinished and nothing running, once per idle stretch; see docs/stalled-nudges.md.",
      relays: "The dispatch and merge-when-green relays in relays.json: poll acts on what it finds and prints no wakes; see docs/relays.md.",
      runtimes: "Copilot server runtimes started without Desk's plugin, whose sessions have no desk-* tools, and how to recover; see docs/schedules.md.",
    },
    commands: [
      command("poll", { ...READ, summary: "List each configured repository's open issues, record what changed and print the wakes to deliver.", flags: { config: CONFIG, state: STATE }, examples: ["poll"] }, async (input) => {
        const paths = pathsOf(drainPaths({ env }), input)
        return withDesk(await withDrainLock(paths.lock, () => pollDrains({ paths, connect, now: now(), ackCommand, ackFlags: ackFlags(input, paths), desk: deskLabel(deskInUse({ script, env })) })), { script, env })
      }),
      command("ack", ACK("repository", { repo: { type: "string", required: true, placeholder: "<owner/name>", description: "The repository the wake was for." } }), (input) => {
        const paths = pathsOf(drainPaths({ env }), input)
        return withDrainLock(paths.lock, () => {
          const acked = ackWake({ paths, repo: input.repo, wake: input.wake, error: input.error, now: now() })
          return input.error ? { ...acked, recovery: recoverDrainTarget({ paths, repo: input.repo, now: now() }) } : acked
        })
      }),
      command("status", { ...READ, summary: "List each drain's state, the relays and any unmerged save, without recording anything.", flags: { config: CONFIG, state: STATE } }, (input) => {
        const paths = pathsOf(drainPaths({ env }), input)
        const status = [...drainStatusLines(readDrainConfig(paths.config), readDrainStates(paths.state), now()), ...relayLines(env, now()), ...allStuckSaves({ env, now }).map((save) => `unmerged save: ${stuckLine(save)}`)]
        return withDesk({ status }, { script, env })
      }),
      command("why", { ...READ, summary: "Print the recorded reason for each wake made for one issue, newest first, and what a merge relay decided about it; with --relay, that relay's recent fires, merges and what it waits on instead.", args: [{ name: "target", description: "The issue, as owner/name#123.", unless: "relay", missing: "needs an issue such as owner/name#123 or --relay <relay name>" }], flags: { state: STATE, relay: { type: "string", placeholder: "<relay name>", description: "A relay's name, instead of an issue." } }, examples: ["why owner/name#123", "why --relay <relay name>"] }, (input) => {
        const files = relayPaths({ env })
        const relays = readRelayConfig(files.config)
        const relayStates = readRelayStates(files.state)
        if (input.relay) return whyRelay(relays, relayStates, input.relay)
        const target = WHY_TARGET.exec(input.target)
        if (!target) throw usageError("why-target", `${WHY_NEEDS}, not ${JSON.stringify(input.target)}`, "run drains why owner/name#123 or drains why --relay <relay name>")
        const paths = pathsOf(drainPaths({ env }), input)
        return { ...whyOf(readDrainStates(paths.state), target[1], Number(target[2])), relays: relaysOfPull(relays, relayStates, target[1], Number(target[2])) }
      }),
      command("schedule poll", { ...READ, summary: "Print the prompts due to a session, at most one per schedule.", flags: { config: CONFIG, state: STATE } }, async (input) => {
        const paths = pathsOf(schedulePaths({ env }), input)
        return withDesk(await withDrainLock(paths.lock, async () => pollSchedules({ paths, now: now(), ackCommand, ackFlags: ackFlags(input, paths) })), { script, env })
      }),
      command("schedule ack", ACK("schedule", { name: { type: "string", required: true, placeholder: "<schedule>", description: "The schedule the wake was for." } }), (input) => {
        const paths = pathsOf(schedulePaths({ env }), input)
        return withDrainLock(paths.lock, async () => ackSchedule({ paths, name: input.name, wake: input.wake, error: input.error, now: now() }))
      }),
      command("schedule status", { ...READ, summary: "List the schedules without recording anything.", flags: { config: CONFIG, state: STATE } }, (input) => {
        const paths = pathsOf(schedulePaths({ env }), input)
        return withDesk({ status: scheduleStatusLines(readScheduleConfig(paths.config), readScheduleStates(paths.state), now()) }, { script, env })
      }),
      command("stalled poll", { ...READ, summary: "Print the nudges due, once per idle stretch.", flags: { config: CONFIG, state: STATE } }, async (input) => {
        const paths = pathsOf(stalledPaths({ env }), input)
        return withDesk(await withDrainLock(paths.lock, () => pollStalled({ paths, now: now(), ackCommand, ackFlags: ackFlags(input, paths), env, homeDir: os.homedir() })), { script, env })
      }),
      command("stalled ack", ACK("stalled-session", { session: { type: "string", required: true, placeholder: "<id>", description: "The session the nudge was for." } }), (input) => {
        const paths = pathsOf(stalledPaths({ env }), input)
        return withDrainLock(paths.lock, async () => ackStalled({ paths, session: input.session, wake: input.wake, error: input.error, now: now() }))
      }),
      command("stalled status", { ...READ, summary: "List the nudges due without recording anything (a dry run).", flags: { config: CONFIG, state: STATE } }, async (input) => {
        const paths = pathsOf(stalledPaths({ env }), input)
        return withDesk(await stalledStatus({ paths, now: now(), env, homeDir: os.homedir() }), { script, env })
      }),
      command("relays poll", { effect: "private", summary: "Poll the relays in relays.json, act on what is found and print no wakes.", flags: { config: CONFIG, state: STATE } }, async (input) => {
        const paths = pathsOf(relayPaths({ env }), input)
        return withDesk(await withDrainLock(paths.lock, () => pollRelays({ paths, drainFiles: drainPaths({ env }), connect, now: now(), signedIn })), { script, env })
      }),
      command("relays status", { ...READ, summary: "List the relays without acting.", flags: { config: CONFIG, state: STATE } }, (input) => {
        const paths = pathsOf(relayPaths({ env }), input)
        return withDesk({ status: relayStatusLines(readRelayConfig(paths.config), readRelayStates(paths.state), now()) }, { script, env })
      }),
      command("runtimes status", { ...READ, summary: "Name the Copilot server runtimes started without Desk's plugin, and how to recover." }, () => ({ status: pluginlessRuntimeLines(findPluginlessRuntimes(listProcesses())) })),
    ],
  })
}

export async function runDrainsCli({ argv, script, env = process.env, io = process, now = Date.now, connect = connectGithub, listProcesses = psList, signedIn = ghSignedIn }) {
  return runCli(drainsCli({ script, env, now, connect, listProcesses, signedIn }), argv, { stdout: io.stdout, stderr: io.stderr })
}
