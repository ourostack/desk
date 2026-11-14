// The `drains` command line: `poll`, `ack`, `status`, `why`, `schedule` and `relays`. Output is one JSON value on stdout; a usage error is one line on stderr
// (exit 2) and a failure is a Desk failure line on stderr (exit 1).
import * as path from "node:path"
import { deskFailure } from "./desk-failure.js"
import { pollRelays, readRelayConfig, readRelayStates, relayPaths, relayStatusLines, relaysOfPull, whyRelay } from "./relays.js"
import { ackSchedule, pollSchedules, readScheduleConfig, readScheduleStates, scheduleStatusLines, schedulePaths } from "./schedules.js"
import { ackWake, connectGithub, drainPaths, deskInUse, drainStatusLines, installLauncher, pollDrains, readDrainConfig, readDrainStates, whyOf, withDrainLock } from "./drains.js"

const USAGE = [
  "Usage: drains.js poll [--config <file>] [--state <file>]",
  "       drains.js ack --repo <owner/name> --wake <id> [--error <text>] [--state <file>]",
  "       drains.js status [--config <file>] [--state <file>]",
  "       drains.js why <owner/name>#<number> [--state <file>]",
  "       drains.js why --relay <relay name>",
  "       drains.js schedule poll|status [--config <file>] [--state <file>]",
  "       drains.js schedule ack --name <schedule> --wake <id> [--error <text>] [--state <file>]",
  "       drains.js relays poll|status [--config <file>] [--state <file>]",
  "poll lists each configured repository's open issues, records what changed and prints the wakes to deliver.",
  "why prints the recorded reason for each wake made for one issue, newest first, and what a merge relay decided about it; with --relay it prints that relay's recent fires, merges and what it waits on instead.",
  "relays polls the dispatch and merge-when-green relays in relays.json, acts on what it finds and prints no wakes; see docs/relays.md.",
  "schedule prints the prompts due to a session (schedules.json), at most one per schedule however many intervals were missed; see docs/schedules.md.",
  "A runner delivers each wake's message to its session, then runs the wake's `done` command, adding --error <text> when delivery failed.",
].join("\n")

const usageFailure = (code, thing, fix) => deskFailure({ code, thing, probably: "the command line does not match the drains usage", look: "run drains.js --help", keepWorking: "nothing was polled or changed", fix })

/** The Desk a poll ran from, for the history: its version, and the release commit when the launcher's own copy ran. */
const deskLabel = ({ version, release }) => (release ? `${version} ${release.slice(0, 8)}` : version)

const VALUED = { poll: ["--config", "--state"], ack: ["--repo", "--wake", "--error", "--state"], status: ["--config", "--state"], why: ["--state", "--relay"], schedule: ["--config", "--state", "--name", "--wake", "--error"], relays: ["--config", "--state"] }

