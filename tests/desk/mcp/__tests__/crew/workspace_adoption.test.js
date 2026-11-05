// crew.js join --adopt-existing <reviewed-commit>: an existing, unregistered desk folder is reused as the member's own desk
// instead of being refused. The preview offers the reviewed commit; the apply keeps every existing file byte for byte,
// adds only the missing template files, records an adoption checkpoint and lands the roster row. Every refusal below
// writes nothing.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, promises as fs, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CIT_SHAPED, bareGit, fakeGh, git, noWait, onMain, pushFromElsewhere, secondClone, teamRepo } from "./_fixtures.js"
import { joinWorkspace, startWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { readCrewRoster } from "../../../../../plugins/desk/mcp/src/desk/crew-roster.js"

const NOW = () => 1767225600000
const ME = "newbie_example"
const DESK = "desks/newbie"
const MINE = { [`${DESK}/AGENTS.md`]: "# my own agents file\r\nkept   exactly\n", [`${DESK}/notes/deep/idea.md`]: "idea without final newline", [`${DESK}/blob.bin`]: Buffer.from([0, 255, 1, 254, 13, 10]) }
const COMPLETE = { [`${DESK}/AGENTS.md`]: "# mine\n", [`${DESK}/README.md`]: "# readme mine\n", [`${DESK}/_meta/friction.md`]: "friction mine\n" }

// A CIT-shaped repository started as a dual-repo workspace, and the new member's own clone of it.
async function startWorkspaceFixture() {
  const repo = await teamRepo(CIT_SHAPED)
  const started = await startWorkspace({ repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh, wait: noWait, now: NOW, apply: true, tooling: { repo: "acme/team-tooling" }, founder: { alias: "test-founder", identity: "test-founder-placeholder" } })
  assert.equal(started.state, "published", started.message)
  const clone = path.join(repo.base, "member")
  spawnSync("git", ["clone", "-q", repo.bare, clone])
  git(clone, ["config", "user.email", "new@example.com"])
  git(clone, ["config", "user.name", "New Member"])
  git(clone, ["remote", "set-url", "origin", "https://github.com/acme/team.git"])
  return { ...repo, clone }
}

const ghFor = (repo, options = {}) => fakeGh(repo.bare, { accounts: [ME], ...options })
const join = (repo, extra = {}) => ({ repo: repo.clone, spawnGit: repo.spawnGit, gh: ghFor(repo).gh, identity: ME, alias: "newbie", wait: noWait, now: NOW, ...extra })

// A started workspace whose main already holds an unregistered desk folder `files`, and the member's clone of it.
async function withDesk(files = MINE, { message = "someone's folder" } = {}) {
  const repo = await startWorkspaceFixture()
  await pushFromElsewhere(repo, files, message)
  git(repo.clone, ["pull", "-q", "--ff-only", repo.bare, "main"])
  return repo
}

const previewOf = async (repo, extra = {}) => (await joinWorkspace(join(repo, extra))).adoption

// A change straight onto main in the bare repository, as a teammate's would be (synchronously, so it can sit inside a hook).
function teammateSync(repo, change, message = "teammate change") {
  const other = path.join(repo.base, `racer-${Math.random().toString(36).slice(2, 8)}`)
  spawnSync("git", ["clone", "-q", repo.bare, other])
  change(other)
  git(other, ["add", "-A"])
  git(other, ["-c", "user.email=o@example.com", "-c", "user.name=O", "commit", "-q", "--allow-empty", "-m", message])
  git(other, ["push", "-q", "origin", "main"])
}

const writeIn = (dir, name, text) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  writeFileSync(path.join(dir, name), text)
}

test("an unregistered desk is refused with an adoption offer: the reviewed commit, what is preserved and what is missing", async () => {
  const repo = await withDesk()
  const refused = await joinWorkspace(join(repo))
  assert.equal(refused.state, "refused")
  assert.match(refused.message, /desks\/newbie\/ already exists and does not match the template/u)
  assert.match(refused.message, /preview with --adopt-existing [0-9a-f]{40}\.$/u)
  assert.equal(refused.adoption.revision, git(repo.clone, ["rev-parse", "HEAD"]))
  assert.deepEqual(refused.adoption.preserved, [`${DESK}/AGENTS.md`, `${DESK}/blob.bin`, `${DESK}/notes/deep/idea.md`])
  assert.deepEqual(refused.adoption.missing, [`${DESK}/README.md`, `${DESK}/_meta/friction.md`])
})

