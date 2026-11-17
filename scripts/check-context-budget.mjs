#!/usr/bin/env node
// Measures what every Copilot session receives from Desk at start and fails when the boot text or using-desk outgrows its
// budget in scripts/context-budget.json. Fate 5 of the Atlas: the always-on context stays tiny; whatever is not always needed
// lives in a skill that loads on demand.
//
//   node scripts/check-context-budget.mjs          print the table, exit 1 over budget
//   node scripts/check-context-budget.mjs --json   the same numbers as JSON
//
// The boot text is measured on a clean desk with every check stubbed to pass, so the number moves only when Desk's own static
// wording does. The desk path is a fixed one, the machine's status line a fixed one, and the pending-check lines (which depend on
// what the machine has installed) are left out. Bytes are UTF-8 bytes, not characters.
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = path.join(repoRoot, "plugins", "desk")
const runtime = (name) => import(path.join(pluginRoot, "mcp", "src", "runtime", name))

const FIXED_ROOT = "/Users/someone/desk"
const FIXED_PLUGIN = "/Users/someone/.copilot/installed-plugins/desk"
const FIXED_STATUS = "Desk boot: ready | desk /Users/someone/desk (bound by env:DESK) | host macos / alex / copilot | Desk synced with origin"
const bytes = (text) => Buffer.byteLength(text, "utf8")

export async function cleanBootText() {
  const { bootOnce } = await runtime("boot.js")
  const { formatBootText } = await runtime("boot-text.js")
  const { bootContext } = await runtime("startup-boot.js")
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-budget-")))
  try {
    await fs.mkdir(path.join(root, "_meta"))
    await fs.mkdir(path.join(root, "_archive"))
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk Instructions\n")
    const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
    const gh = async (args) => {
      if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }
      if (args[0] === "auth") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
      return { code: 1, stdout: "", stderr: "unexpected call" }
    }
    const result = await bootOnce({
      env: { DESK: root, COPILOT_AGENT_SESSION_ID: "budget" },
      cwd: root,
      homeDir: root,
      gh,
      jq,
      syncFn: async () => ({ state: "synced" }),
      factoryStatusFn: () => null,
    })
    const text = bootContext({ boot: { text: formatBootText(result), seconds: null } }).text
    return text
      .split(root).join(FIXED_ROOT)
      .replace(/^Desk boot: .*\n(?:.*\n)*?\n(?=Active tasks)/mu, `${FIXED_STATUS}\n\n`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

export async function measure() {
  const boot = await cleanBootText()
  // Copilot's hook injects the skill without its frontmatter.
  const usingDesk = (await fs.readFile(path.join(pluginRoot, "skills", "using-desk", "SKILL.md"), "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/u, "").trimEnd()
  const { START } = await import(path.join(pluginRoot, "mcp", "src", "util", "startup-direction.js"))
  const { PLAIN_LANGUAGE_POINTER } = (await import("node:module")).createRequire(import.meta.url)(path.join(pluginRoot, "hooks", "lib", "child-agent.cjs"))
  const rfc = `Desk RFC: ${FIXED_PLUGIN}/docs/agentic-engineering-v3-rfc.md`
  const parts = {
    bootText: bytes(boot),
    usingDesk: bytes(usingDesk),
    startupDirection: bytes(`Desk startup: $DESK is ${FIXED_ROOT} (the project folder). ${START.split(pluginRoot).join(FIXED_PLUGIN)}`),
    pointers: bytes(PLAIN_LANGUAGE_POINTER) + bytes(rfc),
  }
  parts.total = Object.values(parts).reduce((sum, value) => sum + value, 0)
  return { parts, boot }
}

const budgets = JSON.parse(await fs.readFile(path.join(repoRoot, "scripts", "context-budget.json"), "utf8"))
const { parts, boot } = await measure()
if (process.argv.includes("--print-boot")) console.log(boot)
if (process.argv.includes("--json")) console.log(JSON.stringify(parts))
const rows = Object.entries(parts).map(([name, value]) => {
  const budget = budgets[name]
  const over = typeof budget === "number" && value > budget
  console.log(`${over ? "OVER " : "ok   "}${name.padEnd(17)}${String(value).padStart(6)} B${typeof budget === "number" ? `  (budget ${budget})` : ""}`)
  return over ? `${name} is ${value} B, over its ${budget} B budget` : null
}).filter(Boolean)
if (rows.length > 0) {
  console.error(`\nThe always-on context grew: ${rows.join("; ")}.\nCut it, or move what is not needed in every session into a skill that loads on demand. Raise scripts/context-budget.json only with an eval that shows the text earns its place.`)
  process.exit(1)
}
