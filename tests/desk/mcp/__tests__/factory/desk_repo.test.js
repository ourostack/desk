// The real binding readers — task-card frontmatter and desk Git history —
// against a temporary Git repository built here. No real desk is read.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createDeskReaders, parseCardRenames, readDeskRemote, resolveJobIdentity } from "../../../../../plugins/desk/mcp/src/factory/desk-repo.js"
import { bindSession, jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"

let scratch
let desk
let other
let origin
let shas

const card = (fields, body = "# A task") => `---\n${fields.join("\n")}\n---\n\n${body}\n`
const LIVE_CARD = ["title: A live task", "status: processing", "created: \"2026-09-20T10:00:00Z\"", "updated: '2026-09-25T09:00:00Z'"]

// A card whose body is unique to `label`, so Git's content-based rename
// detection never pairs it with an unrelated fixture by accident (see the
// resolveJobIdentity fixtures below and in `before`).
const fixtureCard = (label, status, extra = []) => card([`status: ${status}`, ...extra], `# ${label}\n\nUnique fixture content for ${label}, never reused elsewhere.`)

// Runs Git in `repo`; `at` stamps the commit and every reflog entry it makes.
function gitIn(repo, args, at) {
  const dates = at === undefined ? {} : { GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at }
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...dates },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const git = (args, at) => gitIn(desk, args, at)

function writeIn(repo, relative, text) {
  const target = path.join(repo, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
}
const write = (relative, text) => writeIn(desk, relative, text)

function removeIn(repo, relative) {
  rmSync(path.join(repo, relative), { force: true })
}
const remove = (relative) => removeIn(desk, relative)

function commitIn(repo, at, message, extra = []) {
  gitIn(repo, ["add", "-A"])
  gitIn(repo, ["commit", "-q", "-m", message, ...extra], at)
  return gitIn(repo, ["rev-parse", "HEAD"])
}
const commitAt = (at, message, extra) => commitIn(desk, at, message, extra)

before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "desk-repo-"))
  origin = path.join(scratch, "origin.git")
  desk = path.join(scratch, "desk")
  other = path.join(scratch, "other")
  mkdirSync(desk)
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  git(["init", "-q", "-b", "main"])
  git(["remote", "add", "origin", origin])
  shas = {}

  // The initial commit: a `commit (initial)` entry.
  write("track/live-task/task.md", card(LIVE_CARD))
  shas.first = commitAt("2026-09-25T08:00:00Z", "first")

  // old-task also gets a real, non-card file in this same commit, so it
  // keeps end-to-end coverage through the real readers regardless of what
  // its card's own diff classifies as (Finding 2): a task with only a
  // freshly-added card is not the interesting case for the housekeeping
  // rule (a first add is real content, not identity/placement), so a
  // dedicated housekeeping-only edit to this same card is added below.
  write("track/_archive/old-task/task.md", card(["status: done # finished", "created: 2026-09-01T00:00:00Z", "updated: 2026-09-02T12:30:00+02:00"]))
  write("track/_archive/old-task/notes.md", "notes\n")
  write("track/live-task/notes with space.md", "notes\n")
  shas.second = commitAt("2026-09-25T08:20:01Z", "second")
  git(["push", "-q", "origin", "main"], "2026-09-25T08:20:02Z")

  // Another clone commits and pushes; this clone fetches and fast-forwards.
  gitIn(scratch, ["clone", "-q", origin, other], "2026-09-25T08:25:00Z")
  writeIn(other, "track/fetched-task/task.md", card(["status: blocked"]))
  shas.fetched = commitIn(other, "2026-09-25T08:40:00Z", "fetched")
  gitIn(other, ["push", "-q", "origin", "main"], "2026-09-25T08:40:01Z")
  git(["pull", "-q", "--ff-only", "origin", "main"], "2026-09-25T08:45:00Z")

  // A housekeeping-only edit to an already-existing archived card: only its
  // `updated:` field changes (the body and every other field stay the
  // same), so this commit's only change to old-task must not bind it
  // (Finding 2 / the desk_commit housekeeping rule).
  write("track/_archive/old-task/task.md", card(["status: done # finished", "created: 2026-09-01T00:00:00Z", "updated: 2026-09-05T12:30:00+02:00"]))
  shas.oldTaskHousekeeping = commitAt("2026-09-25T08:50:00Z", "touch old-task's updated field")

  // Fixtures for isCardHousekeeping's other branches.
  write("track/edit-cases-task/task.md", card(["status: drafting"]))
  write("track/edit-cases-task/notes.md", "notes\n")
  shas.editCasesCreated = commitAt("2026-09-25T08:51:00Z", "edit-cases: create")

  // A body-only change: the frontmatter is untouched, only the body
  // differs. Real content (a progress note), never housekeeping.
  write("track/edit-cases-task/task.md", card(["status: drafting"], "# A task\n\n- did the thing"))
  shas.editCasesBody = commitAt("2026-09-25T08:52:00Z", "edit-cases: body")

  // A status-only change: frontmatter differs, but not a housekeeping
  // field. Real content, never housekeeping.
  write("track/edit-cases-task/task.md", card(["status: done"], "# A task\n\n- did the thing"))
  shas.editCasesStatus = commitAt("2026-09-25T08:53:00Z", "edit-cases: status")

  // The card alone is deleted, nothing else in the folder changes: a pure
  // delete has no new version to compare, so it is never housekeeping.
  remove("track/edit-cases-task/task.md")
  shas.editCasesDeleted = commitAt("2026-09-25T08:54:00Z", "edit-cases: delete card")

  // A card moved with byte-identical content (an archive move): Git's own
  // rename detection pairs the old and new paths, and the content compares
  // equal, so this is housekeeping on both sides of the move.
  write("track/movable-task/task.md", card(["status: drafting"]))
  write("track/movable-task/notes.md", "notes\n")
  shas.movableCreated = commitAt("2026-09-25T08:55:00Z", "movable: create")
  remove("track/movable-task/task.md")
  write("track/_archive/movable-task/task.md", card(["status: drafting"]))
  shas.movableArchived = commitAt("2026-09-25T08:56:00Z", "movable: archive move")

  // A card with no frontmatter at all, on both sides of an edit: splitCard
  // must not mistake this for a housekeeping-eligible card.
  write("track/no-frontmatter-edit/task.md", "# Just a heading\nstatus: drafting\n")
  shas.noFrontmatterCreated = commitAt("2026-09-25T08:57:00Z", "no-frontmatter: create")
  write("track/no-frontmatter-edit/task.md", "# Just a heading\nstatus: done\n")
  shas.noFrontmatterEdited = commitAt("2026-09-25T08:57:30Z", "no-frontmatter: edit")

  // A card whose frontmatter opens with `---` but is never closed, on both
  // sides of an edit: splitCard's other early return.
  write("track/unclosed-frontmatter-edit/task.md", "---\nstatus: drafting\n")
  shas.unclosedCreated = commitAt("2026-09-25T08:58:00Z", "unclosed: create")
  write("track/unclosed-frontmatter-edit/task.md", "---\nstatus: done\n")
  shas.unclosedEdited = commitAt("2026-09-25T08:58:30Z", "unclosed: edit")

  // --- Fixtures for the tidy-rewrite extensions to isCardHousekeeping
  // (ourostack/desk#75 follow-up): quote-only frontmatter rewrites and
  // same-commit rename substitutions. ---

  // A quote-only rewrite: every frontmatter scalar's value is the same once
  // its surrounding quotes are normalized — double to single, or dropped
  // entirely — including inside a list item, and the body is untouched.
  // This is what a real move/rename tool's own YAML re-serialization does.
  // The folded `note: |` continuation line is neither a `key: value` scalar
  // nor a `- value` list item, and is unchanged either side: it exercises
  // normalizeQuotingLine's plain pass-through for a frontmatter line that
  // matches neither shape.
  write("quote-only-task/task.md", card(["status: drafting", "created: \"2026-09-17T21:22:00Z\"", "requester: \"ari\"", "note: |", "  plain continuation line without a colon or dash"]))
  shas.quoteOnlyCreated = commitAt("2026-09-25T09:10:00Z", "quote-only: create")
  write("quote-only-task/task.md", card(["status: drafting", "created: '2026-09-17T21:22:00Z'", "requester: ari", "note: |", "  plain continuation line without a colon or dash"]))
  shas.quoteOnlyEdited = commitAt("2026-09-25T09:10:10Z", "quote-only: normalize quoting")

  write("quote-list-task/task.md", card(["status: drafting", "repos:", "  - \"./presentation/script.md\"", "  - \"./notes.md\""]))
  shas.quoteListCreated = commitAt("2026-09-25T09:10:20Z", "quote-list: create")
  write("quote-list-task/task.md", card(["status: drafting", "repos:", "  - ./presentation/script.md", "  - ./notes.md"]))
  shas.quoteListEdited = commitAt("2026-09-25T09:10:30Z", "quote-list: normalize list-item quoting")

  // A same-commit rename this card only references: the tidy commit renames
  // ref-rewrite-source/doc.md (unrelated to any card) and, in the same
  // commit, rewrites this card's body reference to it — nothing else
  // changes. The rename pair alone explains the whole diff.
  write("ref-rewrite-source/doc.md", "shared doc content\n")
  write("ref-rewrite-card/task.md", card(["status: drafting"], "# A task\n\nSee ref-rewrite-source/doc.md for details."))
  shas.refRewriteCreated = commitAt("2026-09-25T09:11:00Z", "ref-rewrite: create")
  remove("ref-rewrite-source/doc.md")
  write("ref-rewrite-source/renamed-doc.md", "shared doc content\n")
  write("ref-rewrite-card/task.md", card(["status: drafting"], "# A task\n\nSee ref-rewrite-source/renamed-doc.md for details."))
  shas.refRewriteEdited = commitAt("2026-09-25T09:11:10Z", "ref-rewrite: rename doc.md and update the reference")

  // A directory rename derived from one file's own rename pair: the tidy
  // commit renames dir-group/dir-rename-source-2026/task.md ->
  // dir-group/dir-rename-source/task.md (a task folder drops its year
  // suffix, nested under a parent both sides keep) and, in the same commit,
  // rewrites a different card's reference to another file under the old
  // directory — a file this commit never touches directly. Nested under
  // dir-group on purpose: directorySubstitution only derives a pair that
  // keeps at least two segments on each side, so a bare, single-segment
  // directory rename never widens into one (see the rename-cap-adjacent
  // "solo rename leaves unrelated prose alone" test below).
  write("dir-group/dir-rename-source-2026/task.md", card(["status: drafting"], "# A task\n\nfolder being renamed"))
  write("dir-ref-card/task.md", card(["status: drafting"], "# A task\n\nSee dir-group/dir-rename-source-2026/notes.md for background."))
  shas.dirRefCreated = commitAt("2026-09-25T09:12:00Z", "dir-ref: create")
  remove("dir-group/dir-rename-source-2026/task.md")
  write("dir-group/dir-rename-source/task.md", card(["status: drafting"], "# A task\n\nfolder being renamed"))
  write("dir-ref-card/task.md", card(["status: drafting"], "# A task\n\nSee dir-group/dir-rename-source/notes.md for background."))
  shas.dirRefEdited = commitAt("2026-09-25T09:12:10Z", "dir-ref: rename the folder and update the reference")

  // A reference written with a leading, non-repo-relative prefix (a real
  // desk's own convention for a path on another machine): the
  // substitution's boundary check accepts any character before the match
  // that cannot continue a path segment, `~` and `/` included, so the
  // prefix survives.
  write("prefixed-source/doc.md", "shared doc content\n")
  write("prefixed-ref-card/task.md", card(["status: drafting"], "# A task\n\nSee ~/desk/prefixed-source/doc.md for details."))
  shas.prefixedRefCreated = commitAt("2026-09-25T09:13:00Z", "prefixed-ref: create")
  remove("prefixed-source/doc.md")
  write("prefixed-source/renamed/doc.md", "shared doc content\n")
  write("prefixed-ref-card/task.md", card(["status: drafting"], "# A task\n\nSee ~/desk/prefixed-source/renamed/doc.md for details."))
  shas.prefixedRefEdited = commitAt("2026-09-25T09:13:10Z", "prefixed-ref: rename doc.md and update the prefixed reference")

  // A rename whose derived directory substitution must not cross a path
  // boundary: boundary-group/boundary-source/task.md renames to
  // boundary-group/boundary-target/task.md (a nested folder rename, so
  // directorySubstitution derives boundary-group/boundary-source ->
  // boundary-group/boundary-target), but this card's own reference is to
  // the unrelated boundary-group/boundary-source-extra folder, a longer
  // name that merely starts with the same text. The reference changes by
  // hand in the same commit; the substitution must not paper over it, so
  // this still binds.
  write("boundary-group/boundary-source/task.md", card(["status: drafting"], "# A task\n\nfolder being renamed"))
  write("boundary-group/boundary-source-extra/notes.md", "notes\n")
  write("boundary-ref-card/task.md", card(["status: drafting"], "# A task\n\nSee boundary-group/boundary-source-extra/notes.md for background."))
  shas.boundaryCreated = commitAt("2026-09-25T09:14:00Z", "boundary: create")
  remove("boundary-group/boundary-source/task.md")
  write("boundary-group/boundary-target/task.md", card(["status: drafting"], "# A task\n\nfolder being renamed"))
  write("boundary-ref-card/task.md", card(["status: drafting"], "# A task\n\nSee boundary-group/boundary-target-extra/notes.md for background."))
  shas.boundaryEdited = commitAt("2026-09-25T09:14:10Z", "boundary: rename the folder and hand-edit the unrelated reference")

  // A whole-track rename (a bare, single-segment old and new path) must not
  // widen into a directory-level substitution at all: solo-name/task.md
  // renames to solo-renamed/task.md, and an entirely unrelated card gets
  // only a genuine housekeeping touch of its own (a bare title: line added)
  // in the same commit, while its body merely happens to mention
  // "solo-name" as plain prose, not as a path. If a bare solo-name ->
  // solo-renamed substitution were derived and applied globally, it would
  // corrupt this unrelated, unchanged prose and make the card look edited
  // beyond its own real (housekeeping) change. Real same-commit evidence
  // (ourostack desk history) showed exactly this: a track renamed after a
  // person corrupted an unrelated card's own mention of that person's
  // username in a filesystem path, and a track's bare old name corrupted
  // another card's own title and heading that happened to read the same as
  // that name.
  write("solo-name/task.md", card(["status: drafting"], "# A task\n\nfolder being renamed"))
  write("solo-prose-card/task.md", card(["status: drafting"], "# A task\n\nMentions solo-name in passing, not as a path reference."))
  shas.soloRenameCreated = commitAt("2026-09-25T09:14:20Z", "solo-rename: create")
  remove("solo-name/task.md")
  write("solo-renamed/task.md", card(["status: drafting"], "# A task\n\nfolder being renamed"))
  write("solo-prose-card/task.md", card(["title: Solo prose card", "status: drafting"], "# A task\n\nMentions solo-name in passing, not as a path reference."))
  shas.soloRenameEdited = commitAt("2026-09-25T09:14:30Z", "solo-rename: rename the track and add a title to the unrelated card")

  // A real edit riding along with a reference rewrite the commit's own
  // rename explains: mixed-source/doc.md renames to
  // mixed-source/renamed.md, and mixed-edit-card's reference is rewritten
  // to match, but its body also gains a genuine new line the rename does
  // not explain, and its status changes too — real content, so this binds.
  write("mixed-source/doc.md", "shared doc content\n")
  write("mixed-edit-card/task.md", card(["status: drafting"], "# A task\n\nSee mixed-source/doc.md for details."))
  shas.mixedEditCreated = commitAt("2026-09-25T09:15:00Z", "mixed-edit: create")
  remove("mixed-source/doc.md")
  write("mixed-source/renamed.md", "shared doc content\n")
  write("mixed-edit-card/task.md", card(["status: done"], "# A task\n\nSee mixed-source/renamed.md for details.\n\n- also did real work"))
  shas.mixedEditEdited = commitAt("2026-09-25T09:15:10Z", "mixed-edit: rename doc.md, update the reference, and do real work")

  // A quoted value that itself contains a backslash: never normalized, so a
  // difference here is compared literally and binds, even though it looks
  // like the same quote-only rewrite pattern.
  write("escaped-quote-task/task.md", card(["status: drafting", "note: \"a\\backslash\""]))
  shas.escapedQuoteCreated = commitAt("2026-09-25T09:16:00Z", "escaped-quote: create")
  write("escaped-quote-task/task.md", card(["status: drafting", "note: 'a\\backslash'"]))
  shas.escapedQuoteEdited = commitAt("2026-09-25T09:16:10Z", "escaped-quote: change the quoted value's quoting")

  // A surgical writer only ever rewrites the fields it means to change
  // (track/updated/status/…) and leaves every other line's bytes alone, so
  // these next fixtures exist to prove the *judge's* fallback for commits
  // already made under the old full-YAML-redump writer: a date-only value
  // re-encoded as its own UTC midnight timestamp, and a folded/literal
  // block scalar re-encoded as (or from) the single line with the same
  // text, both count as the same value, while a handful of near-miss shapes
  // stay real differences (fail-safe).

  // `created:` written as a bare date, then re-serialized to that date's own
  // midnight timestamp — exactly what the old writer did to a field it
  // never meant to touch, incidentally, while doing a real `track:` move.
  write("date-equiv-task/task.md", card(["track: track-one", "status: drafting", "created: 2026-05-26"], "# A task\n\ndate-equiv body, unchanged either side."))
  shas.dateEquivCreated = commitAt("2026-09-25T09:17:20Z", "date-equiv: create")
  write("date-equiv-task/task.md", card(["track: track-two", "status: drafting", "created: 2026-05-26T00:00:00.000Z", "updated: '2026-09-25T09:17:30Z'"], "# A task\n\ndate-equiv body, unchanged either side."))
  shas.dateEquivEdited = commitAt("2026-09-25T09:17:30Z", "date-equiv: move the track (old writer reformats created too)")

  // A date-only value paired with a non-midnight timestamp is a real
  // difference, not the known artifact: this must still bind.
  write("date-mismatch-task/task.md", card(["track: track-one", "status: drafting", "created: 2026-05-26"]))
  shas.dateMismatchCreated = commitAt("2026-09-25T09:17:40Z", "date-mismatch: create")
  write("date-mismatch-task/task.md", card(["track: track-two", "status: drafting", "created: 2026-05-26T09:30:00.000Z"]))
  shas.dateMismatchEdited = commitAt("2026-09-25T09:17:50Z", "date-mismatch: move the track and actually change created's time")

  // A full (non-midnight) timestamp gaining a redundant `.000` with no
  // other change — real evidence from personal-desk commit 207c6dd2, where
  // this was the only reason 9 of 10 renamed cards still bound: the same
  // `Date.prototype.toISOString()` artifact as the date-only case, just
  // starting from a value that already had a time-of-day.
  write("millis-equiv-task/task.md", card(["track: track-one", "status: drafting", "created: 2026-05-27T18:47:19Z"]))
  shas.millisEquivCreated = commitAt("2026-09-25T09:17:52Z", "millis-equiv: create")
  write("millis-equiv-task/task.md", card(["track: track-two", "status: drafting", "created: 2026-05-27T18:47:19.000Z"]))
  shas.millisEquivEdited = commitAt("2026-09-25T09:17:54Z", "millis-equiv: move the track (old writer adds .000 to created too)")

  // A genuine, non-`.000` sub-second difference is a real change, not the
  // known artifact: this must still bind.
  write("millis-mismatch-task/task.md", card(["track: track-one", "status: drafting", "created: 2026-05-27T18:47:19Z"]))
  shas.millisMismatchCreated = commitAt("2026-09-25T09:17:56Z", "millis-mismatch: create")
  write("millis-mismatch-task/task.md", card(["track: track-two", "status: drafting", "created: 2026-05-27T18:47:19.500Z"]))
  shas.millisMismatchEdited = commitAt("2026-09-25T09:17:58Z", "millis-mismatch: move the track and actually change created's milliseconds")

  // `purpose: >-` (folded, chomp `-`) re-encoded as the one-line scalar with
  // the same folded text — a long single-line scalar is exactly what a real
  // full-YAML redump can turn into a folded block, and back.
  write("block-equiv-task/task.md", card(["track: track-one", "status: drafting", "purpose: >-", "  Rename the desk card mover's", "  tests to match."]))
  shas.blockEquivCreated = commitAt("2026-09-25T09:18:00Z", "block-equiv: create")
  write("block-equiv-task/task.md", card(["track: track-two", "status: drafting", "purpose: Rename the desk card mover's tests to match."]))
  shas.blockEquivEdited = commitAt("2026-09-25T09:18:10Z", "block-equiv: move the track (old writer folds purpose too)")

  // `note: |-` (literal, chomp `-`) with exactly one content line — a
  // literal block whose folded text has no newline in it — equals that
  // same text as a plain one-line scalar.
  write("literal-equiv-task/task.md", card(["track: track-one", "status: drafting", "note: |-", "  a single literal line"]))
  shas.literalEquivCreated = commitAt("2026-09-25T09:18:20Z", "literal-equiv: create")
  write("literal-equiv-task/task.md", card(["track: track-two", "status: drafting", "note: a single literal line"]))
  shas.literalEquivEdited = commitAt("2026-09-25T09:18:30Z", "literal-equiv: move the track (old writer unfolds note too)")

  // A blank line inside a block scalar's continuation: real YAML folding
  // turns that into a paragraph break, which this module deliberately never
  // implements, so this is treated as unparseable and binds.
  write("block-blank-task/task.md", card(["track: track-one", "status: drafting", "purpose: >-", "  line one", "", "  line two"]))
  shas.blockBlankCreated = commitAt("2026-09-25T09:18:40Z", "block-blank: create")
  write("block-blank-task/task.md", card(["track: track-two", "status: drafting", "purpose: line one line two"]))
  shas.blockBlankEdited = commitAt("2026-09-25T09:18:50Z", "block-blank: move the track; purpose has a blank continuation line")

  // Inconsistent indentation inside a block scalar's continuation: the
  // second line is indented deeper than the first sets the block at, so
  // this is treated as unparseable and binds.
  write("block-indent-task/task.md", card(["track: track-one", "status: drafting", "purpose: >-", "  line one", "    line two"]))
  shas.blockIndentCreated = commitAt("2026-09-25T09:19:00Z", "block-indent: create")
  write("block-indent-task/task.md", card(["track: track-two", "status: drafting", "purpose: line one line two"]))
  shas.blockIndentEdited = commitAt("2026-09-25T09:19:10Z", "block-indent: move the track; purpose has inconsistent indentation")

  // A bare `>` (clip, not strip) is a real chomp variant this module
  // deliberately never parses, so it is compared literally and binds even
  // though its folded text would otherwise match.
  write("block-chomp-task/task.md", card(["track: track-one", "status: drafting", "purpose: >", "  line one", "  line two"]))
  shas.blockChompCreated = commitAt("2026-09-25T09:19:20Z", "block-chomp: create")
  write("block-chomp-task/task.md", card(["track: track-two", "status: drafting", "purpose: line one line two"]))
  shas.blockChompEdited = commitAt("2026-09-25T09:19:30Z", "block-chomp: move the track; purpose uses clip chomping, not strip")

  // The same two fields, reordered: `frontmatterEntriesEqual` compares
  // position by position, so a real key-order change is a real difference
  // and binds, even though both fields' own values are untouched.
  write("key-order-task/task.md", card(["track: track-one", "status: drafting", "requester: ari"]))
  shas.keyOrderCreated = commitAt("2026-09-25T09:19:40Z", "key-order: create")
  write("key-order-task/task.md", card(["track: track-two", "requester: ari", "status: drafting"]))
  shas.keyOrderEdited = commitAt("2026-09-25T09:19:50Z", "key-order: move the track and swap requester/status order")

  // A hand-authored card with no trailing newline gains one — real evidence
  // from personal-desk commit 207c6dd2, where this was the only remaining
  // reason 4 of the 6 still-binding renamed cards bound, once the
  // timestamp-reformatting judge above was in place.
  write("trailing-newline-task/task.md", card(["track: track-one", "status: drafting"], "# A task\n\nBody with no trailing newline").replace(/\n$/u, ""))
  shas.trailingNewlineCreated = commitAt("2026-09-25T09:19:52Z", "trailing-newline: create")
  write("trailing-newline-task/task.md", card(["track: track-two", "status: drafting"], "# A task\n\nBody with no trailing newline"))
  shas.trailingNewlineEdited = commitAt("2026-09-25T09:19:54Z", "trailing-newline: move the track (old writer adds a trailing newline too)")

  // More than one trailing newline of difference is a real change, not the
  // known artifact: this must still bind.
  write("newline-mismatch-task/task.md", card(["track: track-one", "status: drafting"], "# A task\n\nBody text"))
  shas.newlineMismatchCreated = commitAt("2026-09-25T09:19:56Z", "newline-mismatch: create")
  write("newline-mismatch-task/task.md", card(["track: track-two", "status: drafting"], "# A task\n\nBody text\n\n"))
  shas.newlineMismatchEdited = commitAt("2026-09-25T09:19:58Z", "newline-mismatch: move the track and actually add a blank line to the body")

  // A raw top-level line that isn't a `key: value` pair at all (a bare
  // comment, unindented) groups as its own entry with a null key, compared
  // only by its exact text: unchanged here, so it doesn't block the track
  // patch from reading as housekeeping.
  write("bare-line-task/task.md", card(["track: track-one", "# a note, not a key", "status: drafting"]))
  shas.bareLineCreated = commitAt("2026-09-25T09:20:01Z", "bare-line: create")
  write("bare-line-task/task.md", card(["track: track-two", "# a note, not a key", "status: drafting"]))
  shas.bareLineEdited = commitAt("2026-09-25T09:20:02Z", "bare-line: move the track only; the bare comment line is untouched")

  // A blank line before any top-level key at all: grouping sees it before
  // any entry exists yet, and just skips it, same as it skips a blank line
  // anywhere else in the frontmatter.
  write("leading-blank-task/task.md", card(["", "track: track-one", "status: drafting"]))
  shas.leadingBlankCreated = commitAt("2026-09-25T09:20:03Z", "leading-blank: create")
  write("leading-blank-task/task.md", card(["", "track: track-two", "status: drafting"]))
  shas.leadingBlankEdited = commitAt("2026-09-25T09:20:04Z", "leading-blank: move the track only; the leading blank line is untouched")

  // A block-scalar header with no indented content at all (immediately
  // followed by the next top-level key): its continuation is empty, so
  // this can't be folded with confidence, and it binds against a real
  // value the same way any other unparseable block scalar does.
  write("block-empty-task/task.md", card(["track: track-one", "purpose: >-", "status: drafting"]))
  shas.blockEmptyCreated = commitAt("2026-09-25T09:20:05Z", "block-empty: create")
  write("block-empty-task/task.md", card(["track: track-two", "purpose: something else entirely", "status: drafting"]))
  shas.blockEmptyEdited = commitAt("2026-09-25T09:20:06Z", "block-empty: move the track; purpose changes from an empty block scalar to a real value")

  // A block scalar whose first continuation line is itself blank: there is
  // no indentation on that line to read the block's own indent from, so
  // this can't be folded with confidence and binds.
  write("block-blank-first-task/task.md", card(["track: track-one", "purpose: >-", "", "  line one"]))
  shas.blockBlankFirstCreated = commitAt("2026-09-25T09:20:07Z", "block-blank-first: create")
  write("block-blank-first-task/task.md", card(["track: track-two", "purpose: line one"]))
  shas.blockBlankFirstEdited = commitAt("2026-09-25T09:20:08Z", "block-blank-first: move the track (old writer unfolds purpose too, dropping the blank line)")

  // The same track patch, but the tidy commit also adds a brand-new field
  // that didn't exist before: entries are counted before they're compared
  // position by position, and a real field addition changes that count, so
  // this binds even though every field the two cards share reads as
  // unchanged.
  write("entry-count-task/task.md", card(["track: track-one", "status: drafting"]))
  shas.entryCountCreated = commitAt("2026-09-25T09:20:09Z", "entry-count: create")
  write("entry-count-task/task.md", card(["track: track-two", "status: drafting", "note: a brand-new field"]))
  shas.entryCountEdited = commitAt("2026-09-25T09:20:10Z", "entry-count: move the track and add a genuinely new field")

  // A pathological commit's rename count must not be trusted at all: more
  // than RENAME_PAIR_CAP rename pairs makes the whole commit not
  // housekeeping, even for a card whose own edit is nothing but a quote
  // rewrite that needs no substitution at all.
  const RENAME_CAP_FILE_COUNT = 2001
  for (let i = 0; i < RENAME_CAP_FILE_COUNT; i += 1) {
    write(`rename-cap-source/f${i}.md`, `unique file ${i}\n`)
  }
  write("rename-cap-card/task.md", card(["status: drafting", "requester: \"ari\""]))
  shas.renameCapCreated = commitAt("2026-09-25T09:17:00Z", "rename-cap: create")
  for (let i = 0; i < RENAME_CAP_FILE_COUNT; i += 1) {
    remove(`rename-cap-source/f${i}.md`)
    write(`rename-cap-target/f${i}.md`, `unique file ${i}\n`)
  }
  write("rename-cap-card/task.md", card(["status: drafting", "requester: ari"]))
  shas.renameCapEdited = commitAt("2026-09-25T09:17:10Z", "rename-cap: rename past the cap and touch the card")

  // A nested frontmatter value changes (a repos: entry's branch_base) while
  // every top-level field stays the same text: a field map keyed only by
  // each line's own top-level key would see `repos:`'s own captured value
  // ("", nothing follows the colon on that line) as unchanged and miss
  // this; the line comparison must not.
  write("track/nested-repos-task/task.md", card(["title: Nested repos", "repos:", "  - name: alpha", "    branch_base: main", "status: drafting", "updated: '2026-09-25T09:00:00Z'"]))
  shas.nestedReposCreated = commitAt("2026-09-25T08:59:00Z", "nested-repos: create")
  write("track/nested-repos-task/task.md", card(["title: Nested repos", "repos:", "  - name: alpha", "    branch_base: develop", "status: drafting", "updated: '2026-09-25T09:00:00Z'"]))
  shas.nestedReposEdited = commitAt("2026-09-25T08:59:30Z", "nested-repos: change branch_base")

  // A commit, then its amend: both are this clone's.
  write("track/amended-task/task.md", card(["status: drafting"]))
  shas.beforeAmend = commitAt("2026-09-25T09:00:00Z", "draft")
  write("track/amended-task/notes.md", "more\n")
  shas.amended = commitAt("2026-09-25T09:05:00Z", "drafted", ["--amend"])

  // A commit later rebased onto another clone's work keeps its own entry.
  // It also touches a non-card file, so it is a real work signal, not just a
  // card edit: see "the bare card never binds" in binding.test.js. Its body
  // is its own (not byte-identical to track/fetched-task's, another
  // `status: blocked` card): resolveJobIdentity's own Git rename detection
  // is content-based, and two unrelated cards with identical bytes are
  // indistinguishable rename candidates to it.
  write("track/other-task/task.md", card(["status: blocked"], "# A task\n\nother-task's own body, distinct from every other fixture."))
  write("track/other-task/notes.md", "notes\n")
  shas.preRebase = commitAt("2026-09-25T09:30:00Z", "before rebase")
  gitIn(other, ["pull", "-q", "--ff-only", "origin", "main"], "2026-09-25T09:50:00Z")
  writeIn(other, "_meta/log.md", "log\n")
  commitIn(other, "2026-09-25T10:00:00Z", "upstream")
  gitIn(other, ["push", "-q", "origin", "main"], "2026-09-25T10:00:01Z")
  git(["pull", "-q", "--rebase", "origin", "main"], "2026-09-25T11:00:00Z")

  // A side branch merged with `git merge`: the merge entry is not listed.
  git(["checkout", "-q", "-b", "side"], "2026-09-25T11:59:00Z")
  write("track/side-task/task.md", card(["status: drafting"]))
  shas.side = commitAt("2026-09-25T12:00:00Z", "side")
  git(["checkout", "-q", "main"], "2026-09-25T12:00:05Z")
  write("_meta/other.md", "main\n")
  shas.main = commitAt("2026-09-25T12:00:10Z", "main")
  git(["merge", "-q", "--no-ff", "-m", "merge", "side"], "2026-09-25T12:00:20Z")

  // A conflicted merge committed by hand: a `commit (merge)` entry, whose
  // paths are only the file resolved by hand.
  git(["checkout", "-q", "-b", "conflict"], "2026-09-25T12:29:00Z")
  write("track/live-task/task.md", card(LIVE_CARD, "# One side"))
  write("track/c1-only/task.md", card(["status: drafting"]))
  commitAt("2026-09-25T12:30:00Z", "one side")
  git(["checkout", "-q", "main"], "2026-09-25T12:30:05Z")
  write("track/live-task/task.md", card(LIVE_CARD, "# Other side"))
  commitAt("2026-09-25T12:30:10Z", "other side")
  // The merge stops on the conflict (exit 1), leaving MERGE_HEAD for the commit.
  const merge = spawnSync("git", ["-C", desk, "-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "-q", "conflict"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_COMMITTER_DATE: "2026-09-25T12:30:20Z" },
  })
  assert.equal(merge.status, 1)
  write("track/live-task/task.md", card(LIVE_CARD, "# Resolved"))
  git(["add", "-A"])
  git(["commit", "-q", "-m", "resolved"], "2026-09-25T12:30:30Z")
  shas.conflictMerge = git(["rev-parse", "HEAD"])

  // --- Fixtures for resolveJobIdentity (ourostack/desk#76): the task's
  // birth path, from real Git history. Every track here is prefixed
  // `birth-` so its history never shares a literal path with a fixture
  // above. Git's rename detection is content-based, so every card below
  // gets its own unique body text: two byte-identical cards for otherwise
  // unrelated tasks can make Git's own `--follow` pair them by accident
  // (confirmed empirically against this same fixture set), and that
  // accident is not what any of these tests are about.
  // A plain rename: the slug changes, the track does not. Removing the old
  // path and writing the new one with byte-identical content, in one
  // commit, is what makes Git's own rename detection pair them (the same
  // technique the movable-task fixture above uses).
  write("birth-rename/origin-slug/task.md", fixtureCard("birth-rename task", "drafting"))
  shas.birthRenameCreate = commitAt("2026-09-26T08:00:00Z", "birth-rename: create")
  remove("birth-rename/origin-slug/task.md")
  write("birth-rename/new-slug/task.md", fixtureCard("birth-rename task", "drafting"))
  shas.birthRenameMove = commitAt("2026-09-26T08:00:10Z", "birth-rename: rename the slug")
  // Real, non-card work after the rename, so the end-to-end binding test
  // below has something at the new (current) path to bind.
  write("birth-rename/new-slug/notes.md", "notes\n")
  shas.birthRenameNotes = commitAt("2026-09-26T08:00:20Z", "birth-rename: add notes after the rename")

  // An archive move: the card moves from live to `_archive` with the same
  // track and slug either side, so its birth is unchanged.
  write("birth-archive/task-m/task.md", fixtureCard("birth-archive task", "processing"))
  commitAt("2026-09-26T08:01:00Z", "birth-archive: create")
  remove("birth-archive/task-m/task.md")
  write("birth-archive/_archive/task-m/task.md", fixtureCard("birth-archive task", "processing"))
  commitAt("2026-09-26T08:01:10Z", "birth-archive: move to _archive")

  // A track rename followed by a revert: two hops back to the same origin.
  write("birth-revert-a/task-r/task.md", fixtureCard("birth-revert task", "drafting"))
  commitAt("2026-09-26T08:02:00Z", "birth-revert: create in track a")
  remove("birth-revert-a/task-r/task.md")
  write("birth-revert-b/task-r/task.md", fixtureCard("birth-revert task", "drafting"))
  commitAt("2026-09-26T08:02:10Z", "birth-revert: rename track a to b")
  remove("birth-revert-b/task-r/task.md")
  write("birth-revert-a/task-r/task.md", fixtureCard("birth-revert task", "drafting"))
  commitAt("2026-09-26T08:02:20Z", "birth-revert: rename track b back to a")

  // A card deleted and re-created at the same literal path (Finding: Git's
  // `--diff-filter=A` can list more than one add for one current name; the
  // newest is kept). task-origin is born, moves away to task-elsewhere,
  // and only later does an unrelated task reuse the freed task-origin name.
  write("birth-reborn/task-origin/task.md", fixtureCard("birth-reborn task A", "processing"))
  commitAt("2026-09-26T08:03:00Z", "birth-reborn: create task A at task-origin")
  remove("birth-reborn/task-origin/task.md")
  write("birth-reborn/task-elsewhere/task.md", fixtureCard("birth-reborn task A", "processing"))
  commitAt("2026-09-26T08:03:10Z", "birth-reborn: task A moves away to task-elsewhere")
  write("birth-reborn/task-origin/task.md", fixtureCard("birth-reborn task Z", "drafting"))
  commitAt("2026-09-26T08:03:20Z", "birth-reborn: an unrelated task reuses task-origin")

  // Two tasks that swap slugs in the same commit: Git sees a path present
  // on both sides of a commit as a modification, never a rename candidate,
  // so this must not read as either task changing identity.
  write("birth-swap/task-p/task.md", fixtureCard("birth-swap task P", "processing"))
  write("birth-swap/task-q/task.md", fixtureCard("birth-swap task Q", "drafting"))
  commitAt("2026-09-26T08:04:00Z", "birth-swap: create task-p and task-q")
  write("birth-swap/task-p/task.md", fixtureCard("birth-swap task Q", "drafting"))
  write("birth-swap/task-q/task.md", fixtureCard("birth-swap task P", "processing"))
  commitAt("2026-09-26T08:04:10Z", "birth-swap: swap task-p and task-q's contents")

  // A plain rename kept isolated from every other resolveJobIdentity test,
  // so the caching test below is the very first call to resolve it.
  write("birth-cache/task-cache-origin/task.md", fixtureCard("birth-cache task", "drafting"))
  commitAt("2026-09-26T08:05:00Z", "birth-cache: create")
  remove("birth-cache/task-cache-origin/task.md")
  write("birth-cache/task-cache-new/task.md", fixtureCard("birth-cache task", "drafting"))
  commitAt("2026-09-26T08:05:10Z", "birth-cache: rename the slug")

  // A plain rename resolved only through a broken git below, so that test
  // observes a real fallback rather than an already-cached answer.
  write("birth-gitfail/origin-slug/task.md", fixtureCard("birth-gitfail task", "drafting"))
  commitAt("2026-09-26T08:07:00Z", "birth-gitfail: create")
  remove("birth-gitfail/origin-slug/task.md")
  write("birth-gitfail/new-slug/task.md", fixtureCard("birth-gitfail task", "drafting"))
  commitAt("2026-09-26T08:07:10Z", "birth-gitfail: rename the slug")

  // A committed, renamed card under a person prefix, so resolveJobIdentity's
  // person-prefix handling is exercised through real Git history too, not
  // only the fallback path an uncommitted card would take.
  write("desks/ari/birth-person/origin-slug/task.md", fixtureCard("birth-person task", "drafting"))
  commitAt("2026-09-26T08:06:00Z", "birth-person: create")
  remove("desks/ari/birth-person/origin-slug/task.md")
  write("desks/ari/birth-person/new-slug/task.md", fixtureCard("birth-person task", "drafting"))
  commitAt("2026-09-26T08:06:10Z", "birth-person: rename the slug")

  // A whole track archived: findCard (readTask and resolveJobIdentity alike)
  // must also look at `_archive/<track>/<slug>/task.md`, the shape
  // boot-check's finishedTasks already scans for an archived track, not
  // only `<track>/_archive/<slug>/task.md`. The task is renamed before the
  // track archives, so a findCard miss here (falling back to the given,
  // current track/slug) is distinguishable from a real resolution: they
  // would otherwise both name the same track/slug and the bug would hide.
  write("birth-whole-track/task-origin/task.md", fixtureCard("birth-whole-track task", "drafting"))
  commitAt("2026-09-27T08:10:00Z", "birth-whole-track: create")
  remove("birth-whole-track/task-origin/task.md")
  write("birth-whole-track/task-w/task.md", fixtureCard("birth-whole-track task", "drafting"))
  commitAt("2026-09-27T08:10:10Z", "birth-whole-track: rename the slug")
  remove("birth-whole-track/task-w/task.md")
  write("_archive/birth-whole-track/task-w/task.md", fixtureCard("birth-whole-track task", "drafting"))
  commitAt("2026-09-27T08:10:20Z", "birth-whole-track: archive the whole track")

  // A task archived within an already-archived track:
  // `_archive/<track>/_archive/<slug>/task.md`.
  write("birth-doubly-archived/task-origin/task.md", fixtureCard("birth-doubly-archived task", "drafting"))
  commitAt("2026-09-27T08:11:00Z", "birth-doubly-archived: create")
  remove("birth-doubly-archived/task-origin/task.md")
  write("birth-doubly-archived/task-d/task.md", fixtureCard("birth-doubly-archived task", "drafting"))
  commitAt("2026-09-27T08:11:10Z", "birth-doubly-archived: rename the slug")
  remove("birth-doubly-archived/task-d/task.md")
  write("_archive/birth-doubly-archived/task-d/task.md", fixtureCard("birth-doubly-archived task", "drafting"))
  commitAt("2026-09-27T08:11:20Z", "birth-doubly-archived: archive the whole track")
  remove("_archive/birth-doubly-archived/task-d/task.md")
  write("_archive/birth-doubly-archived/_archive/task-d/task.md", fixtureCard("birth-doubly-archived task", "drafting"))
  commitAt("2026-09-27T08:11:30Z", "birth-doubly-archived: archive the task within the archived track too")

  // Cards that are not committed, for the reader's edge cases.
  write("track/no-frontmatter/task.md", "# Just a heading\nstatus: done\n")
  write("track/bad-values/task.md", card(["status: finished", "created: 2026-09-20", "updated: soon"]))
  write("track/unterminated/task.md", "---\nstatus: paused\n")
  write("track/late-frontmatter/task.md", `---\n${"x: y\n".repeat(45)}status: done\n---\n`)
  write("track/indented/task.md", card(["repos:", "  status: done", "status: validating"]))
  mkdirSync(path.join(desk, "track/dir-card/task.md"), { recursive: true })
  write("desks/ari/track/person-task/task.md", card(["status: collaborating", "created: 2026-09-21T00:00:00.000Z"]))
  // A brand-new, never-committed card: no Git history at all yet.
  write("birth-uncommitted/task-fresh/task.md", card(["status: drafting"]))
})