test("adoption preview and apply: existing files stay byte for byte, only missing template files are added, the row is registered", async () => {
  const repo = await withDesk()
  const revision = (await previewOf(repo)).revision
  const plan = await joinWorkspace(join(repo, { adoptExisting: revision }))
  assert.equal(plan.state, "plan", plan.message)
  assert.match(plan.message, /^Plan only: nothing was written\. Adopting desks\/newbie\/ preserves every existing file, adds 2 missing template files and then the roster row/u)
  assert.equal(plan.adoption.revision, revision)
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), revision)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")

  const before = Object.fromEntries(Object.keys(MINE).map((file) => [file, spawnSync("git", ["--git-dir", repo.bare, "show", `main:${file}`]).stdout]))
  const result = await joinWorkspace(join(repo, { adoptExisting: revision, apply: true }))
  assert.equal(result.state, "joined", result.message)
  for (const [file, bytes] of Object.entries(before)) assert.deepEqual(spawnSync("git", ["--git-dir", repo.bare, "show", `main:${file}`]).stdout, bytes, file)
  assert.deepEqual(Buffer.from(await fs.readFile(path.join(repo.clone, `${DESK}/blob.bin`))), MINE[`${DESK}/blob.bin`])
  assert.equal(onMain(repo.bare, `${DESK}/README.md`), onMain(repo.bare, "desks/_template/README.md").replaceAll("{{alias}}", "newbie"))
  assert.ok(onMain(repo.bare, `${DESK}/_meta/friction.md`) !== null)
  assert.deepEqual(readCrewRoster(repo.clone).map((row) => row.alias), ["test-founder", "newbie"])
  const checkpoint = bareGit(repo.bare, ["log", "--format=%B%x00", "-n", "2", "main"]).split("\0").map((body) => body.trim())
  assert.match(checkpoint[0], /^Crew: add newbie to the roster/u)
  assert.equal(checkpoint[1], `Crew: adopt newbie's desk\n\nCrew-Identity: ${ME}\nCrew-Adoption: ${DESK}`)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})

test("adopting a desk that already holds every template file records an empty checkpoint and changes no file", async () => {
  const repo = await withDesk(COMPLETE)
  const revision = (await previewOf(repo)).revision
  assert.deepEqual((await previewOf(repo)).missing, [])
  const result = await joinWorkspace(join(repo, { adoptExisting: revision, apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), "# mine\n")
  assert.equal(bareGit(repo.bare, ["show", "--stat", "--format=%s", "main~1"]), "Crew: adopt newbie's desk")
  assert.equal(bareGit(repo.bare, ["diff", "--name-only", "main~2", "main~1"]), "")
})

test("a revision that is short, not hex, upper case, not a string or not a commit is refused", async () => {
  const repo = await withDesk()
  const full = (await previewOf(repo)).revision
  for (const bad of [full.slice(0, 7), "z".repeat(40), full.toUpperCase(), "0".repeat(40), 12345, ""]) {
    const result = await joinWorkspace(join(repo, { adoptExisting: bad, apply: true }))
    assert.equal(result.state, "refused", String(bad))
    assert.match(result.message, /adoption needs the full reviewed commit from a fresh join preview/u)
  }
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), full)
})

test("adopting when the desk is absent is refused", async () => {
  const repo = await startWorkspaceFixture()
  const result = await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]) }))
  assert.equal(result.state, "refused")
  assert.match(result.message, /desks\/newbie\/ is absent; preview again/u)
})

test("a revision from before the desk existed, or one the desk has changed since, is refused as changed", async () => {
  const repo = await withDesk()
  const before = git(repo.clone, ["rev-parse", "HEAD~1"])
  const old = await joinWorkspace(join(repo, { adoptExisting: before }))
  assert.equal(old.state, "refused")
  assert.match(old.message, /desks\/newbie\/ changed since the adoption preview/u)

  const reviewed = git(repo.clone, ["rev-parse", "HEAD"])
  await pushFromElsewhere(repo, { [`${DESK}/notes/deep/idea.md`]: "edited after review" })
  git(repo.clone, ["pull", "-q", "--ff-only", repo.bare, "main"])
  const changed = await joinWorkspace(join(repo, { adoptExisting: reviewed, apply: true }))
  assert.equal(changed.state, "refused")
  assert.match(changed.message, /desks\/newbie\/ changed since the adoption preview; preview again/u)
  assert.equal(onMain(repo.bare, "_meta/desks.md").includes("newbie"), false)

  // The template changing is as much a change.
  const fresh = await withDesk()
  const reviewedFresh = git(fresh.clone, ["rev-parse", "HEAD"])
  await pushFromElsewhere(fresh, { "desks/_template/extra.md": "new template file\n" })
  git(fresh.clone, ["pull", "-q", "--ff-only", fresh.bare, "main"])
  const template = await joinWorkspace(join(fresh, { adoptExisting: reviewedFresh }))
  assert.match(template.message, /desks\/_template\/ changed since the adoption preview/u)
})

