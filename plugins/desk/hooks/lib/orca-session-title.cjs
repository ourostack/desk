"use strict";

// Claude Code's PostToolUse hook for task_focus and task_create: hands the finished call to
// mcp/src/runtime/orca-session-title.js, which names this session's Orca tab after the focused task (desk#1478).
// It prints nothing and always exits 0, so it can never change or block the tool call; every outcome is logged by the
// module in Desk's state folder.

const { pathToFileURL } = require("node:url");
const path = require("node:path");

const MAX_INPUT = 1024 * 1024;
const MODULE = pathToFileURL(path.join(__dirname, "..", "..", "mcp", "src", "runtime", "orca-session-title.js")).href;

/** The hook's JSON input from `stream`, or null when it is missing, too large, not an object or slow to arrive. */
function readInput(stream, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let bytes = 0;
    const chunks = [];
    const finish = (value) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      stream.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT) finish(null);
      else chunks.push(Buffer.from(chunk));
    });
    stream.once("error", () => finish(null));
    stream.once("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);
      } catch {
        finish(null);
      }
    });
  });
}

/** Reads the hook input and names the session; resolves to the module's outcome code, or "unavailable" when it could not run. */
async function runHook({ stdin = process.stdin, env = process.env, load = () => import(MODULE) } = {}) {
  try {
    const hookInput = await readInput(stdin);
    const { nameOrcaSession } = await load();
    return (await nameOrcaSession({ hookInput, env })).code;
  } catch {
    return "unavailable";
  }
}

function main() {
  runHook().finally(() => { process.exitCode = 0; });
}

module.exports = { readInput, runHook, main };
