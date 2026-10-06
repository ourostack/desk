// Which person's improvement-card folder a session start reads. The same person the Desk tools resolve
// (`resolvePerson`: `DESK_PERSON`, else the crew roster matched with `DESK_IDENTITY` or the cached GitHub login),
// using only what is known without a network call: a cold login lookup is never started here.
//
// `improvementPerson({ deskRoot, env, now, homeDir }) -> { status: "ok", personPrefix } | { status: "unresolved", reason }`.
// `personPrefix` is "" for a solo desk and `desks/<alias>` for a crew desk. A `DESK_PERSON` that is not a valid
// alias is read as no person, as the session-start hook has always read it, and never stops the boot. `reason` is
// `login_not_cached`, `no_matching_member` or `invalid_member`: the cards were not checked, and the caller says so.

import * as os from "node:os"
import * as path from "node:path"
import { crewWorkspace } from "./crew-roster.js"
import { personPrefix } from "../util/paths.js"

const SOLO = Object.freeze({ status: "ok", personPrefix: "" })

function prefixOf(deskRoot, alias) {
  try {
    return { status: "ok", personPrefix: path.relative(deskRoot, personPrefix(deskRoot, alias)) }
  } catch {
    return null
  }
}

const noLookup = () => {
  throw new Error("no lookup at session start")
}

export async function improvementPerson({ deskRoot, env, now = Date.now(), homeDir = env.HOME || os.homedir() }) {
  const named = typeof env.DESK_PERSON === "string" ? env.DESK_PERSON.trim() : ""
  if (named !== "") return prefixOf(deskRoot, named) ?? SOLO
  const { crew, roster } = crewWorkspace(deskRoot)
  if (!crew) return SOLO
  const { resolvePerson } = await import("./tidy.js")
  const person = resolvePerson(deskRoot, { env, homeDir, now, roster, spawnBackground: noLookup })
  if (typeof person === "string") return prefixOf(deskRoot, person) ?? { status: "unresolved", reason: "invalid_member" }
  return { status: "unresolved", reason: person === undefined ? "login_not_cached" : "no_matching_member" }
}