test("conflicting reservations and pending claims block adoption, and say what to reconcile", async () => {
  const roster = (repo) => onMain(repo.bare, "_meta/desks.md")
  const reserved = await withDesk()
  const revision = (await previewOf(reserved)).revision
  await pushFromElsewhere(reserved, { "_meta/desks.md": `${roster(reserved)}| other | other_example | desks/newbie/sub | acme/team | crew | desks/other |\n` })
  git(reserved.clone, ["pull", "-q", "--ff-only", reserved.bare, "main"])
  const overlap = await joinWorkspace(join(reserved, { adoptExisting: git(reserved.clone, ["rev-parse", "HEAD"]) }))
  assert.match(overlap.message, /desks\/newbie\/ overlaps a registered path for other_example; reconcile that reservation first/u)
  assert.notEqual(revision, undefined)

  const parent = await withDesk()
  await pushFromElsewhere(parent, { "_meta/desks.md": `${roster(parent)}| solo | solo_example | desks/ | acme/team | crew | |\n` })
  git(parent.clone, ["pull", "-q", "--ff-only", parent.bare, "main"])
  assert.match((await joinWorkspace(join(parent, { adoptExisting: git(parent.clone, ["rev-parse", "HEAD"]) }))).message, /overlaps a registered path for solo_example/u)

  const anon = await withDesk()
  await pushFromElsewhere(anon, { "_meta/desks.md": `${roster(anon)}| nameless |  | desks/newbie |  |  |\n` })
  git(anon.clone, ["pull", "-q", "--ff-only", anon.bare, "main"])
  assert.match((await joinWorkspace(join(anon, { adoptExisting: git(anon.clone, ["rev-parse", "HEAD"]) }))).message, /overlaps a registered path for another member/u)

  const claimed = await withDesk(MINE, { message: "added for someone\n\nCrew-Identity: other_example" })
  const claim = await joinWorkspace(join(claimed, { adoptExisting: git(claimed.clone, ["rev-parse", "HEAD"]) }))
  assert.equal(claim.state, "refused")
  assert.match(claim.message, /desks\/newbie\/ has a pending claim for other_example; reconcile that claim first/u)

  const unverifiable = await withDesk()
  await pushFromElsewhere(unverifiable, { "notes.txt": "x" }, "checkpoint\n\nCrew-Adoption: desks/newbie")
  git(unverifiable.clone, ["pull", "-q", "--ff-only", unverifiable.bare, "main"])
  const unclear = await joinWorkspace(join(unverifiable, { adoptExisting: git(unverifiable.clone, ["rev-parse", "HEAD"]) }))
  assert.match(unclear.message, /has an unverifiable pending adoption claim; reconcile that claim first/u)

  const registry = await withDesk()
  const lnk = path.join(registry.clone, "_meta", "desks.md")
  await fs.rename(lnk, `${lnk}.real`)
  await fs.symlink(`${lnk}.real`, lnk)
  assert.match((await joinWorkspace(join(registry, { adoptExisting: git(registry.clone, ["rev-parse", "HEAD"]) }))).message, /adoption never follows registry links/u)
})

test("an unfinished explicit adoption by someone else blocks a plain join and points to --adopt-existing for the owner", async () => {
  const repo = await withDesk(COMPLETE, { message: "adopted\n\nCrew-Identity: newbie_example\nCrew-Adoption: desks/newbie" })
  const plain = await joinWorkspace(join(repo))
  assert.equal(plain.state, "refused")
  assert.match(plain.message, /has an unfinished explicit adoption; review a fresh inventory and continue with --adopt-existing/u)
  assert.match(plain.message, /; review the adoption inventory/u)
  const other = await joinWorkspace(join(repo, { identity: "other_example", alias: "newbie" }))
  assert.match(other.message, /adoption cannot proceed: desks\/newbie\/ has a pending claim for newbie_example/u)
})

