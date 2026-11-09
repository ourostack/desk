import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { fakeGh, git, mainFiles, noWait, onMain, pushFromElsewhere, secondClone, teamRepo, toBare } from "./_fixtures.js"
import { joinWorkspace } from "../../../../../plugins/desk/mcp/src/crew/workspace.js"
import { main } from "../../../../../plugins/desk/mcp/scripts/crew.js"

const DESK = "desks/newbie"
const NOTE = `${DESK}/loose.md`
const CONTENT = "# Member's existing work\n\n[Source](../../_shared/landscape/source.md)\n"
const FILES = {
  "_meta/desks.md": "| alias | identity | path | write_subtree |\n|---|---|---|---|\n| pat | pat_example | desks/pat | desks/pat |\n",
  "desks/pat/AGENTS.md": "# Pat\n",
  "desks/_template/AGENTS.md": "# {{alias}}\n",
  "desks/_template/README.md": "Desk for {{identity}}\n",
  "desks/_template/_meta/friction.md": "# Friction\n",
  "_shared/landscape/source.md": "# Source\n",
  [NOTE]: CONTENT,
}

async function fixture(t, files = FILES) {
  const repo = await teamRepo(files)
  t.diagnostic(`Synthetic fixture root (owned by test teardown): ${repo.base}`)
  return repo
}

const args = (repo, extra = {}) => ({
  repo: repo.clone, spawnGit: repo.spawnGit, gh: fakeGh(repo.bare).gh,
  identity: "tester", alias: "newbie", wait: noWait, now: () => 1767225600000,
  ...extra,
})

test("an unregistered partial desk refuses by default and offers a revision-bound adoption preview", async (t) => {
  const repo = await fixture(t)
  const head = git(repo.clone, ["rev-parse", "HEAD"])
  const result = await joinWorkspace(args(repo, { apply: true }))
  assert.equal(result.state, "refused")
  assert.equal(result.adoption.revision, head)
  assert.deepEqual(result.adoption.preserved, [NOTE])
  assert.deepEqual(result.adoption.missing, [`${DESK}/AGENTS.md`, `${DESK}/README.md`, `${DESK}/_meta/friction.md`])
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), head)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal(onMain(repo.bare, NOTE), CONTENT)
})

test("confirmed adoption preserves loose content and custom template files, then registers once through a shared write", async (t) => {
  const custom = "# Existing member preferences\n"
  const repo = await fixture(t, { ...FILES, [`${DESK}/AGENTS.md`]: custom })
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const plan = await joinWorkspace(args(repo, { adoptExisting: revision }))
  assert.equal(plan.state, "plan", plan.message)
  assert.deepEqual(plan.adoption.missing, [`${DESK}/README.md`, `${DESK}/_meta/friction.md`])
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), revision)
  const result = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(repo.bare, NOTE), CONTENT, "filing is agent-guided; join must not guess a destination or rewrite references")
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), custom)
  assert.equal(onMain(repo.bare, `${DESK}/README.md`), "Desk for tester\n")
  assert.equal(onMain(repo.bare, "desks/pat/AGENTS.md"), "# Pat\n")
  assert.match(onMain(repo.bare, "_meta/desks.md"), /\| newbie \| tester \| desks\/newbie \| desks\/newbie \|/u)
  assert.equal(git(repo.clone, ["show", "--format=", "--name-only", "HEAD"]), "_meta/desks.md")
  const after = git(repo.clone, ["rev-parse", "HEAD"])
  assert.equal((await joinWorkspace(args(repo, { adoptExisting: revision, apply: true }))).state, "member")
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), after)
})

test("adoption refuses a stale content or template preview without changing existing files", async (t) => {
  for (const changed of [NOTE, "desks/_template/README.md"]) {
    const repo = await fixture(t)
    const revision = git(repo.clone, ["rev-parse", "HEAD"])
    await pushFromElsewhere(repo, { [changed]: "Changed after confirmation\n" })
    const result = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true }))
    assert.equal(result.state, "refused", result.message)
    assert.match(result.message, /changed.*preview/iu)
    assert.equal(onMain(repo.bare, changed), "Changed after confirmation\n")
    assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
  }
})

