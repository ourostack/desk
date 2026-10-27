// Which person's improvement-card folder a session start reads. The same person the Desk tools resolve
// (`crew-member.js`: `DESK_PERSON`, else the crew roster matched with `DESK_IDENTITY` or the logins signed in to gh; when gh
// lists none, the cached GitHub login), using only what is known without a network call unless the boot passes the
// member it already settled: a cold login lookup is never started here.
//
// `improvementPerson({ deskRoot, env, now, homeDir }) -> { status: "ok", personPrefix } | { status: "unresolved", reason }`.
// `personPrefix` is "" for a solo desk and `desks/<alias>` for a crew desk. A `DESK_PERSON` that is not a valid
// alias is read as no person, as the session-start hook has always read it, and never stops the boot. `reason` is
// `login_not_cached`, `no_matching_member`, `several_accounts` or `invalid_member`: the cards were not checked, and the caller says so.

import * as os from "node:os"
import { crewWorkspace } from "./crew-roster.js"
import { localMember } from "./crew-member.js"
import { envValue } from "../util/env-value.js"
import { deskRelativePath, personPrefix } from "../util/paths.js"

const SOLO = Object.freeze({ status: "ok", personPrefix: "" })

function prefixOf(deskRoot, alias) {
  try {
    return { status: "ok", personPrefix: deskRelativePath(deskRoot, personPrefix(deskRoot, alias)) }
  } catch {
    return null
  }
}

const noLookup = () => {
  throw new Error("no lookup at session start")
}

export async function improvementPerson({ deskRoot, env, now = Date.now(), homeDir = envValue(env, "HOME") || os.homedir(), member }) {
  const value = envValue(env, "DESK_PERSON")
  const named = typeof value === "string" ? value.trim() : ""
  if (named !== "") return prefixOf(deskRoot, named) ?? SOLO
  const workspace = crewWorkspace(deskRoot)
  const { crew, roster } = workspace
  if (!crew) return SOLO
  // The Desk tools' own resolver (crew-member.js): the boot passes the member it settled; otherwise the signed-in logins.
  const found = member?.crew === true ? member : localMember({ deskRoot, env, homeDir, workspace })
  if (!found.crew) return SOLO
  if (typeof found.person === "string") return prefixOf(deskRoot, found.person) ?? { status: "unresolved", reason: "invalid_member" }
  if (found.problem === "invalid_alias" || found.problem === "several_rows") return { status: "unresolved", reason: "invalid_member" }
  if (found.problem === "github_unreachable") return { status: "unresolved", reason: "login_not_cached" }
  if (found.problem === "not_on_roster") return { status: "unresolved", reason: "no_matching_member" }
  if (found.problem === "several_accounts" || found.pending === "choose") return { status: "unresolved", reason: "several_accounts" }
  // gh lists no login: the cached login, never looked up here.
  const { resolvePerson } = await import("./tidy.js")
  const person = resolvePerson(deskRoot, { env, homeDir, now, roster, spawnBackground: noLookup })
  if (typeof person === "string") return prefixOf(deskRoot, person) ?? { status: "unresolved", reason: "invalid_member" }
  return { status: "unresolved", reason: person === undefined ? "login_not_cached" : "no_matching_member" }
}
