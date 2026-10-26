// Searches made before the session's search engine has started read the files directly.
import { directLexicalSearch } from "./direct-lexical.js"

const STARTING = "Desk search is still starting; try again in a few seconds."

const filesRouter = Object.freeze({
  async lexical(request) {
    if (request.kind === "thread") return { status: "error", code: "search_starting", message: STARTING }
    return directLexicalSearch(request)
  },
  async semantic(request) {
    if (request.kind === "similar") return { seed: request.path ?? null, results: [], note: STARTING }
    const result = await directLexicalSearch({ ...request, query: request.topic, scope: request.scope ?? "all" })
    return { topic: request.topic, results: result.results, search_mode: "exact_words", note: "Meaning-based search is getting ready, so these results match exact words." }
  },
  async reindex() {
    return { status: "error", code: "search_starting", message: STARTING }
  },
})

/** The search a tool call uses: the session's engine once admission has started it, else the files. */
export function searchRouter(engine) {
  return typeof engine?.lexical === "function" ? engine : filesRouter
}
