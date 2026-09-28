// The active-task listing desk_status serves as `active_tasks`: non-terminal tasks,
// grouped by track, with every name that carries a secret's value redacted.
//
// Regression (M4-7-F4, 2026-09-27): the hand-rolled session-start scan quoted
// the user and password two task folder names carried.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { folderHandle, isHandle } from "../../../../../plugins/desk/mcp/src/desk/handles.js"
const PASSWORD_FOLDER = "setup-root-pw-hunter-two"

function card(root, rel, frontmatter) {
  const dir = path.join(root, rel)
  mkdirSync(dir, { recursive: true })
  if (frontmatter !== null) writeFileSync(path.join(dir, "task.md"), `---\n${frontmatter}\n---\nbody\n`)
}

function desk() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-active-tasks-")))
  card(root, "desk-plugin/book-flights", "title: Book flights\nstatus: implementing\nupdated: \"2026-09-20T00:00:00Z\"\nrepos:\n  - name: OrderService\n    local_path: ~/code/set pw hunter2/OrderService\n    mode: local\n    pr: 12\n  - just-a-string\n  - name: 7")
  card(root, "desk-plugin/older-work", "title: Older\nstatus: drafting\nupdated: 2026-09-01T00:00:00Z")
  card(root, `desk-plugin/${PASSWORD_FOLDER}`, "title: Set up root pw hunter2\nstatus: blocked\nupdated: \"2026-09-25T00:00:00Z\"")
  card(root, "desk-plugin/finished-work", "title: Done\nstatus: done")
  card(root, "desk-plugin/_archive/archived-work", "title: Archived\nstatus: drafting")
  card(root, "desk-plugin/no-card-here", null)
  card(root, "desk-plugin/bad-frontmatter", "title: A\ntitle: B")
  card(root, "0123456789abcdef01234/some-task", "status: 7")
  card(root, "_meta/not-a-task", "status: drafting")
  card(root, "desks/alex/infra/rotate-api-token", "title: Rotate the API token\nstatus: validating\nupdated: \"2026-09-26T00:00:00Z\"")
  card(root, `desks/${PASSWORD_FOLDER}/infra/some-task`, "title: T\nstatus: drafting")
  mkdirSync(path.join(root, "desks", "alex", "empty-track"), { recursive: true })
  return root
}

test("activeTasks lists non-terminal tasks by track and redacts credential-like names and titles", () => {
  const root = desk()
  const listing = activeTasks(root)
  const json = JSON.stringify(listing)
  assert.doesNotMatch(json, /hunter/)
  assert.deepEqual(listing.redacted, { names: 3, titles: 1 })
  assert.equal(listing.track_count, 4)
  assert.equal(listing.task_count, 7)
  assert.deepEqual(listing.tracks.map((track) => [track.desk ?? null, track.track]), [
    ["alex", "infra"],
    [null, "desk-plugin"],
    [null, "<redacted segment>"],
    ["<redacted segment>", "infra"],
  ])
  const plugin = listing.tracks[1]
  assert.deepEqual(plugin.tasks.map((task) => task.slug), ["<redacted segment>", "book-flights", "older-work", "bad-frontmatter"])
  assert.equal(plugin.tasks[0].title, "<redacted title>")
  assert.equal(plugin.tasks[2].updated, "2026-09-01T00:00:00.000Z", "an unquoted timestamp is shown as ISO text")
  const handleOf = (rel) => folderHandle("task", root, path.join(root, rel))
  assert.deepEqual(plugin.tasks[3], { slug: "bad-frontmatter", handle: handleOf("desk-plugin/bad-frontmatter"), title: null, status: null, updated: null, repos: [] })
  assert.deepEqual(plugin.tasks[1].repos, [{ name: "OrderService", local_path: "~/code/<redacted segment>/OrderService", mode: "local" }, {}], "repos keep name, local_path and mode, redacted, and skip entries that are not objects")
  assert.deepEqual(listing.tracks[0].tasks[0], { desk: "alex", slug: "rotate-api-token", handle: handleOf("desks/alex/infra/rotate-api-token"), title: "Rotate the API token", status: "validating", updated: "2026-09-26T00:00:00Z", repos: [] })
  assert.equal(plugin.tasks[0].handle, handleOf(`desk-plugin/${PASSWORD_FOLDER}`), "a redacted task still has its own handle")
  assert.notEqual(plugin.tasks[0].handle, plugin.tasks[1].handle)
  assert.equal(listing.tracks[1].handle, folderHandle("track", root, path.join(root, "desk-plugin")))
  for (const track of listing.tracks) {
    assert.ok(isHandle("track", track.handle))
    for (const task of track.tasks) assert.ok(isHandle("task", task.handle))
  }
  assert.equal(listing.tracks[2].tasks[0].status, null, "a non-text status is not shown")
})

test("activeTasks on a missing folder lists nothing", () => {
  assert.deepEqual(activeTasks(path.join(tmpdir(), "desk-active-tasks-missing-root")), {
    tracks: [], task_count: 0, track_count: 0, redacted: { names: 0, titles: 0 },
  })
})
