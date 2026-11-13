// task_archive keeps Markdown links working: inbound links from other tasks and the track card follow the moved folder, links out of
// the folder are rewritten, and a link that cannot be rewritten is reported in `links.not_rewritten` while the archive still happens.

import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { extractMarkdownLinks } from "../../../../../plugins/desk/mcp/src/util/markdown-links.cjs"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

const DONE_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/1" }
const NO_PUSH = { schedulePush: () => {} }

const FIXTURE = {
  "LESSONS.md": "# Lessons\n\nKeep links working.\n",
  "t/track.md": "# Track\n\nSee [the brief](book-flights/task.md) before you start.\n",
  "t/book-flights/notes.md": "# Notes\n\nSee [the sibling](../other-task/notes.md), [the lessons](../../LESSONS.md#top), and [research](research/a.md#findings).\n\nAn [absolute link](https://example.com/x) and an [anchor](#notes) stay.\n",
  "t/book-flights/research/a.md": "# Research\n\nSee [the sibling](../../other-task/notes.md) and [the card](../task.md).\n",
  "t/other-task/notes.md": "# Other notes\n",
  "t/alpha/brief.md": "# Brief\n\nSee [the card](../book-flights/task.md) and [research](../book-flights/research/a.md?view=raw).\n",
  "t/beta/planning.md": "# Plan\n\n- [notes](<../book-flights/notes.md>)\n",
}

const REWRITTEN = [
  "t/_archive/book-flights/notes.md",
  "t/_archive/book-flights/research/a.md",
  "t/alpha/brief.md",
  "t/beta/planning.md",
  "t/track.md",
]

function initGit(root) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  }
  run(["init", "-q"])
  run(["config", "user.email", "test@example.com"])
  run(["config", "user.name", "Test"])
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function lastCommitFiles(root) {
  return git(root, "show", "--stat", "--format=", "--name-only", "--no-renames", "HEAD").split("\n").filter(Boolean).sort()
}

async function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split("/"))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }
}

async function buildDesk(root, { gitDesk, files = FIXTURE }) {
  if (gitDesk) initGit(root)
  for (const slug of ["book-flights", "other-task", "alpha", "beta"]) {
    await task_create({ deskRoot: root, input: { track: "t", slug, title: slug }, ...NO_PUSH })
  }
  await writeFiles(root, files)
  if (gitDesk) {
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "fixture")
  }
}

async function markdownFiles(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) await markdownFiles(file, out)
    else if (entry.name.endsWith(".md")) out.push(file)
  }
  return out
}

const deskRel = (root, file) => path.relative(root, file).split(path.sep).join("/")

