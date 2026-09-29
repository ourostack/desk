// The shared, host-agnostic deny decision for Desk-only enforcement (spec §5,
// controller rulings 2 and 3). This module owns exactly one question: given a
// tool name a host is about to run, should Desk deny it? It knows nothing
// about any one host's hook wire format (Claude Code's `hookSpecificOutput`
// wrapping, Copilot's flat JSON, Codex's own shape) -- every caller wraps
// this module's plain `{ permissionDecision, permissionDecisionReason } | {}`
// per its own host, the same way `protected-checkout.cjs`/`ask-gate.cjs`
// already wrap their own core functions' output today. This is the module
// Part 8's Codex/Copilot wrappers reuse directly.
//
// Denied (ruling 2): ask-user tools, host memory, plan mode, Artifacts and
// Claude Docs, and any host task tool that persists across sessions -- every
// one a durable or alternative-UI surface Desk already fully replaces.
// Never denied: an in-session checklist such as `TodoWrite`, which vanishes
// with the session and carries no durable state of its own; Superpowers
// skills tell agents to keep exactly this kind of checklist, and denying it
// would leave an agent with contradictory instructions.
//
// `allowedThisSession` is the set of surface ids `naming-allowlist.js`'s
// `UserPromptSubmit` hook has recorded this session (controller ruling 3):
// once an operator has named a surface in any message, that surface is
// skipped by this deny layer for the rest of the session.

/**
 * One row per denied surface (spec §5's table). `reason` names the Desk
 * equivalent, following the same "what's blocked, then what to do instead"
 * shape `git-guard-policy.js`'s `MESSAGES` already establishes. `tools.claude`
 * lists the exact Claude Code tool names this surface denies; a surface with
 * no Claude Code tool of its own (host memory, handled by the
 * `autoMemoryEnabled: false` settings merge instead) still gets a row here so
 * its Desk-equivalent text exists for Part 8's other hosts to reuse.
 */
export const DENIED_SURFACES = {
  "ask-user": {
    reason: "Desk denies the ask-user tool: converse in normal chat, one decision group at a time -- see interaction-style.",
    tools: { claude: ["AskUserQuestion"] },
  },
  "host-memory": {
    reason: "Desk denies host memory: durable context lives in the desk itself -- friction-management, task cards, _meta/.",
    tools: { claude: [] },
  },
  "plan-mode": {
    reason: "Desk denies plan mode: use superpowers:writing-plans or superpowers:brainstorming, and the desk's own planning docs.",
    tools: { claude: ["EnterPlanMode", "ExitPlanMode"] },
  },
  "host-task": {
    reason: "Desk denies host task tools that persist across sessions: use task_create/task_update, the desk's own task cards.",
    tools: { claude: ["TaskCreate"] },
  },
  artifact: {
    reason: "Desk denies Artifacts and Claude Docs: use desk_save, or the task's own doc files, unless specifically asked for.",
    tools: { claude: ["Artifact", "ArtifactComments", "ArtifactData", "ArtifactCheck"] },
  },
}

// Claude Code names every MCP tool `mcp__<server>__<tool>`; the Claude Docs
// server's tools are all Artifact-shaped durable-doc surfaces, so the whole
// family denies under the `artifact` surface without enumerating each tool.
const CLAUDE_DOCS_MCP_PREFIX = "mcp__claude_ai_Claude_Docs__"

/** The denied surface id `toolName` belongs to for Claude Code, or `null` when it denies nothing. */
function surfaceForToolName(toolName) {
  if (typeof toolName !== "string" || toolName === "") return null
  if (toolName.startsWith(CLAUDE_DOCS_MCP_PREFIX)) return "artifact"
  for (const [surfaceId, definition] of Object.entries(DENIED_SURFACES)) {
    if (definition.tools.claude.includes(toolName)) return surfaceId
  }
  return null
}

/**
 * `{ toolName, allowedThisSession }` -> `{ permissionDecision: "deny", permissionDecisionReason } | {}`.
 * `allowedThisSession` is a `Set` of surface ids named by the operator this
 * session (see `naming-allowlist.js`); a surface in it is never denied, no
 * matter how many of its tools are called.
 */
export function evaluateDeniedTool({ toolName, allowedThisSession }) {
  const surfaceId = surfaceForToolName(toolName)
  if (surfaceId === null) return {}
  if (allowedThisSession?.has(surfaceId)) return {}
  return {
    permissionDecision: "deny",
    permissionDecisionReason: DENIED_SURFACES[surfaceId].reason,
  }
}