test("the clone and the reviewed tree must be clean and plain: uncommitted, ignored, linked and colliding paths are refused", async () => {
  const dirty = await withDesk()
  const revision = git(dirty.clone, ["rev-parse", "HEAD"])
  writeFileSync(path.join(dirty.clone, "stray.txt"), "x")
  assert.match((await joinWorkspace(join(dirty, { adoptExisting: revision }))).message, /uncommitted changes; preserve and commit them before previewing adoption/u)
  await fs.rm(path.join(dirty.clone, "stray.txt"))

  writeFileSync(path.join(dirty.clone, DESK, "untracked.md"), "x")
  assert.match((await joinWorkspace(join(dirty, { adoptExisting: revision }))).message, /uncommitted changes|untracked or ignored files outside the reviewed commit/u)
  await fs.rm(path.join(dirty.clone, DESK, "untracked.md"))

  const linked = await withDesk()
  const target = path.join(linked.clone, DESK, "AGENTS.md")
  await fs.rm(target)
  await fs.symlink(path.join(linked.clone, "README.md"), target)
  assert.match((await joinWorkspace(join(linked, { adoptExisting: git(linked.clone, ["rev-parse", "HEAD"]) }))).message, /is not a regular file; adoption never follows links|uncommitted changes/u)
})

test("committed links and collisions with template paths are refused", async () => {
  const link = await withDesk()
  teammateSync(link, (dir) => spawnSync("ln", ["-s", "../../README.md", path.join(dir, DESK, "link.md")]))
  git(link.clone, ["pull", "-q", "--ff-only", link.bare, "main"])
  assert.match((await joinWorkspace(join(link, { adoptExisting: git(link.clone, ["rev-parse", "HEAD"]) }))).message, /desks\/newbie\/link\.md is not a regular file; adoption never follows links/u)

  const folderLink = await withDesk()
  teammateSync(folderLink, (dir) => spawnSync("ln", ["-s", "../_shared", path.join(dir, DESK, "shared")]))
  git(folderLink.clone, ["pull", "-q", "--ff-only", folderLink.bare, "main"])
  assert.match((await joinWorkspace(join(folderLink, { adoptExisting: git(folderLink.clone, ["rev-parse", "HEAD"]) }))).message, /desks\/newbie\/shared is not a regular file/u)

  const file = await withDesk({ [`${DESK}/_meta`]: "a file where the template has a folder\n" })
  assert.match((await joinWorkspace(join(file, { adoptExisting: git(file.clone, ["rev-parse", "HEAD"]) }))).message, /desks\/newbie\/_meta collides with a template directory/u)

  const dir = await withDesk({ [`${DESK}/AGENTS.md/inner.md`]: "a folder where the template has a file\n" })
  assert.match((await joinWorkspace(join(dir, { adoptExisting: git(dir.clone, ["rev-parse", "HEAD"]) }))).message, /desks\/newbie\/AGENTS\.md collides with a template file/u)

  const desks = await startWorkspaceFixture()
  await fs.rm(path.join(desks.clone, "desks", "newbie"), { recursive: true, force: true })
  teammateSync(desks, (dir2) => writeIn(dir2, `${DESK}/AGENTS.md`, "x"))
  git(desks.clone, ["pull", "-q", "--ff-only", desks.bare, "main"])
  const ignored = path.join(desks.clone, ".git", "info", "exclude")
  await fs.appendFile(ignored, "*.cache\n")
  writeFileSync(path.join(desks.clone, DESK, "x.cache"), "ignored")
  assert.match((await joinWorkspace(join(desks, { adoptExisting: git(desks.clone, ["rev-parse", "HEAD"]) }))).message, /untracked or ignored files outside the reviewed commit/u)
})

test("an interrupted adoption is finished by a rerun against a fresh preview", async () => {
  const repo = await withDesk()
  const first = await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh: ghFor(repo, { create: { code: 1 } }).gh }))
  assert.equal(first.state, "failed")
  assert.equal(first.stage, "pull_request")
  assert.match(first.message, /desks\/newbie\/ is pushed; review a fresh adoption preview and confirm --adopt-existing again to finish the roster row\./u)
  assert.ok(onMain(repo.bare, `${DESK}/README.md`) !== null)

  // A plain rerun is told the adoption is unfinished; the fresh preview adds nothing and finishes the row.
  const plain = await joinWorkspace(join(repo))
  assert.match(plain.message, /has an unfinished explicit adoption/u)
  const fresh = (await previewOf(repo)).revision
  assert.equal(fresh, git(repo.clone, ["rev-parse", "HEAD"]))
  const before = bareGit(repo.bare, ["rev-parse", "main"])
  const second = await joinWorkspace(join(repo, { adoptExisting: fresh, apply: true }))
  assert.equal(second.state, "joined", second.message)
  assert.equal(second.resumed, true)
  assert.equal(bareGit(repo.bare, ["rev-parse", "main~1"]), before, "the rerun adds only the roster row")
  assert.equal(readCrewRoster(repo.clone).filter((row) => row.alias === "newbie").length, 1)
})