after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

// --- readTask --------------------------------------------------------------------

test("readTask reads status, created and updated from a live card's frontmatter, unquoting values", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(readTask("track", "live-task"), { status: "processing", created_at: "2026-09-20T10:00:00.000Z", updated_at: "2026-09-25T09:00:00.000Z", repos: [] })
})

test("readTask falls back to the _archive card, drops trailing comments and normalizes offsets to UTC", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  // The working tree's current content, after the later housekeeping-only edit to `updated:`.
  assert.deepEqual(readTask("track", "old-task"), { status: "done", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-05T10:30:00.000Z", repos: [] })
})

test("readTask finds a card under a whole archived track, and one archived a second time within that archived track", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(readTask("birth-whole-track", "task-w"), { status: "drafting", created_at: null, updated_at: null, repos: [] })
  assert.deepEqual(readTask("birth-doubly-archived", "task-d"), { status: "drafting", created_at: null, updated_at: null, repos: [] })
})

test("readTask returns null when no card exists, live or archived, or when the names are unsafe", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  assert.equal(readTask("track", "missing"), null)
  for (const [track, slug] of [["..", "x"], ["track", "../live-task"], ["_meta", "x"], ["track", ""], [7, "x"]]) {
    assert.equal(readTask(track, slug), null, `${track}/${slug}`)
  }
})

