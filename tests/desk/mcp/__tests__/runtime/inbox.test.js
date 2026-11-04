// Teammate notes on disk: the note file note_leave writes, how it is read back, and the open notes session start lists.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { INBOX, NOTES_SHOWN_CAP, acknowledgeNote, openNotes, parseNote, renderNote } from "../../../../../plugins/desk/mcp/src/runtime/inbox.js"

const note = (extra = {}) => ({ from: "ari", to: "saranya", created: "2026-10-30T13:00:00-07:00", subject: "The tracker is being extended", related: ["https://example.com/plan", "_shared/tracks/customer-engagement/track.md"], body: "Here's my understanding of what Ari was thinking.\n\nSecond paragraph.", ...extra })

test("renderNote writes the frontmatter, the sender's text, the links and who to ask, and parseNote reads it back", () => {
  const text = renderNote(note())
  assert.equal(text, [
    "---",
    "from: \"ari\"",
    "to: \"saranya\"",
    "created: \"2026-10-30T13:00:00-07:00\"",
    "status: open",
    "subject: \"The tracker is being extended\"",
    "related:",
    "  - \"https://example.com/plan\"",
    "  - \"_shared/tracks/customer-engagement/track.md\"",
    "---",
    "",
    "Here's my understanding of what Ari was thinking.",
    "",
    "Second paragraph.",
    "",
    "Related:",
    "",
    "- https://example.com/plan",
    "- _shared/tracks/customer-engagement/track.md",
    "",
    "ari left this note with note_leave. Ask ari if anything here is unclear.",
    "",
  ].join("\n"))
  const parsed = parseNote(text)
  assert.deepEqual({ ...parsed, content: undefined }, { from: "ari", to: "saranya", created: "2026-10-30T13:00:00-07:00", status: "open", subject: "The tracker is being extended", related: ["https://example.com/plan", "_shared/tracks/customer-engagement/track.md"], content: undefined })
  assert.match(parsed.content, /^\nHere's my understanding/u)
  const bare = renderNote(note({ related: [], subject: "Quote \" and: colon" }))
  assert.match(bare, /\nrelated: \[\]\n/u)
  assert.equal(bare.includes("Related:"), false)
  assert.deepEqual([parseNote(bare).subject, parseNote(bare).related], ["Quote \" and: colon", []])
})

test("parseNote reads hand-edited notes leniently and refuses text with no frontmatter", () => {
  assert.equal(parseNote("no frontmatter\n"), null)
  assert.equal(parseNote("---\nfrom: ari\n"), null)
  const odd = parseNote("---\r\nfrom: ari\r\nsubject: \"broken \\q\"\r\n# a comment\r\ntags:\r\n  - x\r\nstatus: open\r\n---")
  assert.deepEqual({ ...odd }, { from: "ari", subject: "\"broken \\q\"", tags: "", status: "open", related: [], content: "" })
})

test("acknowledgeNote marks an open note acknowledged with the time, once, and refuses what is not a note", () => {
  const open = renderNote(note())
  const done = acknowledgeNote(open, "2026-10-31T09:00:00-07:00")
  assert.match(done, /\nstatus: acknowledged\nacknowledged: "2026-10-31T09:00:00-07:00"\nsubject: /u)
  assert.equal(parseNote(done).status, "acknowledged")
  assert.equal(done.split("---")[2], open.split("---")[2], "the text below the frontmatter is unchanged")
  assert.equal(acknowledgeNote(done, "2026-11-01T00:00:00Z"), null)
  assert.equal(acknowledgeNote("no frontmatter", "2026-11-01T00:00:00Z"), null)
  const crlf = acknowledgeNote(open.replace(/\n/gu, "\r\n"), "2026-10-31T09:00:00-07:00")
  assert.match(crlf, /\r\nstatus: acknowledged\r\nacknowledged: "2026-10-31T09:00:00-07:00"\r\n/u)
})

test("openNotes lists the open notes in a person's inbox, oldest first, within a cap that counts the rest", async () => {
  const root = await mkTempRoot("desk-inbox-")
  assert.equal(openNotes(root, "desks/saranya"), null, "no inbox")
  const inbox = path.join(root, "desks", "saranya", INBOX)
  await fs.mkdir(inbox, { recursive: true })
  assert.equal(openNotes(root, "desks/saranya"), null, "an empty inbox")
  await fs.writeFile(path.join(inbox, "2026-10-30-ari-late-aaaaaa.md"), renderNote(note({ subject: "Late", created: "2026-10-30T13:00:00-07:00" })))
  await fs.writeFile(path.join(inbox, "2026-10-30-bo-early-bbbbbb.md"), renderNote(note({ from: "bo", subject: "Early", created: "2026-10-30T19:00:00+00:00" })))
  await fs.writeFile(path.join(inbox, "2026-10-29-ari-seen-cccccc.md"), acknowledgeNote(renderNote(note({ subject: "Seen" })), "2026-10-30T00:00:00Z"))
  await fs.writeFile(path.join(inbox, "README.txt"), "not a note")
  await fs.writeFile(path.join(inbox, "hand-written.md"), "no frontmatter\n")
  await fs.mkdir(path.join(inbox, "folder.md"))
  await fs.writeFile(path.join(inbox, "2026-10-28-ari-undated-dddddd.md"), renderNote(note({ subject: "  Spread\tout  ", created: "sometime" })))
  await fs.writeFile(path.join(inbox, "2026-10-28-bo-undated-eeeeee.md"), renderNote(note({ from: "bo", subject: "Also undated", created: "" })))
  const found = openNotes(root, "desks/saranya")
  assert.deepEqual(found, {
    path: "desks/saranya/_inbox",
    count: 4,
    more: 0,
    notes: [
      { from: "bo", created: "2026-10-30T19:00:00+00:00", subject: "Early", path: "desks/saranya/_inbox/2026-10-30-bo-early-bbbbbb.md" },
      { from: "ari", created: "2026-10-30T13:00:00-07:00", subject: "Late", path: "desks/saranya/_inbox/2026-10-30-ari-late-aaaaaa.md" },
      { from: "ari", created: "sometime", subject: "Spread out", path: "desks/saranya/_inbox/2026-10-28-ari-undated-dddddd.md" },
      { from: "bo", created: "unknown", subject: "Also undated", path: "desks/saranya/_inbox/2026-10-28-bo-undated-eeeeee.md" },
    ],
  })
  for (let index = 0; index < NOTES_SHOWN_CAP + 2; index += 1) {
    await fs.writeFile(path.join(inbox, `2026-10-01-ari-n${index}-eeeeee.md`), renderNote(note({ subject: `N${index} ${"long ".repeat(40)}`, created: `2026-10-01T00:00:0${index}Z` })))
  }
  const many = openNotes(root, "desks/saranya")
  assert.deepEqual([many.count, many.notes.length, many.more], [NOTES_SHOWN_CAP + 6, NOTES_SHOWN_CAP, 6])
  assert.equal(many.notes[0].subject.length, 120)
  assert.match(many.notes[0].subject, /^N0 long long/u)
  // A note missing its sender or subject still shows, with a placeholder.
  await fs.rm(inbox, { recursive: true })
  await fs.mkdir(inbox)
  await fs.writeFile(path.join(inbox, "x.md"), "---\nstatus: open\n---\n")
  assert.deepEqual(openNotes(root, "desks/saranya").notes, [{ from: "unknown", created: "unknown", subject: "(no subject)", path: "desks/saranya/_inbox/x.md" }])
})