test("a returning member is recognized even during adoption, and a row landing from another machine mid-run leaves the desk unused", async () => {
  const repo = await withDesk()
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const mine = await joinWorkspace(join(repo, { adoptExisting: revision, apply: true }))
  assert.equal(mine.state, "joined")
  assert.equal((await joinWorkspace(join(repo, { adoptExisting: revision, apply: true }))).state, "member")

  // Another machine's run registers the member after this run's desk push and before its roster write.
  const racing = await withDesk()
  const reviewed = git(racing.clone, ["rev-parse", "HEAD"])
  const { gh } = ghFor(racing)
  let raced = false
  const hooked = async (args, options) => {
    if (args[1] === "merge" && !raced) {
      raced = true
      const roster = onMain(racing.bare, "_meta/desks.md")
      await pushFromElsewhere(racing, { "_meta/desks.md": `${roster}| newbie2 | ${ME} | desks/newbie2 | acme/team | crew | desks/newbie2 |\n` })
    }
    return gh(args, options)
  }
  const result = await joinWorkspace(join(racing, { adoptExisting: reviewed, apply: true, gh: hooked }))
  assert.equal(result.state, "member", result.message)
  assert.match(result.message, /It joined as newbie2 from another machine meanwhile, so desks\/newbie\/ is unused\./u)
})

test("a teammate's push while the desk is being adopted: rebuilt on the new main, or stopped when the desk or alias is gone or taken", async () => {
  const racePush = (repo, change) => {
    let raced = false
    return (cmd, args, options) => {
      if (!raced && args.includes("push") && git(repo.clone, ["log", "-1", "--format=%B"]).includes("Crew-Adoption")) {
        raced = true
        teammateSync(repo, change)
      }
      return repo.spawnGit(cmd, args, options)
    }
  }
  const roster = (repo) => onMain(repo.bare, "_meta/desks.md")

  const harmless = await withDesk()
  const ok = await joinWorkspace(join(harmless, { adoptExisting: git(harmless.clone, ["rev-parse", "HEAD"]), apply: true, spawnGit: racePush(harmless, (dir) => writeIn(dir, "desks/other/AGENTS.md", "o")) }))
  assert.equal(ok.state, "joined", ok.message)
  assert.ok(onMain(harmless.bare, "desks/other/AGENTS.md") !== null)

  const gone = await withDesk()
  const vanished = await joinWorkspace(join(gone, { adoptExisting: git(gone.clone, ["rev-parse", "HEAD"]), apply: true, spawnGit: racePush(gone, (dir) => spawnSync("git", ["-C", dir, "rm", "-rq", DESK])) }))
  assert.equal(vanished.state, "failed")
  assert.equal(vanished.stage, "desk")
  assert.match(vanished.reason, /desks\/newbie\/ changed since the adoption preview; preview again/u)
  assert.equal(git(gone.clone, ["status", "--porcelain"]), "")

  const registered = await withDesk()
  const done = await joinWorkspace(join(registered, { adoptExisting: git(registered.clone, ["rev-parse", "HEAD"]), apply: true, spawnGit: racePush(registered, (dir) => writeIn(dir, "_meta/desks.md", `${roster(registered)}| newbie2 | ${ME} | desks/newbie2 | acme/team | crew | desks/newbie2 |\n`)) }))
  assert.equal(done.state, "member", done.message)

  const taken = await withDesk()
  const lost = await joinWorkspace(join(taken, { adoptExisting: git(taken.clone, ["rev-parse", "HEAD"]), apply: true, spawnGit: racePush(taken, (dir) => writeIn(dir, "_meta/desks.md", `${roster(taken)}| newbie | other_example | desks/x | acme/team | crew | desks/x |\n`)) }))
  assert.equal(lost.state, "failed")
  assert.equal(lost.stage, "alias")
  assert.match(lost.reason, /the alias newbie belongs to other_example; choose another alias/u)
})