test("readTask gives nulls for fields it cannot read: no frontmatter, invalid values, unterminated, or a folder", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  const empty = { status: null, created_at: null, updated_at: null, repos: [] }
  assert.deepEqual(readTask("track", "no-frontmatter"), empty)
  assert.deepEqual(readTask("track", "bad-values"), empty)
  assert.deepEqual(readTask("track", "unterminated"), empty)
  assert.deepEqual(readTask("track", "dir-card"), empty)
  assert.deepEqual(readTask("track", "indented"), { status: "validating", created_at: null, updated_at: null, repos: [] })
})

test("readTask treats a card it may not open as unreadable, and a track that is a file as no card", { skip: process.platform === "win32" ? "POSIX permission bits only: chmod 000 does not make a file unreadable to its owner on Windows" : false }, () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  write("track/locked/task.md", card(["status: done"]))
  write("file-track", "not a folder\n")
  chmodSync(path.join(desk, "track/locked/task.md"), 0o000)
  try {
    assert.deepEqual(readTask("track", "locked"), { status: null, created_at: null, updated_at: null, repos: [] })
    assert.equal(readTask("file-track", "x"), null)
  } finally {
    chmodSync(path.join(desk, "track/locked/task.md"), 0o644)
  }
})

test("readTask reads under the person prefix when one is given", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk, personPrefix: "desks/ari" })
  assert.deepEqual(readTask("track", "person-task"), { status: "collaborating", created_at: "2026-09-21T00:00:00.000Z", updated_at: null, repos: [] })
  assert.equal(readTask("track", "live-task"), null)
  assert.throws(() => createDeskReaders({ deskRoot: desk, personPrefix: "people/ari" }), TypeError)
  assert.throws(() => createDeskReaders({ deskRoot: "relative" }), TypeError)
})

test("readTask reads the whole frontmatter block, so a field after line 40 still counts", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(readTask("track", "late-frontmatter"), { status: "done", created_at: null, updated_at: null, repos: [] })
  write("track/late-repos/task.md", `---\nstatus: done\n${"x: y\n".repeat(45)}repos:\n  - name: ourostack/desk\n---\n`)
  assert.deepEqual(readTask("track", "late-repos").repos, ["ourostack/desk"])
})

