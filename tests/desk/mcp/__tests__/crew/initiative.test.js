// Shared initiatives: `crew.js initiative new|adopt|check` lay out `_shared/tracks/<slug>/README.md` deterministically
// and flag anything else under `_shared/tracks/`, leading with the command that fixes it.

import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { git, teamRepo } from "./_fixtures.js"
import { CARD_TEMPLATE, adoptInitiative, checkTracks, newInitiative, slugify } from "../../../../../plugins/desk/mcp/src/crew/initiative.js"
import { main } from "../../../../../plugins/desk/mcp/scripts/crew.js"

const TEMPLATE = fileURLToPath(new URL("../../../../../plugins/crew/skills/shared-initiative/template.md", import.meta.url))
const NOW = () => Date.UTC(2026, 10, 13)

const WORKSPACE = {
  "desks/alex/notes.md": "# Notes\n",
  "_shared/tracks/README.md": "# Tracks\n",
  "_shared/tracks/engineering-needs/track.md": "# Engineering needs\n",
  "_shared/tracks/shared-tooling/README.md": "# Shared tooling\n",
}

async function workspace(files = WORKSPACE) {
  const repo = await teamRepo(files)
  return repo.clone
}

const read = (clone, file) => readFileSync(path.join(clone, file), "utf8")
const exists = (clone, file) => fs.access(path.join(clone, file)).then(() => true, () => false)

test("the card template in the script is the shared-initiative skill's template", () => {
  assert.equal(CARD_TEMPLATE, readFileSync(TEMPLATE, "utf8"))
})

test("slugify makes a short kebab-case name", () => {
  assert.equal(slugify("CIT Objectives & Key Results — June 2027!"), "cit-objectives-key-results-june-2027")
  assert.equal(slugify("Café plan"), "cafe-plan")
  assert.equal(slugify("***"), "")
})

