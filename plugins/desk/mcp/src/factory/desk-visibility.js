// The one rule for a desk's visibility, shared by the publisher (`publish.js`), the flush (`flush.js`), the local cache reader (`outbox.js`) and
// `factory reconcile`, so none keeps a copy that can drift:
//   - `githubRepoOfRemote`: only an https GitHub remote (in any spelling `normalizeRemote` accepts) names a repository that has a visibility.
//   - `freshVisibility`: a cached answer lasts seven days; an older entry, one stamped more than `VISIBILITY_SKEW_MS` in the future (a clock
//     that ran fast when it was written would otherwise stretch its life), or one that is not shaped like an entry, is dropped.
//   - `deskVisibilityOf`: a desk's visibility is its repository's cached answer, or `unknown`.
//   - `deskTimingKept`: only a desk known to be `private` or `internal` keeps its job timing; every other answer withholds it.
// A caller that must not guess (reconcile makes no network call) checks `known.has(repo)` before asking.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { normalizeRemote } from "./binding.js"
import { isPlainObject } from "./schema.js"

/** How long a cached visibility answer is used before it is asked again. */
export const VISIBILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How far ahead of now a cached answer's `checked_at` may be before it is treated as stale (fail closed, ruling 2026-10-06). */
export const VISIBILITY_SKEW_MS = 5 * 60 * 1000

/** The visibilities that are not public: a desk with one keeps its job timing, and a store with one names every plugin. */
export const PRIVATE_VISIBILITIES = new Set(["private", "internal"])

const GITHUB_REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})$/u

/** `owner/name` of the GitHub repository a desk remote names, or `null` (no remote, or not GitHub). */
export const githubRepoOfRemote = (remote) => (remote === null ? null : GITHUB_REMOTE.exec(normalizeRemote(remote))?.[1] ?? null)

/** The entries of a visibility cache that are still fresh at `nowMs`. */
export function freshVisibility(cache, nowMs) {
  const fresh = {}
  for (const [key, entry] of Object.entries(cache)) {
    if (!isPlainObject(entry)) continue
    const age = nowMs - Date.parse(entry.checked_at)
    if (age <= VISIBILITY_TTL_MS && age >= -VISIBILITY_SKEW_MS) fresh[key] = entry
  }
  return fresh
}

/** `repo (lower case) -> visibility` for a cache's entries. */
export const visibilityMap = (cache) => new Map(Object.entries(cache).map(([repo, entry]) => [repo.toLowerCase(), entry.visibility]))

/** A desk's visibility: its repository's answer in `known`, `unknown` when there is none or the desk has no GitHub repository. */
export const deskVisibilityOf = (repo, known) => (repo ? known.get(repo.toLowerCase()) ?? "unknown" : "unknown")

/** Whether a desk with this visibility keeps its job timing (true only for `private` and `internal`). */
export const deskTimingKept = (visibility) => PRIVATE_VISIBILITIES.has(visibility)
