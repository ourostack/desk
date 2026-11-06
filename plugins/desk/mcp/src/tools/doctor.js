import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { diagnosticFormat, previewRuntimeSnapshot } from "../runtime/preview-snapshot.js"
import { observeLfs } from "../runtime/lfs-observation.js"
import { organizationFindings } from "../desk/organization.js"
import { operatorNames } from "../desk/naming.js"
import { personPrefix } from "../util/paths.js"
import { legacyLedgerPartitions, legacyLedgerSummary } from "../protected/legacy-ledger.js"
import { factoryStatus, factorySummary } from "./factory-context.js"

// Every code `organizationFindings` can return — printed in this fixed
// order regardless of which codes actually fired, so the section's shape is
// stable across desks and its absence lines read as "checked, found none"
// rather than "not checked".
export const ORGANIZATION_CODES = [
  "track_missing_scope",
  "track_person_name",
  "track_catch_all",
  "track_empty",
  "name_prompt_like",
  "name_credential_like",
  "name_shape",
  "loose_file",
  "duplicate_job",
  "stale_task",
  "stale_quarantine",
]

const ORGANIZATION_PATHS_SHOWN = 5

// Human-readable "Organization" section: count per code, first five paths
// per code (M4-3 brief). Printed even when clean, so a resuming agent can
// tell "checked, nothing to tidy" apart from "never checked".
// Exported for its tests.
export function organizationSection(findings) {
  // Every code `organizationFindings` returns is meant to be listed above (a test checks the list against the checks' source). A code
  // that is not gets its own group after the listed ones, so a new finding type can never make desk_doctor fail (`stale_quarantine` did).
  const byCode = new Map(ORGANIZATION_CODES.map((code) => [code, []]))
  for (const finding of findings) {
    if (!byCode.has(finding.code)) byCode.set(finding.code, [])
    byCode.get(finding.code).push(finding)
  }

  const lines = ["Organization"]
  if (findings.length === 0) {
    lines.push("  clean — no organization findings in this desk subtree")
    return lines.join("\n")
  }

  for (const [code, items] of byCode) {
    if (items.length === 0) continue
    lines.push(`  ${code}: ${items.length}`)
    for (const item of items.slice(0, ORGANIZATION_PATHS_SHOWN)) {
      const handle = item.handle === undefined ? "" : ` (handle ${item.handle})`
      lines.push(`    ${item.path}${handle} — ${item.hint}`)
    }
    if (items.length > ORGANIZATION_PATHS_SHOWN) {
      lines.push(`    ... and ${items.length - ORGANIZATION_PATHS_SHOWN} more`)
    }
  }
  return lines.join("\n")
}

// Organization checks need a real desk subtree to read, so they only run
// when a `deskRoot` is on hand and the caller didn't ask for the private,
// dependency-free `preview` snapshot (which must carry no workspace data).
// Default and preview calls remain synchronous; only an explicit storage observation returns a promise.
function collectOrganization({ deskRoot, person }) {
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") return null
  const scanRoot = path.resolve(personPrefix(deskRoot, person))
  const findings = organizationFindings(deskRoot, {
    personPrefix: scanRoot,
    operatorNames: operatorNames(deskRoot),
  })
  return findings
}

