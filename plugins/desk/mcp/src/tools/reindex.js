import { createDeskQueryRouter } from "../readiness/query-router.js"

// Compatibility request only: even force joins the controller's convergence.
// Deleting a live index would invalidate another process's generation and vectors.
export async function desk_reindex({ deskRoot, input, readiness, queryRouter, signal }) {
  return (queryRouter ?? createDeskQueryRouter({ controller: readiness })).reindex({
    ...input, deskRoot, signal,
  })
}