test("an unrelated remote change does not invalidate adoption of the reviewed desk and template", async (t) => {
  const repo = await fixture(t)
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  await pushFromElsewhere(repo, { "_shared/landscape/other.md": "Another member's fact\n" })
  const result = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(onMain(repo.bare, NOTE), CONTENT)
  assert.equal(onMain(repo.bare, "_shared/landscape/other.md"), "Another member's fact\n")
})

test("adoption refuses another member's alias, path reservation or recorded pending claim", async (t) => {
  for (const mode of ["alias", "path", "claim"]) {
    const registry = mode === "alias" ? "| newbie | other | desks/newbie | desks/newbie |\n" : "| reserved | other | desks/newbie | desks/newbie |\n"
    const repo = await fixture(t, mode === "claim" ? FILES : { ...FILES, "_meta/desks.md": FILES["_meta/desks.md"] + registry })
    if (mode === "claim") await pushFromElsewhere(repo, { [`${DESK}/other.md`]: "Other member\n" }, "Pending desk\n\nCrew-Identity: other")
    // Fetching the claim is part of the production join's pre-write checks.
    const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true }))
    assert.equal(result.state, "refused", result.message)
    assert.match(result.message, /alias.*belongs|overlaps a registered path|pending claim/u)
    assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
    assert.equal(onMain(repo.bare, NOTE), CONTENT)
  }
})

test("adoption requires the authenticated member, without switching the active account", async (t) => {
  const repo = await fixture(t)
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const denied = await joinWorkspace(args(repo, { identity: "someone_else", adoptExisting: revision, apply: true }))
  assert.equal(denied.state, "failed")
  assert.equal(denied.stage, "account")
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
  const { gh, calls } = fakeGh(repo.bare, { accounts: ["other", "tester"] })
  const result = await joinWorkspace(args(repo, { gh, adoptExisting: revision, apply: true }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(result.account, "tester")
  assert.ok(!calls.some((call) => call[0] === "auth" && call[1] === "switch"))
})

test("adoption rejects an invalid or absent revision instead of silently adopting", async (t) => {
  const repo = await fixture(t)
  for (const revision of ["", "HEAD", "0".repeat(40)]) {
    const result = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true }))
    assert.equal(result.state, "refused", result.message)
    assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
  }
})

test("adoption refuses a template directory/file collision and preserves both sides", async (t) => {
  const repo = await fixture(t, { ...FILES, [`${DESK}/_meta`]: "Not a directory\n" })
  const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true }))
  assert.equal(result.state, "refused", result.message)
  assert.match(result.message, /collides with a template directory/u)
  assert.equal(onMain(repo.bare, `${DESK}/_meta`), "Not a directory\n")
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
})

test("adoption refuses symlinks and untracked ignored files instead of following or overwriting them", async (t) => {
  for (const mode of ["symlink", "ignored"]) {
    const repo = await fixture(t, { ...FILES, ".gitignore": "desks/newbie/private.md\n" })
    if (mode === "symlink") {
      await fs.symlink("../../_shared/landscape", path.join(repo.clone, DESK, "linked"))
      git(repo.clone, ["add", "--", `${DESK}/linked`])
      git(repo.clone, ["commit", "-qm", "Linked directory"])
      git(repo.clone, ["push", "-q", repo.bare, "main"])
    } else await fs.writeFile(path.join(repo.clone, DESK, "private.md"), "Ignored member file\n")
    const before = mainFiles(repo.bare)
    const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true }))
    assert.equal(result.state, "refused", result.message)
    assert.match(result.message, mode === "symlink" ? /never follows links/u : /untracked or ignored/u)
    assert.deepEqual(mainFiles(repo.bare), before)
    assert.equal(onMain(repo.bare, "_shared/landscape/source.md"), "# Source\n")
    if (mode === "ignored") assert.equal(await fs.readFile(path.join(repo.clone, DESK, "private.md"), "utf8"), "Ignored member file\n")
  }
})

