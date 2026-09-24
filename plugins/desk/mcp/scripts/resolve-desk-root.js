#!/usr/bin/env node
// Print the desk root Desk's MCP server would bind for this environment, as
// JSON. Startup hooks call this so they can never disagree with the server.
// `--root-only` prints just the root (empty when none). Always exits 0: a hook
// must not block session start.
import process from "node:process"
import {
  claudeBindingPath,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../src/util/paths.js"

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
process.stdout.write(
  process.argv.includes("--root-only") ? (result.root ?? "") : `${JSON.stringify(result)}\n`,
)
