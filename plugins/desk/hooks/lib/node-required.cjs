"use strict";

// The session-start hooks' first check. With no `node` at all, the host's own shell gives the message (hooks/node-missing.sh and the
// PowerShell branch in copilot-hooks.json). This covers the next case: the hook runs in a Node older than Desk needs and no newer Node
// is installed, so the tool servers can only answer that Node is missing. The session then gets the same message, with the install
// command the MCP bootstrap's own desk_status fix names.
//
// It must never say Node is missing when the tool server would find one, so it searches exactly as mcp/bootstrap.cjs does: the same
// selectNode call, with the bootstrap's own probe and time budget. A search that runs out of time says nothing, because the server,
// starting later, may still find a Node. The running Node is checked first, without loading the bootstrap, so a session whose Node
// fits pays nothing. The hooks reach this check on Node 16 and newer; an older Node fails before it (the hooks use Node 16
// syntax and `node:` module names), and desk_status, whose bootstrap runs on Node 8, still names the fix.

const os = require("node:os");
const path = require("node:path");
const { atLeast, engineFloor } = require("../compatible-node.cjs");

const MCP_ROOT = path.join(__dirname, "..", "..", "mcp");
const RESTART = "Then the person must open a new terminal and start a new session, because tool servers load only when a session starts.";
const bootstrap = () => require("../../mcp/bootstrap.cjs");

/**
 * nodeRequiredLine({ env?, platform?, current?, select?, now? }) -> string
 *
 * The message for a session whose Node is older than Desk's engines range when the bootstrap's own search finds no compatible Node,
 * or "" when Desk can run, when the search ran out of time, or when the check itself fails: it must never block a session.
 * `current`, `select` and `now` are test seams.
 */
function nodeRequiredLine({
  env = process.env,
  platform = process.platform,
  current = { path: process.execPath, version: process.version, abi: process.versions.modules },
  select = (options) => bootstrap().selectNode(options),
  now = Date.now,
} = {}) {
  try {
    const plain = engineFloor(MCP_ROOT);
    if (plain !== null && atLeast(current.version, plain.floor)) return "";
    const homeDir = env.HOME || env.USERPROFILE || os.homedir();
    const budget = bootstrap().PROBE_BUDGET_MS;
    const started = now();
    // The bootstrap's start(): the same options, and no probe or budget of the hook's own.
    const { node, range } = select({
      env, platform, arch: process.arch, homeDir, mcpRoot: MCP_ROOT, current, systemPrefix: env.DESK_NODE_SYSTEM_PREFIX || "", now,
    });
    if (node || now() - started >= budget) return "";
    const command = bootstrap().installCommand({ platform, env, homeDir, major: null });
    const floor = /^>=\s*v?(\d+)\.0\.0$/u.exec(String(range).trim());
    const needed = floor ? `Node.js ${floor[1]} or newer` : `Node.js ${range}`;
    return `Desk needs ${needed}, and the \`node\` on PATH is ${current.version} with no newer Node.js installed, so the Desk tool servers (desk, desk-web) cannot run and Desk tools do not work in this session. Install it: run \`${command}\` in a terminal. ${RESTART}`;
  } catch {
    return "";
  }
}

module.exports = { nodeRequiredLine };
