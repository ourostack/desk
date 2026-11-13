// The shape of a Desk failure an agent reads: Ouro AX's one-line error, `<tool>: <thing>: <problem>. Fix: <fix>.` (ax-problem,
// copied into src/lib/ouro/ax/ with `npx shadcn@latest add ourostack/ouro-ui/ax-problem#v1.3.10`), holding what probably
// happened, how to look further, the one call that files a bug with its evidence, and how to keep working.
//
// The kit is TypeScript that Node runs only from 22.18, and Desk still supports Node 20, so the server cannot import it yet;
// `errorLine` below is the kit's own and a test pins it to the kit's output. Raise Desk's Node floor, then import the kit's.
const sentence = (text) => text.trim().replace(/[.\s]+$/u, "")
const errorLine = (tool, { thing, problem, fix }) => {
  const head = `${tool}: ${thing}: ${sentence(problem)}.`
  return (fix === null ? head : `${head} Fix: ${sentence(fix)}.`).replace(/\s*[\r\n]+\s*/gu, " ")
}

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
