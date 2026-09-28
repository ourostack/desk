import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  findFilenameEquivalent,
  readMarkdown,
  serializeMarkdown,
  slugify,
  today,
  patchFrontmatterFields,
  patchMarkdownFrontmatter,
} from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { friction_add } from "../../../../../plugins/desk/mcp/src/tools/friction.js"
import { lesson_add } from "../../../../../plugins/desk/mcp/src/tools/lesson.js"
import { mkTempDeskRoot } from "../tools/_helpers.js"

test("vendored Unicode 16 category tables match their pinned source", async () => {
  const root = fileURLToPath(new URL("../../../../../plugins/desk/mcp/src/util/unicode-16/", import.meta.url))
  const expected = {
    "letter.cjs": "57b42eb5efb05e70fd7378a7998cd4502516ecffaa6ab1119255e45a49077ad4",
    "mark.cjs": "bcd99fa2bda1cc7b38be4a6d3f4713c96701bb42bfd7066b91d305e11eb3b48d",
    "number.cjs": "c9ed76f5842d76210411b7e46162a7b3c4b47196469d5c014a887bba762263f2",
  }

  for (const [file, hash] of Object.entries(expected)) {
    const bytes = await fs.readFile(path.join(root, file))
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash)
  }
})

test("filename equivalence is pinned across case and normalization", async () => {
  const root = await mkTempDeskRoot()
  const missing = path.join(root, "missing", "file.md")
  await assert.rejects(() => findFilenameEquivalent(missing), /confined candidate resolver/)
  assert.equal(
    await findFilenameEquivalent(missing, (name) => path.join(path.dirname(missing), name)),
    null,
  )

  const directory = path.join(root, "files")
  await fs.mkdir(directory, { recursive: true })
  const resolveCandidate = (name) => path.join(directory, name)
  await fs.writeFile(path.join(directory, "_CON.md"), "case", "utf8")
  assert.equal(
    path.basename(await findFilenameEquivalent(path.join(directory, "_con.md"), resolveCandidate)),
    "_CON.md",
  )
  await fs.writeFile(path.join(directory, "cafe\u0301.md"), "normalization", "utf8")
  assert.match(
    await fs.readFile(await findFilenameEquivalent(path.join(directory, "café.md"), resolveCandidate), "utf8"),
    /normalization/,
  )
  assert.equal(await findFilenameEquivalent(path.join(directory, "absent.md"), resolveCandidate), null)

  const nonDirectory = path.join(root, "not-a-directory")
  await fs.writeFile(nonDirectory, "file", "utf8")
  await assert.rejects(
    () => findFilenameEquivalent(
      path.join(nonDirectory, "child.md"),
      (name) => path.join(nonDirectory, name),
    ),
    (error) => error.code === "ENOTDIR",
  )
})