// Every relative link's target must exist on disk; returns the broken ones as `file -> destination`.
async function brokenLinks(root) {
  const broken = []
  for (const file of await markdownFiles(root)) {
    for (const link of extractMarkdownLinks(await fs.readFile(file, "utf8")).links) {
      const target = link.destination
      if (target === "" || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith("#") || target.startsWith("/")) continue
      const pathPart = decodeURIComponent(target.split(/[?#]/u)[0])
      if (!(await exists(path.resolve(path.dirname(file), pathPart)))) broken.push(`${deskRel(root, file)} -> ${target}`)
    }
  }
  return broken.sort()
}

// The text with every link destination blanked out: two texts with equal skeletons differ only inside destinations.
function skeleton(text) {
  const links = extractMarkdownLinks(text).links
  let out = "", at = 0
  for (const link of links) {
    out += `${text.slice(at, link.start)}\u0000`
    at = link.end
  }
  return { links: links.length, text: out + text.slice(at) }
}

async function assertOnlyDestinationsChanged(root, before, pairs) {
  for (const [oldRel, newRel] of pairs) {
    const newText = await fs.readFile(path.join(root, ...newRel.split("/")), "utf8")
    assert.deepEqual(skeleton(newText), skeleton(before.get(oldRel)), `${newRel} changed outside its link destinations`)
  }
}

async function snapshotTexts(root) {
  const texts = new Map()
  for (const file of await markdownFiles(root)) texts.set(deskRel(root, file), await fs.readFile(file, "utf8"))
  return texts
}

for (const gitDesk of [true, false]) {
  test(`task_archive keeps every Markdown link resolving and rewrites only the destinations (${gitDesk ? "Git" : "non-Git"} desk)`, async () => {
    const root = await mkTempDeskRoot()
    await buildDesk(root, { gitDesk })
    const before = await snapshotTexts(root)
    assert.deepEqual(await brokenLinks(root), [], "the fixture starts with every link resolving")

    const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, ...NO_PUSH })

    assert.equal(result.status, "archived")
    assert.deepEqual(result.links.rewritten.slice().sort(), REWRITTEN)
    assert.deepEqual(result.links.not_rewritten, [])
    assert.deepEqual(await brokenLinks(root), [])
    await assertOnlyDestinationsChanged(root, before, [
      ["t/book-flights/notes.md", "t/_archive/book-flights/notes.md"],
      ["t/book-flights/research/a.md", "t/_archive/book-flights/research/a.md"],
      ["t/alpha/brief.md", "t/alpha/brief.md"],
      ["t/beta/planning.md", "t/beta/planning.md"],
      ["t/track.md", "t/track.md"],
    ])
    assert.equal(await fs.readFile(path.join(root, "t", "other-task", "notes.md"), "utf8"), before.get("t/other-task/notes.md"))
    assert.match(await fs.readFile(path.join(root, "t", "alpha", "brief.md"), "utf8"), /\[the card\]\(\.\.\/_archive\/book-flights\/task\.md\)/u)
    assert.match((await readFront(path.join(root, "t", "_archive", "book-flights", "notes.md"))).content, /\[the lessons\]\(\.\.\/\.\.\/\.\.\/LESSONS\.md#top\)/u)

    if (gitDesk) {
      assert.equal(git(root, "status", "--short"), "")
      assert.equal(git(root, "log", "-1", "--format=%s").trim(), "task_archive: t/book-flights")
      const files = lastCommitFiles(root)
      for (const rel of ["t/alpha/brief.md", "t/beta/planning.md", "t/track.md", "t/_archive/book-flights/notes.md"]) {
        assert.ok(files.includes(rel), `the archive commit includes ${rel}`)
      }
      assert.equal(files.includes("t/other-task/notes.md"), false)
    }
  })
}

test("task_archive reports a link that leaves the desk and still archives the task", async () => {
  const root = await mkTempDeskRoot()
  await buildDesk(root, {
    gitDesk: false,
    files: { ...FIXTURE, "t/book-flights/notes.md": `${FIXTURE["t/book-flights/notes.md"]}\nSee [outside](../../../../outside.md).\n` },
  })

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, ...NO_PUSH })

  assert.equal(result.status, "archived")
  assert.deepEqual(result.links.not_rewritten, [{
    file: "t/_archive/book-flights/notes.md",
    destination: "../../../../outside.md",
    reason: "the target is outside the desk after the move",
  }])
  assert.deepEqual(await brokenLinks(root), ["t/_archive/book-flights/notes.md -> ../../../../outside.md"])
})

test("task_archive leaves an inbound file with local edits untouched and reports its broken links", async () => {
  const root = await mkTempDeskRoot()
  await buildDesk(root, { gitDesk: true })
  await fs.appendFile(path.join(root, "t", "alpha", "brief.md"), "\nA local edit I have not committed.\n")
  const edited = await fs.readFile(path.join(root, "t", "alpha", "brief.md"), "utf8")

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, ...NO_PUSH })

  assert.equal(result.status, "archived")
  assert.deepEqual(result.links.not_rewritten.map((entry) => entry.file), ["t/alpha/brief.md"])
  assert.match(result.links.not_rewritten[0].reason, /unstaged, staged or untracked changes/u)
  assert.equal(await fs.readFile(path.join(root, "t", "alpha", "brief.md"), "utf8"), edited, "the edited file is not rewritten")
  assert.deepEqual(await brokenLinks(root), [
    "t/alpha/brief.md -> ../book-flights/research/a.md?view=raw",
    "t/alpha/brief.md -> ../book-flights/task.md",
  ])
  assert.ok(!lastCommitFiles(root).includes("t/alpha/brief.md"), "the archive commit does not take the edited file")
  assert.match(git(root, "status", "--short"), /^ M t\/alpha\/brief\.md$/mu)
  assert.ok(lastCommitFiles(root).includes("t/beta/planning.md"), "the clean inbound file is still rewritten and committed")
})

