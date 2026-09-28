#!/usr/bin/env node
// A fake `claude` CLI for testing the ourostack/desk channel migration
// (`plugins/desk/migrations/01-move-to-ourostack-desk.md`) end to end, with no
// network access and no real Claude Code install. It understands only the
// `plugin`/`plugin marketplace` subcommands that migration's Migrate block
// calls, and keeps state as JSON files under `$CLAUDE_CONFIG_DIR` — the real
// shape for `plugins/known_marketplaces.json` (so the migration's own `jq`
// reads work unchanged), and a fixture-only `fake-plugin-state.json` standing
// in for the real CLI's install ledger, read back through `plugin list --json`.
//
// A real `marketplace add` clones the source and reads the marketplace name
// from its own `.claude-plugin/marketplace.json`; this fixture never clones
// anything, so it hardcodes the name for the two coordinates the migration
// ever adds — matching what a real `claude plugin marketplace add` reports
// for each (verified against the real CLI once, by hand, when this fixture
// was written).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

const MARKETPLACE_NAMES = {
  "ourostack/desk": "ourostack",
  "ourostack/ouroboros-skills": "ouroboros-skills",
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const cfg = process.env.CLAUDE_CONFIG_DIR
if (!cfg) fail("fake claude: CLAUDE_CONFIG_DIR is required")

const marketsPath = path.join(cfg, "plugins", "known_marketplaces.json")
const statePath = path.join(cfg, "fake-plugin-state.json")

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function parseArgs(args) {
  const flags = {}
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scope") {
      flags.scope = args[index + 1]
      index += 1
    } else if (args[index] === "--keep-data") {
      flags.keepData = true
    } else if (args[index] === "--json") {
      flags.json = true
    } else if (args[index] === "-y" || args[index] === "--yes") {
      flags.yes = true
    } else {
      positional.push(args[index])
    }
  }
  return { flags, positional }
}

const [, , command, sub, ...rest] = process.argv
if (command !== "plugin") fail(`fake claude: unsupported command ${JSON.stringify(command)}`)

if (sub === "marketplace") {
  const action = rest[0]
  if (action === "add") {
    const source = rest[1]
    const [repo, ref] = String(source).split("@")
    const name = MARKETPLACE_NAMES[repo]
    if (!name) fail(`fake claude: this fixture does not know the marketplace name for ${source}`)
    const markets = readJson(marketsPath, {})
    markets[name] = { source: { source: "github", repo, ...(ref ? { ref } : {}) } }
    writeJson(marketsPath, markets)
    process.stdout.write(`Successfully added marketplace: ${name}\n`)
    process.exit(0)
  }
  if (action === "update") {
    process.stdout.write(`Successfully updated marketplace: ${rest[1]}\n`)
    process.exit(0)
  }
  if (action === "remove") {
    const markets = readJson(marketsPath, {})
    delete markets[rest[1]]
    writeJson(marketsPath, markets)
    process.stdout.write(`Successfully removed marketplace: ${rest[1]}\n`)
    process.exit(0)
  }
  fail(`fake claude: unsupported marketplace action ${JSON.stringify(action)}`)
}

if (sub === "install") {
  const { flags, positional } = parseArgs(rest)
  const id = positional[0]
  const state = readJson(statePath, [])
  if (!state.some((entry) => entry.id === id)) state.push({ id, scope: flags.scope || "user", enabled: true, installPath: "", projectPath: "" })
  writeJson(statePath, state)
  process.stdout.write(`Successfully installed plugin: ${id} (scope: ${flags.scope || "user"})\n`)
  process.exit(0)
}

if (sub === "uninstall") {
  const { positional } = parseArgs(rest)
  const id = positional[0]
  const state = readJson(statePath, [])
  const next = state.filter((entry) => entry.id !== id)
  if (next.length === state.length) fail(`fake claude: plugin not installed: ${id}`)
  writeJson(statePath, next)
  process.stdout.write(`Successfully uninstalled plugin: ${id}\n`)
  process.exit(0)
}

if (sub === "list") {
  process.stdout.write(`${JSON.stringify(readJson(statePath, []))}\n`)
  process.exit(0)
}

fail(`fake claude: unsupported plugin subcommand ${JSON.stringify(sub)}`)
