#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

// How long the hook may keep running after its output is written, for cancelled children to close.
const EXIT_GRACE_MS = 500;

const pluginRoot = process.env.PLUGIN_ROOT || path.resolve(__dirname, "..");
const foundationPath = path.join(pluginRoot, "skills", "using-desk", "SKILL.md");
// Copilot has no setting that makes a plugin's agent the default (Claude Code takes `agent` from settings.json), and the hook
// input does not say which agent runs, so every session is told to act as the worker unless it was started as another agent.
const workerPointer = `Unless started with \`--agent\`, act as Desk's worker: read ${path.join(pluginRoot, "agents", "worker.agent.md")} first.`;
const bootScript = path.join(pluginRoot, "mcp", "scripts", "session-boot.js");
// The foundation points at the RFC through this line: the installed copy, which
// the agent can open from any repository. Computed, never read at startup.
const rfcPath = path.join(pluginRoot, "docs", "agentic-engineering-v2-rfc.md");
// Copilot drops a sessionStart hook's whole output when the hook passes its 5 s limit, foundation included. So the
// optional lines (boot pre-checks, migrations, the Copilot setting notes) get until this many milliseconds after the
// process started; past it the hook prints the startup line and the foundation without them and does not start factory
// delivery. The boot script runs the migration checks again; the pre-checks and the delivery wait for the next session start.
const OPTIONAL_LINES_DEADLINE_MS = 3500;
const { performance } = require("node:perf_hooks");
let optionalLinesTimedOut = false;

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

// Copilot asks its agent for an AI co-author trailer on commits, and offers it the ask_user question form, unless the operator's
// Copilot settings turn them off. Desk forbids AI attribution and asks in plain chat (Claude's worker disallows AskUserQuestion), so
// each setting is turned off once, only when unset (mcp/src/runtime/copilot-commit-trailer.js). One line for each it changed.
async function hostSettingLines() {
  try {
    const { disableCoAuthorTrailer, disableAskUser } = await import(pathToFileURL(path.join(pluginRoot, "mcp", "src", "runtime", "copilot-commit-trailer.js")).href);
    const trailer = disableCoAuthorTrailer({ env: process.env });
    const askUser = disableAskUser({ env: process.env });
    // A first session usually sets both; one line keeps the startup context inside its budget.
    if (trailer.state === "set" && askUser.state === "set") {
      const file = path.join(process.env.COPILOT_HOME || path.join(process.env.HOME || process.env.USERPROFILE || require("node:os").homedir(), ".copilot"), "settings.json");
      return `Desk startup: set \`includeCoAuthoredBy: false\` and \`askUser: false\` in ${file}, so from the next session Copilot adds no AI co-author trailer and the ask_user form is off; in this session add no trailer and ask in plain chat. Desk keeps a value the operator sets.`;
    }
    return [trailer.line, askUser.line].filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

async function nativeMemoryLine() {
  try {
    const { disableNativeMemory } = await import(pathToFileURL(path.join(pluginRoot, "mcp", "src", "runtime", "copilot-commit-trailer.js")).href);
    const result = disableNativeMemory({ env: process.env });
    if (result.state === "already") return "";
    if (result.state === "set") return "Desk memory: native memory is set off.";
    if (result.line) process.stderr.write(result.line + "\n");
    return "Desk memory: repair native memory now.";
  } catch {
    process.stderr.write("Desk memory: native settings helper failed; use the supported memory:false setting before continuing.\n");
    return "Desk memory: repair native memory now.";
  }
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
    const { runBootChecks, migrationLine } = require("./lib/boot-checks.cjs");
    // Desk's own migration Detect blocks run alongside the boot checks, and
    // add one line only when a migration is pending.
    const optional = Promise.all([
      runBootChecks({ host: "copilot", env: process.env, sessionFolder }),
      migrationLine({ host: "copilot", env: process.env, sessionFolder }),
      hostSettingLines(),
    ]);
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, OPTIONAL_LINES_DEADLINE_MS - performance.now()), null); });
    const lines = await Promise.race([optional, late]);
    clearTimeout(timer);
    if (lines === null) optionalLinesTimedOut = true;
    return [direction, ...(lines ?? [])].filter(Boolean).join("\n\n");
  } catch {
    return `Desk startup: Desk could not resolve its root in this hook. The boot has not run: run node ${bootScript} now, before other work, for the authoritative workspace scan; desk_status reports the root Desk actually bound. A child agent with a bounded brief follows the brief instead and skips this.`;
  }
}

async function startFactory() {
  try {
    const { startFactory: start } = require("./lib/boot-checks.cjs");
    await start({ env: process.env });
  } catch {
    // Delivery retries at the next session start.
  }
}

function emit(additionalContext) {
  // The host waits for this process to end, not for its output: once the output is written, nothing left running (a
  // check past its budget, a migration block being stopped) may hold it for long. Cancelled children get a moment to close
  // first; the timer does not itself keep the process alive. Every repair and delivery it started is detached.
  process.stdout.write(JSON.stringify({ additionalContext }), () => setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref());
}

(async () => {
  const memory = await nativeMemoryLine();
  // A headless evaluator session gets no startup output and starts nothing (mcp/src/factory/headless-flag.cjs); a missing rule file falls back to the same exact comparison.
  try { if (require("../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(process.env)) return; } catch { const v = String(process.env.DESK_FACTORY_HEADLESS ?? ""); if (v !== "" && v !== "0") return; }
  try {
    // The frontmatter only names and describes the skill for the host's skill list; dropping it here pays for the worker pointer
    // inside the startup context budget.
    const foundation = fs.readFileSync(foundationPath, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/u, "").trimEnd();
    const direction = await startupDirection();
    // The startup line leads, as in the Claude hook: a host that keeps only a preview of a long context still shows the boot imperative.
    const output = `${direction}${memory ? `\n\n${memory}` : ""}\n\n${workerPointer}\n\n${foundation}\n\nDesk RFC: ${rfcPath}`;
    // Factory delivery starts detached only once the output is built; it never delays or changes it.
    if (!optionalLinesTimedOut) await startFactory();
    emit(output);
  } catch {
    emit(`desk worker boot — the Desk foundation could not be read from ${foundationPath}. The boot has not run: run node ${bootScript} before other work, then desk:session-start explains its result. A child agent with a bounded brief follows the brief instead and skips this.`);
  }
})();
