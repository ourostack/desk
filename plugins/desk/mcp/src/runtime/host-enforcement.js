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

import { deskToolName } from "./desk-tool-name.js"

/**
 * One row per denied surface (spec §5's table). `reason` names the Desk
 * equivalent, following the same "what's blocked, then what to do instead"
 * shape `git-guard-policy.js`'s `MESSAGES` already establishes. `tools` is
 * keyed by host id (`claude`, `copilot`, `codex`); each host's list is
 * spelled in that host's own tool-naming convention, including its own MCP
 * form (`claude`/`codex` name an MCP tool `mcp__<server>__<tool>`; Copilot
 * names one `<server>-<tool>`) -- a caller never translates between hosts.
 * A whole MCP server's tools deny together without enumerating each one: an
 * entry ending in `*` matches any tool name sharing that prefix. Copilot and
 * Codex's lists stay empty for all five surfaces: this pass's live proof
 * (`docs/host-enforcement-live-proof.md`) confirmed each host's `PreToolUse`
 * wire shape, but never confirmed either host's own tool names for ask-user,
 * plan-mode, a persistent task tool, or an Artifact/Claude-Docs-shaped
 * surface. The lists stay empty until a live proof against a real Copilot or
 * Codex session confirms each host's own names for these surfaces, rather
 * than guessing names here. Host memory has no tool on any host (it is a
 * config flag -- `autoMemoryEnabled` on Claude Code, `features.memories` on
 * Codex, `memory` on Copilot -- pinned at setup instead); every surface still
 * gets a row here so its Desk-equivalent text exists for every host's
 * denial/documentation to reuse.
 */