test("new makes a README card from the template and refuses to overwrite", async () => {
  const clone = await workspace()
  const made = newInitiative({ repo: clone, slug: "Reliability Checks", now: NOW })
  assert.equal(made.state, "created")
  assert.equal(made.card, "_shared/tracks/reliability-checks/README.md")
  assert.equal(made.slug_changed, true)
  const card = read(clone, made.card)
  assert.match(card, /^# Reliability checks\n/u)
  assert.match(card, /## Decisions\n\nNo decision recorded\./u)
  assert.match(made.message, /nothing is committed yet/u)

  const again = newInitiative({ repo: clone, slug: "reliability-checks", now: NOW })
  assert.equal(again.state, "exists")
  const legacy = newInitiative({ repo: clone, slug: "engineering-needs", now: NOW })
  assert.equal(legacy.state, "exists")
  assert.match(legacy.message, /^Read _shared\/tracks\/engineering-needs\/track\.md and contribute there/u)
  assert.equal(newInitiative({ repo: clone, slug: "***", now: NOW }).state, "refused")
  assert.equal(newInitiative({ repo: clone, slug: undefined, now: NOW }).state, "refused")
  await fs.writeFile(path.join(clone, "_shared/tracks/loose-file"), "x")
  const file = newInitiative({ repo: clone, slug: "loose-file", now: NOW })
  assert.equal(file.state, "exists")
  assert.match(file.message, /Pick another name/u)
})

test("adopt turns a flat file in shared tracks into a folder with the file kept beside a card", async () => {
  const clone = await workspace({ ...WORKSPACE, "_shared/tracks/cit-objectives-and-key-results-june-2027.md": "# CIT objectives\n\nDraft.\n" })
  const adopted = adoptInitiative({ repo: clone, source: "_shared/tracks/cit-objectives-and-key-results-june-2027.md", now: NOW })
  assert.equal(adopted.state, "adopted")
  assert.equal(adopted.slug, "cit-objectives-and-key-results-june-2027")
  assert.deepEqual(adopted.moved, [{ from: "_shared/tracks/cit-objectives-and-key-results-june-2027.md", to: "_shared/tracks/cit-objectives-and-key-results-june-2027/cit-objectives-and-key-results-june-2027.md", how: "moved" }])
  assert.equal(adopted.pointer, undefined)
  const dir = "_shared/tracks/cit-objectives-and-key-results-june-2027"
  assert.equal(read(clone, `${dir}/cit-objectives-and-key-results-june-2027.md`), "# CIT objectives\n\nDraft.\n")
  const card = read(clone, `${dir}/README.md`)
  assert.match(card, /^# CIT objectives\n/u)
  assert.match(card, /- \[cit-objectives-and-key-results-june-2027\.md\]\(cit-objectives-and-key-results-june-2027\.md\): the original document/u)
  assert.equal(await exists(clone, "_shared/tracks/cit-objectives-and-key-results-june-2027.md"), false)
  assert.equal(checkTracks({ repo: clone }).state, "ok")
  assert.match(git(clone, ["status", "--porcelain"]), /cit-objectives-and-key-results-june-2027\.md/u)
})

test("adopt a file from a desk moves it, leaves a one-line pointer and takes --slug and --title", async () => {
  const clone = await workspace({ ...WORKSPACE, "desks/alex/plan.md": "# Plan\n" })
  const adopted = adoptInitiative({ repo: clone, source: "desks/alex/plan.md", slug: "Q3 plan", title: "Quarter plan", now: NOW })
  assert.equal(adopted.state, "adopted")
  assert.equal(adopted.pointer, "desks/alex/plan.md")
  assert.equal(read(clone, "desks/alex/plan.md"), "Moved to [q3-plan](../../_shared/tracks/q3-plan/plan.md), a shared initiative.\n")
  assert.equal(read(clone, "_shared/tracks/q3-plan/plan.md"), "# Plan\n")
  assert.match(read(clone, "_shared/tracks/q3-plan/README.md"), /^# Quarter plan\n/u)
  const clash = adoptInitiative({ repo: clone, source: "desks/alex/plan.md", slug: "q3-plan", now: NOW })
  assert.equal(clash.state, "refused", "the pointer is a different file, but the name is taken")
})

test("adopt titles a card from the slug when the document has no heading, and refuses a slug that is taken by a file", async () => {
  const clone = await workspace({ ...WORKSPACE, "desks/alex/plain.md": "no heading here\n", "_shared/tracks/taken": "x" })
  const adopted = adoptInitiative({ repo: clone, source: "desks/alex/plain.md", now: NOW })
  assert.match(read(clone, "_shared/tracks/plain/README.md"), /^# Plain\n/u)
  assert.equal(adopted.state, "adopted")
  const taken = adoptInitiative({ repo: clone, source: "desks/alex/notes.md", slug: "taken", now: NOW })
  assert.equal(taken.state, "refused")
  assert.match(taken.message, /is a file, not a folder/u)
  assert.equal(adoptInitiative({ repo: clone, source: "desks/alex/notes.md", slug: "***", now: NOW }).state, "refused")
  await fs.writeFile(path.join(clone, "desks/alex/###.md"), "x")
  const nameless = adoptInitiative({ repo: clone, source: "desks/alex/###.md", now: NOW })
  assert.equal(nameless.state, "refused")
  assert.match(nameless.message, /^Pass --slug <short-name> made of letters or digits\. ###/u)
})

test("adopt refuses a symbolic link and a folder whose slug is taken", async () => {
  const clone = await workspace({ ...WORKSPACE, "desks/alex/launch/plan.md": "p" })
  await fs.symlink(path.join(clone, "desks/alex/notes.md"), path.join(clone, "desks/alex/link.md"))
  const link = adoptInitiative({ repo: clone, source: "desks/alex/link.md", now: NOW })
  assert.equal(link.state, "refused")
  assert.match(link.message, /symbolic link/u)
  const taken = adoptInitiative({ repo: clone, source: "desks/alex/launch", slug: "shared-tooling", now: NOW })
  assert.equal(taken.state, "refused")
  assert.match(taken.message, /already exists/u)
})

test("adopt a file from outside the workspace copies it and leaves the original", async () => {
  const clone = await workspace()
  const outside = await mkTempRoot("outside-")
  const doc = path.join(outside, "Roadmap.docx")
  await fs.writeFile(doc, "binary")
  const adopted = adoptInitiative({ repo: clone, source: doc, now: NOW })
  assert.equal(adopted.state, "adopted")
  assert.equal(adopted.moved[0].how, "copied")
  assert.equal(adopted.slug, "roadmap")
  assert.equal(await exists(outside, "Roadmap.docx"), true)
  assert.equal(read(clone, "_shared/tracks/roadmap/Roadmap.docx"), "binary")
  assert.match(adopted.message, /the original is left where it was/u)
})

test("adopt a folder in shared tracks without a card adds the card and links its files", async () => {
  const clone = await workspace({ ...WORKSPACE, "_shared/tracks/hiring/notes.md": "x", "_shared/tracks/hiring/roles.md": "y" })
  const adopted = adoptInitiative({ repo: clone, source: "_shared/tracks/hiring", now: NOW })
  assert.equal(adopted.state, "adopted")
  assert.deepEqual(adopted.moved, [])
  const card = read(clone, "_shared/tracks/hiring/README.md")
  assert.match(card, /- \[notes\.md\]\(notes\.md\)/u)
  assert.match(card, /- \[roles\.md\]\(roles\.md\)/u)
  assert.equal(adoptInitiative({ repo: clone, source: "_shared/tracks/hiring", now: NOW }).state, "exists")
  assert.equal(adoptInitiative({ repo: clone, source: "_shared/tracks/engineering-needs", now: NOW }).state, "exists")
})

test("adopt a folder from elsewhere moves it whole and keeps its own README as the card", async () => {
  const clone = await workspace({ ...WORKSPACE, "desks/alex/launch/README.md": "# Launch\n", "desks/alex/launch/plan.md": "p" })
  const adopted = adoptInitiative({ repo: clone, source: "desks/alex/launch", now: NOW })
  assert.equal(adopted.state, "adopted")
  assert.equal(read(clone, "_shared/tracks/launch/README.md"), "# Launch\n")
  assert.equal(read(clone, "_shared/tracks/launch/plan.md"), "p")
  assert.equal(await exists(clone, "desks/alex/launch"), false)
})

test("adopt refuses what it cannot place and changes nothing", async () => {
  const clone = await workspace({ ...WORKSPACE, "_shared/tracks/hiring/deep/file.md": "x" })
  for (const source of ["missing.md", "_shared/tracks", "_shared", clone, "_shared/tracks/README.md", "_shared/tracks/hiring/deep/file.md"]) {
    assert.equal(adoptInitiative({ repo: clone, source, now: NOW }).state, "refused", source)
  }
  assert.equal(adoptInitiative({ repo: clone, now: NOW }).state, "refused")
  assert.equal(adoptInitiative({ repo: path.dirname(clone), source: "x", now: NOW }).state, "not_git")
})

test("a repository that is not a Crew workspace is told how to start one", async () => {
  const repo = await teamRepo({ "README.md": "# Hi\n" })
  const result = newInitiative({ repo: repo.clone, slug: "x", now: NOW })
  assert.equal(result.state, "not_crew")
  assert.match(result.message, /crew:start-crew/u)
})

test("check passes on the correct layout and on legacy cards", async () => {
  const clone = await workspace()
  const result = checkTracks({ repo: clone })
  assert.equal(result.state, "ok")
  assert.equal(checkTracks({ repo: path.dirname(clone) }).state, "not_git")
  assert.equal((await workspace({ "desks/alex/n.md": "x" }).then((c) => checkTracks({ repo: c }))).state, "ok", "no tracks folder")
})

test("check flags a flat file and a folder without a card, leading with the fix command", async () => {
  const clone = await workspace({ ...WORKSPACE, "_shared/tracks/my plan.md": "x", "_shared/tracks/hiring/notes.md": "y", "_shared/tracks/.gitkeep": "" })
  const result = checkTracks({ repo: clone, crewScript: "/plugins/desk/mcp/scripts/crew.js" })
  assert.equal(result.state, "problems")
  assert.deepEqual(result.problems.map((p) => [p.kind, p.path]), [
    ["folder_without_card", "_shared/tracks/hiring/"],
    ["flat_file", "_shared/tracks/my plan.md"],
  ])
  assert.ok(result.message.startsWith("Run the fix for each of 2 entries, for example `node /plugins/desk/mcp/scripts/crew.js initiative adopt _shared/tracks/hiring`"), result.message)
  assert.match(result.message, /Fix: `node \/plugins\/desk\/mcp\/scripts\/crew\.js initiative adopt "_shared\/tracks\/my plan\.md"`/u)

  const spaced = checkTracks({ repo: clone, crewScript: "/Program Files/crew.js" })
  assert.match(spaced.message, /node "\/Program Files\/crew\.js" initiative adopt/u)
  const scoped = checkTracks({ repo: clone, only: new Set(["my plan.md"]) })
  assert.deepEqual(scoped.problems.map((p) => p.path), ["_shared/tracks/my plan.md"])
  assert.ok(scoped.message.startsWith("Run `node "), scoped.message)
})

test("the command line: new, adopt and check print JSON and check exits 1 on problems", async () => {
  const clone = await workspace({ ...WORKSPACE, "_shared/tracks/loose.md": "# Loose\n" })
  const run = async (argv) => {
    let out = ""
    const code = await main({ argv: [...argv, "--repo", clone], cwd: "/elsewhere", write: (text) => { out += text }, script: "/crew.js" })
    return { code, result: JSON.parse(out) }
  }
  const failing = await run(["initiative", "check"])
  assert.equal(failing.code, 1)
  assert.match(failing.result.message, /^Run `node \/crew\.js initiative adopt _shared\/tracks\/loose\.md`/u)
  assert.equal((await run(["initiative", "adopt", "_shared/tracks/loose.md"])).code, 0)
  assert.equal((await run(["initiative", "check"])).code, 0)
  assert.equal((await run(["initiative", "new", "fresh-idea", "--title", "Fresh idea"])).result.state, "created")
  assert.equal((await run(["initiative", "new", "fresh-idea"])).code, 0, "exists is not a failure")
  assert.equal((await main({ argv: ["initiative"], cwd: clone, write: () => {} })), 2)
  for (const argv of [["initiative"], ["initiative", "rename"], ["initiative", "new"], ["initiative", "adopt", "--slug", "x"], ["initiative", "check", "--slug", "x"], ["initiative", "new", "a", "--bogus"]]) {
    const usage = await run(argv)
    assert.equal(usage.code, 2, argv.join(" "))
    assert.match(usage.result.message, /usage: crew\.js initiative/u)
  }
})

test("run as a script from the clone, check reports a flat file with the real script path", async () => {
  const clone = await workspace({ ...WORKSPACE, "_shared/tracks/loose.md": "x" })
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/crew.js", import.meta.url))
  const ran = spawnSync(process.execPath, [script, "initiative", "check"], { cwd: clone, encoding: "utf8" })
  assert.equal(ran.status, 1)
  assert.ok(JSON.parse(ran.stdout).message.includes(`initiative adopt _shared/tracks/loose.md`))
})
