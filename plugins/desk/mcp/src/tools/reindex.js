import { createDeskQueryRouter } from "../readiness/query-router.js"

// Every field desk_reindex accepts off `input`: `force` is forwarded to the
// query router's `reindex()` (readiness/query-router.js) as part of the
// request object, which is a compatibility accept only — see the comment
// below. Kept next to this module so a field added here is checked against
// the tool's declared schema in tool-schemas.js by
// __tests__/tool_schema_parity.test.js.
export const DESK_REINDEX_FIELDS = ["force"]

// Compatibility request only: even force joins the controller's convergence.
// Deleting a live index would invalidate another process's generation and vectors.
export async function desk_reindex({ deskRoot, input, readiness, queryRouter, signal }) {
  return (queryRouter ?? createDeskQueryRouter({ controller: readiness })).reindex({
    ...input, deskRoot, signal,
  })
}
