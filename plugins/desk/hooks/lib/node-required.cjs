"use strict";

// The session-start hooks' first check. With no `node` at all, the host's own shell gives the message (hooks/node-missing.sh and the
// PowerShell branch in copilot-hooks.json). This covers the next case: the hook runs in a Node older than Desk needs and no newer Node
// is installed, so the tool servers can only answer that Node is missing. The session then gets the same message, with the install
// command the MCP bootstrap's own desk_status fix names. The running Node is checked first and needs no search. Node 16 syntax.

const os = require("node:os");
const { compatibleNode } = require("../compatible-node.cjs");

const RESTART = "Then the person must open a new terminal and start a new session, because tool servers load only when a session starts.";

/**
 * nodeRequiredLine({ env?, platform?, current?, find? }) -> string
 *
 * The message for a session whose Node is older than Desk's engines range when no compatible Node is installed, or "" when Desk
 * can run (or the check itself fails: it must never block a session). `current` and `find` are test seams.
 */
function nodeRequiredLine({
  env = process.env,
  platform = process.platform,
  current = { path: process.execPath, version: process.version, abi: process.versions.modules },
  find = compatibleNode,
} = {}) {
  try {
    const { node, range } = find({ env, current });
    if (node) return "";
    const { installCommand } = require("../../mcp/bootstrap.cjs");
    const command = installCommand({ platform, env, homeDir: env.HOME || env.USERPROFILE || os.homedir(), major: null });
    const floor = /^>=\s*v?(\d+)\.0\.0$/u.exec(String(range).trim());
    const needed = floor ? `Node.js ${floor[1]} or newer` : `Node.js ${range}`;
    return `Desk needs ${needed}, and the \`node\` on PATH is ${current.version} with no newer Node.js installed, so the Desk tool servers (desk, desk-web) cannot run and Desk tools do not work in this session. Install it: run \`${command}\` in a terminal. ${RESTART}`;
  } catch {
    return "";
  }
}

module.exports = { nodeRequiredLine };