test("the CLI accepts the reviewed adoption revision and still requires apply", async (t) => {
  const repo = await fixture(t)
  let output = ""
  const code = await main({
    argv: ["join", "--repo", repo.clone, "--identity", "tester", "--alias", "newbie", "--adopt-existing", git(repo.clone, ["rev-parse", "HEAD"])],
    write: (text) => { output += text },
  })
  assert.equal(code, 0, output)
  assert.equal(JSON.parse(output).state, "plan")
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
})

test("adoption detects a changed desk during a rejected push retry and preserves the remote change", async (t) => {
  const repo = await fixture(t)
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const other = await secondClone(repo)
  await fs.writeFile(path.join(other, NOTE), "Changed during push\n")
  git(other, ["add", "--", NOTE])
  git(other, ["commit", "-qm", "Concurrent member edit"])
  let raced = false
  const spawnGit = (cmd, argv, options) => {
    if (!raced && argv.includes("push")) {
      raced = true
      git(other, ["push", "-q", "origin", "main"])
    }
    return repo.spawnGit(cmd, argv, options)
  }
  const result = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true, spawnGit }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "desk")
  assert.match(result.message, /changed.*preview/iu)
  assert.equal(raced, true)
  assert.equal(onMain(repo.bare, NOTE), "Changed during push\n")
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
})

test("an adoption desk push failure restores only additions and keeps every preexisting file", async (t) => {
  const repo = await fixture(t)
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const spawnGit = (cmd, argv, options) => argv.includes("push")
    ? { status: 1, stdout: "", stderr: "Protected branch update failed" }
    : repo.spawnGit(cmd, argv, options)
  const result = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true, spawnGit }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "push")
  assert.equal(await fs.readFile(path.join(repo.clone, NOTE), "utf8"), CONTENT)
  assert.equal(onMain(repo.bare, NOTE), CONTENT)
  assert.equal(git(repo.clone, ["status", "--porcelain"]), "")
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), revision)
})

test("a registry-only alias reservation during the desk push prevents a retry from adding templates", async (t) => {
  const repo = await fixture(t)
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const other = await secondClone(repo)
  await fs.writeFile(path.join(other, "_meta/desks.md"), "| alias | identity |\n|---|---|\n| newbie | other |\n")
  git(other, ["add", "--", "_meta/desks.md"])
  git(other, ["commit", "-qm", "Concurrent alias reservation"])
  let raced = false
  const spawnGit = (cmd, argv, options) => {
    if (!raced && argv.includes("push")) {
      raced = true
      git(other, ["push", "-q", "origin", "main"])
    }
    return repo.spawnGit(cmd, argv, options)
  }
  const result = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true, spawnGit }))
  assert.equal(result.state, "failed")
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null, "another member's newly reserved folder must not receive our additions")
  assert.equal(onMain(repo.bare, NOTE), CONTENT)
})

test("a token that cannot verify the requested login cannot adopt or write a roster row", async (t) => {
  const repo = await fixture(t)
  const fake = fakeGh(repo.bare)
  const gh = async (argv, options) => argv[0] === "api" && argv[1] === "user"
    ? { code: 401, stdout: "{\"message\":\"Bad credentials\"}", stderr: "HTTP 401" }
    : fake.gh(argv, options)
  const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh }))
  assert.equal(result.state, "failed")
  assert.equal(result.stage, "account")
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
})

test("adoption refuses a symlinked registry before adding any desk files", async (t) => {
  const repo = await fixture(t)
  await fs.rename(path.join(repo.clone, "_meta/desks.md"), path.join(repo.clone, "_meta/real-desks.md"))
  await fs.symlink("real-desks.md", path.join(repo.clone, "_meta/desks.md"))
  git(repo.clone, ["add", "-A"])
  git(repo.clone, ["commit", "-qm", "Linked registry"])
  git(repo.clone, ["push", "-q", repo.bare, "main"])
  const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true }))
  assert.equal(result.state, "refused", result.message)
  assert.match(result.message, /registry.*regular|registry.*link/iu)
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
  assert.equal(onMain(repo.bare, "_meta/real-desks.md"), FILES["_meta/desks.md"])
})