test("equivalent-name symlinks cannot escape lesson or friction roots", async () => {
  const root = await mkTempDeskRoot()
  const outside = await fs.mkdtemp(path.join(tmpdir(), "desk-slug-symlink-"))
  try {
    const outsideLesson = path.join(outside, "lesson.md")
    await fs.writeFile(outsideLesson, "# CON\n\nOutside.\n", "utf8")
    const tips = path.join(root, "_meta", "tips")
    await fs.mkdir(tips, { recursive: true })
    await fs.symlink(outsideLesson, path.join(tips, "_CON.md"))
    await assert.rejects(
      () => lesson_add({
        deskRoot: root,
        input: { topic: "CON", body: "Must stay confined." },
      }),
      /resolves outside effective write root/,
    )

    const outsideFriction = path.join(outside, "friction.md")
    await fs.writeFile(outsideFriction, "<!-- desk-friction:v2 theme=caf -->\n\nOutside.\n", "utf8")
    const frictionDirectory = path.join(root, "t1", "_friction")
    await fs.mkdir(frictionDirectory, { recursive: true })
    await fs.symlink(outsideFriction, path.join(frictionDirectory, `${today()}-CAF.md`))
    await assert.rejects(
      () => friction_add({
        deskRoot: root,
        input: { track: "t1", theme: "caf", body: "Must stay confined." },
      }),
      /resolves outside effective write root/,
    )
  } finally {
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("slugify preserves Unicode letters, marks, and numbers", () => {
  assert.equal(slugify(null), "")
  assert.equal(slugify("Working with gh CLI on EMU"), "working-with-gh-cli-on-emu")
  assert.equal(slugify("日本語の教訓"), "日本語の教訓")
  assert.equal(slugify("安全/路径"), "安全-路径")
  assert.equal(slugify("हिन्दी १२३"), "हिन्दी-१२३")
  assert.equal(slugify("café"), slugify("cafe\u0301"))
  assert.equal(slugify("H\u0331"), slugify("\u1E96"))
  assert.equal(slugify("J\u030C"), slugify("\u01F0"))
  assert.equal(slugify("H\u0331"), slugify("H\u0331").normalize("NFC"))
  assert.equal(slugify("Σ"), slugify("ς"))
  assert.equal(slugify("Straße"), slugify("STRASSE"))
  assert.notEqual(slugify("ı"), slugify("i"))
  assert.equal(slugify("\u1C89"), "\u1C8A")
  assert.equal(slugify("\u088F"), "")
  assert.equal(slugify("\u0628\u0897\u0618"), "\u0628\u0618\u0897")
  assert.equal(slugify("\u115F"), "\u115F")
  assert.equal(slugify("一\uFE00"), "一\uFE00")
  assert.equal(slugify("一\u{E0100}"), "一\u{E0100}")
  assert.notEqual(slugify("一\uFE00"), slugify("一 fe00"))
  assert.equal(slugify("A".repeat(5000)), "a".repeat(5000))
  assert.equal(slugify("❤️"), "")
  assert.equal(slugify("☀️"), "")
  assert.equal(slugify("✈️"), "")
  assert.equal(slugify("\u0301"), "")
  assert.equal(slugify("\u0345"), "")
  assert.equal(slugify("a ❤️ b"), "a-b")
  assert.equal(slugify("CON"), "_con")
  assert.equal(slugify("COM¹"), "_com¹")
  assert.equal(slugify("LPT³"), "_lpt³")
  assert.notEqual(slugify("CON"), slugify("x con"))
  assert.equal(slugify("COM0"), "com0")
  assert.equal(slugify("!!!"), "")
})

test("Unicode slugs reach lesson and track-friction file paths", async () => {
  const root = await mkTempDeskRoot()

  const lesson = await lesson_add({
    deskRoot: root,
    input: { topic: "日本語の教訓", body: "Lesson body." },
  })
  assert.equal(lesson.path, path.join("_meta", "tips", "日本語の教訓.md"))
  assert.match(await fs.readFile(path.join(root, lesson.path), "utf8"), /Lesson body/)

  const friction = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "安全/路径", body: "Friction body." },
  })
  assert.equal(path.dirname(friction.path), path.join("t1", "_friction"))
  assert.match(path.basename(friction.path), /^\d{4}-\d{2}-\d{2}-安全-路径\.md$/)
  assert.match(await fs.readFile(path.join(root, friction.path), "utf8"), /Friction body/)

  const reservedLesson = await lesson_add({
    deskRoot: root,
    input: { topic: "COM¹", body: "Windows-safe lesson." },
  })
  assert.equal(reservedLesson.path, path.join("_meta", "tips", "_com¹.md"))
})

test("reserved-name escaping stays distinct for both write orders", async () => {
  for (const topics of [["CON", "x con"], ["x con", "CON"]]) {
    const root = await mkTempDeskRoot()
    const lessonPaths = []
    const frictionPaths = []
    for (const topic of topics) {
      lessonPaths.push((await lesson_add({
        deskRoot: root,
        input: { topic, body: `Lesson for ${topic}.` },
      })).path)
      frictionPaths.push((await friction_add({
        deskRoot: root,
        input: { track: "t1", theme: topic, body: `Friction for ${topic}.` },
      })).path)
    }
    assert.notEqual(lessonPaths[0], lessonPaths[1])
    assert.notEqual(frictionPaths[0], frictionPaths[1])
  }
})