const reposOf = (name, lines) => {
  write(`track/${name}/task.md`, card(["status: done", ...lines]))
  return createDeskReaders({ deskRoot: desk }).readTask("track", name).repos
}

test("readTask returns repos from a flow list and a block list of names", () => {
  assert.deepEqual(reposOf("repos-flow", ["repos: [ourostack/desk, spoonjoy/spoonjoy-v2]"]), ["ourostack/desk", "spoonjoy/spoonjoy-v2"])
  assert.deepEqual(reposOf("repos-block", ["repos:", "  - ourostack/desk", "  - spoonjoy/spoonjoy-v2", "title: after"]), ["ourostack/desk", "spoonjoy/spoonjoy-v2"])
  assert.deepEqual(reposOf("repos-block-flush", ["repos:", "- ourostack/desk", "status: done"]), ["ourostack/desk"])
})

test("readTask returns repos from object entries and never a path, mode or other field", () => {
  const repos = reposOf("repos-objects", [
    "repos:",
    "  - name: ourostack/teamscrawl",
    "    mode: local",
    "    local_path: '~/code/teamscrawl'",
    "  - name: desk",
    "    url: https://github.com/ourostack/desk",
    "    mode: remote",
    "  - name: ssh-form",
    "    url: git@github.com:ourostack/ouro-work-substrate.git",
    "  - name: plain",
    "    url: https://example.com/not/github",
    "  - name: bare-no-url",
    "    local_path: /Users/someone/code/bare-no-url",
    "    branches:",
    "      - feature/x",
    "    name: ignored-second-name",
  ])
  assert.deepEqual(repos, ["ourostack/teamscrawl", "ourostack/desk", "ourostack/ouro-work-substrate", "plain", "bare-no-url"])
  assert.equal(JSON.stringify(repos).includes("/Users"), false)
})

test("readTask falls back to a GitHub url when the name is not a usable owner/name, and refuses dot segments", () => {
  const repos = reposOf("repos-url-fallback", [
    "repos:",
    '  - name: "My Repo"',
    "    url: https://github.com/ourostack/desk.git",
    "  - name: ../x",
    "    url: https://github.com/ourostack/ouro-work-substrate",
    "  - name: ../x",
    "  - name: ..",
    "  - name: .",
    "  - name: a/..",
    "  - name: bad",
    "    url: https://github.com/../x",
    "  - name: My Repo",
  ])
  assert.deepEqual(repos, ["ourostack/desk", "ourostack/ouro-work-substrate", "bad"])
})

test("a trailing comment after a quoted value is dropped for status, created and updated too", () => {
  write("track/quoted-comments/task.md", card(['status: "done" # finished', 'created: "2026-09-20T10:00:00Z" # born', "updated: '2026-09-25T09:00:00Z' # touched"]))
  assert.deepEqual(createDeskReaders({ deskRoot: desk }).readTask("track", "quoted-comments"), { status: "done", created_at: "2026-09-20T10:00:00.000Z", updated_at: "2026-09-25T09:00:00.000Z", repos: [] })
})

test("readTask strips quotes from repos, skips empty or missing names, drops duplicates, and reads an empty or absent list as none", () => {
  assert.deepEqual(reposOf("repos-quoted", ['repos: ["ourostack/desk", \'spoonjoy/spoonjoy-v2\', "ourostack/desk", "", {a: b}]']), ["ourostack/desk", "spoonjoy/spoonjoy-v2"])
  assert.deepEqual(reposOf("repos-quoted-block", ["repos:", '  - "ourostack/desk" # note', "  - ''", "  - url: https://github.com/a/b", "    mode: remote", "  - name:"]), ["ourostack/desk"])
  assert.deepEqual(reposOf("repos-empty", ["repos: []"]), [])
  assert.deepEqual(reposOf("repos-scalar", ["repos: ourostack/desk"]), [])
  assert.deepEqual(reposOf("repos-absent", []), [])
  assert.deepEqual(reposOf("repos-blank", ["repos:"]), [])
})

// --- readTask follows renames ---------------------------------------------------------------

function renameRepo(name) {
  const repo = path.join(scratch, name)
  mkdirSync(repo)
  gitIn(repo, ["init", "-q", "-b", "main"])
  return repo
}
const taskCard = (label) => fixtureCard(label, "processing")
function moveIn(repo, from, to, at) {
  mkdirSync(path.dirname(path.join(repo, to)), { recursive: true })
  gitIn(repo, ["mv", from, to])
  return commitIn(repo, at, `move ${from}`)
}

