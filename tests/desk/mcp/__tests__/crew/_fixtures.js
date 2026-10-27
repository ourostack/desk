// Fixtures for the crew workspace script: a bare repository that stands in for GitHub, a clone of it, and a fake `gh`
// that opens and merges pull requests on that bare repository. The clone's origin reads as
// https://github.com/acme/team.git; only the Git these tests hand the script reaches the bare repository through it.
//
// The CIT-shaped fixture copies the shape of a real team repository (collections under `context/`, `guides/`, a people
// roster in `team/roster.md`, a workflow that merges agent pull requests, a root AGENTS.md that says not to rewrite
// material). Every name and every line of content is an invented placeholder.

import "../_isolated_env.mjs"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"

export const ORIGIN = "https://github.com/acme/team"
export const PR = `${ORIGIN}/pull/12`

export function git(cwd, args, env = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...env } })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

export const onMain = (bare, file) => {
  const result = spawnSync("git", ["--git-dir", bare, "show", `main:${file}`], { encoding: "utf8" })
  return result.status === 0 ? result.stdout : null
}

export const mainFiles = (bare) => spawnSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)

export const branches = (bare) => spawnSync("git", ["--git-dir", bare, "branch", "--format=%(refname:short)"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)

// Git as the script runs it, with https://github.com/acme/team.git leading to `bare`, the way only a test may.
export const toBare = (bare, inner = spawnSync) => (cmd, args, options = {}) => inner(cmd, args, { ...options, env: { ...(options.env ?? process.env), GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: `${ORIGIN}.git`, GIT_CONFIG_KEY_1: `url.${bare}.pushInsteadOf`, GIT_CONFIG_VALUE_1: `${ORIGIN}.git` } })

async function writeAll(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), content)
  }
}

/**
 * A team repository on "GitHub" holding `files` on main (none: an empty repository), and a clone of it. Returns the
 * paths and the Git that reaches the bare repository.
 */
export async function teamRepo(files = {}, { origin = `${ORIGIN}.git` } = {}) {
  const base = await mkTempRoot("crew-workspace-")
  const bare = path.join(base, "origin.git")
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  if (Object.keys(files).length > 0) {
    const seed = path.join(base, "seed")
    spawnSync("git", ["init", "-q", "-b", "main", seed])
    git(seed, ["config", "user.email", "seed@example.com"])
    git(seed, ["config", "user.name", "Seed"])
    await writeAll(seed, files)
    git(seed, ["add", "-A"])
    git(seed, ["commit", "-q", "-m", "seed"])
    git(seed, ["push", "-q", bare, "main"])
  }
  const clone = path.join(base, "clone")
  spawnSync("git", ["clone", "-q", bare, clone], { encoding: "utf8" })
  git(clone, ["config", "user.email", "member@example.com"])
  git(clone, ["config", "user.name", "Member"])
  git(clone, ["remote", "set-url", "origin", origin])
  return { base, bare, clone, spawnGit: toBare(bare) }
}

/** A second clone of the same bare repository, as a teammate's machine. */
export async function secondClone(repo) {
  const other = path.join(repo.base, `other-${Math.random().toString(36).slice(2, 8)}`)
  spawnSync("git", ["clone", "-q", repo.bare, other])
  git(other, ["config", "user.email", "other@example.com"])
  git(other, ["config", "user.name", "Other"])
  return other
}

/** Commits `files` straight onto main in the bare repository, as a teammate's push would. */
export async function pushFromElsewhere(repo, files, message = "teammate change") {
  const other = await secondClone(repo)
  await writeAll(other, files)
  git(other, ["add", "-A"])
  git(other, ["commit", "-q", "-m", message])
  git(other, ["push", "-q", "origin", "main"])
}

export const CIT_SHAPED = Object.freeze({
  "AGENTS.md": "# Hello, agents\n\nRead the [README](README.md) first.\n\n## Contribute safely\n\nCollections go under `context/<collection-name>/`. Do not migrate, reformat or rewrite existing material.\n",
  "README.md": "# Placeholder Team\n\nThis repository holds the placeholder team's shared working context.\n",
  ".gitignore": ".DS_Store\n",
  ".github/workflows/merge-agent-prs.yml": "name: Merge agent pull requests\non:\n  schedule:\n    - cron: \"*/15 * * * *\"\njobs:\n  merge:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          for pr in $(gh pr list --json number,headRefName --jq '.[] | select(.headRefName | startswith(\"copilot/\")) | .number'); do\n            gh pr merge \"$pr\" --squash --delete-branch\n          done\n",
  ".github/acl/access.yml": "placeholder: true\n",
  "context/README.md": "# Context index\n\n- [Collection alpha](collection-alpha/README.md)\n- [Collection beta](collection-beta/notes.md)\n",
  "context/collection-alpha/README.md": "# Collection alpha\n\nInvented placeholder collection about a fictional customer, Example Widgets.\n",
  "context/collection-alpha/meetings/2026-01-05-planning.md": "# 2026-01-05 planning\n\n00:00 Speaker One: Placeholder line.\n00:05 Speaker Two: Another placeholder line.\n",
  "context/collection-alpha/sources/2026-01-05-planning/transcript.json": "{\"placeholder\":true,\"lines\":2}\n",
  "context/collection-beta/notes.md": "Placeholder notes   with  odd   spacing,\ttabs and no final newline",
  "guides/contributing-context.md": "# Contributing context\n\nPut collections under `context/`. Placeholder guide.\n",
  "guides/evidence/screenshot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
  "team/roster.md": "# Placeholder team roster\n\n| Name | Alias | Title | Pronouns | Source |\n|---|---|---|---|---|\n| Pat Example | pexample | Placeholder title | not recorded | Invented |\n| Sam Sample | ssample | Placeholder title | they/them | Invented |\n",
})

/**
 * A fake `gh` acting on the bare repository. `pr create` records the head branch; `pr merge` fast-forwards main to it
 * when main is its ancestor and is a conflict otherwise (or does what `merge(state)` says); `pr view` reports the state.
 */
export function fakeGh(bare, { create = { code: 0 }, merge, view } = {}) {
  const calls = []
  const state = { head: null, merged: false, merges: 0, closed: false }
  const gh = async (args) => {
    calls.push(args)
    const [a, b] = args
    if (a === "pr" && b === "create") {
      state.head = args[args.indexOf("--head") + 1]
      state.merged = false
      if (create.code !== 0) return { code: 1, stdout: "", stderr: "GraphQL: no permission\nmore" }
      return { code: 0, stdout: `Creating pull request\n${PR}\n`, stderr: "" }
    }
    if (a === "pr" && b === "merge") {
      state.merges += 1
      if (merge !== undefined) return merge(state)
      const ok = spawnSync("git", ["--git-dir", bare, "merge-base", "--is-ancestor", "main", state.head]).status === 0
      if (ok) {
        spawnSync("git", ["--git-dir", bare, "update-ref", "refs/heads/main", `refs/heads/${state.head}`])
        state.merged = true
      }
      return { code: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "Pull request is not mergeable" }
    }
    if (a === "pr" && b === "view") {
      if (view !== undefined) return view(state)
      const oid = spawnSync("git", ["--git-dir", bare, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim()
      return { code: 0, stdout: JSON.stringify(state.merged ? { state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", mergeCommit: { oid } } : { state: "OPEN", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", mergeCommit: null }), stderr: "" }
    }
    throw new Error(`unexpected gh ${args.join(" ")}`)
  }
  return { gh, calls, state }
}

export const noWait = async () => {}