test("adoption does not merge a roster row when the reviewed content changes after its PR opens", async (t) => {
  const repo = await fixture(t)
  const fake = fakeGh(repo.bare)
  const gh = async (argv, options) => {
    const result = await fake.gh(argv, options)
    if (argv[0] === "pr" && argv[1] === "create") await pushFromElsewhere(repo, { [NOTE]: "Changed while the roster merged\n" })
    return result
  }
  const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "verify")
  assert.equal(onMain(repo.bare, NOTE), "Changed while the roster merged\n")
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
})

test("adoption readback reports an unconfirmed outcome if content changes after GitHub merges", async (t) => {
  const repo = await fixture(t)
  const fake = fakeGh(repo.bare)
  const gh = async (argv, options) => {
    const result = await fake.gh(argv, options)
    if (argv[0] === "pr" && argv[1] === "merge") await pushFromElsewhere(repo, { [NOTE]: "Changed just after merge\n" })
    return result
  }
  const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "verify")
  assert.match(result.message, /row merged.*changed/iu)
  assert.equal(onMain(repo.bare, NOTE), "Changed just after merge\n")
  assert.match(onMain(repo.bare, "_meta/desks.md"), /\| newbie \| tester \|/u)
})

test("an interrupted adoption requires a fresh explicit preview and member authentication until registered", async (t) => {
  const repo = await fixture(t)
  const first = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh: fakeGh(repo.bare, { create: { code: 1 } }).gh }))
  assert.equal(first.state, "failed")
  assert.equal(first.stage, "pull_request")
  assert.equal(onMain(repo.bare, `${DESK}/README.md`), "Desk for tester\n")
  await pushFromElsewhere(repo, { [NOTE]: "Changed before adoption resumes\n" })
  const blocked = await joinWorkspace(args(repo, { apply: true, gh: fakeGh(repo.bare, { accounts: ["other"] }).gh }))
  assert.equal(blocked.state, "refused", blocked.message)
  assert.match(blocked.message, /unfinished.*adoption/iu)
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
  // Fetch through the fixture transport; the fresh preview must include the changed content.
  git(repo.clone, ["fetch", "-q", repo.bare, "main:refs/remotes/origin/main"])
  git(repo.clone, ["merge", "--ff-only", "origin/main"])
  const preview = await joinWorkspace(args(repo))
  assert.equal(preview.state, "refused")
  const denied = await joinWorkspace(args(repo, { adoptExisting: preview.adoption.revision, apply: true, gh: fakeGh(repo.bare, { accounts: ["other"] }).gh }))
  assert.equal(denied.state, "failed")
  assert.equal(denied.stage, "account")
  const again = await joinWorkspace(args(repo, { adoptExisting: preview.adoption.revision, apply: true }))
  assert.equal(again.state, "joined", again.message)
  assert.equal(onMain(repo.bare, NOTE), "Changed before adoption resumes\n")
  assert.equal(again.resumed, true)
})

test("a nonconflicting path reservation after PR creation prevents adoption's registry merge", async (t) => {
  const registry = FILES["_meta/desks.md"] + "| second | second | desks/second | desks/second |\n| third | third | desks/third | desks/third |\n"
  const repo = await fixture(t, { ...FILES, "_meta/desks.md": registry })
  const fake = fakeGh(repo.bare)
  const gh = async (argv, options) => {
    const result = await fake.gh(argv, options)
    if (argv[0] === "pr" && argv[1] === "create") await pushFromElsewhere(repo, { "_meta/desks.md": registry.replaceAll("desks/pat", DESK) })
    return result
  }
  const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "verify")
  assert.match(result.message, /reservation|registered path/u)
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
})

