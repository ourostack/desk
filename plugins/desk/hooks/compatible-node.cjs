"use strict";

// The Node a hook's background child runs in. Desk never depends on which
// `node` the host puts first on PATH (Milestone 3a ruling 5): a hook itself
// runs in that Node, so it keeps to what Node 16 has, but a child that loads
// Desk's MCP code runs in a Node that satisfies the MCP's engines range. This
// reuses the MCP bootstrap's own discovery and selection, so a hook child and
// the MCP server agree on which Node is compatible.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bootstrap = require("../mcp/bootstrap.cjs");

const MCP_ROOT = path.join(__dirname, "..", "mcp");

// A probe runs the Node and blocks the hook while it does, so the hook spends
// at most this long on probes, and never probes a Node whose install folder
// (nvm, fnm, Volta, asdf, mise, a Homebrew Cellar) already names its version.
// Such a Node is trusted without running it: if it then fails to start, its
// own child fails, never the hook. A Node that is probed is probed once per
// selection: the answer from discovery also serves the final check.
const PROBE_BUDGET_MS = 250;

function hookProbe(env) {
  const answers = new Map();
  return (file, timeoutMs) => {
    if (answers.has(file)) return answers.get(file);
    let real = file;
    try { real = fs.realpathSync(file); } catch { /* probed below */ }
    const version = bootstrap.versionFromPath(real);
    const answer = version ? { version, abi: null } : bootstrap.probeNode(file, env, timeoutMs);
    answers.set(file, answer);
    return answer;
  };
}

/**
 * compatibleNode({ env?, current?, mcpRoot?, select? }) -> { node, range }
 *
 * `node` is the path of a Node that satisfies `range` (the MCP's engines
 * range), or null when none is installed. The running Node is used when it
 * satisfies the range, with no search. `current` and `select` are test seams.
 */
function compatibleNode({
  env = process.env,
  current = { path: process.execPath, version: process.version, abi: process.versions.modules },
  mcpRoot = MCP_ROOT,
  select = bootstrap.selectNode,
} = {}) {
  const { range } = bootstrap.readPackage(mcpRoot);
  if (bootstrap.satisfies(current.version, range)) return { node: current.path, range };
  const selection = select({
    env,
    platform: process.platform,
    arch: process.arch,
    homeDir: env.HOME || env.USERPROFILE || os.homedir(),
    mcpRoot,
    current,
    systemPrefix: env.DESK_NODE_SYSTEM_PREFIX || "",
    probeBudgetMs: PROBE_BUDGET_MS,
    probe: hookProbe(env),
  });
  return { node: selection.node ? selection.node.path : null, range };
}

module.exports = { compatibleNode, hookProbe, PROBE_BUDGET_MS };