test("case-fold-equivalent inputs share lesson and friction paths", async () => {
  const root = await mkTempDeskRoot()

  const firstLesson = await lesson_add({
    deskRoot: root,
    input: { topic: "Σ", body: "First lesson." },
  })
  const secondLesson = await lesson_add({
    deskRoot: root,
    input: { topic: "ς", body: "Second lesson." },
  })
  assert.equal(secondLesson.path, firstLesson.path)
  assert.match(await fs.readFile(path.join(root, firstLesson.path), "utf8"), /Second lesson/)

  const firstFriction = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "Straße", body: "First friction." },
  })
  const secondFriction = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "STRASSE", body: "Second friction." },
  })
  assert.equal(secondFriction.path, firstFriction.path)
  assert.match(await fs.readFile(path.join(root, firstFriction.path), "utf8"), /Second friction/)
})

test("legacy paths are reused only when their identity is provable", async () => {
  const root = await mkTempDeskRoot()
  const lessonSlug = "caf"
  const lessonPath = path.join(root, "_meta", "tips", `${lessonSlug}.md`)
  await fs.mkdir(path.dirname(lessonPath), { recursive: true })
  await fs.mkdir(path.join(path.dirname(lessonPath), "a-directory.md"))
  await fs.writeFile(path.join(path.dirname(lessonPath), "a-note.txt"), "Ignored.\n", "utf8")
  await fs.writeFile(path.join(path.dirname(lessonPath), "a-no-heading.md"), "Ignored.\n", "utf8")
  await fs.writeFile(path.join(path.dirname(lessonPath), "b-other.md"), "# caf\n\nOther.\n", "utf8")
  await fs.writeFile(lessonPath, "# café\n\nOriginal lesson.\n", "utf8")

  const lesson = await lesson_add({
    deskRoot: root,
    input: { topic: "cafe\u0301", body: "Updated lesson." },
  })
  assert.equal(lesson.path, path.join("_meta", "tips", `${lessonSlug}.md`))
  assert.match(await fs.readFile(lessonPath, "utf8"), /Updated lesson/)

  const collisionRoot = await mkTempDeskRoot()
  const collisionPath = path.join(collisionRoot, "_meta", "tips", `${lessonSlug}.md`)
  await fs.mkdir(path.dirname(collisionPath), { recursive: true })
  await fs.writeFile(collisionPath, "# caf\n\nDifferent lesson.\n", "utf8")
  const collision = await lesson_add({
    deskRoot: collisionRoot,
    input: { topic: "café", body: "Specific lesson." },
  })
  assert.equal(collision.path, path.join("_meta", "tips", "café.md"))
  assert.equal(await fs.readFile(collisionPath, "utf8"), "# caf\n\nDifferent lesson.\n")

  const occupiedRoot = await mkTempDeskRoot()
  const occupiedDirectory = path.join(occupiedRoot, "_meta", "tips")
  await fs.mkdir(occupiedDirectory, { recursive: true })
  await fs.writeFile(path.join(occupiedDirectory, "caf.md"), "# café\n\nLegacy collision.\n", "utf8")
  await fs.writeFile(path.join(occupiedDirectory, "_caf.md"), "# café\n\nSecond collision.\n", "utf8")
  const occupied = await lesson_add({
    deskRoot: occupiedRoot,
    input: { topic: "caf", body: "Distinct ASCII lesson." },
  })
  assert.equal(occupied.path, path.join("_meta", "tips", "__caf.md"))
  const occupiedAgain = await lesson_add({
    deskRoot: occupiedRoot,
    input: { topic: "caf", body: "Second ASCII update." },
  })
  assert.equal(occupiedAgain.path, occupied.path)

  const reservedRoot = await mkTempDeskRoot()
  const reservedLegacyPath = path.join(reservedRoot, "_meta", "tips", "con.md")
  await fs.mkdir(path.dirname(reservedLegacyPath), { recursive: true })
  await fs.writeFile(reservedLegacyPath, "# CON\n\nOriginal reserved lesson.\n", "utf8")
  const occupiedReservedPath = path.join(path.dirname(reservedLegacyPath), "_CON.md")
  await fs.writeFile(occupiedReservedPath, "# Different topic\n\nMust survive.\n", "utf8")
  const reserved = await lesson_add({
    deskRoot: reservedRoot,
    input: { topic: "CON", body: "Updated reserved lesson." },
  })
  assert.equal(reserved.path, path.join("_meta", "tips", "__con.md"))
  await assert.rejects(() => fs.access(reservedLegacyPath), { code: "ENOENT" })
  assert.match(await fs.readFile(path.join(reservedRoot, reserved.path), "utf8"), /Original reserved lesson/)
  assert.equal(await fs.readFile(occupiedReservedPath, "utf8"), "# Different topic\n\nMust survive.\n")

  const frictionSlug = "ma-ana-notes"
  const frictionPath = path.join(root, "t1", "_friction", `${today()}-${frictionSlug}.md`)
  await fs.mkdir(path.dirname(frictionPath), { recursive: true })
  await fs.writeFile(frictionPath, "Original friction.\n", "utf8")

  const friction = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "mañana notes", body: "Updated friction." },
  })
  assert.equal(friction.path, path.join("t1", "_friction", `${today()}-mañana-notes.md`))
  assert.equal(await fs.readFile(frictionPath, "utf8"), "Original friction.\n")
  assert.match(await fs.readFile(path.join(root, friction.path), "utf8"), /Updated friction/)

  const ambiguousPath = path.join(root, "t1", "_friction", `${today()}-untitled.md`)
  await fs.writeFile(ambiguousPath, "Ambiguous legacy friction.\n", "utf8")
  const unicodeFriction = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "日本語の教訓", body: "Specific friction." },
  })
  assert.notEqual(unicodeFriction.path, path.relative(root, ambiguousPath))
  assert.match(unicodeFriction.path, /日本語の教訓\.md$/)
  assert.equal(await fs.readFile(ambiguousPath, "utf8"), "Ambiguous legacy friction.\n")

  const collidingLegacyPath = path.join(root, "t1", "_friction", `${today()}-x-con.md`)
  await fs.writeFile(collidingLegacyPath, "Legacy x-con friction.\n", "utf8")
  const reservedFriction = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "CON", body: "Reserved friction." },
  })
  assert.match(reservedFriction.path, /-_con\.md$/)
  assert.equal(await fs.readFile(collidingLegacyPath, "utf8"), "Legacy x-con friction.\n")

  const defaultFriction = await friction_add({
    deskRoot: root,
    input: { track: "t1", body: "New unthemed friction." },
  })
  assert.match(defaultFriction.path, /-_untitled\.md$/)
  assert.equal(await fs.readFile(ambiguousPath, "utf8"), "Ambiguous legacy friction.\n")

  const exactLegacyPath = path.join(root, "t1", "_friction", `${today()}-caf.md`)
  const occupiedNamespacePath = path.join(root, "t1", "_friction", `${today()}-_CAF.md`)
  await fs.writeFile(exactLegacyPath, "Legacy café friction.\n", "utf8")
  await fs.writeFile(occupiedNamespacePath, "Unverified namespace collision.\n", "utf8")
  const exactCollision = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "caf", body: "Distinct caf friction." },
  })
  assert.match(exactCollision.path, /-__caf\.md$/)
  const exactCollisionAgain = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "caf", body: "Second caf update." },
  })
  assert.equal(exactCollisionAgain.path, exactCollision.path)
  assert.equal(await fs.readFile(exactLegacyPath, "utf8"), "Legacy café friction.\n")
  assert.equal(await fs.readFile(occupiedNamespacePath, "utf8"), "Unverified namespace collision.\n")
})