test("explicit adoption of a complete resumable desk keeps its safeguards after interruption", async (t) => {
  const repo = await fixture(t, {
    ...FILES,
    [`${DESK}/AGENTS.md`]: "# Existing preferences\n",
    [`${DESK}/README.md`]: "# Existing desk\n",
    [`${DESK}/_meta/friction.md`]: "# Existing friction\n",
  })
  await pushFromElsewhere(repo, { [`${DESK}/prior.md`]: "Earlier ordinary join\n" }, "Earlier desk push\n\nCrew-Identity: tester")
  git(repo.clone, ["fetch", "-q", repo.bare, "main:refs/remotes/origin/main"])
  git(repo.clone, ["merge", "--ff-only", "origin/main"])
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const tree = git(repo.clone, ["rev-parse", `HEAD:${DESK}`])
  const first = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true, gh: fakeGh(repo.bare, { create: { code: 1 } }).gh }))
  assert.equal(first.state, "failed")
  assert.equal(first.stage, "pull_request")
  assert.equal(git(repo.clone, ["rev-parse", `HEAD:${DESK}`]), tree, "recording adoption must not alter any existing file")
  await pushFromElsewhere(repo, { [NOTE]: "Changed complete desk\n" })
  const retry = await joinWorkspace(args(repo, { apply: true, gh: fakeGh(repo.bare, { accounts: ["other"] }).gh }))
  assert.equal(retry.state, "refused", retry.message)
  assert.match(retry.message, /unfinished.*adoption/iu)
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
})

test("a trailer-free complete legacy folder stays claimed by its authenticated adopter after interruption", async (t) => {
  const repo = await fixture(t, {
    ...FILES,
    [`${DESK}/AGENTS.md`]: "# Legacy preferences\n",
    [`${DESK}/README.md`]: "# Legacy desk\n",
    [`${DESK}/_meta/friction.md`]: "# Legacy friction\n",
  })
  const revision = git(repo.clone, ["rev-parse", "HEAD"])
  const tree = git(repo.clone, ["rev-parse", `HEAD:${DESK}`])
  assert.ok(!git(repo.clone, ["log", "--format=%B"]).includes("Crew-Identity:"))
  const first = await joinWorkspace(args(repo, { adoptExisting: revision, apply: true, gh: fakeGh(repo.bare, { create: { code: 1 } }).gh }))
  assert.equal(first.state, "failed")
  assert.equal(first.stage, "pull_request")
  const checkpoint = git(repo.clone, ["rev-parse", "HEAD"])
  assert.notEqual(checkpoint, revision)
  assert.equal(git(repo.clone, ["rev-parse", `HEAD:${DESK}`]), tree)
  assert.ok(!git(repo.clone, ["log", "--diff-filter=A", "--format=%B", "--", `${DESK}/`]).includes("Crew-Identity:"), "the only claim is an empty checkpoint, not a file-addition commit")
  const other = await joinWorkspace(args(repo, { identity: "other", adoptExisting: checkpoint, apply: true, gh: fakeGh(repo.bare, { accounts: ["other"] }).gh }))
  assert.equal(other.state, "refused", other.message)
  assert.match(other.message, /pending claim for tester/u)
  assert.equal(git(repo.clone, ["rev-parse", "HEAD"]), checkpoint)
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
  const recovered = await joinWorkspace(args(repo, { adoptExisting: checkpoint, apply: true }))
  assert.equal(recovered.state, "joined", recovered.message)
  assert.match(onMain(repo.bare, "_meta/desks.md"), /\| newbie \| tester \|/u)
  assert.equal(git(repo.clone, ["rev-parse", `HEAD:${DESK}`]), tree)
})

test("a conflicting empty adoption checkpoint arriving after PR creation prevents its merge", async (t) => {
  const repo = await fixture(t)
  const fake = fakeGh(repo.bare)
  const gh = async (argv, options) => {
    const result = await fake.gh(argv, options)
    if (argv[0] === "pr" && argv[1] === "create") {
      const other = await secondClone(repo)
      t.diagnostic(`Concurrent synthetic clone: ${other}`)
      git(other, ["commit", "--allow-empty", "-qm", `Concurrent claim\n\nCrew-Adoption: ${DESK}\nCrew-Identity: other`])
      git(other, ["push", "-q", "origin", "main"])
    }
    return result
  }
  const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "verify")
  assert.match(result.message, /pending claim for other/u)
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
})

