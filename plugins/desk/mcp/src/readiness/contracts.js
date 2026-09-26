// The contracts a readiness controller is identified by. Sessions on one root elect one controller only when these match.
// Dependency-free, so the session can derive a root's controller identity before the runtime pack is restored.

export function readinessContracts(policy) {
  return {
    protocolVersion: 1,
    lexicalContract: {
      schema: 1,
      chunker: "markdown-v1",
      normalization: "unicode-v1",
      policy: {
        lexical: policy.lexical,
      },
    },
  }
}
