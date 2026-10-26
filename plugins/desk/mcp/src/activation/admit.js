import { ActivationFailure } from "./failures.js"
import { validateWriteSegment } from "../util/paths.js"
import { normalizeReadinessPolicy } from "./readiness-policy.js"

export function validateAdmissionAuthority({ authority, person = null, policy } = {}) {
  const normalizedPolicy = normalizeReadinessPolicy(policy)
  if (authority?.mode !== normalizedPolicy.write_authority) {
    throw new ActivationFailure({
      phase: "VERIFYING",
      code: "authority_invalid",
      expected: { write_authority: normalizedPolicy.write_authority },
      observed: { authority, person },
      summary: "Admitted Desk write authority does not match the required policy; server admission refused.",
    })
  }
  return resolveAdmittedPerson({ authority, person })
}

export function resolveAdmittedPerson({ authority, person = null } = {}) {
  if (authority?.mode === "workspace" && authority.person == null && person === null) {
    return null
  }
  if (authority?.mode === "person" && (person === null || person === authority.person)) {
    try {
      validateWriteSegment(authority.person)
    } catch (error) {
      throw new ActivationFailure({
        phase: "VERIFYING",
        code: "authority_invalid",
        expected: { person: "non-empty single path segment" },
        observed: { authority, person, message: error.message },
        summary: "Admitted Desk person authority has no enforceable write identity.",
      })
    }
    return authority.person
  }
  throw new ActivationFailure({
    phase: "VERIFYING",
    code: "authority_invalid",
    expected: { authority: "workspace without --person, or person matching the admitted identity" },
    observed: { authority, person },
    summary: "Desk write authority is missing, invalid, or contradicts --person; server admission refused.",
  })
}

export async function verifyAdmissionAuthority({ person, policy, authorityProvider }) {
  if (policy?.authority_provider !== null && typeof authorityProvider !== "function") {
    throw new ActivationFailure({
      phase: "VERIFYING",
      code: "authority_invalid",
      expected: {
        authority_provider: policy.authority_provider,
      },
      observed: {
        authority_provider: policy.authority_provider,
        resolution: "missing",
      },
      summary: `Desk authority provider ${policy.authority_provider} is unavailable.`,
    })
  }
  if (typeof authorityProvider === "function") {
    return authorityProvider({ person, policy })
  }
  if (policy?.write_authority === "person") {
    if (typeof person !== "string" || person.trim().length === 0) {
      throw new ActivationFailure({
        phase: "VERIFYING",
        code: "authority_invalid",
        expected: { write_authority: "person" },
        observed: { person },
        summary: "Person-scoped Desk authority requires a person identity.",
      })
    }
    return Object.freeze({ mode: "person", person })
  }
  return Object.freeze({ mode: "workspace" })
}
