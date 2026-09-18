import { ActivationFailure } from "./failures.js"

const ROOTS = new Set(["workspace"])
const WRITE_AUTHORITIES = new Set(["workspace", "person"])
const LEXICAL_POLICIES = new Set(["required"])
const SEMANTIC_POLICIES = new Set(["background", "required", "unsupported"])
const DEFAULT_POLICY = Object.freeze({
  root: "workspace",
  write_authority: "workspace",
  lexical: "required",
  semantic: "background",
  authority_provider: null,
})

export function normalizeReadinessPolicy(value = {}, context = {}) {
  if (!isObject(value)) {
    throw new ActivationFailure({
      phase: context.phase ?? "VERIFYING",
      code: "activation_policy_invalid",
      expected: {
        desk_runtime: "object",
      },
      observed: {
        desk_runtime: value,
      },
      automaticActions: context.automaticActions ?? [],
      summary: "Desk readiness policy must be an object.",
      diagnostics: [
        {
          path: context.path ?? "desk_runtime",
          code: "activation_policy_invalid",
          message: "desk_runtime must be an object",
        },
      ],
    })
  }

  const policy = {
    root: value.root ?? DEFAULT_POLICY.root,
    write_authority: value.write_authority ?? DEFAULT_POLICY.write_authority,
    lexical: value.lexical ?? DEFAULT_POLICY.lexical,
    semantic: value.semantic ?? DEFAULT_POLICY.semantic,
    authority_provider: value.authority_provider ?? DEFAULT_POLICY.authority_provider,
  }

  const diagnostics = []
  validateEnum(policy.root, ROOTS, `${context.path ?? "desk_runtime"}.root`, "root", diagnostics)
  validateEnum(policy.write_authority, WRITE_AUTHORITIES, `${context.path ?? "desk_runtime"}.write_authority`, "write_authority", diagnostics)
  validateEnum(policy.lexical, LEXICAL_POLICIES, `${context.path ?? "desk_runtime"}.lexical`, "lexical", diagnostics)
  validateEnum(policy.semantic, SEMANTIC_POLICIES, `${context.path ?? "desk_runtime"}.semantic`, "semantic", diagnostics)
  if (policy.authority_provider !== null && !hasText(policy.authority_provider)) {
    diagnostics.push({
      path: `${context.path ?? "desk_runtime"}.authority_provider`,
      code: "activation_policy_invalid",
      message: "Desk readiness policy authority_provider must be null or non-empty text.",
    })
  }

  if (diagnostics.length > 0) {
    throw new ActivationFailure({
      phase: context.phase ?? "VERIFYING",
      code: "activation_policy_invalid",
      expected: {
        root: [...ROOTS],
        write_authority: [...WRITE_AUTHORITIES],
        lexical: [...LEXICAL_POLICIES],
        semantic: [...SEMANTIC_POLICIES],
        authority_provider: "null-or-text",
      },
      observed: {
        root: policy.root,
        write_authority: policy.write_authority,
        lexical: policy.lexical,
        semantic: policy.semantic,
        authority_provider: policy.authority_provider,
      },
      automaticActions: context.automaticActions ?? [],
      summary: diagnostics.map((diagnostic) => diagnostic.message).join(" "),
      diagnostics,
    })
  }

  return Object.freeze(policy)
}

function validateEnum(value, allowed, path, field, diagnostics) {
  if (!allowed.has(value)) {
    diagnostics.push({
      path,
      code: "activation_policy_invalid",
      message: `Desk readiness policy ${field} must be one of: ${[...allowed].join(", ")}.`,
    })
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0
}
