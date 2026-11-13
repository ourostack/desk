// The `drains` command line: `poll`, `ack` and `status`. Output is one JSON value on stdout; a usage error is one line on stderr
// (exit 2) and a failure is a Desk failure line on stderr (exit 1).
import * as path from "node:path"
import { ackWake, connectGithub, drainPaths, drainStatusLines, pollDrains, readDrainConfig, readDrainStates, withDrainLock } from "./drains.js"

const USAGE = [
  "Usage: drains.js poll [--config <file>] [--state <file>]",
  "       drains.js ack --repo <owner/name> --wake <id> [--error <text>] [--state <file>]",
  "       drains.js status [--config <file>] [--state <file>]",
  "poll lists each configured repository's open issues, records what changed and prints the wakes to deliver.",
  "A runner delivers each wake's message to its session, then runs the wake's `done` command, adding --error <text> when delivery failed.",
].join("\n")

const VALUED = { poll: ["--config", "--state"], ack: ["--repo", "--wake", "--error", "--state"], status: ["--config", "--state"] }

export function parseDrainsArgs(argv) {
  const [command, ...rest] = argv
  if (command === undefined || command === "--help" || command === "-h") return { help: true }
  if (!(command in VALUED)) return { error: `unknown command ${JSON.stringify(command)}` }
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]
    const value = rest[i + 1]
    if (!VALUED[command].includes(name)) return { error: `${command} does not take ${JSON.stringify(name)}` }
    if (value === undefined || value.startsWith("--")) return { error: `${name} needs a value` }
    flags[name.slice(2)] = value
    i++
  }
  if (command === "ack" && (!flags.repo || !flags.wake)) return { error: "ack needs --repo and --wake" }
  return { command, flags }
}

export async function runDrainsCli({ argv, script, env = process.env, io = process, now = Date.now, connect = connectGithub }) {
  const parsed = parseDrainsArgs(argv)
  if (parsed.help) {
    io.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (parsed.error) {
    io.stderr.write(`drains: ${parsed.error}\n${USAGE}\n`)
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
    } else {
      result = { status: drainStatusLines(readDrainConfig(paths.config), readDrainStates(paths.state), now()) }
    }
    io.stdout.write(`${JSON.stringify(result, null, 1)}\n`)
    return 0
  } catch (error) {
    io.stderr.write(`${error.message}\n`)
    return 1
  }
}
