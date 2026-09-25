#!/usr/bin/env node
// Print the desk root Desk's MCP server would bind for this environment, as
// JSON. Startup hooks call this so they can never disagree with the server.
// `--root-only` prints just the root (empty when none); `--startup-line` prints
// the `Desk startup:` line the Claude hook appends. Always exits 0: a hook must
// not block session start.
import process from "node:process"
import {
  claudeBindingPath,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../src/util/paths.js"
import { deskStartupDirection } from "../src/util/startup-direction.js"

const env = process.env
const bindingPath = claudeBindingPath(env)
let result
try {
  const resolved = resolveDeskRootWithSource({
    activationConfigPath: resolveActivationConfigPath({ env }),
    env,
    hostProjectRoot: env.CLAUDE_PROJECT_DIR,
  })
  result = { root: resolved.root, source: resolved.source, binding_path: bindingPath }
} catch (error) {
  result = {
    root: null,
    source: null,
    binding_path: bindingPath,
    tried: error.tried ?? [],
    error: error.message,
  }
}
let output = `${JSON.stringify(result)}\n`
if (process.argv.includes("--root-only")) output = result.root ?? ""
if (process.argv.includes("--startup-line")) output = deskStartupDirection(result)
process.stdout.write(output)
