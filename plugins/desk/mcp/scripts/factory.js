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

import { setConsent } from "../src/factory/outbox.js"

const CONSENT_OPTIONS = new Set(["store", "contribute", "account"])
const CONTRIBUTE_VALUES = new Set(["yes", "no"])

/** `{ "store": "...", "contribute": "yes" }`-shaped options from `--flag value` pairs, or `null` for a malformed argv. */
export function parseOptions(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (typeof flag !== "string" || !flag.startsWith("--") || flag.length <= 2 || value === undefined) return null
    options.set(flag.slice(2), value)
  }
  return options
}

/** Runs the `consent` subcommand: validates `argv`, calls `setConsent`, and returns the JSON-ready result. */
export function runConsentCommand({ argv, env }) {
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
  const consent = setConsent(env, { store, contribute: contribute === "yes", account })
  return { store, ...consent.stores[store] }
}

/** Dispatches `argv[0]` to its subcommand and writes the JSON result with `write`. Returns the process exit code. */
export function main({ argv = process.argv.slice(2), env = process.env, write = (text) => process.stdout.write(text), logError = (text) => process.stderr.write(text) } = {}) {
  const [subcommand, ...rest] = argv
  try {
    if (subcommand !== "consent") {
      throw new Error(`factory.js: unknown subcommand ${JSON.stringify(subcommand ?? "")} (supported: consent)`)
    }
    const result = runConsentCommand({ argv: rest, env })
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
  process.exitCode = main()
}
