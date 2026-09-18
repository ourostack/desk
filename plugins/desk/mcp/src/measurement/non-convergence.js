export function assessConvergence({ contract, cycles }) {
  void contract
  const orderedCycles = [...cycles].sort((left, right) => left.cycle - right.cycle)
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