test("an empty adoption checkpoint without an identity remains an unresolved claim", async (t) => {
  const repo = await fixture(t)
  git(repo.clone, ["commit", "--allow-empty", "-qm", `Unverifiable claim\n\nCrew-Adoption: ${DESK}`])
  git(repo.clone, ["push", "-q", repo.bare, "main"])
  const result = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true }))
  assert.equal(result.state, "refused", result.message)
  assert.match(result.message, /unverifiable pending adoption claim/u)
  assert.equal(onMain(repo.bare, `${DESK}/AGENTS.md`), null)
})

async function completeLegacy(t) {
  return fixture(t, {
    ...FILES,
    [`${DESK}/AGENTS.md`]: "# Legacy preferences\n",
    [`${DESK}/README.md`]: "# Legacy desk\n",
    [`${DESK}/_meta/friction.md`]: "# Legacy friction\n",
  })
}

function shallowClone(t, repo, name, bare = repo.bare) {
  const clone = path.join(repo.base, name)
  t.diagnostic(`Synthetic shallow clone: ${clone}`)
  const result = spawnSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(bare).href, clone], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  git(clone, ["config", "user.email", "shallow@example.com"])
  git(clone, ["config", "user.name", "Shallow Member"])
  git(clone, ["remote", "set-url", "origin", "https://github.com/acme/team.git"])
  assert.equal(git(clone, ["rev-parse", "--is-shallow-repository"]), "true")
  return { ...repo, bare, clone, spawnGit: toBare(bare) }
}

test("a depth-one clone recovers hidden checkpoint history before refusing another member's adoption", async (t) => {
  const repo = await completeLegacy(t)
  const first = await joinWorkspace(args(repo, { adoptExisting: git(repo.clone, ["rev-parse", "HEAD"]), apply: true, gh: fakeGh(repo.bare, { create: { code: 1 } }).gh }))
  assert.equal(first.state, "failed")
  assert.equal(first.stage, "pull_request")
  await pushFromElsewhere(repo, { "_shared/landscape/unrelated.md": "Unrelated subsequent commit\n" })
  const other = shallowClone(t, repo, "shallow-other")
  assert.ok(!git(other.clone, ["log", "--format=%B"]).includes("Crew-Adoption:"))
  const result = await joinWorkspace(args(other, { identity: "other", adoptExisting: git(other.clone, ["rev-parse", "HEAD"]), apply: true, gh: fakeGh(repo.bare, { accounts: ["other"] }).gh }))
  assert.equal(result.state, "refused", result.message)
  assert.match(result.message, /pending claim for tester/u)
  assert.equal(git(other.clone, ["rev-parse", "--is-shallow-repository"]), "false")
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
  const member = shallowClone(t, repo, "shallow-original-member")
  const recovered = await joinWorkspace(args(member, { adoptExisting: git(member.clone, ["rev-parse", "HEAD"]), apply: true }))
  assert.equal(recovered.state, "joined", recovered.message)
  assert.equal(git(member.clone, ["rev-parse", "--is-shallow-repository"]), "false")
  assert.equal(onMain(repo.bare, NOTE), CONTENT)
  assert.match(onMain(repo.bare, "_meta/desks.md"), /\| newbie \| tester \|/u)
})

test("a shallow trailer-free legacy folder remains adoptable after authenticated history recovery", async (t) => {
  const repo = await completeLegacy(t)
  await pushFromElsewhere(repo, { "_shared/landscape/unrelated.md": "More complete history without a claim\n" })
  const member = shallowClone(t, repo, "shallow-legacy-member")
  let recoveries = 0
  const spawnGit = (cmd, argv, options) => {
    if (argv.includes("--unshallow")) recoveries += 1
    return member.spawnGit(cmd, argv, options)
  }
  const result = await joinWorkspace(args(member, { adoptExisting: git(member.clone, ["rev-parse", "HEAD"]), apply: true, spawnGit }))
  assert.equal(result.state, "joined", result.message)
  assert.equal(recoveries, 1)
  assert.equal(git(member.clone, ["rev-parse", "--is-shallow-repository"]), "false")
  assert.equal(onMain(repo.bare, NOTE), CONTENT)
})