test("while the roster row is landing: a changed desk, template, reservation or claim stops the merge, and before the merge nothing lands", async () => {
  const roster = (repo) => onMain(repo.bare, "_meta/desks.md")
  const scenarios = [
    ["the desk changes", (repo) => ({ [`${DESK}/notes/deep/idea.md`]: "changed in flight" }), /adopted desk or template changed since the preview; the roster row was not merged by this run/u],
    ["the template changes", () => ({ "desks/_template/extra.md": "x\n" }), /adopted desk or template changed since the preview/u],
    ["a reservation appears", (repo) => ({ "_meta/desks.md": `${roster(repo)}| other | other_example | desks/newbie/x | acme/team | crew | desks/other |\n` }), /overlaps a registered path for other_example/u],
    ["the alias is taken", (repo) => ({ "_meta/desks.md": `${roster(repo)}| newbie | other_example | desks/elsewhere | acme/team | crew | desks/elsewhere |\n` }), /the alias newbie belongs to other_example; reconcile that reservation first/u],
    ["the identity is registered under another alias", (repo) => ({ "_meta/desks.md": `${roster(repo)}| newbie2 | ${ME} | desks/newbie2 | acme/team | crew | desks/newbie2 |\n` }), /newbie_example is already registered as newbie2; use the registered alias rather than add another row/u],
    ["the registry disappears", null, /_meta\/desks\.md could not be verified; reconcile the registry before continuing/u],
  ]
  for (const [name, files, reason] of scenarios) {
    const repo = await withDesk()
    const { gh } = ghFor(repo)
    let raced = false
    const hooked = async (args, options) => {
      const answer = await gh(args, options)
      if (args[1] === "create" && !raced) {
        raced = true
        if (files === null) teammateSync(repo, (dir) => spawnSync("git", ["-C", dir, "rm", "-q", "_meta/desks.md"]))
        else await pushFromElsewhere(repo, files(repo))
      }
      return answer
    }
    const result = await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh: hooked }))
    assert.equal(result.state, "failed", name)
    assert.equal(result.stage, "verify", name)
    assert.match(result.reason, reason, name)
    assert.equal(result.pr !== undefined, true)
  }

  // An ownership problem: someone adds a file to the desk for another identity.
  const repo = await withDesk()
  const { gh } = ghFor(repo)
  let raced = false
  const hooked = async (args, options) => {
    const answer = await gh(args, options)
    if (args[1] === "create" && !raced) {
      raced = true
      teammateSync(repo, () => {}, "theirs\n\nCrew-Identity: other_example\nCrew-Adoption: desks/newbie")
    }
    return answer
  }
  const result = await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh: hooked }))
  assert.equal(result.stage, "verify")
  assert.match(result.reason, /desks\/newbie\/ has a pending claim for other_example/u)
})

test("a change that lands during the merge itself is reported after it: the row merged, the adoption needs review", async () => {
  for (const [name, change] of [
    ["the desk changes", { [`${DESK}/notes/deep/idea.md`]: "changed during the merge" }, undefined],
    ["a claim appears", null, "theirs\n\nCrew-Identity: other_example\nCrew-Adoption: desks/newbie"],
  ].map(([n, files, message]) => [n, { files, message }])) {
    const repo = await withDesk()
    const { gh } = ghFor(repo)
    let raced = false
    const hooked = async (args, options) => {
      if (args[1] === "merge" && !raced) {
        raced = true
        if (change.files === null) teammateSync(repo, () => {}, change.message)
        else await pushFromElsewhere(repo, change.files)
      }
      return gh(args, options)
    }
    const result = await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh: hooked }))
    assert.equal(result.state, "failed", name)
    assert.equal(result.stage, "verify", name)
    assert.match(result.reason, /changed during the roster merge/u)
    assert.match(result.message, /The registry row merged, but the adopted desk, template, registry reservations or pending claims changed/u)
  }
})

