import { terminalFailure } from "../activation/failures.js"

const reasonDetails = {
  unsupported_target: {
    summary: "Desk does not ship an offline runtime dependency pack for the current platform, architecture, and Node ABI.",
    code: "runtime_unsupported",
  },
  missing_pack: {
    summary: "Desk's offline runtime dependency pack is missing for the current Node runtime.",
    code: "artifact_integrity_invalid",
  },
  corrupt_pack: {
    summary: "Desk found an offline runtime dependency pack, but its checksum, manifest, or archive is invalid.",
    code: "artifact_integrity_invalid",
  },
  runtime_restore_failed: {
    summary: "Desk validated its offline runtime pack but could not restore a usable runtime cache.",
    code: "artifact_integrity_invalid",
  },
  runtime_inspection_failed: {
    summary: "Desk could not inspect its committed offline runtime metadata safely.",
    code: "artifact_integrity_invalid",
  },
  node_selection_failed: {
    summary: "Desk could not complete bounded discovery of a compatible local Node runtime.",
    code: "runtime_unsupported",
  },
  no_compatible_node: {
    summary: "Desk could not find a local Node runtime matching a shipped offline dependency pack.",
    code: "runtime_unsupported",
  },
  guarded_reexec_failure: {
    summary: "Desk's one-time compatible-Node handoff did not produce a healthy runtime.",
    code: "runtime_unsupported",
  },
}

export function createRuntimeDiagnostic({
  reason,
  failureKind,
  currentTarget,
  shippedTargets = [],
  pathsChecked = [],
  runtimeCachePath = null,
  supportMatrixPath = null,
} = {}) {
  const details = reasonDetails[reason] ?? {
    summary: "Desk could not prepare its local runtime.",
    code: "artifact_integrity_invalid",
  }
  const diagnostic = terminalFailure({
    phase: "VERIFYING",
    code: details.code,
    expected: {
      runtime: "verified supported artifact",
    },
    observed: {
      reason,
      failure_kind: failureKind,
    },
    automaticActions: [],
    summary: details.summary,
  })
  const remediation = [{
    action: "refresh_plugin",
    message: "Refresh or reinstall Desk from its trusted source to restore the committed runtime support matrix and verified dependency packs, then call desk_status: Desk rechecks its runtime pack in place (and on its own after 1, 2, 5, 10 and 30 s, then every 60 s). A refresh that installs Desk into a new folder takes effect when the host reconnects the Desk MCP server.",
  }]
  if (details.code === "runtime_unsupported") {
    const abis = [...new Set(shippedTargets.map((target) => target.node_abi).filter(Boolean))]
    remediation.unshift({
      action: "use_shipped_node",
      message: abis.length > 0
        ? `Install a local Node runtime matching a shipped platform, architecture, and module ABI (${abis.join(", ")}), then reconnect the Desk MCP server (in Claude Code run /mcp and reconnect desk): Desk's launcher picks that Node itself.`
        : "Check Desk's runtime support matrix and install a supported local Node runtime, then reconnect the Desk MCP server (in Claude Code run /mcp and reconnect desk): Desk's launcher picks that Node itself.",
    })
  }
  if (reason === "runtime_restore_failed") {
    remediation.unshift({
      action: "check_runtime_cache",
      message: `Check write permissions and free disk space for ${runtimeCachePath ?? "Desk's runtime cache"}, then call desk_status: Desk retries the verified offline restoration in place.`,
    })
  }
  Object.assign(diagnostic, {
    activation_status: diagnostic.status,
    status: "degraded",
    state: `degraded:${details.code}`,
    mode: "diagnostic",
    reason,
    fix: remediation[0].message,
    lexical: {
      generation: null, event_cursor: null, pending_changes: null,
      certain: false, current_automatic_action: null, serving_path: "blocked",
    },
    remediation,
    runtime: {
      current_target: currentTarget,
      shipped_targets: shippedTargets,
      paths_checked: pathsChecked,
      runtime_cache_path: runtimeCachePath,
      support_matrix_path: supportMatrixPath,
    },
  })
  if (failureKind !== undefined) {
    diagnostic.failure_kind = failureKind
  }
  return diagnostic
}