test("task_archive leaves a track card with local edits as it is and reports its links", async () => {
  const root = await mkTempDeskRoot()
  await buildDesk(root, { gitDesk: true })
  await fs.appendFile(path.join(root, "t", "track.md"), "\nA local note.\n")

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, ...NO_PUSH })

  assert.equal(result.status, "archived")
  assert.deepEqual(result.links.not_rewritten.map((entry) => entry.file), ["t/track.md"])
  assert.match(await fs.readFile(path.join(root, "t", "track.md"), "utf8"), /\[the brief\]\(book-flights\/task\.md\)/u)
})

test("task_archive omits the links field when no Markdown file links into or out of the task", async () => {
  const root = await mkTempDeskRoot()
  await buildDesk(root, { gitDesk: false, files: { "t/track.md": "# Track\n\nbook-flights is the first task.\n", "t/other-task/notes.md": "# Other notes, no links\n" } })

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, ...NO_PUSH })

  assert.equal(result.status, "archived")
  assert.equal("links" in result, false)
})

test("task_archive writes the track row and the track card's own links in one update", async () => {
  const root = await mkTempDeskRoot()
  const track = "| Slug | State |\n|---|---|\n| book-flights | active |\n\nSee [the brief](book-flights/task.md) for details.\n"
  await buildDesk(root, { gitDesk: false, files: { ...FIXTURE, "t/track.md": `# Track\n\n${track}` } })

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, ...NO_PUSH })

  assert.equal(result.status, "archived")
  assert.deepEqual(result.links.rewritten.includes("t/track.md"), true)
  const written = await fs.readFile(path.join(root, "t", "track.md"), "utf8")
  assert.match(written, /\| book-flights \| done \|/u)
  assert.match(written, /\[the brief\]\(_archive\/book-flights\/task\.md\)/u)
})

test("task_archive leaves an untracked inbound file as it is and reports its links", async () => {
  const root = await mkTempDeskRoot()
  await buildDesk(root, { gitDesk: true })
  await writeFiles(root, { "t/gamma/brief.md": "# New\n\nSee [the card](../book-flights/task.md).\n" })
  const fresh = await fs.readFile(path.join(root, "t", "gamma", "brief.md"), "utf8")

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, ...NO_PUSH })

  assert.equal(result.status, "archived")
  assert.deepEqual(result.links.not_rewritten.map((entry) => entry.file), ["t/gamma/brief.md"])
  assert.match(result.links.not_rewritten[0].reason, /not a tracked regular file in Git/u)
  assert.equal(await fs.readFile(path.join(root, "t", "gamma", "brief.md"), "utf8"), fresh)
})

test("task_archive reports a Markdown file that is not UTF-8 and never rewrites its bytes", async () => {
  const root = await mkTempDeskRoot()
  const invalid = Buffer.from([0xff, 0xfe, 0x20])
  await buildDesk(root, { gitDesk: false })
  await fs.mkdir(path.join(root, "t", "zeta"), { recursive: true })
  await fs.writeFile(path.join(root, "t", "zeta", "raw.md"), Buffer.concat([invalid, Buffer.from(" [card](../book-flights/task.md)\n")]))
  await fs.writeFile(path.join(root, "t", "book-flights", "raw.md"), Buffer.concat([invalid, Buffer.from(" [card](task.md)\n")]))

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, ...NO_PUSH })

  assert.equal(result.status, "archived")
  assert.deepEqual(result.links.not_rewritten.map((entry) => entry.file).sort(), ["t/_archive/book-flights/raw.md", "t/zeta/raw.md"])
  assert.match(result.links.not_rewritten[0].reason, /not UTF-8/u)
  assert.deepEqual(await fs.readFile(path.join(root, "t", "zeta", "raw.md")), Buffer.concat([invalid, Buffer.from(" [card](../book-flights/task.md)\n")]))
  assert.deepEqual(await fs.readFile(path.join(root, "t", "_archive", "book-flights", "raw.md")), Buffer.concat([invalid, Buffer.from(" [card](task.md)\n")]))
})