export function parseDrainsArgs(argv) {
  const [command, ...args] = argv
  if (command === undefined || command === "--help" || command === "-h") return { help: true }
  if (!(command in VALUED)) return { error: usageFailure("drains_unknown_command", `unknown command ${JSON.stringify(command)}`, "run drains.js poll, ack, status, why, schedule or relays") }
  const target = command === "why" ? /^([^#\s/]+\/[^#\s/]+)#(\d+)$/u.exec(args[0] ?? "") : null
  const whyFailure = () => usageFailure("drains_why_target", "why needs an issue such as owner/name#123 or --relay <relay name>", "run drains.js why owner/name#123 or drains.js why --relay <relay name>")
  if (command === "why" && !target && !args[0]?.startsWith("--")) return { error: whyFailure() }
  const sub = command === "schedule" || command === "relays" ? args[0] : undefined
  if (command === "schedule" && !["poll", "ack", "status"].includes(sub)) return { error: usageFailure("drains_schedule_command", "schedule needs poll, ack or status", "run drains.js schedule poll, ack or status") }
  if (command === "relays" && !["poll", "status"].includes(sub)) return { error: usageFailure("drains_relays_command", "relays needs poll or status", "run drains.js relays poll or status") }
  const rest = command === "schedule" || command === "relays" || target ? args.slice(1) : args
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]
    const value = rest[i + 1]
    if (!VALUED[command].includes(name)) return { error: usageFailure("drains_unknown_flag", `${command} does not take ${JSON.stringify(name)}`, `drop ${name} or use ${VALUED[command].join(" or ")}`) }
    if (value === undefined || value.startsWith("--")) return { error: usageFailure("drains_flag_value", `${name} needs a value`, `pass ${name} <value>`) }
    flags[name.slice(2)] = value
    i++
  }
  if (command === "ack" && (!flags.repo || !flags.wake)) return { error: usageFailure("drains_ack_args", "ack needs --repo and --wake", "run drains.js ack --repo <owner/name> --wake <id>") }
  if (command === "schedule" && sub === "ack" && (!flags.name || !flags.wake)) return { error: usageFailure("drains_schedule_ack_args", "schedule ack needs --name and --wake", "run drains.js schedule ack --name <schedule> --wake <id>") }
  if (command === "schedule" || command === "relays") return { command, sub, flags }
  if (command === "why" && !target && !flags.relay) return { error: whyFailure() }
  if (command === "why") return target ? { command, flags, repo: target[1], number: Number(target[2]) } : { command, flags, relay: flags.relay }
  return { command, flags }
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

export async function runDrainsCli({ argv, script, env = process.env, io = process, now = Date.now, connect = connectGithub }) {
  const parsed = parseDrainsArgs(argv)
  if (parsed.help) {
    io.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (parsed.error) {
    io.stderr.write(`${parsed.error}\n${USAGE}\n`)
    return 2
  }
  const { command, flags } = parsed
  if (command === "schedule") return runScheduleCli({ parsed, script, env, io, now })
  if (command === "relays") return runRelaysCli({ parsed, script, env, io, now, connect })
  const defaults = drainPaths({ env })
  const paths = { ...defaults, ...(flags.config ? { config: path.resolve(flags.config) } : {}), ...(flags.state ? { state: path.resolve(flags.state), lock: `${path.resolve(flags.state)}.lock` } : {}) }
  try {
    let result
    if (command === "poll") {
      const ackFlags = flags.state ? ["--state", paths.state] : []
      result = await withDrainLock(paths.lock, () => pollDrains({ paths, connect, now: now(), ackCommand: [process.execPath, path.resolve(script)], ackFlags, desk: deskLabel(deskInUse({ script, env })) }))
    } else if (command === "ack") {
      result = await withDrainLock(paths.lock, () => ackWake({ paths, repo: flags.repo, wake: flags.wake, error: flags.error, now: now() }))
    } else if (command === "why") {
      const files = relayPaths({ env })
      const relays = readRelayConfig(files.config)
      const relayStates = readRelayStates(files.state)
      const answer = parsed.relay
        ? whyRelay(relays, relayStates, parsed.relay)
        : { ...whyOf(readDrainStates(paths.state), parsed.repo, parsed.number), relays: relaysOfPull(relays, relayStates, parsed.repo, parsed.number) }
      io.stdout.write(`${JSON.stringify(answer, null, 1)}\n`)
      return 0
    } else {
      const relays = readRelayConfig(relayPaths({ env }).config)
      result = { status: [...drainStatusLines(readDrainConfig(paths.config), readDrainStates(paths.state), now()), ...relayStatusLines(relays, readRelayStates(relayPaths({ env }).state), now())] }
    }
    if (command !== "ack") {
      const { line, ...desk } = deskInUse({ script, env })
      result = { ...result, desk, status: [line, ...result.status], launcher: refreshLauncher(env) }
    }
    io.stdout.write(`${JSON.stringify(result, null, 1)}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`${error.message}\n`)
    return 1
  }
}

async function runScheduleCli({ parsed, script, env, io, now }) {
  const { sub, flags } = parsed
  const defaults = schedulePaths({ env })
  const paths = { ...defaults, ...(flags.config ? { config: path.resolve(flags.config) } : {}), ...(flags.state ? { state: path.resolve(flags.state), lock: `${path.resolve(flags.state)}.lock` } : {}) }
  try {
    let result
    if (sub === "poll") {
      const ackFlags = flags.state ? ["--state", paths.state] : []
      result = await withDrainLock(paths.lock, async () => pollSchedules({ paths, now: now(), ackCommand: [process.execPath, path.resolve(script)], ackFlags }))
    } else if (sub === "ack") {
      result = await withDrainLock(paths.lock, async () => ackSchedule({ paths, name: flags.name, wake: flags.wake, error: flags.error, now: now() }))
    } else {
      result = { status: scheduleStatusLines(readScheduleConfig(paths.config), readScheduleStates(paths.state), now()) }
    }
    if (sub !== "ack") {
      const { line, ...desk } = deskInUse({ script, env })
      result = { ...result, desk, status: [line, ...result.status], launcher: refreshLauncher(env) }
    }
    io.stdout.write(`${JSON.stringify(result, null, 1)}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`${error.message}\n`)
    return 1
  }
}

async function runRelaysCli({ parsed, script, env, io, now, connect }) {
  const { sub, flags } = parsed
  const defaults = relayPaths({ env })
  const paths = { ...defaults, ...(flags.config ? { config: path.resolve(flags.config) } : {}), ...(flags.state ? { state: path.resolve(flags.state), lock: `${path.resolve(flags.state)}.lock` } : {}) }
  try {
    let result
    if (sub === "poll") {
      result = await withDrainLock(paths.lock, () => pollRelays({ paths, drainFiles: drainPaths({ env }), connect, now: now() }))
    } else {
      result = { status: relayStatusLines(readRelayConfig(paths.config), readRelayStates(paths.state), now()) }
    }
    const { line, ...desk } = deskInUse({ script, env })
    io.stdout.write(`${JSON.stringify({ ...result, desk, status: [line, ...result.status], launcher: refreshLauncher(env) }, null, 1)}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`${error.message}\n`)
    return 1
  }
}
