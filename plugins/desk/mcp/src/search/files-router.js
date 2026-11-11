// Searches made before the session's search engine has started read the files directly.
import { directLexicalSearch } from "./direct-lexical.js"

const STARTING = "Desk search is still starting; try again in a few seconds."

const filesRouter = Object.freeze({
  async lexical(request) {
    return directLexicalSearch(request)
  },
  async semantic(request) {
    const result = await directLexicalSearch({ ...request, query: request.topic, scope: request.scope ?? "all" })
    return { topic: request.topic, results: result.results, search_mode: "exact_words", note: "Meaning-based search is getting ready, so these results match exact words." }
  },
  async reindex() {
    return { status: "error", code: "search_starting", message: STARTING }
  },
})

/** The engine owns classified index recovery; before admission, searches read files directly. */
export function searchRouter(engine) {
  return typeof engine?.lexical === "function" ? engine : filesRouter
}
