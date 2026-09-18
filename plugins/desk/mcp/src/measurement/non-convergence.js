function scopeEntryAdmitsPath(scopeEntry, writePath) {
  return scopeEntry.endsWith("/") ? writePath.startsWith(scopeEntry) : writePath === scopeEntry
}

const introducedArchitectureMechanisms = new Set([
  "subsystem",
  "service",
  "registry",
  "persistent-store",
  "cross-platform-contract",
])

export function assessConvergence({ contract, cycles }) {
  const orderedCycles = [...cycles].sort((left, right) => left.cycle - right.cycle)
  const scopeEnvelope = contract.scope_envelope ?? []
  const discriminatorFields = [
    "hypothesis",
    "changed_mechanism",
    "expected_observation",
    "repeated_boundary_reason",
    "introduced_mechanisms",
    "finding_categories",
  ]
  const failedByBoundary = new Map()

  for (const cycle of orderedCycles) {
    if (cycle.result !== "rejected") continue
    const failed = failedByBoundary.get(cycle.boundary) ?? []
    failed.push(cycle)
    failedByBoundary.set(cycle.boundary, failed)
  }

  const triggers = []
  for (const cycle of orderedCycles) {
    const values = (cycle.discriminator?.introduced_mechanisms ?? []).filter((value) =>
      introducedArchitectureMechanisms.has(value),
    )
    if (values.length === 0) continue
    triggers.push({
      code: "introduced_mechanism",
      evidence: {
        cycle: cycle.cycle,
        values,
      },
    })
  }

  for (const cycle of orderedCycles) {
    const outsidePaths = (cycle.write_set ?? []).filter(
      (writePath) =>
        !scopeEnvelope.some((scopeEntry) => scopeEntryAdmitsPath(scopeEntry, writePath)),
    )
    if (outsidePaths.length === 0) continue
    triggers.push({
      code: "write_set_outside_scope",
      evidence: {
        cycle: cycle.cycle,
        paths: outsidePaths,
        scope_envelope: [...scopeEnvelope],
      },
    })
  }

  for (let index = 1; index < orderedCycles.length; index += 1) {
    const previous = orderedCycles[index - 1]
    const current = orderedCycles[index]
    if (previous.result !== "rejected" || current.result !== "rejected") continue
    if (current.open_findings.length < previous.open_findings.length) continue
    const hasNewDiscriminator = discriminatorFields.some((field) => {
      const currentValue = current.discriminator[field]
      const isNonEmpty = Array.isArray(currentValue)
        ? currentValue.length > 0
        : typeof currentValue === "string" && currentValue.trim().length > 0
      return (
        isNonEmpty &&
        JSON.stringify(currentValue) !== JSON.stringify(previous.discriminator[field])
      )
    })
    if (hasNewDiscriminator) continue
    triggers.push({
      code: "stalled_open_findings",
      evidence: {
        cycles: [previous, current],
        previous_open_findings: previous.open_findings,
        current_open_findings: current.open_findings,
        previous_discriminator: previous.discriminator,
        current_discriminator: current.discriminator,
      },
    })
  }

  for (const [boundary, failed] of failedByBoundary) {
    if (failed.length < 3) continue
    const evidenceCycles = failed.slice(0, 3)
    triggers.push({
      code: "three_failed_cycles_at_boundary",
      evidence: {
        boundary,
        cycles: evidenceCycles.map((cycle) => cycle.cycle),
        results: evidenceCycles.map((cycle) => cycle.result),
      },
    })
  }

  return {
    status: triggers.length === 0 ? "continue" : "pivot_required",
    triggers,
  }
}