export const DENIED_SURFACES = {
  "ask-user": {
    reason: "Converse in normal chat, one decision group at a time (see interaction-style). Desk denies the ask-user tool.",
    tools: { claude: ["AskUserQuestion"], copilot: [], codex: [] },
  },
  "host-memory": {
    reason: "Record durable context in the desk itself: friction-management, task cards, _meta/. Desk denies host memory.",
    tools: { claude: [], copilot: [], codex: [] },
  },
  "plan-mode": {
    reason: "Use superpowers:writing-plans or superpowers:brainstorming, and the desk's own planning docs. Desk denies plan mode.",
    tools: { claude: ["EnterPlanMode", "ExitPlanMode"], copilot: [], codex: [] },
  },
  "host-task": {
    // Only Claude Code lists host task tools to deny, so the reason names its spelling of the Desk tools.
    reason: `Call ${deskToolName("claude", "task_create")} or ${deskToolName("claude", "task_update")}, the desk's own task cards. Desk denies host task tools that persist across sessions.`,
    // TaskStop and TaskOutput are deliberately not here: they manage a
    // background shell's or subagent's already-running process, which an
    // agent needs regardless of where its durable task state lives.
    tools: { claude: ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"], copilot: [], codex: [] },
  },
  artifact: {
    reason: "Use desk_save, or the task's own doc files, unless specifically asked for Artifacts. Desk denies Artifacts and Claude Docs.",
    tools: { claude: ["Artifact", "ArtifactComments", "ArtifactData", "ArtifactCheck", "mcp__claude_ai_Claude_Docs__*"], copilot: [], codex: [] },
  },
}

/** The denied surface id `toolName` belongs to for `host`, or `null` when it denies nothing (including an unrecognized host, which this function never denies anything for). */
export function surfaceForToolName(host, toolName, surfaces = DENIED_SURFACES) {
  if (typeof host !== "string" || host === "") return null
  if (typeof toolName !== "string" || toolName === "") return null
  for (const [surfaceId, definition] of Object.entries(surfaces)) {
    const toolsForHost = definition.tools?.[host]
    if (!Array.isArray(toolsForHost)) continue
    for (const entry of toolsForHost) {
      const isWildcard = entry.endsWith("*")
      if (isWildcard ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry) return surfaceId
    }
  }
  return null
}

/**
 * `{ host, toolName, allowedThisSession }` -> `{ permissionDecision: "deny", permissionDecisionReason } | {}`.
 * `host` defaults to `"claude"`, the only host this PR wires in, so today's
 * one caller can omit it; Part 8's Copilot/Codex wrappers pass their own host
 * id explicitly. An unrecognized `host` denies nothing, the same as an
 * unrecognized `toolName`. `allowedThisSession` is a `Set` of surface ids
 * named by the operator this session (see `naming-allowlist.js`); a surface
 * in it is never denied, no matter how many of its tools are called.
 */
export function evaluateDeniedTool({ host = "claude", toolName, allowedThisSession }) {
  const surfaceId = surfaceForToolName(host, toolName)
  if (surfaceId === null) return {}
  if (allowedThisSession?.has(surfaceId)) return {}
  return {
    permissionDecision: "deny",
    permissionDecisionReason: DENIED_SURFACES[surfaceId].reason,
  }
}

/**
 * The tool-name field out of a raw `PreToolUse`-family stdin payload, read in
 * `host`'s own wire shape (`docs/host-enforcement-live-proof.md`): Copilot's
 * is camelCase `toolName`; Claude Code's and Codex's are both the shared
 * snake_case `tool_name` (confirmed identical on the wire for both hosts).
 * Returns `undefined`, never throws, when the field is missing or not a
 * string -- the same shape `evaluateDeniedTool`'s own `toolName` already
 * tolerates.
 */
export function toolNameFromPayload(host, payload) {
  const raw = host === "copilot" ? payload?.toolName : payload?.tool_name
  return typeof raw === "string" ? raw : undefined
}

/**
 * The session-id field out of a raw `PreToolUse`-family stdin payload, read
 * in `host`'s own wire shape: Copilot's camelCase `sessionId`; Claude Code's
 * and Codex's shared snake_case `session_id`.
 */
export function sessionIdFromPayload(host, payload) {
  return host === "copilot" ? payload?.sessionId : payload?.session_id
}

/**
 * Wraps `decision` (an `evaluateDeniedTool` result) in `host`'s own
 * `PreToolUse` JSON response shape. Claude Code nests a deny inside
 * `hookSpecificOutput` (confirmed today, Part 7); Copilot's own shape is
 * flat, with no wrapper at all -- confirmed live against a real fired hook,
 * `docs/host-enforcement-live-proof.md`. An allow (`{}`) is identical on both
 * hosts. Codex's deny mechanism is not JSON at all (exit code 2 plus stderr
 * text, confirmed live) -- a caller on `codex` never calls this function for
 * a deny; it exists only for hosts whose `PreToolUse` contract is JSON.
 */
export function formatHookOutput(host, decision) {
  if (decision.permissionDecision !== "deny") return {}
  if (host === "claude") return { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }
  return { ...decision }
}

/**
 * The complete `PreToolUse` hook process contract for `host`, given
 * `decision` (an `evaluateDeniedTool` result): exactly what to write to
 * stdout, what to write to stderr, and what exit code to use. This is the
 * one place that branches on a host's wire contract -- `host-
 * enforcement.cjs` itself stays a thin, branch-free wrapper that writes
 * these fields directly, so every one of these contracts is covered by a
 * plain function call here rather than needing a real denied tool for each
 * host to exercise it end to end (`docs/host-enforcement-live-proof.md`).
 *
 * Claude Code and Copilot both read a JSON decision on stdout and always
 * exit 0 -- `formatHookOutput` shapes it per host. Codex has no JSON
 * `PreToolUse` contract at all (confirmed live): a deny is exit code 2 with
 * the reason on stderr and nothing on stdout; an allow writes nothing on
 * either stream and exits 0.
 */
export function hookProcessOutput(host, decision) {
  if (host === "codex") {
    if (decision.permissionDecision === "deny") {
      return { stdout: "", stderr: `${decision.permissionDecisionReason}\n`, exitCode: 2 }
    }
    return { stdout: "", stderr: "", exitCode: 0 }
  }
  return { stdout: `${JSON.stringify(formatHookOutput(host, decision))}\n`, stderr: "", exitCode: 0 }
}