test("a shallow preview recovers history but writes no adoption checkpoint or registry row", async (t) => {
  const repo = await completeLegacy(t)
  await pushFromElsewhere(repo, { "_shared/landscape/unrelated.md": "Unrelated history\n" })
  const member = shallowClone(t, repo, "shallow-preview")
  const head = git(member.clone, ["rev-parse", "HEAD"])
  const fake = fakeGh(repo.bare)
  const result = await joinWorkspace(args(member, { adoptExisting: head, gh: fake.gh }))
  assert.equal(result.state, "plan", result.message)
  assert.equal(git(member.clone, ["rev-parse", "--is-shallow-repository"]), "false")
  assert.equal(git(member.clone, ["rev-parse", "HEAD"]), head)
  assert.equal(git(member.clone, ["status", "--porcelain"]), "")
  assert.ok(!git(member.clone, ["log", "--format=%B"]).includes("Crew-Adoption:"))
  assert.ok(!onMain(repo.bare, "_meta/desks.md").includes("| newbie |"))
  assert.ok(!fake.calls.some(call => call[0] === "pr"))
})

test("unavailable complete-history recovery reports its failure without adoption writes", async (t) => {
  const repo = await completeLegacy(t)
  await pushFromElsewhere(repo, { "_shared/landscape/unrelated.md": "Unrelated history\n" })
  const member = shallowClone(t, repo, "shallow-unavailable")
  const before = mainFiles(repo.bare)
  const head = git(member.clone, ["rev-parse", "HEAD"])
  let recoveries = 0
  const spawnGit = (cmd, argv, options) => {
    if (argv.includes("--unshallow")) {
      recoveries += 1
      return { status: 1, stdout: "", stderr: "Synthetic history service unavailable" }
    }
    return member.spawnGit(cmd, argv, options)
  }
  const fake = fakeGh(repo.bare)
  const result = await joinWorkspace(args(member, { adoptExisting: head, apply: true, spawnGit, gh: fake.gh }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "history")
  assert.match(result.reason, /Synthetic history service unavailable/u)
  assert.equal(recoveries, 1)
  assert.equal(git(member.clone, ["rev-parse", "HEAD"]), head)
  assert.equal(git(member.clone, ["rev-parse", "--is-shallow-repository"]), "true")
  assert.deepEqual(mainFiles(repo.bare), before)
  assert.ok(!fake.calls.some(call => call[0] === "pr"))
})

test("a shallow upstream cannot supply complete history and no adoption is written", async (t) => {
  const repo = await completeLegacy(t)
  await pushFromElsewhere(repo, { "_shared/landscape/unrelated.md": "Only this commit will be served\n" })
  const partial = path.join(repo.base, "partial-origin.git")
  t.diagnostic(`Synthetic shallow upstream: ${partial}`)
  const cloned = spawnSync("git", ["clone", "-q", "--bare", "--depth", "1", pathToFileURL(repo.bare).href, partial], { encoding: "utf8" })
  assert.equal(cloned.status, 0, cloned.stderr)
  const member = shallowClone(t, repo, "shallow-partial-member", partial)
  const before = mainFiles(partial)
  const head = git(member.clone, ["rev-parse", "HEAD"])
  const result = await joinWorkspace(args(member, { adoptExisting: head, apply: true, gh: fakeGh(partial).gh }))
  assert.equal(result.state, "failed", result.message)
  assert.equal(result.stage, "history")
  assert.match(result.reason, /incomplete|shallow/u)
  assert.equal(git(member.clone, ["rev-parse", "HEAD"]), head)
  assert.equal(git(member.clone, ["rev-parse", "--is-shallow-repository"]), "true")
  assert.deepEqual(mainFiles(partial), before)
  assert.ok(!onMain(partial, "_meta/desks.md").includes("| newbie |"))
})
