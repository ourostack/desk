// The `drains` command line: `poll`, `ack` and `status`. Output is one JSON value on stdout; a usage error is one line on stderr
// (exit 2) and a failure is a Desk failure line on stderr (exit 1).
import * as path from "node:path"
import { deskFailure } from "./desk-failure.js"
import { ackWake, connectGithub, drainPaths, deskInUse, drainStatusLines, installLauncher, pollDrains, readDrainConfig, readDrainStates, whyOf, withDrainLock } from "./drains.js"

const USAGE = [
  "Usage: drains.js poll [--config <file>] [--state <file>]",
  "       drains.js ack --repo <owner/name> --wake <id> [--error <text>] [--state <file>]",
  "       drains.js status [--config <file>] [--state <file>]",
  "       drains.js why <owner/name>#<number> [--state <file>]",
  "poll lists each configured repository's open issues, records what changed and prints the wakes to deliver.",
  "why prints the recorded reason for each wake made for one issue, newest first.",
  "A runner delivers each wake's message to its session, then runs the wake's `done` command, adding --error <text> when delivery failed.",
].join("\n")

const usageFailure = (code, thing, fix) => deskFailure({ code, thing, probably: "the command line does not match the drains usage", look: "run drains.js --help", keepWorking: "nothing was polled or changed", fix })

const VALUED = { poll: ["--config", "--state"], ack: ["--repo", "--wake", "--error", "--state"], status: ["--config", "--state"], why: ["--state"] }

export function parseDrainsArgs(argv) {
  const [command, ...args] = argv
  if (command === undefined || command === "--help" || command === "-h") return { help: true }
  if (!(command in VALUED)) return { error: usageFailure("drains_unknown_command", `unknown command ${JSON.stringify(command)}`, "run drains.js poll, ack, status or why") }
  const target = command === "why" ? /^([^#\s/]+\/[^#\s/]+)#(\d+)$/u.exec(args[0] ?? "") : null
  if (command === "why" && !target) return { error: usageFailure("drains_why_target", "why needs an issue such as owner/name#123", "run drains.js why owner/name#123") }
  const rest = command === "why" ? args.slice(1) : args
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
  if (command === "why") return { command, flags, repo: target[1], number: Number(target[2]) }
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
  const defaults = drainPaths({ env })
  const paths = { ...defaults, ...(flags.config ? { config: path.resolve(flags.config) } : {}), ...(flags.state ? { state: path.resolve(flags.state), lock: `${path.resolve(flags.state)}.lock` } : {}) }
  try {
    let result
    if (command === "poll") {
      const ackFlags = flags.state ? ["--state", paths.state] : []
      result = await withDrainLock(paths.lock, () => pollDrains({ paths, connect, now: now(), ackCommand: [process.execPath, path.resolve(script)], ackFlags }))
    } else if (command === "ack") {
      result = await withDrainLock(paths.lock, () => ackWake({ paths, repo: flags.repo, wake: flags.wake, error: flags.error, now: now() }))
    } else if (command === "why") {
      io.stdout.write(`${JSON.stringify(whyOf(readDrainStates(paths.state), parsed.repo, parsed.number), null, 1)}\n`)
      return 0
    } else {
      result = { status: drainStatusLines(readDrainConfig(paths.config), readDrainStates(paths.state), now()) }
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
