"use strict";

// The one statement of the headless-session rule: DESK_FACTORY_HEADLESS is set, and is neither empty nor `0`, compared
// exactly as given (no trimming), so the Claude hook (hooks/claude-session-start.cjs, which repeats this comparison when it cannot load this file) and this function agree on every value.
// The MCP server reads it through headless-flag.js beside this file, which stays inside mcp/src because the runtime mirrors only that tree. A hook that cannot load this file repeats the same exact comparison inline from the environment, so the flag is still honoured and an ordinary session keeps working.

function isHeadlessFactorySession(env) {
  const value = String(env?.DESK_FACTORY_HEADLESS ?? "");
  return value !== "" && value !== "0";
}

module.exports = { isHeadlessFactorySession };