// The last-resort catch in index.js: anything that throws before the server starts becomes this diagnostic, so the handshake still completes and desk_status names the cause and the fix instead of the process exiting.
export function createStartupExceptionDiagnostic({ error } = {}) {
  const observed = {
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
  }
  if (typeof error?.code === "string") {
    observed.failure_code = error.code
  }
  const fix = "Read observed.message and fix the cause it names (for example a --root path that does not exist, or a malformed activation config), then reconnect the Desk MCP server (in Claude Code run /mcp and reconnect desk; otherwise start a new session)."
  return {
    status: "degraded",
    activation_status: "terminal",
    state: "degraded:startup_exception",
    mode: "diagnostic",
    reason: "startup_exception",
    code: "startup_exception",
    phase: typeof error?.phase === "string" ? error.phase : "STARTING",
    summary: "Desk hit an error before it finished starting, so it is serving diagnostic mode: desk_status and desk_doctor answer, and every other tool is unavailable until the cause is fixed.",
    observed,
    fix,
    lexical: {
      generation: null, event_cursor: null, pending_changes: null,
      certain: false, current_automatic_action: null, serving_path: "blocked",
    },
    remediation: [{ action: "fix_startup_cause", message: fix }],
  }
}

// No desk is bound yet. This is the normal first-run state, so Desk keeps
// answering desk_status/desk_doctor and points at setup instead of exiting.
// Overlays that own onboarding (a crew workspace, for example) name their own
// skill; they also own the binding, so only the default path names the file.
export const DEFAULT_ONBOARDING_SKILL = "desk:first-run-bootstrap"

export function createSetupDiagnostic({
  pathsTried = [],
  bindingPath = null,
  onboardingSkill = DEFAULT_ONBOARDING_SKILL,
  reasonDetail = null,
} = {}) {
  const overlay = onboardingSkill !== DEFAULT_ONBOARDING_SKILL
  const bindStep = bindingPath === null
    ? "Bind the chosen desk by exporting DESK=<path> for the host, or by writing an activation config with {\"schema_version\":1,\"desk\":{\"root\":\"<path>\"}}."
    : `Bind the chosen desk by writing {"schema_version":1,"desk":{"root":"<absolute path>"}} to ${bindingPath}. The binding survives plugin updates.`
  const remediation = overlay
    ? [{
        action: "run_onboarding",
        message: `Run ${onboardingSkill} now: the active overlay owns onboarding and binding for this workspace. Do not offer to continue without Desk.`,
      }]
    : [
        {
          action: "run_first_run_bootstrap",
          message: "Run desk:first-run-bootstrap now. It looks for an existing local desk, then for the operator's desk repository on GitHub, and otherwise offers to create a fresh desk. Do not offer to continue without Desk.",
        },
        { action: "bind_desk", message: bindStep },
      ]
  remediation.push(overlay
    ? {
        action: "restart_session",
        message: "Start a new session once onboarding completes so Desk loads the workspace.",
      }
    : {
        action: "check_binding",
        message: "Then call desk_status: Desk rechecks the binding in place and loads the bound desk in this session. Opening the desk folder itself as the project also binds it.",
      })
  return {
    status: "setup_required",
    mode: "setup",
    reason: "no_desk_root",
    summary: overlay
      ? `No desk is bound yet. Desk is running in setup mode: run ${onboardingSkill}, then start a new session.`
      : `No desk is bound yet. Desk is running in setup mode: run ${onboardingSkill}, then call desk_status to load the bound desk in this session.`,
    onboarding_skill: onboardingSkill,
    reason_detail: reasonDetail ?? null,
    paths_tried: pathsTried,
    binding_path: bindingPath,
    lexical: {
      generation: null, event_cursor: null, pending_changes: null,
      certain: false, current_automatic_action: null, serving_path: "blocked",
    },
    remediation,
  }
}
