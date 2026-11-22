#!/usr/bin/env node
// Print the desk root Desk's MCP server would bind for this environment, as
// JSON. Startup hooks call this so they can never disagree with the server.
// `--root-only` prints just the root (empty when none); `--startup-line` prints
// the `Desk startup:` line the Claude hook appends; `--boot-checks` appends the
// one `Desk boot pre-checks:` line when a boot check has something to say and the one
// `Desk migrations:` line when one of Desk's own migrations is pending.
// Always exits 0: a hook must not block session
// start.
import process from "node:process"
import * as os from "node:os"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  claudeBindingPath,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../src/util/paths.js"
import { claudeStartupDirection } from "../src/util/startup-direction.js"
import { defineCli, defineCommand } from "../src/lib/ouro-ui/registry/ouro/ax/ax-command.ts"
import { runCli } from "../src/lib/ouro-ui/registry/ouro/ax/cli.ts"
import { readSmallText } from "../src/factory/marker.js"

export function resolveHookDeskRoot({ env = process.env, cwd = process.cwd(), hostProjectRoot = env.CLAUDE_PROJECT_DIR } = {}) {
  const bindingPath = claudeBindingPath(env)
  try {
    const resolved = resolveDeskRootWithSource({
      activationConfigPath: resolveActivationConfigPath({ env }),
      env, cwd, homeDir: env.HOME || os.homedir(),
      hostProjectRoot,
      readActivationConfig: (file) => readSmallText(file),
    })
    return { root: resolved.root, source: resolved.source, binding_path: bindingPath }
  } catch (error) {
    return { root: null, source: null, binding_path: bindingPath, tried: error.tried ?? [], error: error.message }
  }
}

// Named, so that what the registry exports and nothing here uses is reported as unused code.
async function loadBootChecks() {
  const { migrationLine, runBootChecks } = await import("../../hooks/lib/boot-checks.cjs")
  return { migrationLine, runBootChecks }
}

const FLAGS = {
  "root-only": { type: "boolean", description: "Print just the root, with no newline (empty when no desk is bound)." },
  "startup-line": { type: "boolean", description: "Print the `Desk startup:` line the Claude hook appends." },
  "boot-checks": { type: "boolean", description: "Append the `Desk boot pre-checks:` line when a boot check has something to say, and the `Desk migrations:` line when one is pending." },
}

export async function main({ argv = process.argv.slice(2), env = process.env, write = (text) => process.stdout.write(text), loadBoot = loadBootChecks, writeError = (text) => process.stderr.write(text) } = {}) {
  let output
  const cli = defineCli({
    name: "resolve-desk-root",
    about: ["Prints the desk root Desk's MCP server would bind for this environment, as JSON. Startup hooks call this so they can never disagree with the server."],
    command: defineCommand({
      name: "resolve-desk-root",
      summary: "Print the bound desk root as JSON, or the one line a flag asks for.",
      effect: "private",
      readOnly: true,
      protocol: true,
      output: "the root's JSON, or the one line a flag asks for",
      flags: FLAGS,
      text: () => output,
      run: async (input) => {
        const result = resolveHookDeskRoot({ env })
        output = `${JSON.stringify(result)}\n`
        if (input["root-only"]) output = result.root ?? ""
        if (input["startup-line"]) output = claudeStartupDirection({ env })
        if (input["boot-checks"]) {
          const { migrationLine, runBootChecks } = await loadBoot()
          // Desk's own migration Detect blocks run alongside the boot checks, and
          // add one line only when a migration is pending.
          const migrations = migrationLine({ host: "claude", env })
          // One agent line only when a boot check has something to say; otherwise the output is unchanged.
          const line = await runBootChecks({ host: "claude", env })
          if (line) output += `\n\n${line}`
          const pending = await migrations
          if (pending) output += `\n\n${pending}`
        }
        return {}
      },
    }),
  })
  // The kit ends its output with a newline; the output is read as it is, so only the newline the output itself has stays.
  const stdout = { write: (text) => write(text.endsWith("\n") && !output.endsWith("\n") ? text.slice(0, -1) : text) }
  return runCli(cli, argv, { stdin: process.stdin, stdout, stderr: { write: writeError } }, { env })
}

// Whether this module is the script Node was asked to run. Node gives
// `import.meta.url` as the real path, while `argv[1]` keeps the spelling the
// hook used, which can run through a symlink (the macOS `$TMPDIR`, a
// symlinked `~/.claude` or `CLAUDE_CONFIG_DIR`), so both are compared as real
// paths.
export function isEntrypoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  process.exitCode = await main()
}