export function doctorRuntime({ input, statusContext = {}, deskRoot, person = null, env = process.env, signal, observeStorage = observeLfs } = {}) {
  if (diagnosticFormat(input) === "preview") {
    return previewRuntimeSnapshot("ready")
  }
  if (input?.storage !== undefined && input.storage !== "inspect") {
    throw new TypeError('unsupported storage observation; use storage: "inspect"')
  }
  if (input?.storage === "inspect" && input?.repair !== undefined) {
    throw new TypeError("cannot combine storage inspection with repair")
  }
  const runtime = statusContext.runtime ?? {}

  const organizationResult = collectOrganization({ deskRoot, person })
  const organization = organizationResult ?? []
  // The factory section, like the organization one, needs a bound desk.
  const factory = organizationResult === null ? null : factoryStatus({ env, deskRoot })
  // The retired manual ledger's leftover private partitions, counted and never opened (M3-12).
  const legacyLedger = legacyLedgerPartitions({ env })
  const sections = [
    "Desk MCP runtime dependencies are ready.",
    ...(organizationResult === null ? [] : [organizationSection(organization), factorySummary(factory)]),
    legacyLedgerSummary(legacyLedger),
  ].filter((section) => section !== null)
  const summary = sections.join("\n\n")

  const result = {
    status: "ok",
    mode: "healthy",
    reason: "ready",
    summary,
    runtime: {
      state: "ready",
      current_target: runtime.current_target ?? runtime.target,
      shipped_targets: runtime.shipped_targets ?? [],
      paths_checked: runtime.paths_checked ?? [],
      runtime_cache_path: runtime.runtime_cache_path ?? runtime.runtime_cache_dir,
      support_matrix_path: runtime.support_matrix_path,
    },
    organization,
    ...(factory === null ? {} : { factory }),
    legacy_work_ledger: legacyLedger,
    remediation: [],
  }
  if (input?.storage !== "inspect") return result
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") {
    return Promise.resolve(withStorage(result, { state: "not_checked", reason: "desk_unavailable", worker: "not_started" }, null))
  }
  let pending
  try {
    pending = observeStorage({ repo: path.resolve(deskRoot), env, signal })
  } catch {
    pending = { state: "unavailable", reason: "observation_failed", worker: "unconfirmed" }
  }
  return Promise.resolve(pending).then(
    (observation) => withStorage(result, observation, path.resolve(deskRoot)),
    () => withStorage(result, { state: "unavailable", reason: "observation_failed", worker: "unconfirmed" }, path.resolve(deskRoot)),
  )
}

function withStorage(result, observation, repo) {
  const storage = {
    state: observation.state === "observed" ? observation.report.state : observation.state,
    ...(observation.reason === undefined ? {} : { reason: observation.reason }),
    worker: observation.worker,
    readiness: "not_checked",
    qualification: { remote_publication: "not_checked", network_auth: "not_checked", installed_payload: "not_checked" },
  }
  if (observation.state === "observed") {
    const report = observation.report
    storage.scope = {
      kind: ["context", "package"].includes(report.repository.kind) ? report.repository.kind : "unknown",
      context: ["personal", "shared"].includes(report.repository.context) ? report.repository.context : "unknown",
    }
    storage.tool = { state: ["available", "missing", "unavailable"].includes(report.tool.state) ? report.tool.state : "not_checked" }
    storage.counts = {
      inspected: report.files.filter((file) => file.inspection === "inspected").length,
      skipped: report.files.filter((file) => file.inspection !== "inspected").length,
      tracking_candidates: report.files.filter((file) => file.proposal === "track_exact_path").length,
      review_candidates: report.files.filter((file) => typeof file.proposal === "string" && file.proposal.startsWith("review_")).length,
      pointers: report.files.filter((file) => file.tracking === "lfs_pointer").length,
      missing_local_objects: report.files.filter((file) => file.local_object === "missing").length,
      mismatches: report.files.filter((file) => file.local_object === "mismatch" || file.materialization === "mismatch").length,
      materialized_verified: report.files.filter((file) => file.materialization === "verified").length,
      package_exempt: report.files.filter((file) => file.proposal === "package_exempt").length,
      diagnostics: report.findings.length,
    }
  }
  storage.next_step = observation.state === "cancelled" ? {
    kind: "none", message: "Storage observation was cancelled. No retry or repair was performed; wait for a new request.",
  } : repo === null || ["unconfirmed", "running"].includes(observation.worker) ? {
    kind: "tool_call", tool: "desk_status", input: { detail: true },
    message: repo === null ? "Read the bound Desk root before requesting storage inspection; do not use cwd as a fallback."
      : observation.worker === "running" ? "A storage observation is still running. Wait for its result or cancel that request; do not start another."
        : "Worker shutdown is unconfirmed. Do not repeat storage inspection; check this session's status and retain the failed observation.",
  } : {
    kind: "readonly_command", command: process.execPath,
    args: [fileURLToPath(new URL("../../scripts/lfs.js", import.meta.url)), "inspect", "--repo", repo],
    message: storage.counts?.mismatches > 0 ? "Preserve modified files and inspect the local mismatch details. Do not overwrite or convert them."
      : storage.counts?.missing_local_objects > 0 ? "Inspect the missing local-object details. This report does not prove remote loss or authorize a download."
        : "Review the local report before proposing any setup or forward-only contribution. This command installs, downloads and changes nothing.",
  }
  return { ...result, storage, summary: `${result.summary}\n\nBinary storage\n  Local inspection: ${storage.state}; storage readiness is not checked.\n  Remote publication, authentication and installed payloads are not checked.\n  ${storage.next_step.message}` }
}
