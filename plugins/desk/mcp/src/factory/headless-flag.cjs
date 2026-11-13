"use strict";

// The one statement of the headless-session rule: DESK_FACTORY_HEADLESS is set, and is neither empty nor `0`, compared
// exactly as given (no trimming), so the Claude hook (hooks/claude-session-start.cjs, which repeats this comparison when it cannot load this file) and this function agree on every value.
// The MCP server reads it through headless-flag.js beside this file, which stays inside mcp/src because the runtime mirrors only that tree. A hook that cannot load this file repeats the same exact comparison inline from the environment, so the flag is still honoured and an ordinary session keeps working.

function isFlagSet(value) {
  const text = String(value ?? "");
  return text !== "" && text !== "0";
}

function isHeadlessFactorySession(env) {
  return isFlagSet(env?.DESK_FACTORY_HEADLESS);
}

// The explicit mark of a controlled SDK proof run (issue #578). Only this variable marks a proof; an unattended run without it counts as before.
function isProofFactorySession(env) {
  return isFlagSet(env?.DESK_FACTORY_PROOF);
}

module.exports = { isHeadlessFactorySession, isProofFactorySession };
