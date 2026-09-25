#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const pluginRoot = process.env.PLUGIN_ROOT || path.resolve(__dirname, "..");
const foundationPath = path.join(pluginRoot, "skills", "using-desk", "SKILL.md");
// The foundation points at the RFC through this line: the installed copy, which
// the agent can open from any repository. Computed, never read at startup.
const rfcPath = path.join(pluginRoot, "docs", "agentic-engineering-v2-rfc.md");

// Copilot passes the session's working folder as `cwd` in the hook input. Read
// it briefly and fall back to the process folder, so startup never waits on a
// host that leaves stdin open.
function readSessionFolder() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(process.cwd());
      return;
    }
    let input = "";
    const finish = () => {
      clearTimeout(timer);
      process.stdin.destroy();
      try {
        const folder = JSON.parse(input).cwd;
        resolve(typeof folder === "string" && folder.length > 0 ? folder : process.cwd());
      } catch {
        resolve(process.cwd());
      }
    };
    const timer = setTimeout(finish, 500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

// Ask the MCP server's own resolver which desk this session binds, with the
// session folder standing in for the project folder, and let the shared module
// compose the startup line, so the hook and the server use one rule.
async function startupDirection() {
  try {
    const mcpSource = path.join(pluginRoot, "mcp", "src", "util");
    const paths = await import(pathToFileURL(path.join(mcpSource, "paths.js")).href);
    const { deskStartupDirection } = await import(pathToFileURL(path.join(mcpSource, "startup-direction.js")).href);
    let resolution = null;
    try {
      resolution = paths.resolveDeskRootWithSource({
        activationConfigPath: paths.resolveActivationConfigPath({ env: process.env }),
        env: process.env,
        hostProjectRoot: await readSessionFolder(),
      });
    } catch {
      resolution = null;
    }
    return deskStartupDirection(resolution);
  } catch {
    return "Desk startup: Desk could not resolve its root in this hook. Invoke desk:session-start now for the authoritative workspace scan before other work; desk_status reports the root Desk actually bound.";
  }
}

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({ additionalContext }));
}

(async () => {
  try {
    const foundation = fs.readFileSync(foundationPath, "utf8").trimEnd();
    const direction = await startupDirection();
    emit(`${foundation}\n\nDesk RFC: ${rfcPath}\n\n${direction}`);
  } catch {
    emit(`desk worker boot — the Desk foundation could not be read from ${foundationPath}. Invoke desk:session-start before other work; it remains the authoritative workspace scan.`);
  }
})();