test("readMarkdown reports a missing file clearly", async () => {
  const root = await mkTempDeskRoot()
  const missing = path.join(root, "missing.md")

  await assert.rejects(() => readMarkdown(missing), {
    message: `file does not exist: ${missing}`,
  })
})

test("readMarkdown preserves non-missing filesystem errors", async () => {
  const root = await mkTempDeskRoot()

  await assert.rejects(
    () => readMarkdown(root),
    (error) => error.code === "EISDIR",
  )
})

test("readMarkdown returns concrete data and content without frontmatter", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "plain.md")
  await fs.writeFile(filePath, "Plain body.\n", "utf8")

  assert.deepEqual(await readMarkdown(filePath), {
    data: {},
    content: "Plain body.\n",
  })
})

test("serializeMarkdown handles empty and already-prefixed content", () => {
  assert.equal(serializeMarkdown({}, null), "\n")
  assert.equal(serializeMarkdown({}, "\nBody.\n"), "\nBody.\n")
})

// --- patchFrontmatterFields / patchMarkdownFrontmatter ------------------------------------
//
// A mover/renamer/archiver only ever changes a small, known set of fields
// (`track`, `updated`, `status`, `merged_into`, `factory_report`). These
// prove every other byte of a hand-written card — a date-only value, a long
// single-line scalar, quoted and unquoted values, a `note: |` block, key
// order, and a trailing comment — survives untouched, which
// `serializeMarkdown`'s full YAML re-dump cannot guarantee.

