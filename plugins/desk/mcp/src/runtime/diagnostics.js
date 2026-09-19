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
    message: "Refresh or reinstall Desk from its trusted source to restore the committed runtime support matrix and verified dependency packs, then restart the host.",
  }]
  if (details.code === "runtime_unsupported") {
    const abis = [...new Set(shippedTargets.map((target) => target.node_abi).filter(Boolean))]
    remediation.unshift({
      action: "use_shipped_node",
      message: abis.length > 0
        ? `Start Desk with a local Node runtime matching a shipped platform, architecture, and module ABI (${abis.join(", ")}), then restart the host.`
        : "Check Desk's runtime support matrix and start with a supported local Node runtime, then restart the host.",
    })
  }
  if (reason === "runtime_restore_failed") {
    remediation.unshift({
      action: "check_runtime_cache",
      message: `Check write permissions and free disk space for ${runtimeCachePath ?? "Desk's runtime cache"}, then restart the host to retry verified offline restoration.`,
    })
  }
  Object.assign(diagnostic, {
    activation_status: diagnostic.status,
    status: "degraded",
    mode: "diagnostic",
    reason,
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
