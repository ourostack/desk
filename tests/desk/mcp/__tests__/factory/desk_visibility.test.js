// The one rule for a desk's visibility: which GitHub repository a remote names, how long a cached answer lasts and whether the answer keeps job timing.

import { test } from "node:test"
import assert from "node:assert/strict"

import { VISIBILITY_TTL_MS, deskTimingKept, deskVisibilityOf, freshVisibility, githubRepoOfRemote, visibilityMap } from "../../../../../plugins/desk/mcp/src/factory/desk-visibility.js"

test("only an https GitHub remote names a repository, however it is spelled", () => {
  assert.equal(githubRepoOfRemote("https://github.com/Acme/Desk.git"), "acme/desk")
  assert.equal(githubRepoOfRemote("git@github.com:acme/desk.git"), "acme/desk")
  assert.equal(githubRepoOfRemote("https://gitlab.com/acme/desk.git"), null)
  assert.equal(githubRepoOfRemote("local:/some/desk"), null)
  assert.equal(githubRepoOfRemote(null), null)
})

test("a cached answer is fresh for seven days, and an entry that is not an entry is dropped", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z")
  const fresh = freshVisibility({
    "a/new": { visibility: "private", checked_at: "2026-09-18T12:00:00.000Z" },
    "a/old": { visibility: "private", checked_at: "2026-09-18T11:59:59.999Z" },
    "a/bad": { visibility: "private", checked_at: "yesterday" },
    "a/junk": "private",
  }, now)
  assert.deepEqual(Object.keys(fresh), ["a/new"])
  assert.equal(VISIBILITY_TTL_MS, 7 * 24 * 3600 * 1000)
})

test("a desk's visibility is its repository's cached answer, unknown when there is none; only private and internal keep timing", () => {
  const known = visibilityMap({ "Acme/Desk": { visibility: "private" } })
  assert.equal(deskVisibilityOf("acme/desk", known), "private")
  assert.equal(deskVisibilityOf("acme/other", known), "unknown")
  assert.equal(deskVisibilityOf(null, known), "unknown")
  assert.equal(deskVisibilityOf(undefined, known), "unknown")
  assert.deepEqual(["private", "internal", "public", "unknown", undefined].map(deskTimingKept), [true, true, false, false, false])
})
