#!/usr/bin/env node
"use strict";

// desk worker: the SessionStart hook Claude Code and Codex run (hooks.json). It is Node, never a shell script: on Windows
// a bare `bash` resolves through PATH, and a standard user can have the WSL relay bash.exe first with no distro installed,
// where it exits 1. Foundation plus bounded local boot checks; repairs run detached. MUST always exit 0, because a nonzero
// SessionStart hook blocks the session from starting. It keeps to Node 16 syntax, and loads Desk's modules with dynamic
// import() inside try/catch, so an older Node still prints the fallback line and exits 0.

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const foundationPath = process.argv[2] || `${pluginRoot}/skills/using-desk/SKILL.md`;
const bootScript = `${pluginRoot}/mcp/scripts/session-boot.js`;

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
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`);
}

(async () => {
  try {
    // A headless evaluator session gets no startup output and starts nothing (mcp/src/factory/headless-flag.cjs); a missing rule file falls back to the same exact comparison.
    try { if (require("../mcp/src/factory/headless-flag.cjs").isHeadlessFactorySession(process.env)) return; } catch { const v = String(process.env.DESK_FACTORY_HEADLESS ?? ""); if (v !== "" && v !== "0") return; }
    let foundation;
    try {
      foundation = stripTrailingNewlines(fs.readFileSync(foundationPath, "utf8"));
    } catch {
      emit(`desk worker boot — the Desk foundation could not be read from ${foundationPath}. The boot has not run: run node "${bootScript}" before other work, then desk:session-start explains its result. A child agent with a bounded brief follows the brief instead and skips this.`);
      return;
    }
    let direction = await startupDirection();
    if (!direction) {
      direction = `Desk startup: Desk could not resolve its root in this hook. The boot has not run: run node "${bootScript}" now, before other work, for the authoritative workspace scan; desk_status reports the root Desk actually bound. A child agent with a bounded brief follows the brief instead and skips this.`;
    }
    // The foundation points at the RFC through this line: the installed copy, which the agent can open from any repository.
    // A Windows plugin root keeps its backslash separators, so the separator follows the root's own spelling.
    const sep = pluginRoot.includes("\\") ? "\\" : "/";
    const rfc = `Desk RFC: ${pluginRoot}${sep}docs${sep}agentic-engineering-v2-rfc.md`;
    // The startup line goes first. Claude Code saves a hook's additionalContext to a file and shows the agent only a preview of its first 2 KB once it passes 10,000 characters, and the foundation alone is most of that budget. The boot imperative has to sit inside the preview, so the foundation and the RFC line come after it.
    emit(`${direction}\n\n${foundation}\n\n${rfc}\n`);
  } catch {
    // Nothing may fail a session start.
  } finally {
    process.exitCode = 0;
  }
})();
