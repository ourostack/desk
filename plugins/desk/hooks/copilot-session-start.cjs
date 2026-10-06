#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const pluginRoot = process.env.PLUGIN_ROOT || path.resolve(__dirname, "..");
const foundationPath = path.join(pluginRoot, "skills", "using-desk", "SKILL.md");
const bootScript = path.join(pluginRoot, "mcp", "scripts", "session-boot.js");
// The foundation points at the RFC through this line: the installed copy, which
// the agent can open from any repository. Computed, never read at startup.
const rfcPath = path.join(pluginRoot, "docs", "agentic-engineering-v2-rfc.md");

// Copilot passes the session's working folder as `cwd` and the session id as `sessionId` in the hook input. Read
// them briefly and fall back to the process folder, so startup never waits on a host that leaves stdin open.
function readSessionInput() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({ folder: process.cwd() });
      return;
    }
    let input = "";
    const finish = () => {
      clearTimeout(timer);
      process.stdin.destroy();
      try {
        const { cwd, sessionId, source } = JSON.parse(input);
        resolve({ folder: typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd(), sessionId, source });
      } catch {
        resolve({ folder: process.cwd() });
      }
    };
    const timer = setTimeout(finish, 500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

// Copilot gives the Desk MCP server no session folder, so this hook records the one it was given, and the saved binding
// it sees, in a file keyed by the session id; the server reads it whenever it resolves its root (see
// mcp/src/runtime/copilot-session.js). It runs before the line below is composed, so the line and the server resolve alike.
// Writing the record never throws (a session must start without it); only a Desk install that cannot load the module reaches the fallback line.
async function recordSession({ folder, sessionId, source }) {
  const { recordCopilotSession } = await import(pathToFileURL(path.join(pluginRoot, "mcp", "src", "runtime", "copilot-session.js")).href);
  const { resolveActivationConfigPath } = await import(pathToFileURL(path.join(pluginRoot, "mcp", "src", "util", "paths.js")).href);
  recordCopilotSession({ sessionId, folder: path.resolve(folder), source, activationConfig: resolveActivationConfigPath({ env: process.env }), env: process.env });
}

// Let Desk's shared startup module resolve the root the way the Desk server will, with the session folder as the
// project folder, so the line never names a root the server will not use.
async function startupDirection() {
  try {
    const modulePath = path.join(pluginRoot, "mcp", "src", "util", "startup-direction.js");
    const { copilotStartupDirection } = await import(pathToFileURL(modulePath).href);
    const session = await readSessionInput();
    const sessionFolder = session.folder;
    await recordSession(session);
    const direction = copilotStartupDirection({ env: process.env, sessionFolder });
    // The boot checks add one agent line only when one of them has something to say.
    const { runBootChecks, migrationLine } = require("./boot-checks.cjs");
    // Desk's own migration Detect blocks run alongside the boot checks, and
    // add one line only when a migration is pending.
    const pending = migrationLine({ host: "copilot", env: process.env, sessionFolder });
    const boot = await runBootChecks({ host: "copilot", env: process.env, sessionFolder });
    const migrations = await pending;
    return [direction, boot, migrations].filter(Boolean).join("\n\n");
  } catch {
    return `Desk startup: Desk could not resolve its root in this hook. The boot has not run: run node ${bootScript} now, before other work, for the authoritative workspace scan; desk_status reports the root Desk actually bound. A child agent with a bounded brief follows the brief instead and skips this.`;
  }
}

async function startFactory() {
  try {
    await require("./boot-checks.cjs").startFactory({ env: process.env });
  } catch {
    // Delivery retries at the next session start.
  }
}

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({ additionalContext }));
}

(async () => {
  // A headless evaluator session gets no startup output and starts nothing (mcp/src/factory/headless-flag.cjs); a missing rule file falls back to the same exact comparison.
  try { if (require("../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(process.env)) return; } catch { const v = String(process.env.DESK_FACTORY_HEADLESS ?? ""); if (v !== "" && v !== "0") return; }
  try {
    const foundation = fs.readFileSync(foundationPath, "utf8").trimEnd();
    const direction = await startupDirection();
    // The startup line leads, as in the Claude hook: a host that keeps only a preview of a long context still shows the boot imperative.
    const output = `${direction}\n\n${foundation}\n\nDesk RFC: ${rfcPath}`;
    // Factory delivery starts detached only once the output is built; it never delays or changes it.
    await startFactory();
    emit(output);
  } catch {
    emit(`desk worker boot — the Desk foundation could not be read from ${foundationPath}. The boot has not run: run node ${bootScript} before other work, then desk:session-start explains its result. A child agent with a bounded brief follows the brief instead and skips this.`);
  }
})();
