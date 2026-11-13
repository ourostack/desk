#!/usr/bin/env node
"use strict";

// desk worker: the SessionStart hook Claude Code runs (hooks.json). It is Node, never a shell script: on Windows
// a bare `bash` resolves through PATH, and a standard user can have the WSL relay bash.exe first with no distro installed,
// where it exits 1. Foundation plus bounded local boot checks; repairs run detached. MUST always exit 0, because a nonzero
// SessionStart hook blocks the session from starting. It keeps to Node 16 syntax, and loads Desk's modules with dynamic
// import() inside try/catch, so an older Node still prints the fallback line and exits 0.

const fs = require("node:fs");
const path = require("node:path");

// How long the hook may keep running after its output is written, for cancelled children to close.
const EXIT_GRACE_MS = 500;
const { pathToFileURL } = require("node:url");

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const foundationPath = process.argv[2] || `${pluginRoot}/skills/using-desk/SKILL.md`;
const BOOT_STAND_DOWN = "The boot's instructions are for the operator's session: a child agent with a bounded brief, or a session the operator told not to boot, follows its brief and ignores them.";

// A shell command substitution strips trailing newlines; the output this hook replaces was built from such substitutions.
function stripTrailingNewlines(text) {
  return text.replace(/\n+$/u, "");
}

// Ask the MCP server's own resolver which desk this session binds and let it compose the startup line, so the hook and the
// server can never disagree. It honours the Claude project folder when it is a desk, the saved binding, $DESK and the home
// fallbacks, names where the root came from, and with the boot checks adds one "Desk boot pre-checks:" line only when a
// check has something to say, then starts factory delivery detached with ignored stdio, after the output is built.
// An empty answer means the resolver could not load or run.
async function startupDirection() {
  try {
    const { main } = await import(pathToFileURL(path.join(pluginRoot, "mcp", "scripts", "resolve-desk-root.js")).href);
    let text = "";
    await main({ argv: ["--startup-line", "--boot-checks"], env: process.env, write: (chunk) => { text += chunk; } });
    return stripTrailingNewlines(text);
  } catch {
    return "";
  }
}

function emit(additionalContext) {
  // A host that closes its end of the pipe early would raise an uncaught EPIPE and fail the hook; the hook has nothing left to do then.
  process.stdout.on("error", () => {});
  // The host waits for this process to end, not for its output: once the output is written, nothing left running (a
  // check past its budget, a migration block being stopped) may hold it for long. Cancelled children get a moment to close
  // first; the timer does not itself keep the process alive. Every repair and delivery it started is detached.
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`, () => setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref());
}

// Claude Code saves a hook's additionalContext to a file and shows the agent only a 2 KB preview once it passes 10,000 characters, and the foundation alone is most of that budget; so the hook carries only the head of the boot (its status, what needs the operator, the notes) and the rest comes with the first Desk tool reply.
const BOOT_HEAD_CHARS = 1500;
// The hook's limit is 10 s (hooks.json). The wait ends this long after the hook's process started, so a slow Node start shortens the wait instead of overrunning the limit.
const BOOT_WAIT_UNTIL_MS = 7000;

// Starts the session's boot (a new session in this folder, so afresh) and waits for it within the hook's budget. The boot runs
// detached and its result is also delivered, once, by the first Desk tool reply (mcp/src/runtime/startup-boot.js). Never throws.
async function bootSection() {
  try {
    const boot = await import(pathToFileURL(path.join(pluginRoot, "mcp", "src", "runtime", "startup-boot.js")).href);
    const { claudeBootRoot } = await import(pathToFileURL(path.join(pluginRoot, "mcp", "src", "util", "startup-direction.js")).href);
    const folder = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    if (!boot.autoBootEnabled(process.env) || claudeBootRoot({ env: process.env }) === null) return "";
    // On Windows a hook that starts the boot holds the host's pipe open until it ends; the Desk server starts it with the first tool reply.
    if (process.platform === "win32") return boot.WINDOWS_BOOT_LINE;
    const key = boot.bootKey({ folder: process.env.CLAUDE_PROJECT_DIR });
    if (key === null) return "";
    const { paths } = boot.startBoot({ key, folder, env: process.env, fresh: true });
    if (paths === null) return "";
    const result = await boot.awaitBoot({ paths, waitMs: Math.max(0, BOOT_WAIT_UNTIL_MS - performance.now()) });
    if (result.boot !== null) {
      const context = boot.bootContext({ boot: result.boot, maxChars: BOOT_HEAD_CHARS });
      return context.whole && !boot.claimDelivery(paths) ? "" : context.text;
    }
    return result.reason === "running" ? boot.pendingBootLine({ seconds: boot.bootAgeSeconds(paths) }) : "";
  } catch {
    return "";
  }
}

(async () => {
  try {
    // A headless evaluator session gets no startup output and starts nothing (mcp/src/factory/headless-flag.cjs); a missing rule file falls back to the same exact comparison.
    try { if (require("../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(process.env)) return; } catch { const v = String(process.env.DESK_FACTORY_HEADLESS ?? ""); if (v !== "" && v !== "0") return; }
    // A Node older than Desk needs, with no newer one installed: say what to install and that a new session is needed, and nothing else.
    let nodeRequired = "";
    try { nodeRequired = require("./lib/node-required.cjs").nodeRequiredLine(); } catch { /* a check that cannot load never blocks the session */ }
    if (nodeRequired) {
      emit(nodeRequired);
      return;
    }
    let foundation;
    try {
      foundation = stripTrailingNewlines(fs.readFileSync(foundationPath, "utf8"));
    } catch {
      emit(`desk worker boot — the Desk foundation could not be read from ${foundationPath}. Desk runs its own boot; its result comes with your first Desk tool reply, and desk:session-start explains it. ${BOOT_STAND_DOWN}`);
      return;
    }
    const bootResult = bootSection();
    let direction = await startupDirection();
    if (!direction) {
      direction = `Desk startup: Desk could not resolve its root in this hook, so the hook did not start the boot. Desk starts it with your first Desk tool reply; desk_status reports the root Desk actually bound. ${BOOT_STAND_DOWN}`;
    }
    const bootText = await bootResult;
    // The foundation points at the RFC through this line: the installed copy, which the agent can open from any repository.
    // A Windows plugin root keeps its backslash separators, so the separator follows the root's own spelling.
    const sep = pluginRoot.includes("\\") ? "\\" : "/";
    const rfc = `Desk RFC: ${pluginRoot}${sep}docs${sep}agentic-engineering-v2-rfc.md`;
    // The startup line goes first, then the head of the boot: they have to sit inside the 2 KB preview, so the foundation and the RFC line come after them.
    emit(`${direction}\n\n${bootText ? `${bootText}\n\n` : ""}${foundation}\n\n${rfc}\n`);
  } catch {
    // Nothing may fail a session start.
  } finally {
    process.exitCode = 0;
  }
})();
