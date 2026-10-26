import { searchRouter } from "../search/files-router.js"

// Every field desk_reindex accepts off `input`. `force` is accepted for older callers and changes nothing: a reindex
// always re-reads the desk into this session's search engine. Kept next to this module so a field added here is checked
// against the tool's declared schema in tool-schemas.js by __tests__/tool_schema_parity.test.js.
export const DESK_REINDEX_FIELDS = ["force"]

export async function desk_reindex({ deskRoot, input, search, queryRouter, signal }) {
  return (queryRouter ?? searchRouter(search)).reindex({
    ...input, deskRoot, signal,
  })
}
