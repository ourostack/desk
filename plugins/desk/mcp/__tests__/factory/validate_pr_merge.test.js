// Review C1 regressions: a pull request head with a second merge base.
//
// `git diff base...head` reads only one merge base, while the merge GitHub
// performs builds a virtual base from all of them, so a crafted head could
// pass validation while its merge reverted files on main. These tests rebuild
// the reviewer's two reproductions with Git plumbing and check that
// validate-pr refuses the head (`unexpected_merge`) and that, even with that
// check out of the way, it judges what the merge lands.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { runValidatePrCommand } from "../../scripts/factory.js"

const FACTS = fileURLToPath(new URL("fixtures/store/facts", import.meta.url))
const VICTIM = "claude-code-11111111-1111-4111-8111-111111111111.json"
const ATTACKER = "claude-code-33333333-3333-4333-8333-333333333333.json"

async function repository(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-validate-pr-merge-"))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  }
  const git = (args, { input, date } = {}) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env,
  }).trim()
  git(["init", "-q", "-b", "main"])
  const blob = (text) => git(["hash-object", "-w", "--stdin"], { input: text })
  const tree = (entries) => git(["mktree"], { input: entries.map(([mode, type, id, name]) => `${mode} ${type} ${id}\t${name}\n`).join("") })
  const commit = (treeId, parents, message, date) => git(["commit-tree", treeId, ...parents.flatMap((parent) => ["-p", parent]), "-m", message], { date })
  try {
    return await run({ root, git, blob, tree, commit })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Runs validate-pr with real Git, optionally hiding the head's merge commits
// so the merge-result judgement is exercised on its own.
function validate(root, base, head, { hideMerges = false } = {}) {
  const git = (args, options) => {
    if (hideMerges && args[0] === "rev-list") return ""
    try {
      return execFileSync("git", args, { cwd: root, encoding: options.encoding === null ? null : "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      const failure = new Error("git failed")
      failure.status = error.status
      throw failure
    }
  }
  return runValidatePrCommand({ argv: ["--base", base, "--head", head, "--author-association", "NONE"], cwd: root, git })
}

test("a stranger's second pull request with two merge bases cannot revert a workflow fix or delete another contributor's facts (review mb2)", () => repository(async ({ root, git, blob, tree, commit }) => {
  const workflow = "name: factory-validate\n"
  const wf1 = blob(workflow)
  const wf2 = blob(`# fixed\n${workflow}`)
  const victimBytes = readFileSync(path.join(FACTS, VICTIM), "utf8")
  const fa = blob(victimBytes)
  const fb = blob(victimBytes.replaceAll("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"))
  const snapshot = (wf, victim, attacker) => {
    const github = tree([["040000", "tree", tree([["100644", "blob", wf, "validate.yml"]]), "workflows"]])
    const facts = [
      ...(victim ? [["100644", "blob", fa, VICTIM]] : []),
      ...(attacker ? [["100644", "blob", fb, ATTACKER]] : []),
    ]
    return tree([["040000", "tree", github, ".github"], ...(facts.length ? [["040000", "tree", tree(facts), "facts"]] : [])])
  }
  const b0 = commit(snapshot(wf1, false, false), [], "B0 workflows", "2030-01-01T00:00:00Z")
  const p1 = commit(snapshot(wf2, false, false), [b0], "maintainer workflow fix", "2030-01-02T00:00:00Z")
  const m1 = commit(snapshot(wf2, false, false), [b0, p1], "M1", "2030-01-02T01:00:00Z")
  const va = commit(snapshot(wf2, true, false), [m1], "victim intake", "2030-01-03T00:00:00Z")
  const ma = commit(snapshot(wf2, true, false), [m1, va], "MA", "2030-01-03T01:00:00Z")
  // The stranger's first intake branches from the old B0 and is valid.
  const ab = commit(snapshot(wf1, false, true), [b0], "attacker intake", "2031-01-01T00:00:00Z")
  assert.deepEqual(await validate(root, ma, ab), { ok: true, maintenance: false, errors: [] })
  const mb = commit(snapshot(wf2, true, true), [ma, ab], "MB (auto-merged)", "2030-01-04T01:00:00Z")
  // The follow-up head has two parents and the first intake's tree.
  const x = commit(snapshot(wf1, false, true), [ma, ab], "attacker follow-up", "2031-01-02T00:00:00Z")
  assert.equal(git(["merge-base", "--all", mb, x]).split("\n").length, 2)
  // What the old base...head diff saw: nothing at all.
  assert.equal(git(["diff", "--name-status", `${mb}...${x}`]), "")

  assert.deepEqual(await validate(root, mb, x), { ok: false, maintenance: false, errors: [{ code: "unexpected_merge", path: "head" }] })
  assert.deepEqual(await validate(root, mb, x, { hideMerges: true }), {
    ok: false,
    maintenance: false,
    errors: [
      { code: "path", path: "changes.0" },
      { code: "removal", path: `facts/${VICTIM}` },
    ],
  })
}))

test("a head with two merge bases cannot slip a README change past a stranger's validation (review mb)", () => repository(async ({ root, blob, tree, commit }) => {
  const wf = blob("name: factory-validate\n")
  const r1 = blob("readme v1\n")
  const r2 = blob("readme v2 maintenance\n")
  const f = blob(readFileSync(path.join(FACTS, VICTIM), "utf8"))
  const github = tree([["040000", "tree", tree([["100644", "blob", wf, "validate.yml"]]), "workflows"]])
  const snapshot = (readme, withFacts) => tree([
    ["040000", "tree", github, ".github"],
    ["100644", "blob", readme, "README.md"],
    ...(withFacts ? [["040000", "tree", tree([["100644", "blob", f, VICTIM]]), "facts"]] : []),
  ])
  const b = commit(snapshot(r1, false), [], "B", "2030-01-01T00:00:00Z")
  const p1 = commit(snapshot(r2, false), [b], "P1 maintenance README", "2030-01-02T00:00:00Z")
  const p2 = commit(snapshot(r1, true), [b], "P2 victim intake", "2030-01-03T00:00:00Z")
  const m1 = commit(snapshot(r2, false), [b, p1], "M1", "2030-01-04T00:00:00Z")
  const m2 = commit(snapshot(r2, true), [m1, p2], "M2", "2030-01-05T00:00:00Z")
  // Tree of P2 with parents P1 and P2: the old diff chose P2 as the base and saw nothing.
  const xb = commit(snapshot(r1, true), [p1, p2], "attacker: tree of P2", "2031-01-01T00:00:00Z")
  assert.deepEqual(await validate(root, m2, xb), { ok: false, maintenance: false, errors: [{ code: "unexpected_merge", path: "head" }] })
  assert.deepEqual(await validate(root, m2, xb, { hideMerges: true }), {
    ok: false,
    maintenance: false,
    errors: [{ code: "path", path: "changes.0" }],
  })
}))
