import * as path from "node:path"
import { diagnosticFormat, previewRuntimeSnapshot } from "../runtime/preview-snapshot.js"
import { organizationFindings } from "../desk/organization.js"
import { operatorNames } from "../desk/naming.js"
import { personPrefix } from "../util/paths.js"

// Every code `organizationFindings` can return — printed in this fixed
// order regardless of which codes actually fired, so the section's shape is
// stable across desks and its absence lines read as "checked, found none"
// rather than "not checked".
const ORGANIZATION_CODES = [
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
]

const ORGANIZATION_PATHS_SHOWN = 5

// Human-readable "Organization" section: count per code, first five paths
// per code (M4-3 brief). Printed even when clean, so a resuming agent can
// tell "checked, nothing to tidy" apart from "never checked".
function organizationSection(findings) {
  // Every code `organizationFindings` can return is pre-registered above, so
  // `byCode.get(finding.code)` below always finds its array.
  const byCode = new Map(ORGANIZATION_CODES.map((code) => [code, []]))
  for (const finding of findings) {
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
      lines.push(`    ${item.path} — ${item.hint}`)
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
// Both the no-deskRoot and preview paths stay fully synchronous, matching
// every existing caller of `doctorRuntime()` that reads its return value
// without awaiting it.
function collectOrganization({ deskRoot, person }) {
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") return null
  const scanRoot = path.resolve(personPrefix(deskRoot, person))
  const findings = organizationFindings(deskRoot, {
    personPrefix: scanRoot,
    operatorNames: operatorNames(deskRoot),
  })
  return findings
}

export function doctorRuntime({ input, statusContext = {}, deskRoot, person = null } = {}) {
  if (diagnosticFormat(input) === "preview") {
    return previewRuntimeSnapshot("ready")
  }
  const runtime = statusContext.runtime ?? {}

  const organizationResult = collectOrganization({ deskRoot, person })
  const organization = organizationResult ?? []
  const summary = organizationResult === null
    ? "Desk MCP runtime dependencies are ready."
    : `Desk MCP runtime dependencies are ready.\n\n${organizationSection(organization)}`

  return {
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
    remediation: [],
  }
}
