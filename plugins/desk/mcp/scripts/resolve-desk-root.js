#!/usr/bin/env node
// Print the desk root Desk's MCP server would bind for this environment, as
// JSON. Startup hooks call this so they can never disagree with the server.
// `--root-only` prints just the root (empty when none); `--startup-line` prints
// the `Desk startup:` line the Claude hook appends; `--boot-checks` appends the
// one `Desk boot pre-checks:` line when a boot check has something to say and the one
// `Desk migrations:` line when one of Desk's own migrations is pending, then
// starts factory delivery detached. Always exits 0: a hook must not block session
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

export async function main({ argv = process.argv.slice(2), env = process.env, write = (text) => process.stdout.write(text), loadBoot = () => import("../../hooks/boot-checks.cjs") } = {}) {
  const result = resolveHookDeskRoot({ env })
  let output = `${JSON.stringify(result)}\n`
  if (argv.includes("--root-only")) output = result.root ?? ""
  if (argv.includes("--startup-line")) output = claudeStartupDirection({ env })
  if (argv.includes("--boot-checks")) {
    const { default: boot } = await loadBoot()
    // Desk's own migration Detect blocks run alongside the boot checks, and
    // add one line only when a migration is pending.
    const migrations = boot.migrationLine({ host: "claude", env })
    // One agent line only when a boot check has something to say; otherwise the output is unchanged.
    const line = await boot.runBootChecks({ host: "claude", env })
    if (line) output += `\n\n${line}`
    const pending = await migrations
    if (pending) output += `\n\n${pending}`
    // Factory delivery starts detached only once the output is built.
    await boot.startFactory({ env })
  }
  write(output)
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
  await main()
}