const HAND_WRITTEN_CARD = [
  "---",
  "schema_version: 1",
  "title: Rename the desk card mover's tests to match",
  "track: old-track",
  "status: drafting",
  "created: 2026-05-26",
  "requester: \"ari\"",
  "reviewer: ari",
  "purpose: A long single-line scalar describing the task in one uninterrupted run of prose, exactly as a human first typed it, with no wrapping.",
  "note: |",
  "  first literal line",
  "  second literal line",
  "repos:",
  "  - name: alpha",
  "    branch_base: main",
  "updated: \"2026-09-20T10:00:00Z\" # last touched by hand",
  "---",
  "",
  "# A task",
  "",
  "Body text, never touched by a frontmatter patch.",
  "",
].join("\n")

test("patchFrontmatterFields changes only the named fields and leaves every other byte, including a date-only value, a long single-line scalar, quoted and unquoted values, a note: | block, nested repos:, key order, and a trailing comment", () => {
  const patched = patchFrontmatterFields(HAND_WRITTEN_CARD, { track: "new-track", updated: "2026-09-28T12:00:00Z" })
  const expected = [
    "---",
    "schema_version: 1",
    "title: Rename the desk card mover's tests to match",
    "track: new-track",
    "status: drafting",
    "created: 2026-05-26",
    "requester: \"ari\"",
    "reviewer: ari",
    "purpose: A long single-line scalar describing the task in one uninterrupted run of prose, exactly as a human first typed it, with no wrapping.",
    "note: |",
    "  first literal line",
    "  second literal line",
    "repos:",
    "  - name: alpha",
    "    branch_base: main",
    "updated: \"2026-09-28T12:00:00Z\" # last touched by hand",
    "---",
    "",
    "# A task",
    "",
    "Body text, never touched by a frontmatter patch.",
    "",
  ].join("\n")
  assert.equal(patched, expected)
})

test("patchFrontmatterFields appends a new field just before the closing fence, and encodes a track/status-shaped value bare but a timestamp quoted", () => {
  const card = "---\nstatus: drafting\ntrack: t\n---\n\nBody.\n"
  const patched = patchFrontmatterFields(card, { status: "done", updated: "2026-09-28T12:00:00Z", merged_into: "other-task" })
  assert.equal(patched, [
    "---",
    'status: done',
    "track: t",
    'updated: "2026-09-28T12:00:00Z"',
    "merged_into: other-task",
    "---",
    "",
    "Body.",
    "",
  ].join("\n"))
})

test("patchFrontmatterFields replaces a field that was itself a block scalar or nested value with one plain-scalar line, dropping only that field's own continuation", () => {
  const card = [
    "---",
    "status: drafting",
    "note: >-",
    "  a folded value",
    "  across two lines",
    "track: t",
    "---",
    "",
    "Body.",
    "",
  ].join("\n")
  const patched = patchFrontmatterFields(card, { note: "a replaced note" })
  assert.equal(patched, [
    "---",
    "status: drafting",
    'note: "a replaced note"',
    "track: t",
    "---",
    "",
    "Body.",
    "",
  ].join("\n"))
})

