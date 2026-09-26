#!/usr/bin/env node
// Print the desk root Desk's MCP server would bind for this environment, as
// JSON. Startup hooks call this so they can never disagree with the server.
// `--root-only` prints just the root (empty when none); `--startup-line` prints
// the `Desk startup:` line the Claude hook appends. Always exits 0: a hook must
// not block session start.
import process from "node:process"
import * as os from "node:os"
import { pathToFileURL } from "node:url"
import {
  claudeBindingPath,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../src/util/paths.js"
import { claudeStartupDirection } from "../src/util/startup-direction.js"

export function resolveHookDeskRoot({ env = process.env, cwd = process.cwd() } = {}) {
  const bindingPath = claudeBindingPath(env)
  try {
    const resolved = resolveDeskRootWithSource({
      activationConfigPath: resolveActivationConfigPath({ env }),
      env, cwd, homeDir: env.HOME || os.homedir(),
      hostProjectRoot: env.CLAUDE_PROJECT_DIR,
    })
    return { root: resolved.root, source: resolved.source, binding_path: bindingPath }
  } catch (error) {
    return { root: null, source: null, binding_path: bindingPath, tried: error.tried ?? [], error: error.message }
  }
}

export async function main({ argv = process.argv.slice(2), env = process.env, write = (text) => process.stdout.write(text) } = {}) {
  const result = resolveHookDeskRoot({ env })
  let output = `${JSON.stringify(result)}\n`
  if (argv.includes("--root-only")) output = result.root ?? ""
  if (argv.includes("--startup-line")) output = claudeStartupDirection({ env })
  if (argv.includes("--boot-checks")) {
    const { default: boot } = await import("../../hooks/boot-checks.cjs")
    output += `\n\n${await boot.runBootChecks({ host: "claude", env })}`
  }
  write(output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