test("renamed task folder still found", () => {
  const repo = renameRepo("rename-one")
  writeIn(repo, "a/old/task.md", taskCard("rename-one"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "a/old", "b/new", "2026-09-25T09:00:00Z")
  const { readTask } = createDeskReaders({ deskRoot: repo })
  assert.equal(readTask("a", "old").status, "processing")
  assert.equal(readTask("b", "new").status, "processing")
})

test("a chain of two renames resolves, including into an archive and to a later reader after HEAD moves", () => {
  const repo = renameRepo("rename-chain")
  writeIn(repo, "a/old/task.md", taskCard("rename-chain"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "a/old", "b/mid", "2026-09-25T09:00:00Z")
  const { readTask } = createDeskReaders({ deskRoot: repo })
  assert.equal(readTask("a", "old").status, "processing")
  moveIn(repo, "b/mid", "c/new", "2026-09-25T10:00:00Z")
  assert.equal(readTask("a", "old").status, "processing")
  assert.equal(readTask("b", "mid").status, "processing")
  moveIn(repo, "c/new", "c/_archive/new", "2026-09-25T11:00:00Z")
  assert.equal(readTask("a", "old").status, "processing")
  moveIn(repo, "c/_archive/new", "_archive/c/new", "2026-09-25T12:00:00Z")
  assert.equal(readTask("a", "old").status, "processing")
  moveIn(repo, "_archive/c/new", "_archive/c/_archive/new", "2026-09-25T13:00:00Z")
  assert.equal(readTask("a", "old").status, "processing")
})

test("renames are read under the person prefix, and another person's or a non-card rename is ignored", () => {
  const repo = renameRepo("rename-person")
  writeIn(repo, "desks/ari/a/old/task.md", taskCard("rename-person-ari"))
  writeIn(repo, "desks/bo/a/old/task.md", taskCard("rename-person-bo"))
  writeIn(repo, "desks/ari/a/old/notes.md", "# Notes\n\nUnique notes for the person-prefix rename fixture.\n")
  writeIn(repo, "a/old/deep/inner/task.md", taskCard("rename-person-deep"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "desks/ari/a/old", "desks/ari/b/new", "2026-09-25T09:00:00Z")
  moveIn(repo, "desks/bo/a/old", "desks/bo/b/new", "2026-09-25T10:00:00Z")
  moveIn(repo, "a/old/deep", "a/old/deeper", "2026-09-25T11:00:00Z")
  const { readTask } = createDeskReaders({ deskRoot: repo, personPrefix: "desks/ari" })
  assert.equal(readTask("a", "old").status, "processing")
  assert.equal(createDeskReaders({ deskRoot: repo }).readTask("a", "old"), null)
})

test("two readers on one desk root and HEAD with different person prefixes each get their own renames", () => {
  const repo = renameRepo("rename-two-prefixes")
  writeIn(repo, "desks/ari/a/old/task.md", taskCard("two-prefixes-ari"))
  writeIn(repo, "desks/bo/a/old/task.md", taskCard("two-prefixes-bo"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "desks/ari/a/old", "desks/ari/b/ari-new", "2026-09-25T09:00:00Z")
  moveIn(repo, "desks/bo/a/old", "desks/bo/b/bo-new", "2026-09-25T10:00:00Z")
  const ari = createDeskReaders({ deskRoot: repo, personPrefix: "desks/ari" })
  const bo = createDeskReaders({ deskRoot: repo, personPrefix: "desks/bo" })
  assert.equal(ari.readTask("a", "old").status, "processing")
  assert.equal(bo.readTask("a", "old").status, "processing")
})

test("a card heavily edited in its rename commit is not followed, and reads null (the known limit of Git's rename detection)", () => {
  const repo = renameRepo("rename-heavy")
  writeIn(repo, "a/old/task.md", taskCard("rename-heavy-before"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  gitIn(repo, ["mv", "a/old", "b-new"])
  writeIn(repo, "b-new/task.md", card(["status: done"], `# Completely different\n\n${"Entirely new text, nothing shared. ".repeat(20)}`))
  commitIn(repo, "2026-09-25T09:00:00Z", "rename and rewrite")
  assert.equal(createDeskReaders({ deskRoot: repo }).readTask("a", "old"), null)
})

test("resolveJobIdentity finds a renamed card, so it agrees with readTask on where it lives", () => {
  const repo = renameRepo("rename-identity")
  writeIn(repo, "a/old/task.md", taskCard("rename-identity"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "a/old", "b/mid", "2026-09-25T09:00:00Z")
  moveIn(repo, "b/mid", "c/new", "2026-09-25T10:00:00Z")
  assert.deepEqual(resolveJobIdentity({ deskRoot: repo, track: "b", slug: "mid" }), { track: "a", slug: "old" })
  assert.deepEqual(resolveJobIdentity({ deskRoot: repo, track: "c", slug: "new" }), { track: "a", slug: "old" })
})

test("a card deleted and an unrelated one created in one commit is never read as a rename: their creation times differ", () => {
  const repo = renameRepo("rename-false-pair")
  // Two cards from one template, nearly identical, so Git's similarity pairs the deleted one with the new one.
  const templated = (created) => card(["status: processing", `created: "${created}"`], "# Task\n\nThe same template body, line for line, as every other card made from it.\n".repeat(3))
  writeIn(repo, "a/gone/task.md", templated("2026-09-20T10:00:00.000Z"))
  writeIn(repo, "a/moved/task.md", templated("2026-09-21T10:00:00.000Z"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  removeIn(repo, "a/gone/task.md")
  writeIn(repo, "b/fresh/task.md", templated("2026-09-25T09:00:00.000Z"))
  commitIn(repo, "2026-09-25T09:00:00Z", "delete one card, create another")
  assert.equal(gitIn(repo, ["log", "-1", "-M", "--diff-filter=R", "--name-status", "--format="]).trim().startsWith("R"), true, "Git itself pairs them")
  assert.equal(createDeskReaders({ deskRoot: repo }).readTask("a", "gone"), null, "the deleted card does not resolve to the new one")
  assert.deepEqual(resolveJobIdentity({ deskRoot: repo, track: "b", slug: "fresh" }), { track: "b", slug: "fresh" }, "the new card's birth is its own path")
  // A real move keeps its creation time even when the move edits the card.
  mkdirSync(path.join(repo, "c"))
  gitIn(repo, ["mv", "a/moved", "c/moved"])
  writeIn(repo, "c/moved/task.md", templated("2026-09-21T10:00:00.000Z").replace("status: processing", "status: done"))
  commitIn(repo, "2026-09-25T10:00:00Z", "move and finish")
  assert.equal(createDeskReaders({ deskRoot: repo }).readTask("a", "moved").status, "done")
  assert.deepEqual(resolveJobIdentity({ deskRoot: repo, track: "c", slug: "moved" }), { track: "a", slug: "moved" })
  // A card with no readable creation time cannot be told apart, so Git's pairing stands.
  writeIn(repo, "d/plain/task.md", card(["status: processing"], "# Plain\n\nA card from before creation times, with a body long enough to pair.\n".repeat(3)))
  commitIn(repo, "2026-09-25T11:00:00Z", "add plain")
  gitIn(repo, ["mv", "d/plain", "d/plain-moved"])
  writeIn(repo, "d/plain-moved/task.md", card(["status: processing", `created: "2026-09-25T11:00:00.000Z"`], "# Plain\n\nA card from before creation times, with a body long enough to pair.\n".repeat(3)))
  commitIn(repo, "2026-09-25T12:00:00Z", "move and date")
  assert.equal(createDeskReaders({ deskRoot: repo }).readTask("d", "plain").status, "processing")
  assert.deepEqual(resolveJobIdentity({ deskRoot: repo, track: "d", slug: "plain-moved" }), { track: "d", slug: "plain" })
})

test("when the birth card's old text cannot be read, Git's birth stands", () => {
  const repo = renameRepo("rename-unreadable-birth")
  writeIn(repo, "a/first/task.md", card(["status: processing", `created: "2026-09-21T10:00:00.000Z"`], "# Task\n\nA body long enough for Git to pair the two sides of the move.\n".repeat(3)))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "a/first", "a/second", "2026-09-25T09:00:00Z")
  let asked = 0
  const spawn = (command, args, options) => (args.includes("cat-file") ? (asked += 1, { status: 128, stdout: "" }) : spawnSync(command, args, options))
  assert.deepEqual(resolveJobIdentity({ deskRoot: repo, track: "a", slug: "second", spawn }), { track: "a", slug: "first" })
  assert.equal(asked, 1)
})

test("parseCardRenames keeps a rename whose creation time is unchanged or only respelled, and drops one whose time differs", () => {
  const block = (removed, added) => `diff --git a/a/x/task.md b/b/y/task.md\nsimilarity index 90%\nrename from a/x/task.md\nrename to b/y/task.md\n@@ -2 +2 @@\n-created: ${removed}\n+created: ${added}\n`
  assert.deepEqual(parseCardRenames(block("2026-09-20T10:00:00Z", "'2026-09-20T10:00:00.000Z'")), [{ oldPath: "a/x/task.md", path: "b/y/task.md" }])
  assert.deepEqual(parseCardRenames(block("2026-09-20T10:00:00Z", "2026-09-21T10:00:00Z")), [])
  assert.deepEqual(parseCardRenames(block("2026-09-20", "2026-09-21T10:00:00Z")), [{ oldPath: "a/x/task.md", path: "b/y/task.md" }], "an unreadable time is not comparable")
  assert.deepEqual(parseCardRenames("diff --git a/a b/a\nindex 1..2\n"), [], "a block that is not a rename")
})

test("mergedInto follows a task merged with task_move into_task to the task that keeps the job, after renames on either side", () => {
  const repo = renameRepo("merged-into")
  writeIn(repo, "a/dup/task.md", card(["status: processing", `created: "2026-09-20T10:00:00.000Z"`], "# Duplicate\n\nThe duplicate's own body, long enough for Git to pair it after the merge.\n".repeat(3)))
  writeIn(repo, "a/keeper/task.md", taskCard("merged-into-keeper"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "a/dup", "a/dup-renamed", "2026-09-25T08:30:00Z")
  // What task_move into_task commits: the folder under the keeper's iterations, the card renamed to merged-task.md with merged_into set.
  mkdirSync(path.join(repo, "a", "keeper", "_iterations"), { recursive: true })
  gitIn(repo, ["mv", "a/dup-renamed", "a/keeper/_iterations/2026-09-20-dup-renamed"])
  gitIn(repo, ["mv", "a/keeper/_iterations/2026-09-20-dup-renamed/task.md", "a/keeper/_iterations/2026-09-20-dup-renamed/merged-task.md"])
  writeIn(repo, "a/keeper/_iterations/2026-09-20-dup-renamed/merged-task.md", card(["status: processing", `created: "2026-09-20T10:00:00.000Z"`, "merged_into: keeper"], "# Duplicate\n\nThe duplicate's own body, long enough for Git to pair it after the merge.\n".repeat(3)))
  commitIn(repo, "2026-09-25T09:00:00Z", "merge dup into keeper")
  moveIn(repo, "a/keeper", "b/keeper", "2026-09-25T10:00:00Z")
  const readers = createDeskReaders({ deskRoot: repo })
  assert.deepEqual(readers.mergedInto("a", "dup"), { track: "a", slug: "keeper" }, "named as it was at the merge")
  assert.equal(readers.readTask("a", "keeper").status, "processing", "and readTask follows the keeper's later rename")
  assert.deepEqual(readers.mergedInto("a", "dup-renamed"), { track: "a", slug: "keeper" })
  assert.equal(readers.mergedInto("b", "keeper"), null, "a task with its own card was not merged")
  assert.equal(readers.mergedInto("a", "never"), null, "nor was a task Git never saw")
  assert.equal(readers.mergedInto("not a segment", "dup"), null)
  assert.equal(createDeskReaders({ deskRoot: path.join(scratch, "no-such-desk") }).mergedInto("a", "dup"), null, "a Git failure follows nothing")
})

test("a deleted, never-renamed folder returns null", () => {
  const repo = renameRepo("rename-deleted")
  writeIn(repo, "a/gone/task.md", taskCard("rename-deleted"))
  writeIn(repo, "a/kept/task.md", taskCard("rename-deleted-kept"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "a/kept", "a/kept-renamed", "2026-09-25T09:00:00Z")
  removeIn(repo, "a/gone/task.md")
  commitIn(repo, "2026-09-25T10:00:00Z", "delete")
  const { readTask } = createDeskReaders({ deskRoot: repo })
  assert.equal(readTask("a", "gone"), null)
  assert.equal(readTask("a", "kept").status, "processing")
})

test("a rename lookup in a desk that is not its own repository, has no commits, or whose Git fails gives null without throwing", () => {
  const plain = path.join(scratch, "rename-plain")
  mkdirSync(path.join(plain, "a/x"), { recursive: true })
  assert.equal(createDeskReaders({ deskRoot: plain }).readTask("a", "old"), null)
  const empty = renameRepo("rename-empty")
  assert.equal(createDeskReaders({ deskRoot: empty }).readTask("a", "old"), null)
  const repo = renameRepo("rename-gitfail")
  writeIn(repo, "a/old/task.md", taskCard("rename-gitfail"))
  commitIn(repo, "2026-09-25T08:00:00Z", "add")
  moveIn(repo, "a/old", "b/new", "2026-09-25T09:00:00Z")
  const wrapper = path.join(scratch, "git-no-log.sh")
  writeFileSync(wrapper, '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "log" ] && exit 1; done\nexec git "$@"\n')
  chmodSync(wrapper, 0o755)
  assert.equal(createDeskReaders({ deskRoot: repo, git: wrapper }).readTask("a", "old"), null)
  assert.equal(createDeskReaders({ deskRoot: repo, git: path.join(scratch, "no-such-git") }).readTask("a", "old"), null)
})

// --- deskCommitsBetween: the commits this clone made -------------------------------------

const between = (start, end, root = desk) => createDeskReaders({ deskRoot: root }).deskCommitsBetween(start, end)

test("deskCommitsBetween lists this clone's commit made in the window, once, with every path it changed", () => {
  assert.deepEqual(between("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z"), [{
    sha: shas.second,
    committed_at: "2026-09-25T08:20:01.000Z",
    taskPaths: ["track/_archive/old-task/notes.md", "track/_archive/old-task/task.md", "track/live-task/notes with space.md"],
  }])
  assert.deepEqual(between("2026-09-25T08:20:02.000Z", "2026-09-25T08:25:00.000Z"), [], "the window's end bounds it")
})

test("deskCommitsBetween never lists a commit fetched or pulled from another clone, nor the pull itself", () => {
  assert.deepEqual(between("2026-09-25T08:39:59.000Z", "2026-09-25T08:45:05.000Z"), [])
  assert.deepEqual(between("2026-09-25T09:59:59.000Z", "2026-09-25T10:00:05.000Z"), [])
})

test("deskCommitsBetween lists a commit and its amend, and a commit later rebased keeps its original entry", () => {
  assert.deepEqual(between("2026-09-25T09:00:00.000Z", "2026-09-25T09:05:00.000Z").map(({ sha, taskPaths }) => ({ sha, taskPaths })), [
    { sha: shas.amended, taskPaths: ["track/amended-task/notes.md", "track/amended-task/task.md"] },
    { sha: shas.beforeAmend, taskPaths: ["track/amended-task/task.md"] },
  ])
  assert.deepEqual(between("2026-09-25T09:29:59.000Z", "2026-09-25T09:30:05.000Z"), [
    { sha: shas.preRebase, committed_at: "2026-09-25T09:30:00.000Z", taskPaths: ["track/other-task/notes.md", "track/other-task/task.md"] },
  ])
  assert.deepEqual(between("2026-09-25T10:59:59.000Z", "2026-09-25T11:00:05.000Z"), [], "the rebase's own entries are not commits")
})

test("deskCommitsBetween skips checkouts and git merge entries, and lists a hand-committed merge with only the files resolved", () => {
  assert.deepEqual(between("2026-09-25T11:58:00.000Z", "2026-09-25T12:00:25.000Z").map(({ sha }) => sha).sort(), [shas.main, shas.side].sort())
  assert.deepEqual(between("2026-09-25T12:30:25.000Z", "2026-09-25T12:30:35.000Z"), [
    { sha: shas.conflictMerge, committed_at: "2026-09-25T12:30:30.000Z", taskPaths: ["track/live-task/task.md"] },
  ])
})

test("the desk's initial commit is listed too, so a desk's first commit can bind", () => {
  assert.deepEqual(between("2026-09-25T07:59:59.000Z", "2026-09-25T08:00:05.000Z"), [
    { sha: shas.first, committed_at: "2026-09-25T08:00:00.000Z", taskPaths: ["track/live-task/task.md"] },
  ])
})

test("Git ignores GIT_* variables the caller inherited, so a hook's GIT_DIR cannot point it at another repository", () => {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE }
  process.env.GIT_DIR = path.join(os.tmpdir(), "desk-repo-not-a-repository")
  process.env.GIT_WORK_TREE = os.tmpdir()
  try {
    assert.deepEqual(between("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z").map(({ sha }) => sha), [shas.second])
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("deskCommitsBetween returns nothing for an invalid window, outside a repository, or when Git is missing", () => {
  assert.deepEqual(between("yesterday", "2026-09-25T08:20:02.000Z"), [])
  assert.deepEqual(between("2026-09-25T08:20:02.000Z", "2026-09-25T08:20:01.000Z"), [])
  assert.deepEqual(between("2026-09-25T08:20:01.000Z", 5), [])
  const outside = mkdtempSync(path.join(os.tmpdir(), "desk-repo-none-"))
  try {
    assert.deepEqual(between("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z", outside), [])
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
  const noGit = createDeskReaders({ deskRoot: desk, git: path.join(desk, "no-such-git") })
  assert.deepEqual(noGit.deskCommitsBetween("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z"), [])
})

test("a desk root that is not its repository's top level reads no history and no remote: Git never walks up", () => {
  const inner = path.join(desk, "track")
  assert.deepEqual(between("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z", inner), [])
  assert.deepEqual(createDeskReaders({ deskRoot: inner }).gitCommitTaskPaths(shas.second), { exists: false, taskPaths: [] })
  assert.equal(readDeskRemote({ deskRoot: inner }), null)
  assert.equal(readDeskRemote({ deskRoot: desk }), origin)
})

test("a repository with no commits yet lists nothing", () => {
  const empty = path.join(scratch, "empty")
  mkdirSync(empty)
  gitIn(empty, ["init", "-q", "-b", "main"])
  assert.deepEqual(between("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z", empty), [])
})

test("a stand-in Git whose branch listing fails lists nothing", () => {
  const fakeGit = path.join(scratch, "fake-git-no-refs.sh")
  writeFileSync(fakeGit, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = for-each-ref ] && exit 1; done\nexec git "$@"\n`, { mode: 0o755 })
  assert.deepEqual(createDeskReaders({ deskRoot: desk, git: fakeGit }).deskCommitsBetween("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z"), [])
})

test("reflog lines with an unreadable time are skipped", () => {
  const fakeGit = path.join(scratch, "fake-git-bad-time.sh")
  const record = `\x1e${"a".repeat(40)}\x1fHEAD@{not a time}\x1fcommit: x\x00\ntrack/t/task.md\x00\x1e${"b".repeat(40)}\x1fHEAD\x1fcommit: y\x00`
  writeFileSync(fakeGit, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = --walk-reflogs ] && { printf '${record.replaceAll("\x1e", "\\036").replaceAll("\x1f", "\\037").replaceAll("\x00", "\\000").replaceAll("\n", "\\n")}'; exit 0; }; done\nexec git "$@"\n`, { mode: 0o755 })
  assert.deepEqual(createDeskReaders({ deskRoot: desk, git: fakeGit }).deskCommitsBetween("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z"), [])
})

// --- gitCommitTaskPaths ------------------------------------------------------------------

test("gitCommitTaskPaths confirms a desk commit and lists what it changed, the root commit included", () => {
  const { gitCommitTaskPaths } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(gitCommitTaskPaths(shas.first), { exists: true, taskPaths: ["track/live-task/task.md"] })
  assert.deepEqual(gitCommitTaskPaths(shas.fetched), { exists: true, taskPaths: ["track/fetched-task/task.md"] }, "a native ref needs only to exist in the desk")
})

test("gitCommitTaskPaths reports a commit Git confirms but cannot list as changing nothing", { skip: process.platform === "win32" ? "the stand-in Git is a #!/bin/sh script, which Windows cannot execute as a program" : false }, () => {
  // A stand-in Git that confirms every commit, finds the desk, and fails every other command.
  const fakeGit = path.join(desk, "..", `${path.basename(desk)}-fake-git.sh`)
  writeFileSync(fakeGit, "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = cat-file ] && exit 0; [ \"$arg\" = rev-parse ] && exec git \"$@\"; done\nexit 1\n", { mode: 0o755 })
  try {
    const { gitCommitTaskPaths } = createDeskReaders({ deskRoot: desk, git: fakeGit })
    assert.deepEqual(gitCommitTaskPaths(shas.first), { exists: true, taskPaths: [] })
  } finally {
    rmSync(fakeGit, { force: true })
  }
})

test("gitCommitTaskPaths says a commit that is not in the desk, or is not a SHA, does not exist", () => {
  const { gitCommitTaskPaths } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(gitCommitTaskPaths("0".repeat(40)), { exists: false, taskPaths: [] })
  assert.deepEqual(gitCommitTaskPaths("--output=/tmp/x"), { exists: false, taskPaths: [] })
  assert.deepEqual(gitCommitTaskPaths(shas.first.toUpperCase()), { exists: false, taskPaths: [] })
})

// --- isCardHousekeeping ------------------------------------------------------------------

const housekeeping = (sha, filePath) => createDeskReaders({ deskRoot: desk }).isCardHousekeeping(sha, filePath)

test("isCardHousekeeping is true for a card modified in place with only an exempt frontmatter field changed", () => {
  assert.equal(housekeeping(shas.oldTaskHousekeeping, "track/_archive/old-task/task.md"), true)
})

test("isCardHousekeeping is true on both sides of a move with byte-identical content, found through Git's rename detection", () => {
  assert.equal(housekeeping(shas.movableArchived, "track/movable-task/task.md"), true, "the old path")
  assert.equal(housekeeping(shas.movableArchived, "track/_archive/movable-task/task.md"), true, "the new path")
})

test("isCardHousekeeping is false for a card's body change, even with the frontmatter untouched", () => {
  assert.equal(housekeeping(shas.editCasesBody, "track/edit-cases-task/task.md"), false)
})

test("isCardHousekeeping is false for a non-exempt frontmatter field change, even with the body untouched", () => {
  assert.equal(housekeeping(shas.editCasesStatus, "track/edit-cases-task/task.md"), false)
})

test("isCardHousekeeping is false for a path this commit only added or only removed: no prior or no new version to compare", () => {
  assert.equal(housekeeping(shas.editCasesCreated, "track/edit-cases-task/task.md"), false, "a pure add")
  assert.equal(housekeeping(shas.editCasesDeleted, "track/edit-cases-task/task.md"), false, "a pure delete")
})

test("isCardHousekeeping is false when the path was not part of the commit at all", () => {
  assert.equal(housekeeping(shas.first, "track/live-task/notes.md"), false)
})

test("isCardHousekeeping is false for a bad path, a bad or missing SHA, or a desk root that is not its repository's top level", () => {
  assert.equal(housekeeping(shas.first, ""), false)
  assert.equal(housekeeping(shas.first, 7), false)
  assert.equal(housekeeping("0".repeat(40), "track/live-task/task.md"), false)
  assert.equal(housekeeping("not-a-sha", "track/live-task/task.md"), false)
  const inner = createDeskReaders({ deskRoot: path.join(desk, "track") })
  assert.equal(inner.isCardHousekeeping(shas.first, "track/live-task/task.md"), false)
})

test("isCardHousekeeping is false when Git cannot list the commit's changes", () => {
  const fakeGit = path.join(scratch, "fake-git-no-diff-tree.sh")
  writeFileSync(fakeGit, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = diff-tree ] && exit 1; done\nexec git "$@"\n`, { mode: 0o755 })
  assert.equal(createDeskReaders({ deskRoot: desk, git: fakeGit }).isCardHousekeeping(shas.oldTaskHousekeeping, "track/_archive/old-task/task.md"), false)
})

test("isCardHousekeeping is false when Git lists the change but cannot read the old or new content", () => {
  const fakeGit = path.join(scratch, "fake-git-no-show.sh")
  writeFileSync(fakeGit, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = show ] && exit 1; done\nexec git "$@"\n`, { mode: 0o755 })
  assert.equal(createDeskReaders({ deskRoot: desk, git: fakeGit }).isCardHousekeeping(shas.oldTaskHousekeeping, "track/_archive/old-task/task.md"), false)
})

test("isCardHousekeeping is false for a card with no frontmatter at all, on either side of the edit", () => {
  assert.equal(housekeeping(shas.noFrontmatterEdited, "track/no-frontmatter-edit/task.md"), false)
})

test("isCardHousekeeping is false for a card whose frontmatter is opened but never closed, on either side of the edit", () => {
  assert.equal(housekeeping(shas.unclosedEdited, "track/unclosed-frontmatter-edit/task.md"), false)
})

test("isCardHousekeeping is false when only a nested frontmatter value changes, such as a repos: entry's branch_base, even though no exempt field differs", () => {
  assert.equal(housekeeping(shas.nestedReposEdited, "track/nested-repos-task/task.md"), false)
})

test("isCardHousekeeping is false when Git's list of the commit's changes is truncated right after a status, with no path to go with it", () => {
  const fakeGit = path.join(scratch, "fake-git-truncated-status.sh")
  writeFileSync(fakeGit, "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = diff-tree ] && { printf 'M\\000'; exit 0; }; done\nexec git \"$@\"\n", { mode: 0o755 })
  assert.equal(createDeskReaders({ deskRoot: desk, git: fakeGit }).isCardHousekeeping(shas.first, "track/live-task/task.md"), false)
})

test("isCardHousekeeping is false when Git's list of the commit's changes is truncated after a rename's old path, with no new path to go with it", () => {
  const fakeGit = path.join(scratch, "fake-git-truncated-rename.sh")
  writeFileSync(fakeGit, "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = diff-tree ] && { printf 'R100\\000onlypath\\000'; exit 0; }; done\nexec git \"$@\"\n", { mode: 0o755 })
  assert.equal(createDeskReaders({ deskRoot: desk, git: fakeGit }).isCardHousekeeping(shas.first, "track/live-task/task.md"), false)
})

// --- isCardHousekeeping: tidy-rewrite extensions (quote normalization and same-commit rename substitutions) -------

test("isCardHousekeeping is true for a quote-only frontmatter rewrite: scalar and list-item quoting normalized, nothing else different", () => {
  assert.equal(housekeeping(shas.quoteOnlyEdited, "quote-only-task/task.md"), true, "a scalar's quoting")
  assert.equal(housekeeping(shas.quoteListEdited, "quote-list-task/task.md"), true, "a list item's quoting")
})

test("isCardHousekeeping is true when a card's only change is a reference to a path this same commit renamed", () => {
  assert.equal(housekeeping(shas.refRewriteEdited, "ref-rewrite-card/task.md"), true)
})

test("isCardHousekeeping is true when a card's reference is to a directory this same commit's file rename implies was renamed, even for a file the commit never touches", () => {
  assert.equal(housekeeping(shas.dirRefEdited, "dir-ref-card/task.md"), true)
})

test("isCardHousekeeping is true when the renamed-path reference carries a leading prefix, such as a tilde path to another machine's desk", () => {
  assert.equal(housekeeping(shas.prefixedRefEdited, "prefixed-ref-card/task.md"), true)
})

test("isCardHousekeeping is false when a reference merely starts with a renamed directory's name: the substitution must not cross the path boundary", () => {
  assert.equal(housekeeping(shas.boundaryEdited, "boundary-ref-card/task.md"), false)
})

test("isCardHousekeeping is false for a real edit that rides along with a reference rewrite the commit's own rename explains", () => {
  assert.equal(housekeeping(shas.mixedEditEdited, "mixed-edit-card/task.md"), false)
})

test("isCardHousekeeping is false for a quoted value that contains a backslash: never normalized, so a quoting difference there is compared literally", () => {
  assert.equal(housekeeping(shas.escapedQuoteEdited, "escaped-quote-task/task.md"), false)
})

test("isCardHousekeeping is false for a commit with more rename pairs than the cap allows, even for a card whose own edit needs no substitution", () => {
  assert.equal(housekeeping(shas.renameCapEdited, "rename-cap-card/task.md"), false)
})

test("isCardHousekeeping is true for an unrelated card's own housekeeping touch, even when the same commit's whole-track rename is a bare word its body happens to mention as plain prose", () => {
  assert.equal(housekeeping(shas.soloRenameEdited, "solo-prose-card/task.md"), true)
})

// --- isCardHousekeeping: semantic frontmatter equality for pre-existing full-YAML-redump commits ------

test("isCardHousekeeping is true when a real track move's own commit also reformats a date-only value to that same date's midnight timestamp", () => {
  assert.equal(housekeeping(shas.dateEquivEdited, "date-equiv-task/task.md"), true)
})

test("isCardHousekeeping is false when a date-only value is paired with a non-midnight timestamp: a real change, not the known reformatting artifact", () => {
  assert.equal(housekeeping(shas.dateMismatchEdited, "date-mismatch-task/task.md"), false)
})

test("isCardHousekeeping is true when a real track move's own commit also adds a redundant .000 to a full (non-midnight) timestamp — the actual residual found in personal-desk's own tidy commit", () => {
  assert.equal(housekeeping(shas.millisEquivEdited, "millis-equiv-task/task.md"), true)
})

test("isCardHousekeeping is false when a timestamp's milliseconds actually change to a non-.000 value: a real change, not the known reformatting artifact", () => {
  assert.equal(housekeeping(shas.millisMismatchEdited, "millis-mismatch-task/task.md"), false)
})

test("isCardHousekeeping is true when a real track move's own commit also adds a trailing newline to a body that had none — the actual body-level residual found in personal-desk's own tidy commit", () => {
  assert.equal(housekeeping(shas.trailingNewlineEdited, "trailing-newline-task/task.md"), true)
})

test("isCardHousekeeping is false when more than one trailing newline separates the two bodies: a real change, not the known reformatting artifact", () => {
  assert.equal(housekeeping(shas.newlineMismatchEdited, "newline-mismatch-task/task.md"), false)
})

test("isCardHousekeeping is true when a real track move's own commit also folds a long single-line scalar into a >- block, or back", () => {
  assert.equal(housekeeping(shas.blockEquivEdited, "block-equiv-task/task.md"), true)
})

test("isCardHousekeeping is true when a real track move's own commit also turns a single-line |- literal block into that same one-line scalar, or back", () => {
  assert.equal(housekeeping(shas.literalEquivEdited, "literal-equiv-task/task.md"), true)
})

test("isCardHousekeeping is false when a block scalar's continuation has a blank line: folding it is never attempted, so it binds", () => {
  assert.equal(housekeeping(shas.blockBlankEdited, "block-blank-task/task.md"), false)
})

test("isCardHousekeeping is false when a block scalar's continuation lines are indented inconsistently: never folded, so it binds", () => {
  assert.equal(housekeeping(shas.blockIndentEdited, "block-indent-task/task.md"), false)
})

test("isCardHousekeeping is false for a bare > (clip) block scalar: only the strip (-) chomp indicator is folded, so a clip block is compared literally and binds", () => {
  assert.equal(housekeeping(shas.blockChompEdited, "block-chomp-task/task.md"), false)
})

test("isCardHousekeeping is false when two untouched fields swap order: entries are compared position by position, so a reordered key is a real difference", () => {
  assert.equal(housekeeping(shas.keyOrderEdited, "key-order-task/task.md"), false)
})

test("isCardHousekeeping is true when a bare top-level line that isn't a key: value pair at all — a raw comment — is untouched alongside the track patch", () => {
  assert.equal(housekeeping(shas.bareLineEdited, "bare-line-task/task.md"), true)
})

test("isCardHousekeeping is true when a blank line precedes every top-level key and is untouched alongside the track patch", () => {
  assert.equal(housekeeping(shas.leadingBlankEdited, "leading-blank-task/task.md"), true)
})

test("isCardHousekeeping is false when a block scalar with no indented content at all (an empty fold) changes to a real value: unparseable, so it binds", () => {
  assert.equal(housekeeping(shas.blockEmptyEdited, "block-empty-task/task.md"), false)
})

test("isCardHousekeeping is false when a block scalar's first continuation line is itself blank: there is no indentation to read the block's own indent from, so it binds", () => {
  assert.equal(housekeeping(shas.blockBlankFirstEdited, "block-blank-first-task/task.md"), false)
})

test("isCardHousekeeping is false when the tidy commit also adds a genuinely new field: entry counts differ, so it binds even though every shared field reads as unchanged", () => {
  assert.equal(housekeeping(shas.entryCountEdited, "entry-count-task/task.md"), false)
})

test("isCardHousekeeping caches a commit's diff-tree entries and derived substitutions per sha: a second call against the same sha and readers instance reuses them", () => {
  const readers = createDeskReaders({ deskRoot: desk })
  const first = readers.isCardHousekeeping(shas.blockEquivEdited, "block-equiv-task/task.md")
  const second = readers.isCardHousekeeping(shas.blockEquivEdited, "block-equiv-task/task.md")
  assert.equal(first, true)
  assert.equal(second, true)
})

// --- resolveJobIdentity (ourostack/desk#76): the birth path ------------------------------

const birth = (track, slug, options = {}) => resolveJobIdentity({ deskRoot: desk, track, slug, ...options })

test("resolveJobIdentity follows a plain rename back to the slug the card was first added at", () => {
  assert.deepEqual(birth("birth-rename", "new-slug"), { track: "birth-rename", slug: "origin-slug" })
})

test("resolveJobIdentity is unchanged across an archive move: the track and slug are the same either side", () => {
  assert.deepEqual(birth("birth-archive", "task-m"), { track: "birth-archive", slug: "task-m" })
})

test("resolveJobIdentity follows a track rename back through a later revert to the same original track", () => {
  assert.deepEqual(birth("birth-revert-a", "task-r"), { track: "birth-revert-a", slug: "task-r" })
})

test("resolveJobIdentity: a card deleted and re-created at the same slug keeps the newest occupant's own birth, never an unrelated predecessor's", () => {
  // task-origin is now an unrelated task (Z) that only reused the freed
  // slug; its own birth is where it landed, not task A's old history.
  assert.deepEqual(birth("birth-reborn", "task-origin"), { track: "birth-reborn", slug: "task-origin" })
  // task-elsewhere is task A, which really did move there; its birth is
  // correctly the original slug, not tangled up with task Z's later reuse.
  assert.deepEqual(birth("birth-reborn", "task-elsewhere"), { track: "birth-reborn", slug: "task-origin" })
})

test("resolveJobIdentity: two tasks that swap slugs in one commit each keep their own birth, documenting Git's own behavior here", () => {
  // Finding: a path Git sees on both sides of one commit is a
  // modification, never a rename candidate, so the swap is not read as
  // either task changing identity.
  assert.deepEqual(birth("birth-swap", "task-p"), { track: "birth-swap", slug: "task-p" })
  assert.deepEqual(birth("birth-swap", "task-q"), { track: "birth-swap", slug: "task-q" })
})

test("resolveJobIdentity falls back to the current path for a brand-new, uncommitted card: it has no Git history yet", () => {
  assert.deepEqual(birth("birth-uncommitted", "task-fresh"), { track: "birth-uncommitted", slug: "task-fresh" })
})

test("resolveJobIdentity falls back to the current path when the card is found neither live nor archived", () => {
  assert.deepEqual(birth("birth-track-missing", "no-such-task"), { track: "birth-track-missing", slug: "no-such-task" })
})

test("resolveJobIdentity falls back to the current path for a desk that is not a Git repository of its own", () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "desk-repo-not-git-"))
  try {
    writeIn(outside, "a-track/a-slug/task.md", card(["status: drafting"]))
    assert.deepEqual(resolveJobIdentity({ deskRoot: outside, track: "a-track", slug: "a-slug" }), { track: "a-track", slug: "a-slug" })
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test("resolveJobIdentity falls back to the current path when the desk root is not its repository's own top level", () => {
  // Git would otherwise walk up past `desk` into whatever repository
  // contains it, so a card found here must still not be birth-resolved.
  write("birth-nested-root/inner-track/inner-slug/task.md", card(["status: drafting"]))
  assert.deepEqual(
    resolveJobIdentity({ deskRoot: path.join(desk, "birth-nested-root"), track: "inner-track", slug: "inner-slug" }),
    { track: "inner-track", slug: "inner-slug" },
  )
})

test("resolveJobIdentity follows a rename under a person prefix too", () => {
  assert.deepEqual(birth("birth-person", "new-slug", { personPrefix: "desks/ari" }), { track: "birth-person", slug: "origin-slug" })
})

test("resolveJobIdentity refuses a bad deskRoot or personPrefix, and returns the given path outright for unsafe track/slug names", () => {
  assert.throws(() => resolveJobIdentity({ deskRoot: "relative", track: "t", slug: "s" }), TypeError)
  assert.throws(() => birth("t", "s", { personPrefix: "people/ari" }), TypeError)
  assert.deepEqual(birth("_meta", "s"), { track: "_meta", slug: "s" })
  assert.deepEqual(birth("t", "../s"), { track: "t", slug: "../s" })
})

test("resolveJobIdentity never throws for a Git failure: a broken git executable falls back to the current path", () => {
  assert.deepEqual(birth("birth-gitfail", "new-slug", { git: path.join(desk, "no-such-git") }), { track: "birth-gitfail", slug: "new-slug" })
})

test("resolveJobIdentity falls back to the current path when Git's own log output for the birth query has no header separator", () => {
  write("birth-malformed-git-1/origin-slug/task.md", card(["status: drafting"]))
  const fakeGit = path.join(scratch, "fake-git-no-header.sh")
  writeFileSync(fakeGit, "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = --diff-filter=A ] && { printf '\\036abcdefabcdefabcdefabcdefabcdefabcdefab'; exit 0; }; done\nexec git \"$@\"\n", { mode: 0o755 })
  assert.deepEqual(birth("birth-malformed-git-1", "origin-slug", { git: fakeGit }), { track: "birth-malformed-git-1", slug: "origin-slug" }, "a record with no NUL separator after the commit hash is unparseable, so the current path stands")
})

test("resolveJobIdentity falls back to the current path when Git's own log output for the birth query names no paths", () => {
  write("birth-malformed-git-2/origin-slug/task.md", card(["status: drafting"]))
  const fakeGit = path.join(scratch, "fake-git-no-paths.sh")
  writeFileSync(fakeGit, "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = --diff-filter=A ] && { printf '\\036abcdefabcdefabcdefabcdefabcdefabcdefab\\000'; exit 0; }; done\nexec git \"$@\"\n", { mode: 0o755 })
  assert.deepEqual(birth("birth-malformed-git-2", "origin-slug", { git: fakeGit }), { track: "birth-malformed-git-2", slug: "origin-slug" }, "a header with no path after it names no birth, so the current path stands")
})

test("resolveJobIdentity finds and follows the rename of a card under a whole archived track, and one archived a second time within it", () => {
  assert.deepEqual(birth("birth-whole-track", "task-w"), { track: "birth-whole-track", slug: "task-origin" }, "found at _archive/<track>/<slug>, not only <track>/_archive/<slug>")
  assert.deepEqual(birth("birth-doubly-archived", "task-d"), { track: "birth-doubly-archived", slug: "task-origin" }, "found at _archive/<track>/_archive/<slug>")
})

test("createDeskReaders's resolveJobIdentity wrapper agrees with the standalone function", () => {
  const { resolveJobIdentity: fromReaders } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(fromReaders("birth-rename", "new-slug"), birth("birth-rename", "new-slug"))
})

test("resolveJobIdentity caches a birth path per process: a later call for the same desk root and card returns the cached answer without needing Git again", () => {
  const first = birth("birth-cache", "task-cache-new")
  assert.deepEqual(first, { track: "birth-cache", slug: "task-cache-origin" }, "resolved correctly on the first, real call")
  const second = birth("birth-cache", "task-cache-new", { git: path.join(desk, "no-such-git-cache-test") })
  assert.deepEqual(second, first, "a broken git still returns the cached birth, so it was never invoked again")
})

test("resolveJobIdentity invalidates its birth-path cache when HEAD moves: a card path vacated and later reoccupied by a different task, within one process, gets the new occupant's own birth, not the old occupant's cached one", () => {
  // task-a is born at task-origin and renamed into task-slot: its own birth,
  // once resolved, is task-origin, not task-slot itself.
  write("birth-vacate/task-origin/task.md", fixtureCard("birth-vacate task A", "drafting"))
  commitAt("2026-09-27T08:12:00Z", "birth-vacate: create task A at task-origin")
  remove("birth-vacate/task-origin/task.md")
  write("birth-vacate/task-slot/task.md", fixtureCard("birth-vacate task A", "drafting"))
  commitAt("2026-09-27T08:12:10Z", "birth-vacate: task A moves into task-slot")

  const beforeVacate = birth("birth-vacate", "task-slot")
  assert.deepEqual(beforeVacate, { track: "birth-vacate", slug: "task-origin" }, "task A's own birth is task-origin, resolved and cached under the task-slot cache key")

  // task-a moves away, vacating task-slot; an unrelated task Z is then
  // freshly created there. If the cached answer above were reused as-is, a
  // later resolution would wrongly hand task Z task A's own birth.
  remove("birth-vacate/task-slot/task.md")
  write("birth-vacate/task-elsewhere/task.md", fixtureCard("birth-vacate task A", "drafting"))
  commitAt("2026-09-27T08:12:20Z", "birth-vacate: task A moves away to task-elsewhere, vacating task-slot")
  write("birth-vacate/task-slot/task.md", fixtureCard("birth-vacate task Z", "processing"))
  commitAt("2026-09-27T08:12:30Z", "birth-vacate: an unrelated task Z reoccupies task-slot")

  const afterReoccupy = birth("birth-vacate", "task-slot")
  assert.deepEqual(afterReoccupy, { track: "birth-vacate", slug: "task-slot" }, "task Z's own birth is task-slot itself: HEAD moved, so the stale cache entry was dropped rather than reused")
})

test("resolveJobIdentity shares one deadline across its Git calls and throws on reaching it, exactly as readDeskRemote does", () => {
  const deadlineDesk = mkdtempSync(path.join(os.tmpdir(), "desk-repo-birth-deadline-"))
  try {
    spawnSync("git", ["init", "-q", "-b", "main", deadlineDesk])
    writeIn(deadlineDesk, "t/s/task.md", card(["status: drafting"]))
    commitIn(deadlineDesk, "2026-09-27T08:13:00Z", "create")
    assert.deepEqual(
      resolveJobIdentity({ deskRoot: deadlineDesk, track: "t", slug: "s", deadline: performance.now() + 60_000 }),
      { track: "t", slug: "s" },
      "plenty of deadline left resolves normally",
    )
    assert.throws(
      () => resolveJobIdentity({ deskRoot: deadlineDesk, track: "t", slug: "s", deadline: 0.5, clock: () => 0 }),
      { code: "git_deadline" },
      "less than a millisecond left starts nothing",
    )
    // A Git call that returns at or after the deadline throws too, so a timed-out call never silently falls back to the current path.
    const readings = [0, 1000]
    assert.throws(
      () => resolveJobIdentity({ deskRoot: deadlineDesk, track: "t", slug: "s", deadline: 500, clock: () => readings.shift() ?? 1000 }),
      { code: "git_deadline" },
    )
  } finally {
    rmSync(deadlineDesk, { recursive: true, force: true })
  }
})

test("resolveJobIdentity never reads a Git call killed by its time limit or a signal as no birth, whatever it printed", () => {
  const killedDesk = mkdtempSync(path.join(os.tmpdir(), "desk-repo-birth-killed-"))
  try {
    // A real card must be found first (findCard has no Git of its own), so
    // this reaches the deadline-aware Git calls the fake spawn intercepts.
    writeIn(killedDesk, "t/s/task.md", card(["status: drafting"]))
    const killed = { status: null, signal: "SIGTERM", stdout: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) }
    const spawn = () => killed
    assert.throws(
      () => resolveJobIdentity({ deskRoot: killedDesk, track: "t", slug: "s", spawn, deadline: Infinity }),
      { code: "git_deadline" },
    )
  } finally {
    rmSync(killedDesk, { recursive: true, force: true })
  }
})

// A real Windows host's own path separators and drive letters, exercised
// through the same real Git history resolveJobIdentity's other tests use.
// Skipped everywhere but a real Windows host; nothing on another platform
// substitutes for it, since `path.sep`, `path.join` and `path.relative` are
// this process's own platform's, not injectable.
test("native: resolveJobIdentity follows a rename back to its birth slug on a real Windows checkout, backslashes and a drive letter included", {
  skip: process.platform === "win32" ? false : "requires a native Windows host",
}, () => {
  const winDesk = mkdtempSync(path.join(os.tmpdir(), "desk-repo-win-"))
  try {
    assert.ok(path.isAbsolute(winDesk) && /^[A-Za-z]:\\/u.test(winDesk), "a real Windows temp path is a drive letter followed by a backslash")
    spawnSync("git", ["init", "-q", "-b", "main", winDesk])
    writeIn(winDesk, "birth-win\\origin-slug\\task.md", fixtureCard("birth-win task", "drafting"))
    commitIn(winDesk, "2026-09-27T08:14:00Z", "birth-win: create")
    removeIn(winDesk, "birth-win\\origin-slug\\task.md")
    writeIn(winDesk, "birth-win\\new-slug\\task.md", fixtureCard("birth-win task", "drafting"))
    commitIn(winDesk, "2026-09-27T08:14:10Z", "birth-win: rename the slug")
    assert.deepEqual(resolveJobIdentity({ deskRoot: winDesk, track: "birth-win", slug: "new-slug" }), { track: "birth-win", slug: "origin-slug" })
  } finally {
    rmSync(winDesk, { recursive: true, force: true })
  }
})

// --- readDeskRemote ---------------------------------------------------------------------

test("readDeskRemote reads origin's URL, and is null with no origin or no repository", () => {
  git(["remote", "set-url", "origin", "git@github.com:Owner/Desk.git"])
  try {
    assert.equal(readDeskRemote({ deskRoot: desk }), "git@github.com:Owner/Desk.git")
    git(["remote", "remove", "origin"])
    assert.equal(readDeskRemote({ deskRoot: desk }), null)
  } finally {
    spawnSync("git", ["-C", desk, "remote", "remove", "origin"])
    git(["remote", "add", "origin", origin])
  }
  assert.equal(readDeskRemote({ deskRoot: path.join(os.tmpdir(), "desk-repo-missing-folder") }), null)
})

// --- The real readers drive binding end to end ---------------------------------------------

// Each call is `[start, end, ...paths]`: a `git commit` shell call in the desk and the desk-relative paths its `git add` or `git commit` named.
function bindWith(calls, events = {}) {
  return bindSession({
    events: { ...events, shellGitCommits: calls.map(([start, end, ...paths]) => ({ start, end, cwd: desk, paths: paths.map((named) => path.join(desk, named)) })) },
    session: { started_at: "2026-09-25T08:00:00.000Z", derived_through: "2026-09-26T09:00:00.000Z" },
    deskRoot: desk,
    deskRemote: null,
    personPrefix: "",
    ...createDeskReaders({ deskRoot: desk }),
  }).jobs
}
const idOf = (track, slug) => jobId({ deskRemote: `local:${realpathSync(desk)}`, personPrefix: "", track, slug })
const id = (slug) => idOf("track", slug)

test("end to end: a session's git commit call binds the task whose path it names, live or archived", () => {
  const window = ["2026-09-25T08:20:01.300Z", "2026-09-25T08:20:01.900Z"]
  const live = bindWith([[...window, "track/live-task/notes with space.md"]])
  assert.deepEqual(live.map(({ job, basis, observed }) => ({ job, basis, observed })), [{ job: id("live-task"), basis: ["desk_commit"], observed: { status: "processing", at: null } }])
  const archived = bindWith([[...window, "track/_archive/old-task/notes.md"]])
  assert.deepEqual(archived.map(({ job, basis, observed }) => ({ job, basis, observed })), [{ job: id("old-task"), basis: ["desk_commit"], observed: { status: "done", at: "2026-09-05T10:30:00.000Z" } }])
  // The task folder itself is a named path too.
  assert.deepEqual(bindWith([[...window, "track/live-task"]]).map(({ job }) => job), [id("live-task")])
  // Naming both in one call is one event on each, which makes neither a candidate.
  assert.deepEqual(bindWith([[...window, "track/live-task/notes with space.md", "track/_archive/old-task/notes.md"]]), [])
})

test("end to end: a real-git commit from the session's own refs whose only change to an archived card is housekeeping (only `updated:` differs) binds nothing", () => {
  // Finding 2: shas.oldTaskHousekeeping only bumps old-task's card's
  // `updated:` field; the body and every other field stay the same, so
  // isCardHousekeeping must call it housekeeping and this commit binds no job.
  assert.deepEqual(bindWith([], { nativeCommitShas: [{ sha: shas.oldTaskHousekeeping, agent: 0 }] }), [])
  // shas.second is real work on live-task and old-task: two tasks, one event each, so neither is a candidate.
  assert.deepEqual(bindWith([], { nativeCommitShas: [{ sha: shas.second, agent: 0 }] }), [])
})

test("end to end: a commit that lands while the session's git commit call runs binds nothing unless the call named its task", () => {
  // The other clone committed track/fetched-task at 08:40:00 and this clone
  // fetched it at 08:45; a session here had a git commit call spanning both.
  assert.deepEqual(bindWith([["2026-09-25T08:39:59.000Z", "2026-09-25T08:45:05.000Z"]]), [])
  // This clone's own commit to track/old-task and track/live-task at 08:20:01 is inside this window too.
  assert.deepEqual(bindWith([["2026-09-25T08:20:01.300Z", "2026-09-25T08:20:01.900Z"]]), [])
})

test("end to end, same clone: of two sessions whose git commit calls overlap one commit, only the one that named the task's path binds it", () => {
  const first = bindWith([["2026-09-25T09:29:58.000Z", "2026-09-25T09:30:01.000Z", "track/other-task/notes.md"]])
  const second = bindWith([["2026-09-25T09:29:59.500Z", "2026-09-25T09:30:03.000Z"]])
  assert.deepEqual(first.map(({ job }) => job), [id("other-task")])
  assert.deepEqual(second, [])
})

test("end to end: a real rename's job ID, through the real Git readers and bindSession together, is the birth path's, not the current path's (ourostack/desk#76)", () => {
  const jobs = bindWith([["2026-09-26T08:00:19.000Z", "2026-09-26T08:00:20.500Z", "birth-rename/new-slug/notes.md"]])
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: idOf("birth-rename", "origin-slug"), basis: ["desk_commit"] }])
  assert.notEqual(jobs[0].job, idOf("birth-rename", "new-slug"), "not the current (post-rename) path's own ID")
  // A session that touched the task under its old name, before the rename, is the same job.
  const before = bindWith([["2026-09-26T08:00:00.000Z", "2026-09-26T08:00:01.000Z", "birth-rename/origin-slug/task.md"], ["2026-09-26T08:00:19.000Z", "2026-09-26T08:00:20.500Z", "birth-rename/new-slug/notes.md"]])
  assert.deepEqual(before.map(({ job }) => job), [idOf("birth-rename", "origin-slug")])
})

test("readDeskRemote shares one deadline across its Git calls and throws on reaching it", () => {
  const desk = mkdtempSync(path.join(os.tmpdir(), "desk-repo-deadline-"))
  try {
    spawnSync("git", ["init", "-q", desk])
    spawnSync("git", ["-C", desk, "remote", "add", "origin", "https://github.com/acme/desk.git"])
    assert.equal(readDeskRemote({ deskRoot: desk, deadline: performance.now() + 60_000 }), "https://github.com/acme/desk.git")
    assert.throws(() => readDeskRemote({ deskRoot: desk, deadline: 0.5, clock: () => 0 }), { code: "git_deadline" }, "less than a millisecond left starts nothing")
    // A Git call that returns at or after the deadline throws, so a timed-out call never reads as "no remote".
    const readings = [0, 1000]
    assert.throws(() => readDeskRemote({ deskRoot: desk, deadline: 500, clock: () => readings.shift() ?? 1000 }), { code: "git_deadline" })
  } finally {
    rmSync(desk, { recursive: true, force: true })
  }
})

test("readDeskRemote never reads a Git call killed by its time limit or a signal as no remote, whatever it printed", () => {
  const killed = [
    { status: null, signal: "SIGTERM", stdout: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) },
    { status: null, signal: "SIGKILL", stdout: "" },
    { status: 0, signal: null, stdout: "\n", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) },
  ]
  for (const answer of killed) {
    for (const call of [0, 1]) {
      let calls = 0
      const spawn = () => (calls++ === call ? answer : { status: 0, signal: null, stdout: call === 1 && calls === 1 ? "\n" : "https://github.com/acme/desk.git\n" })
      assert.throws(() => readDeskRemote({ deskRoot: "/desk", spawn }), { code: "git_deadline" }, `${JSON.stringify(answer)} at call ${call}`)
      assert.throws(() => readDeskRemote({ deskRoot: "/desk", spawn: () => answer, deadline: Infinity }), { code: "git_deadline" })
    }
  }
  const ordinary = (outputs) => { let calls = 0; return () => outputs[calls++] }
  assert.equal(readDeskRemote({ deskRoot: "/desk", spawn: ordinary([{ status: 0, signal: null, stdout: "\n" }, { status: 0, signal: null, stdout: "https://github.com/acme/desk.git\n" }]) }), "https://github.com/acme/desk.git")
  assert.equal(readDeskRemote({ deskRoot: "/desk", spawn: ordinary([{ status: 0, signal: null, stdout: "\n" }, { status: 1, signal: null, stdout: "" }]) }), null, "an ordinary failure is still no remote")
  assert.equal(readDeskRemote({ deskRoot: "/desk", spawn: ordinary([{ status: 128, signal: null, stdout: "" }]) }), null)
})

// --- repoOfPath: the code repository a path outside the desk is in --------------

// A desk and code repositories built for one test; `run` gets their folder and a git that logs each call it is given.
function withRepos(run) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "desk-repo-of-path-")))
  try {
    const repo = (name, remote) => {
      const folder = path.join(root, name)
      mkdirSync(folder, { recursive: true })
      gitIn(folder, ["init", "-q", "-b", "main"])
      if (remote !== null) gitIn(folder, ["remote", "add", "origin", remote])
      return folder
    }
    const log = path.join(root, "git-calls.log")
    const loggingGit = path.join(root, "logging-git.sh")
    writeFileSync(loggingGit, `#!/bin/sh\necho "$*" >> '${log}'\nexec git "$@"\n`, { mode: 0o755 })
    const gitCalls = () => spawnSync("cat", [log], { encoding: "utf8" }).stdout.split("\n").filter((line) => line !== "")
    return run({ root, repo, loggingGit, gitCalls })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("repoOfPath names a path's repository as lowercase owner/name, for every remote form, from any depth, and for a file that is gone", () => withRepos(({ root, repo }) => {
  const deskRoot = repo("desk", "git@github.com:Me/My-Desk.git")
  const { repoOfPath } = createDeskReaders({ deskRoot })
  const scp = repo("scp", "git@github.com:OurOStack/Desk.git")
  const https = repo("https", "https://user:token@GitHub.com/Spoonjoy/Spoonjoy-V2/")
  const ssh = repo("ssh", "ssh://git@example.com:2222/Group/Sub/Tool.git")
  mkdirSync(path.join(scp, "src", "deep"), { recursive: true })
  writeFileSync(path.join(scp, "src", "deep", "file.js"), "x\n")
  assert.equal(repoOfPath(scp), "ourostack/desk")
  assert.equal(repoOfPath(path.join(scp, "src", "deep", "file.js")), "ourostack/desk")
  assert.equal(repoOfPath(path.join(scp, "src", "deep")), "ourostack/desk")
  // The nearest directory that still exists decides: a deleted file, in a folder that is gone too, is still in its repository.
  assert.equal(repoOfPath(path.join(scp, "gone", "also-gone", "file.js")), "ourostack/desk")
  assert.equal(repoOfPath(path.join(https, "README.md")), "spoonjoy/spoonjoy-v2")
  assert.equal(repoOfPath(path.join(ssh, "a.txt")), "sub/tool", "the last two path parts of a longer remote path")
  // A linked worktree's `.git` is a file; the path is still in the repository.
  writeFileSync(path.join(scp, "a.txt"), "a\n")
  commitIn(scp, "2026-09-25T08:00:00Z", "first")
  const linked = path.join(root, "linked")
  gitIn(scp, ["worktree", "add", "-q", linked, "-b", "side"])
  assert.equal(repoOfPath(path.join(linked, "a.txt")), "ourostack/desk")
}))

test("repoOfPath answers null for no repository, no remote, a remote with no owner and name, a missing folder tree, and anything that is not an absolute path", () => withRepos(({ root, repo }) => {
  const { repoOfPath } = createDeskReaders({ deskRoot: repo("desk", "git@github.com:Me/My-Desk.git") })
  const plain = path.join(root, "plain")
  mkdirSync(plain)
  assert.equal(repoOfPath(path.join(plain, "file.txt")), null, "not a repository")
  assert.equal(repoOfPath(path.join(root, "never", "was", "here.txt")), null, "nothing exists there, and nothing above it is a repository")
  assert.equal(repoOfPath(path.join(repo("no-remote", null), "a.txt")), null)
  assert.equal(repoOfPath(path.join(repo("local-remote", path.join(root, "some", "origin.git")), "a.txt")), null, "a local path is no owner/name")
  assert.equal(repoOfPath(path.join(repo("one-part", "https://example.com/solo.git"), "a.txt")), null)
  assert.equal(repoOfPath(path.join(repo("file-url", "file:///srv/git/tool.git"), "a.txt")), null)
  assert.equal(repoOfPath(path.join(repo("dots", "https://example.com/../tool"), "a.txt")), null, "an unsafe owner is no name")
  for (const bad of ["relative/path.js", "", null, undefined, 7]) assert.equal(repoOfPath(bad), null)
}))

test("repoLookup tells a repository, a true none and evidence that is not available apart", () => withRepos(({ root, repo }) => {
  const { repoLookup, repoOfPath } = createDeskReaders({ deskRoot: repo("desk", "git@github.com:Me/My-Desk.git") })
  const code = repo("code", "git@github.com:OurOStack/Desk.git")
  assert.deepEqual(repoLookup(path.join(code, "a.txt")), { repo: "ourostack/desk" })
  assert.deepEqual(repoLookup(path.join(code, "gone", "deep", "a.txt")), { repo: "ourostack/desk" }, "a deleted file is still in its repository")
  const plain = path.join(root, "plain")
  mkdirSync(plain)
  assert.deepEqual(repoLookup(plain), { none: true }, "an existing folder in no repository is a true none")
  assert.deepEqual(repoLookup(repo("no-origin", null)), { none: true }, "a repository with no origin is a true none")
  assert.deepEqual(repoLookup(path.join(root, "desk", "sub")), { none: true }, "the desk itself, even for a folder not made yet")
  for (const unknown of ["relative/dir", "", null, undefined, 7]) assert.deepEqual(repoLookup(unknown), { none: true })
  assert.equal(repoOfPath(plain), null)
  assert.equal(repoOfPath(path.join(code, "a.txt")), "ourostack/desk")
}))

test("repoLookup says unavailable for a folder that is gone (ENOENT) or under a file (ENOTDIR)", () => withRepos(({ root, repo }) => {
  const { repoLookup } = createDeskReaders({ deskRoot: repo("desk", "git@github.com:Me/My-Desk.git") })
  mkdirSync(path.join(root, "plain"))
  assert.deepEqual(repoLookup(path.join(root, "vanished")), { unavailable: true }, "ENOENT")
  assert.deepEqual(repoLookup(path.join(root, "vanished", "deeper", "out.txt")), { unavailable: true })
  const file = path.join(root, "plain", "file.txt")
  writeFileSync(file, "x")
  assert.deepEqual(repoLookup(path.join(file, "child")), { unavailable: true }, "ENOTDIR")
  assert.deepEqual(repoLookup(file), { none: true }, "a file that exists is looked up by its folder")
  assert.deepEqual(repoLookup(path.join(repo("no-remote", null), "src")), { unavailable: true }, "a folder that never existed in a repository with no origin")
}))

test("a deleted file is not lost evidence when its own folder exists, and is when its folder is gone", () => withRepos(({ root, repo }) => {
  const { repoLookup } = createDeskReaders({ deskRoot: repo("desk", "git@github.com:Me/My-Desk.git") })
  const file = { maybeFile: true }
  const plain = path.join(root, "plain")
  mkdirSync(plain)
  assert.deepEqual(repoLookup(path.join(plain, "gone.txt"), file), { none: true }, "an existing folder in no repository")
  assert.deepEqual(repoLookup(path.join(repo("no-origin", null), "gone.txt"), file), { none: true }, "an existing repository with no origin")
  assert.deepEqual(repoLookup(path.join(repo("code", "git@github.com:OurOStack/Desk.git"), "gone.txt"), file), { repo: "ourostack/desk" })
  assert.deepEqual(repoLookup(path.join(root, "vanished", "gone.txt"), file), { unavailable: true }, "its folder is gone too")
  assert.deepEqual(repoLookup(path.join(plain, "gone.txt")), { unavailable: true }, "asked as a folder, a missing path is a folder that is gone")
}))

test("repoLookup names a nested repository root itself, and a file by the repository that holds its folder", () => withRepos(({ repo }) => {
  const { repoLookup } = createDeskReaders({ deskRoot: repo("desk", "git@github.com:Me/My-Desk.git") })
  const parent = repo("parent", "git@github.com:Some/Parent.git")
  const nested = path.join(parent, "nested")
  mkdirSync(nested)
  gitIn(nested, ["init", "-q", "-b", "main"])
  gitIn(nested, ["remote", "add", "origin", "git@github.com:Some/Nested.git"])
  writeFileSync(path.join(nested, "a.txt"), "x")
  assert.deepEqual(repoLookup(nested), { repo: "some/nested" })
  assert.deepEqual(repoLookup(path.join(nested, "a.txt")), { repo: "some/nested" })
  assert.deepEqual(repoLookup(parent), { repo: "some/parent" })
}))

test("repoLookup says unavailable for a stat error that is not a missing folder, such as a permission error", { skip: process.getuid?.() === 0 || process.platform === "win32" }, () => withRepos(({ root, repo }) => {
  const { repoLookup } = createDeskReaders({ deskRoot: repo("desk", "git@github.com:Me/My-Desk.git") })
  const locked = path.join(root, "locked")
  mkdirSync(path.join(locked, "inner"), { recursive: true })
  chmodSync(locked, 0)
  try {
    assert.deepEqual(repoLookup(path.join(locked, "inner")), { unavailable: true })
    assert.deepEqual(repoLookup(path.join(locked, "inner", "gone", "x.txt")), { unavailable: true })
  } finally {
    chmodSync(locked, 0o755)
  }
}))

test("repoLookup says unavailable when Git fails or times out, and none when Git cleanly reports no origin", { skip: process.platform === "win32" ? "a #!/bin/sh script cannot stand in for git on Windows: it cannot be started without a shell" : false }, () => withRepos(({ root, repo }) => {
  const deskRoot = repo("desk", "git@github.com:Me/My-Desk.git")
  const code = repo("code", "git@github.com:OurOStack/Desk.git")
  const script = (name, body) => {
    const file = path.join(root, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }
  assert.deepEqual(createDeskReaders({ deskRoot, git: script("failing.sh", "exit 128") }).repoLookup(code), { unavailable: true })
  assert.deepEqual(createDeskReaders({ deskRoot, git: path.join(root, "no-such-git") }).repoLookup(code), { unavailable: true })
  assert.deepEqual(createDeskReaders({ deskRoot, git: script("slow.sh", "sleep 5"), timeoutMs: 100 }).repoLookup(code), { unavailable: true }, "a timeout")
  assert.deepEqual(createDeskReaders({ deskRoot, git: script("unset.sh", "exit 1") }).repoLookup(code), { none: true }, "exit 1 is `config --get` reporting no origin")
}))

test("repoOfPath answers null when Git fails or is missing", () => withRepos(({ root, repo }) => {
  const deskRoot = repo("desk", "git@github.com:Me/My-Desk.git")
  const code = repo("code", "git@github.com:OurOStack/Desk.git")
  const failing = path.join(root, "failing-git.sh")
  writeFileSync(failing, "#!/bin/sh\nexit 128\n", { mode: 0o755 })
  assert.equal(createDeskReaders({ deskRoot, git: failing }).repoOfPath(path.join(code, "a.txt")), null)
  assert.equal(createDeskReaders({ deskRoot, git: path.join(root, "no-such-git") }).repoOfPath(path.join(code, "a.txt")), null)
  assert.equal(createDeskReaders({ deskRoot }).repoOfPath(path.join(code, "a.txt")), "ourostack/desk")
}))

test("repoOfPath asks Git once per repository and remembers each directory", { skip: process.platform === "win32" ? "a #!/bin/sh script cannot stand in for git on Windows: it cannot be started without a shell" : false }, () => withRepos(({ repo, loggingGit, gitCalls }) => {
  const deskRoot = repo("desk", "git@github.com:Me/My-Desk.git")
  const code = repo("code", "git@github.com:OurOStack/Desk.git")
  mkdirSync(path.join(code, "src"))
  const { repoOfPath } = createDeskReaders({ deskRoot, git: loggingGit })
  const before = gitCalls().length
  for (const file of ["a.js", "b.js", "src/c.js", "src/d.js", "src/missing/e.js"]) assert.equal(repoOfPath(path.join(code, file)), "ourostack/desk")
  const calls = gitCalls().slice(before).filter((line) => line.includes("remote.origin.url"))
  // One call for the repository and one for the desk's own remote, however many paths and directories.
  assert.deepEqual(calls.map((line) => line.split(" ")[1]), [code, deskRoot])
  // A second set of readers has its own memory.
  assert.equal(createDeskReaders({ deskRoot, git: loggingGit }).repoOfPath(path.join(code, "a.js")), "ourostack/desk")
  assert.equal(gitCalls().slice(before).filter((line) => line.includes("remote.origin.url")).length, 4)
}))

test("repoOfPath answers null for the desk repository itself: a path inside the desk, and another clone of the desk's remote", () => withRepos(({ root, repo, loggingGit, gitCalls }) => {
  const deskRoot = repo("desk", "git@github.com:Me/My-Desk.git")
  mkdirSync(path.join(deskRoot, "track", "task"), { recursive: true })
  const { repoOfPath } = createDeskReaders({ deskRoot, git: loggingGit })
  assert.equal(repoOfPath(path.join(deskRoot, "track", "task", "notes.md")), null)
  assert.equal(repoOfPath(deskRoot), null)
  assert.deepEqual(gitCalls().filter((line) => line.includes("remote.origin.url")), [], "a path inside the desk needs no Git call")
  // The same remote, spelled another way, checked out elsewhere (a second clone or a worktree of the desk).
  assert.equal(repoOfPath(path.join(repo("desk-again", "https://github.com/me/my-desk"), "track", "x.md")), null)
  // A desk with no remote still names other repositories, and a desk root that does not exist reads as no desk remote.
  const local = createDeskReaders({ deskRoot: repo("local-desk", null) })
  assert.equal(local.repoOfPath(path.join(repo("code", "git@github.com:OurOStack/Desk.git"), "a.js")), "ourostack/desk")
  assert.equal(createDeskReaders({ deskRoot: path.join(root, "no-desk-here") }).repoOfPath(path.join(root, "code", "a.js")), "ourostack/desk")
}))

// --- readOutcome -----------------------------------------------------------------

const OUTCOME_FIELDS = [
  "status: done",
  "updated: 2026-09-25T09:00:00Z",
  "signoff:",
  "  state: accepted",
  "  at: 2026-09-25T09:20:00.000Z",
  "  verified: true",
  "flow:",
  "  since: created",
  "  rev: 4",
  "  reached: done",
  "  delivered_at: 2026-09-25T09:00:00.000Z",
  "  deliveries: 1",
]

function outcomeDesk() {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "desk-outcome-")))
  writeIn(home, "track/live/task.md", card(OUTCOME_FIELDS))
  writeIn(home, "track/_archive/old/task.md", card(OUTCOME_FIELDS))
  writeIn(home, "_archive/gone-track/task-a/task.md", card(OUTCOME_FIELDS))
  writeIn(home, "_archive/gone-track/_archive/task-b/task.md", card(OUTCOME_FIELDS))
  writeIn(home, "track/legacy/task.md", card(["status: done", "updated: 2026-09-24T08:00:00Z"]))
  writeIn(home, "track/odd-status/task.md", card(["status: nonsense", "updated: not a time"]))
  return home
}

test("readOutcome gives the card's record, its status and the time of its last update", () => {
  const home = outcomeDesk()
  try {
    const { readOutcome } = createDeskReaders({ deskRoot: home })
    const found = readOutcome("track", "live")
    assert.equal(found.status, "done")
    assert.equal(found.evidenceAt, "2026-09-25T09:00:00.000Z")
    assert.deepEqual(found.record.signoff, { state: "accepted", at: "2026-09-25T09:20:00.000Z", verified: true, reason: null })
    assert.equal(found.record.flow.rev, 4)
    assert.equal(found.record.flow.deliveries, 1)
    assert.deepEqual(found.record.returns, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("an archived card is found, in each of the four places a card can lie", () => {
  const home = outcomeDesk()
  try {
    const { readOutcome } = createDeskReaders({ deskRoot: home })
    for (const [track, slug] of [["track", "old"], ["gone-track", "task-a"], ["gone-track", "task-b"]]) {
      assert.equal(readOutcome(track, slug)?.record.flow.rev, 4, `${track}/${slug}`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("readOutcome gives an empty record for a legacy card, null status and time for unreadable fields, and null when no card exists or the names are unsafe", () => {
  const home = outcomeDesk()
  try {
    const { readOutcome } = createDeskReaders({ deskRoot: home })
    assert.deepEqual(readOutcome("track", "legacy"), { record: { signoff: null, flow: null, returns: [], returns_damaged: 0 }, status: "done", evidenceAt: "2026-09-24T08:00:00.000Z" })
    assert.deepEqual(readOutcome("track", "odd-status")?.status, null)
    assert.equal(readOutcome("track", "odd-status").evidenceAt, null)
    assert.equal(readOutcome("track", "missing"), null)
    for (const [track, slug] of [["..", "x"], ["track", "../live"], ["_meta", "x"], ["track", ""], [7, "x"]]) assert.equal(readOutcome(track, slug), null, `${track}/${slug}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("readOutcome follows a person prefix and a renamed task like readTask does", () => {
  const home = outcomeDesk()
  try {
    writeIn(home, "desks/ari/track/mine/task.md", card(OUTCOME_FIELDS))
    assert.equal(createDeskReaders({ deskRoot: home, personPrefix: "desks/ari" }).readOutcome("track", "mine")?.status, "done")
    assert.equal(createDeskReaders({ deskRoot: home }).readOutcome("track", "mine"), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("readOutcome follows Git's rename history to a task folder that moved", () => {
  const home = outcomeDesk()
  try {
    gitIn(home, ["init", "-q", "-b", "main"])
    writeIn(home, "track/before/task.md", fixtureCard("rename before", "done", ["signoff:", "  state: accepted", "  at: 2026-09-25T09:20:00.000Z", "  verified: true"]))
    commitIn(home, "2026-09-25T10:00:00Z", "add")
    gitIn(home, ["mv", "track/before", "track/after"])
    commitIn(home, "2026-09-25T10:05:00Z", "rename")
    const { readOutcome } = createDeskReaders({ deskRoot: home })
    assert.equal(readOutcome("track", "before")?.record.signoff.state, "accepted")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("desk-repo.js imports nothing from src/tools", () => {
  const source = readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/desk-repo.js", import.meta.url), "utf8")
  assert.equal(/from\s+["'][^"']*\/tools\//u.test(source), false)
})