test("patchFrontmatterFields returns null when there is no closing frontmatter fence, so the caller can fall back rather than corrupt the file", () => {
  assert.equal(patchFrontmatterFields("no frontmatter here\n", { status: "done" }), null)
  assert.equal(patchFrontmatterFields("---\nstatus: drafting\n", { status: "done" }), null)
  // No line break at all: the EOL sniff still has to run before the fence
  // check bails, and must not throw on a string with no `\n` to find.
  assert.equal(patchFrontmatterFields("no newline at all", { status: "done" }), null)
})

test("patchFrontmatterFields keeps the file's own CRLF line endings: only the patched line's value changes, every line break stays \\r\\n", () => {
  const card = ["---", "status: drafting", "track: t", "---", "", "Body.", ""].join("\r\n")
  const patched = patchFrontmatterFields(card, { track: "new-track" })
  assert.equal(patched, ["---", "status: drafting", "track: new-track", "---", "", "Body.", ""].join("\r\n"))
  // No bare \n slipped in anywhere: splitting on \r\n leaves no segment
  // that still contains a line break of its own.
  assert.equal(patched.split("\r\n").some((segment) => segment.includes("\n")), false)
})

test("patchFrontmatterFields never swallows a blank line that only separates two fields: it is not that field's own continuation", () => {
  const card = ["---", "status: drafting", "", "track: t", "---", "", "Body.", ""].join("\n")
  const patched = patchFrontmatterFields(card, { status: "done" })
  assert.equal(patched, ["---", "status: done", "", "track: t", "---", "", "Body.", ""].join("\n"))
})

test("patchFrontmatterFields still drops a block scalar's own blank continuation lines, and a nested map/list under an otherwise-empty value", () => {
  const blockCard = ["---", "status: drafting", "note: >-", "", "  folded text", "track: t", "---", "", "Body.", ""].join("\n")
  assert.equal(
    patchFrontmatterFields(blockCard, { note: "replaced" }),
    ["---", "status: drafting", "note: replaced", "track: t", "---", "", "Body.", ""].join("\n"),
  )
  const nestedCard = ["---", "repos:", "  - name: alpha", "track: t", "---", "", "Body.", ""].join("\n")
  assert.equal(
    patchFrontmatterFields(nestedCard, { repos: "none" }),
    ["---", "repos: none", "track: t", "---", "", "Body.", ""].join("\n"),
  )
})

test("patchFrontmatterFields preserves a patched field's trailing inline comment", () => {
  const card = ["---", "status: drafting # keep me", "track: t", "---", "", "Body.", ""].join("\n")
  const patched = patchFrontmatterFields(card, { status: "done" })
  assert.equal(patched, ["---", "status: done # keep me", "track: t", "---", "", "Body.", ""].join("\n"))
})

test("patchFrontmatterFields finds a trailing comment only outside quotes: a # inside the quoted value doesn't end the value early or get mistaken for the comment", () => {
  const card = ["---", 'status: "a # b" # real comment', "track: t", "---", "", "Body.", ""].join("\n")
  const patched = patchFrontmatterFields(card, { status: "done" })
  assert.equal(patched, ["---", "status: done # real comment", "track: t", "---", "", "Body.", ""].join("\n"))
})

test("patchFrontmatterFields keeps tracking a trailing comment correctly across an escaped quote inside a double-quoted value", () => {
  const card = ["---", 'status: "a \\"quoted\\" value" # note', "track: t", "---", "", "Body.", ""].join("\n")
  const patched = patchFrontmatterFields(card, { status: "done" })
  assert.equal(patched, ["---", "status: done # note", "track: t", "---", "", "Body.", ""].join("\n"))
})

test("patchFrontmatterFields treats an otherwise-empty value that is only a comment as having no value of its own", () => {
  const card = ["---", "status: # to be decided", "track: t", "---", "", "Body.", ""].join("\n")
  const patched = patchFrontmatterFields(card, { status: "done" })
  assert.equal(patched, ["---", "status: done # to be decided", "track: t", "---", "", "Body.", ""].join("\n"))
})

test("patchFrontmatterFields also tracks a trailing comment correctly for a single-quoted value, not only a double-quoted one", () => {
  const card = ["---", "status: 'a value' # single-quoted comment", "track: t", "---", "", "Body.", ""].join("\n")
  const patched = patchFrontmatterFields(card, { status: "done" })
  assert.equal(patched, ["---", "status: done # single-quoted comment", "track: t", "---", "", "Body.", ""].join("\n"))
})

