#!/usr/bin/env node
// The Desk factory CLI. Its first subcommand is `consent`:
//
//   node scripts/factory.js consent --store <owner/repo> --contribute yes|no [--account <gh login>]
//
// Later tasks add more subcommands. Every subcommand prints one JSON object
// on success and exits 0; a usage or validation problem prints one line to
// stderr and exits 1. Nothing here ever prints the machine secret — this
// subcommand never touches it.
import { pathToFileURL } from "node:url"

import { listFinalizeRequests, listMarkers, readStatus, setConsent } from "../src/factory/outbox.js"

export const SUPPORTED_COMMANDS = Object.freeze(["consent", "derive", "status"])
const CONSENT_OPTIONS = new Set(["store", "contribute", "account"])
const CONTRIBUTE_VALUES = new Set(["yes", "no"])

/** `{ "store": "...", "contribute": "yes" }`-shaped options from `--flag value` pairs, or `null` for a malformed argv. */
export function parseOptions(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (typeof flag !== "string" || !flag.startsWith("--") || flag.length <= 2 || typeof value !== "string" || options.has(flag.slice(2))) return null
    options.set(flag.slice(2), value)
  }
  return options
}

export async function runDeriveCommand({ argv, env }) {
  const options = parseOptions(argv)
  if (options === null || !options.has("marker") || [...options.keys()].some((key) => !["marker", "wait-quiet"].includes(key))) {
    throw new Error("Usage: factory.js derive --marker <file> [--wait-quiet <milliseconds>]")
  }
  const raw = options.get("wait-quiet") ?? "0"
  if (!/^\d{1,6}$/u.test(raw) || Number(raw) > 30000) throw new Error("factory.js derive: wait-quiet must be 0..30000")
  const { deriveFile } = await import("../src/factory/derive-run.js")
  return deriveFile(env, options.get("marker"), { quietMs: Number(raw) })
}

export async function runStatusCommand({ argv, env }) {
  if (argv.length) throw new Error("Usage: factory.js status")
  return { ...await readStatus(env), markers: (await listMarkers(env)).length, finalize: (await listFinalizeRequests(env)).length }
}

/** Runs the `consent` subcommand: validates `argv`, calls `setConsent`, and returns the JSON-ready result. */
export async function runConsentCommand({ argv, env }) {
  const options = parseOptions(argv)
  const store = options?.get("store")
  const contribute = options?.get("contribute")
  if (options === null || store === undefined || !CONTRIBUTE_VALUES.has(contribute)) {
    throw new Error("Usage: factory.js consent --store <owner/repo> --contribute yes|no [--account <gh login>]")
  }
  for (const key of options.keys()) {
    if (!CONSENT_OPTIONS.has(key)) throw new Error(`factory.js consent: unknown option --${key}`)
  }
  const account = options.has("account") ? options.get("account") : null
  const consent = await setConsent(env, { store, contribute: contribute === "yes", account })
  return { store, ...consent.stores[store] }
}

/** Dispatches `argv[0]` to its subcommand and writes the JSON result with `write`. Returns the process exit code. */
export async function main({ argv = process.argv.slice(2), env = process.env, write = (text) => process.stdout.write(text), logError = (text) => process.stderr.write(text) } = {}) {
  const [subcommand, ...rest] = argv
  try {
    if (!SUPPORTED_COMMANDS.includes(subcommand)) {
      throw new Error(`factory.js: unknown subcommand ${JSON.stringify(subcommand ?? "")} (supported: ${SUPPORTED_COMMANDS.join(", ")})`)
    }
    const command = { consent: runConsentCommand, derive: runDeriveCommand, status: runStatusCommand }[subcommand]
    const result = await command({ argv: rest, env })
    write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    logError(`${error.message}\n`)
    return 1
  }
}

/** True when this module is the process entry point (`node scripts/factory.js ...`), false when merely imported. */
export function isMainModule(importMetaUrl, argv1) {
  if (typeof argv1 !== "string") return false
  return importMetaUrl === pathToFileURL(argv1).href
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const code = await main()
  process.exitCode = code
}
