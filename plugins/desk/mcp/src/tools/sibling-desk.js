// The `desk` field on the card tools: write a card in another desk registered on this machine.
// Only a desk in the operator's registry (desk/machine-desks.js) is reachable; a path or name that is not registered is refused, so the field never widens where a session can write.

import { realpathSync } from "node:fs"
import * as path from "node:path"
import { readMachineDesks, resolveMachineDesk } from "../desk/machine-desks.js"

export const SIBLING_DESK_TOOLS = Object.freeze(["task_create", "task_update", "task_archive", "task_signoff"])

const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function refusal(tool, problem) {
  return Object.assign(new Error(`${tool}: Pass a registered desk, or leave \`desk\` out: ${problem} Nothing was changed.`), { code: "card_tool_desk_not_registered" })
}

/**
 * Resolves the card tools' `desk` field to `{ deskRoot }` of a desk registered on this machine, or throws a refusal that says what to do.
 * A name, repo or owner resolves as in desk_status; an absolute path must be a registered desk's folder.
 */
// Only the operator-controlled registry counts (`DESK_REGISTRY` or the recorded registry path): the bound desk's own `_meta/desks.md` is writable by this session, so it cannot widen where the session writes.
export function resolveSiblingDesk({ tool, desk, boundRoot, person, env }) {
  if (typeof desk !== "string" || desk.trim() === "") throw refusal(tool, "`desk` must be a non-empty string.")
  if (person) throw refusal(tool, "this session writes as a person-scoped member, and another desk's card is written under that desk's own authority: open a session in that desk.")
  const machine = readMachineDesks({ homeDir: env.HOME, root: null, env })
  const wanted = desk.trim()
  const byPath = path.isAbsolute(wanted) ? machine.filter((candidate) => real(candidate.path) === real(wanted)) : []
  const found = byPath.length === 1 ? (byPath[0].present ? { desk: byPath[0] } : { problem: `The ${byPath[0].name} desk is registered at ${byPath[0].path} but is not on this machine.` }) : resolveMachineDesk(wanted, machine)
  if (found.desk === undefined) throw refusal(tool, `${found.problem}`)
  if (found.desk.kind === "crew") throw refusal(tool, `${found.desk.name} is a Crew desk, where cards are written under a member's authority: open a session in that desk.`)
  return { deskRoot: real(found.desk.path) }
}