test("patchFrontmatterFields leaves an empty-valued field with nothing after it (no collection, no comment, no next line at all) as just that one line", () => {
  const card = ["---", "track: t", "note:", "---", "", "Body.", ""].join("\n")
  const patched = patchFrontmatterFields(card, { note: "now-noted" })
  assert.equal(patched, ["---", "track: t", "note: now-noted", "---", "", "Body.", ""].join("\n"))
})

test("patchFrontmatterFields skips a bare top-level line that isn't a key: value pair at all — a raw comment — leaving it untouched while still patching a real field", () => {
  const card = ["---", "# a note, not a key", "track: t", "---", "", "Body.", ""].join("\n")
  const patched = patchFrontmatterFields(card, { track: "new-track" })
  assert.equal(patched, ["---", "# a note, not a key", "track: new-track", "---", "", "Body.", ""].join("\n"))
})

test("patchFrontmatterFields returns null when a field to patch appears more than once at top level, rather than guess which occurrence was meant", () => {
  const card = ["---", "status: drafting", "track: t", "status: stale-duplicate", "---", "", "Body.", ""].join("\n")
  assert.equal(patchFrontmatterFields(card, { status: "done" }), null)
  // A duplicate of a field this call never touches doesn't block the patch.
  const untouchedDuplicate = ["---", "title: one", "track: t", "title: two", "---", "", "Body.", ""].join("\n")
  assert.equal(
    patchFrontmatterFields(untouchedDuplicate, { track: "new-track" }),
    ["---", "title: one", "track: new-track", "title: two", "---", "", "Body.", ""].join("\n"),
  )
})

test("patchMarkdownFrontmatter writes only the patched bytes to disk, in place", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "task.md")
  await fs.writeFile(filePath, HAND_WRITTEN_CARD, "utf8")
  await patchMarkdownFrontmatter(filePath, { track: "new-track", status: "done" })
  const raw = await fs.readFile(filePath, "utf8")
  assert.match(raw, /\ntrack: new-track\n/u)
  assert.match(raw, /\nstatus: done\n/u)
  assert.match(raw, /\ncreated: 2026-05-26\n/u)
  assert.match(raw, /\nrequester: "ari"\n/u)
  assert.match(raw, /\nreviewer: ari\n/u)
  assert.match(raw, /\nnote: \|\n {2}first literal line\n {2}second literal line\n/u)
  assert.match(raw, /\nupdated: "2026-09-20T10:00:00Z" # last touched by hand\n/u)
})

test("patchMarkdownFrontmatter falls back to a full write for a file with no frontmatter fence, still landing the intended fields", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "task.md")
  await fs.writeFile(filePath, "Just a body, no frontmatter.\n", "utf8")
  await patchMarkdownFrontmatter(filePath, { status: "done" })
  const { data, content } = await readMarkdown(filePath)
  assert.equal(data.status, "done")
  // gray-matter's own stringify/parse round trip adds and then keeps a
  // blank line between the newly added fence and the body (unrelated to
  // this patch: the same thing happens for any fenced card with a body).
  assert.equal(content, "\nJust a body, no frontmatter.\n")
})

test("patchMarkdownFrontmatter throws rather than guess when a field it means to patch is duplicated at top level, and leaves the file untouched", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "task.md")
  const original = ["---", "status: drafting", "track: t", "status: stale-duplicate", "---", "", "Body.", ""].join("\n")
  await fs.writeFile(filePath, original, "utf8")
  // patchFrontmatterFields declines (null) rather than guess which
  // occurrence wins; the fallback then tries a full parse, and a document
  // with a genuinely duplicated top-level key is invalid YAML gray-matter's
  // own parser rejects, so the call throws instead of silently picking one
  // occurrence over the other or writing a merged guess.
  await assert.rejects(() => patchMarkdownFrontmatter(filePath, { status: "done" }))
  assert.equal(await fs.readFile(filePath, "utf8"), original)
})