test("account verification: the account that can push must also be the member, or nothing is adopted", async () => {
  const repo = await withDesk()
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const { gh } = ghFor(repo)
  const asking = (answer) => async (args, options) => (args[0] === "api" && args[args.length - 1] === "user" ? answer : gh(args, options))

  const other = await joinWorkspace(join(repo, { adoptExisting: revision, apply: true, gh: asking({ code: 0, stdout: JSON.stringify({ login: "someone_else" }), stderr: "" }) }))
  assert.equal(other.state, "failed")
  assert.equal(other.stage, "account")
  assert.match(other.reason, /could not verify the authenticated member as newbie_example; nothing may be adopted with another account$/u)

  const denied = await joinWorkspace(join(repo, { adoptExisting: revision, apply: true, gh: asking({ code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)\nmore" }) }))
  assert.equal(denied.stage, "account")
  assert.match(denied.reason, /nothing may be adopted with another account \(gh: Bad credentials \(HTTP 401\)\)$/u)

  const noLogin = await joinWorkspace(join(repo, { adoptExisting: revision, apply: true, gh: asking({ code: 0, stdout: JSON.stringify({ login: 7 }), stderr: "" }) }))
  assert.equal(noLogin.stage, "account")

  // The member's own account, checked with the very token that writes.
  const fake = ghFor(repo)
  const joined = await joinWorkspace(join(repo, { adoptExisting: revision, apply: true, gh: fake.gh }))
  assert.equal(joined.state, "joined", joined.message)
  assert.equal(joined.account, ME)
  assert.ok(fake.calls.some((args) => args[0] === "api" && args[args.length - 1] === "user"))
})

// A shallow clone of the team repository, as a member's machine may hold one.
function shallowOf(repo, { origin = "https://github.com/acme/team.git" } = {}) {
  const clone = path.join(repo.base, `shallow-${Math.random().toString(36).slice(2, 8)}`)
  spawnSync("git", ["clone", "-q", "--depth", "1", `file://${repo.bare}`, clone])
  git(clone, ["config", "user.email", "new@example.com"])
  git(clone, ["config", "user.name", "New Member"])
  git(clone, ["remote", "set-url", "origin", origin])
  assert.equal(git(clone, ["rev-parse", "--is-shallow-repository"]), "true")
  return { ...repo, clone }
}

test("a shallow clone recovers its complete history before any ownership is judged, for a preview and for an apply", async () => {
  const repo = await withDesk()
  const shallow = shallowOf(repo)
  const refused = await joinWorkspace(join(shallow))
  assert.equal(refused.state, "refused", refused.message)
  assert.equal(git(shallow.clone, ["rev-parse", "--is-shallow-repository"]), "false")
  assert.match(refused.message, /--adopt-existing/u)

  const other = shallowOf(repo)
  const result = await joinWorkspace(join(other, { adoptExisting: git(other.clone, ["rev-parse", "HEAD"]), apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(git(other.clone, ["rev-parse", "--is-shallow-repository"]), "false")
})

test("shallow history that cannot be recovered fails before anything is written", async () => {
  const repo = await withDesk()

  const noOrigin = shallowOf(repo, { origin: "/somewhere/else.git" })
  const none = await joinWorkspace(join(noOrigin))
  assert.equal(none.state, "failed")
  assert.equal(none.stage, "history")
  assert.match(none.reason, /no authenticated GitHub default-branch route for recovery/u)

  const unauthenticated = shallowOf(repo)
  const wrong = await joinWorkspace(join(unauthenticated, { gh: fakeGh(repo.bare, { accounts: ["someone_else"] }).gh }))
  assert.equal(wrong.stage, "account")
  assert.equal(git(unauthenticated.clone, ["rev-parse", "--is-shallow-repository"]), "true")

  const refusedFetch = shallowOf(repo)
  const spawnGit = (cmd, args, options) => (args.includes("--unshallow") ? { status: 1, stdout: "", stderr: "fatal: unable to access\nmore" } : repo.spawnGit(cmd, args, options))
  const failed = await joinWorkspace(join(refusedFetch, { spawnGit }))
  assert.equal(failed.stage, "history")
  assert.match(failed.reason, /fetching complete history failed: .*unable to access/u)
  assert.equal(git(refusedFetch.clone, ["status", "--porcelain"]), "")

  // The upstream hands over a history that is still shallow.
  const still = shallowOf(repo)
  const stillShallow = (cmd, args, options) => (args.includes("--unshallow") ? { status: 0, stdout: "", stderr: "" } : repo.spawnGit(cmd, args, options))
  const remains = await joinWorkspace(join(still, { spawnGit: stillShallow }))
  assert.equal(remains.stage, "history")
  assert.match(remains.reason, /ownership history remains incomplete: the upstream did not supply a complete history/u)
})

test("a second recovery attempt in one run is refused rather than looped", async () => {
  const repo = await withDesk()
  const clone = repo.clone
  // Shallow at the first check, whole after the recovery, and shallow again once the clone is brought up to date.
  let asked = 0
  let synced = false
  const spawnGit = (cmd, args, options) => {
    if (args.includes("--unshallow")) return { status: 0, stdout: "", stderr: "" }
    if (args.includes("--ff-only")) synced = true
    if (args.includes("--is-shallow-repository")) {
      asked += 1
      const shallow = asked === 1 || synced
      synced = false
      return { status: 0, stdout: `${shallow}\n`, stderr: "" }
    }
    return repo.spawnGit(cmd, args, options)
  }
  const result = await joinWorkspace(join(repo, { adoptExisting: git(clone, ["rev-parse", "HEAD"]), apply: true, spawnGit }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "history")
  assert.match(result.reason, /still incomplete after this run's recovery attempt; no further history fetch will be attempted/u)
  assert.equal(git(clone, ["status", "--porcelain"]), "")
})

test("git that does not say whether history is complete is a failure, never a guess", async () => {
  const repo = await withDesk()
  const spawnGit = (cmd, args, options) => (args.includes("--is-shallow-repository") ? { status: 0, stdout: "maybe\n", stderr: "" } : repo.spawnGit(cmd, args, options))
  const result = await joinWorkspace(join(repo, { spawnGit }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "history")
  assert.match(result.reason, /Git did not report whether ownership history is complete/u)
})

test("a clone that another session also uses: a second clone's identical adoption sees the first's checkpoint as its own", async () => {
  const repo = await withDesk()
  await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh: ghFor(repo, { create: { code: 1 } }).gh }))
  const elsewhere = await secondClone(repo)
  git(elsewhere, ["remote", "set-url", "origin", "https://github.com/acme/team.git"])
  const result = await joinWorkspace(join({ ...repo, clone: elsewhere }, { adoptExisting: git(elsewhere, ["rev-parse", "HEAD"]), apply: true }))
  assert.equal(result.state, "joined", result.message)
})

test("a short roster row, a roster that does not exist yet and a stale pull-request branch name do not stop an adoption", async () => {
  const short = await withDesk()
  await pushFromElsewhere(short, { "_meta/desks.md": "| path | alias | identity |\n|---|---|---|\n| desks/x |\n" })
  git(short.clone, ["pull", "-q", "--ff-only", short.bare, "main"])
  const plan = await joinWorkspace(join(short, { adoptExisting: git(short.clone, ["rev-parse", "HEAD"]) }))
  assert.equal(plan.state, "plan", plan.message)

  const bare = await teamRepo({ "desks/_template/AGENTS.md": "# {{alias}}\n", [`${DESK}/notes.md`]: "mine\n" })
  const revision = git(bare.clone, ["rev-parse", "HEAD"])
  const none = await joinWorkspace(join(bare, { adoptExisting: revision }))
  assert.equal(none.state, "plan", none.message)
  assert.deepEqual(none.adoption.missing, [`${DESK}/AGENTS.md`])

  // The branch this run would open already exists on origin: the next free name is taken.
  const taken = await withDesk()
  bareGit(taken.bare, ["branch", `crew/join-newbie-${NOW().toString(36)}`, "main"])
  const fake = ghFor(taken)
  const result = await joinWorkspace(join(taken, { adoptExisting: git(taken.clone, ["rev-parse", "HEAD"]), apply: true, gh: fake.gh }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(fake.state.head, `crew/join-newbie-${(NOW() + 1).toString(36)}`)
})

test("a desk that is a link to a folder is refused", async () => {
  const repo = await withDesk()
  teammateSync(repo, (dir) => {
    spawnSync("git", ["-C", dir, "rm", "-rq", DESK])
    spawnSync("ln", ["-s", "../_shared", path.join(dir, DESK)])
  })
  git(repo.clone, ["pull", "-q", "--ff-only", repo.bare, "main"])
  const result = await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]) }))
  assert.equal(result.state, "refused")
  assert.match(result.message, /desks\/newbie is not a regular directory; adoption never follows links/u)
})

test("a teammate's conflicting roster change together with a desk change during the merge stops the rebuilt roster row", async () => {
  const repo = await withDesk()
  const { gh } = ghFor(repo)
  let raced = false
  const hooked = async (args, options) => {
    if (args[1] === "merge" && !raced) {
      raced = true
      await pushFromElsewhere(repo, { "_meta/desks.md": `${onMain(repo.bare, "_meta/desks.md")}| other | other_example | desks/other | acme/team | crew | desks/other |\n`, [`${DESK}/notes/deep/idea.md`]: "changed meanwhile" })
    }
    return gh(args, options)
  }
  const result = await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh: hooked }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "desk")
  assert.match(result.reason, /desks\/newbie\/ changed since the adoption preview; preview again and confirm the new contents/u)
  assert.match(result.message, /review a fresh adoption preview and confirm --adopt-existing again/u)
})

test("history that turns out shallow after the recovery fails at the ownership check instead of guessing", async () => {
  const repo = await withDesk()
  let asked = 0
  let synced = false
  let afterSync = 0
  const spawnGit = (cmd, args, options) => {
    if (args.includes("--unshallow")) return { status: 0, stdout: "", stderr: "" }
    if (args.includes("--ff-only")) synced = true
    if (args.includes("--is-shallow-repository")) {
      asked += 1
      if (!synced) return { status: 0, stdout: `${asked === 1}\n`, stderr: "" }
      afterSync += 1
      return { status: 0, stdout: `${afterSync > 1}\n`, stderr: "" }
    }
    return repo.spawnGit(cmd, args, options)
  }
  const result = await joinWorkspace(join(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, spawnGit }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "history")
  assert.match(result.reason, /no claim can be inferred from this shallow history/u)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
})
