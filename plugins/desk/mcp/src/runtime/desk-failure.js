// The shape of a Desk failure an agent reads: Ouro AX's one-line error (`<tool>: <thing>: <problem>. Fix: <fix>.`), holding what
// probably happened, how to look further, the one call that files a bug with its evidence, and how to keep working. The kit is
// vendored unmodified from ourostack/ouro-ui under upstream-sources.lock.json, which a daily check keeps current.
import { errorLine } from "../lib/ouro-ui/registry/ouro/ax/problem.ts"

// The latest failure per code in this process, with the stack where it was built, for `friction_add`'s evidence and `desk_doctor`.
const recent = new Map()

/** The failure line: `desk: <thing>: <probably>; to look further, <look>; to file a bug with its evidence, call friction_add with {"error_code":"<code>"}; <keepWorking>. Fix: <fix>.` */
export function deskFailure({ code, thing, probably, look, keepWorking, fix = null }) {
  const problem = `${probably}; to look further, ${look}; to file a bug with its evidence, call friction_add with {"error_code":"${code}"}; ${keepWorking}`
  const message = errorLine("desk", { thing, problem, fix })
  recent.delete(code)
  recent.set(code, { code, message, stack: new Error(code).stack, at: new Date().toISOString() })
  return message
}

/** What this process last recorded for `code`, or `null`. */
export function recentFailure(code) {
  return recent.get(code) ?? null
}

/** Every failure this process has recorded, newest first. */
export function recentFailures() {
  return [...recent.values()].reverse()
}
