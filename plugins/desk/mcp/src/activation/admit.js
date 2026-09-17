import { ActivationFailure } from "./failures.js"

export async function admitControlPlane({
  deskRoot,
  person = null,
  policy,
  runtime,
  authorityProvider,
  controllerConnector,
  verifyRuntime = async () => runtime ?? { state: "ready" },
  verifyAuthority = defaultVerifyAuthority,
  connectController = controllerConnector,
} = {}) {
  if (typeof connectController !== "function") {
    throw new ActivationFailure({
      phase: "VERIFYING",
      code: "controller_start_failed",
      observed: { connector: "missing" },
      summary: "The readiness controller connector is unavailable.",
    })
  }
  const verifiedRuntime = await verifyRuntime({ deskRoot, policy })
  const authority = await verifyAuthority({
    deskRoot,
    person,
    policy,
    authorityProvider,
  })
  const controller = await connectController({ deskRoot, policy })
  if (!controller?.accepted) {
    throw new ActivationFailure({
      phase: "VERIFYING",
      code: "controller_start_failed",
      observed: controller ?? null,
      summary: "The readiness controller could not accept ownership.",
    })
  }
  return Object.freeze({
    state: "CONTROL_READY",
    root: deskRoot,
    authority,
    runtime: verifiedRuntime,
    controller,
    automatic_actions: [],
  })
}

async function defaultVerifyAuthority({ person, policy, authorityProvider }) {
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
