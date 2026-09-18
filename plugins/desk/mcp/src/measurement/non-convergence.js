export function assessConvergence({ contract, cycles }) {
  void contract
  const failedByBoundary = new Map()

  for (const cycle of [...cycles].sort((left, right) => left.cycle - right.cycle)) {
    if (cycle.result === "clean") continue
    const failed = failedByBoundary.get(cycle.boundary) ?? []
    failed.push(cycle)
    failedByBoundary.set(cycle.boundary, failed)
  }

  const triggers = []
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
