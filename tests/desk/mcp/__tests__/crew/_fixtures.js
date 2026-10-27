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
export async function teamRepo(files = {}, { origin = `${ORIGIN}.git`, cloneConfig = {} } = {}) {
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
  spawnSync("git", ["clone", "-q", ...Object.entries(cloneConfig).flatMap(([key, value]) => ["-c", `${key}=${value}`]), bare, clone], { encoding: "utf8" })
  git(clone, ["config", "user.email", "member@example.com"])
  git(clone, ["config", "user.name", "Member"])
  git(clone, ["remote", "set-url", "origin", origin])
  return { base, bare, clone, spawnGit: toBare(bare) }
}

/** A second clone of the same bare repository, as a teammate's machine. */
export async function secondClone(repo) {
  const other = path.join(repo.base, `other-${Math.random().toString(36).slice(2, 8)}`)
  const cloned = spawnSync("git", ["clone", "-q", repo.bare, other], { encoding: "utf8" })
  assert.equal(cloned.status, 0, `git clone: ${cloned.stderr}`)
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

/** The default tooling repository on "GitHub": `acme/team-tooling`, with the plugin `team` in `plugins/team/`. */
export const TOOLING_REPOS = Object.freeze({ "acme/team-tooling": { "plugins/team/plugin.json": "{\"name\":\"team\"}\n" } })

/**
 * A fake `gh` acting on the bare repository the way GitHub does. `pr create` opens a pull request (numbered from 12)
 * authored by the account whose token it was given; `pr merge` squash-merges it onto main when the two do not conflict
 * and refuses otherwise (or does what `merge(state)` says); `pr view` reports its state; `pr list` lists the open ones
 * with their author, fork flag, base branch and changed files, filtered by `--author`; `pr close` closes one; `repo view`
 * reports the merge methods `methods` allows (null: the call fails), and `api user` the login a token belongs to. While
 * `blocked()` returns a refusal, `pr merge` fails with it, as with a required review. The signed-in `accounts` (by default one,
 * `tester`, whose token is `tok`; another account's token is `tok-<account>`, and `token(account)` returning null makes
 * gh fail to give one) see every repository except those in `hidden` and may push where `canPush(account, repo)` says.
 * It answers the GitHub contents API from `repos`: `{ "owner/name": { "path/in/repo": "text" } }`, by default the
 * tooling repository `acme/team-tooling` holding the plugin `team` in `plugins/team/`. Every call is recorded with the
 * token it was given. A test adds someone else's pull request with `plantPullRequest`.
 */
export function fakeGh(bare, { create = { code: 0 }, merge, view, repos = TOOLING_REPOS, hidden = [], list, accounts = ["tester"], canPush = () => true, token = (account) => (account === "tester" ? "tok" : `tok-${account}`), methods = { squash: true, merge: true, rebase: true }, blocked = () => null } = {}) {
  const calls = []
  const tokens = []
  const state = { head: null, merged: false, merges: 0, closed: false, prs: [], method: null }
  const inBare = (args, env = {}) => spawnSync("git", ["--git-dir", bare, ...args], { encoding: "utf8", env: { ...process.env, ...env } })
  const prOf = (url) => state.prs.find((pr) => pr.url === url)
  // The tree a squash merge of `branch` onto main would make, or null on a conflict.
  const squashTree = (branch) => {
    const tree = inBare(["merge-tree", "--write-tree", "main", `refs/heads/${branch}`])
    return tree.status === 0 ? tree.stdout.trim().split("\n")[0] : null
  }
  const changed = (branch) => inBare(["diff", "--name-only", `main...refs/heads/${branch}`]).stdout.trim().split("\n").filter(Boolean).map((file) => ({ path: file, additions: 1, deletions: 0 }))
  const gh = async (args, options = {}) => {
    calls.push(args)
    tokens.push(options.token)
    const [a, b] = args
    const asking = accounts.find((login) => token(login) === options.token)
    if (a === "auth" && b === "status") return { code: 0, stdout: `github.com\n${accounts.map((login, index) => `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${index === 0}\n`).join("")}`, stderr: "" }
    if (a === "auth" && b === "token") {
      const given = token(args[3])
      return given === null ? { code: 1, stdout: "", stderr: "no token" } : { code: 0, stdout: `${given}\n`, stderr: "" }
    }
    if (a === "api" && args[args.length - 1] === "user") {
      if (asking === undefined) return { code: 1, stdout: "{\"message\":\"Bad credentials\"}", stderr: "gh: Bad credentials (HTTP 401)" }
      return { code: 0, stdout: JSON.stringify({ login: asking }), stderr: "" }
    }
    if (a === "api") {
      const route = args[args.length - 1]
      const contents = /^repos\/([^/]+\/[^/]+)\/contents\/([^?]+)\?ref=(.+)$/u.exec(route)
      const repo = contents === null ? route.replace(/^repos\//u, "") : contents[1]
      if (hidden.includes(repo)) return { code: 1, stdout: "{\"message\":\"Not Found\"}", stderr: "gh: Not Found (HTTP 404)" }
      if (contents === null) return { code: 0, stdout: JSON.stringify({ full_name: repo, default_branch: "main", permissions: { push: canPush(asking, repo) } }), stderr: "" }
      const text = repos[repo]?.[decodeURIComponent(contents[2])]
      if (text === undefined) return { code: 1, stdout: "{\"message\":\"Not Found\"}", stderr: "gh: Not Found (HTTP 404)" }
      return { code: 0, stdout: JSON.stringify({ type: "file", content: Buffer.from(text).toString("base64") }), stderr: "" }
    }
    if (a === "repo" && b === "view") {
      if (methods === null) return { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" }
      return { code: 0, stdout: JSON.stringify({ squashMergeAllowed: methods.squash === true, mergeCommitAllowed: methods.merge === true, rebaseMergeAllowed: methods.rebase === true }), stderr: "" }
    }
    if (a === "pr" && b === "list") {
      if (list !== undefined) return list(state)
      const author = args.includes("--author") ? args[args.indexOf("--author") + 1] : undefined
      const open = state.prs.filter((pr) => pr.open && (author === undefined || pr.author === author))
      return { code: 0, stdout: JSON.stringify(open.map((pr) => ({ url: pr.url, headRefName: pr.headRefName, body: pr.body, author: { login: pr.author }, isCrossRepository: pr.isCrossRepository, baseRefName: pr.baseRefName, files: pr.files === undefined ? changed(pr.headRefName) : pr.files }))), stderr: "" }
    }
    if (a === "pr" && b === "close") {
      state.closed = true
      for (const pr of state.prs) if (pr.url === args[2]) pr.open = false
      return { code: 0, stdout: "", stderr: "" }
    }
    if (a === "pr" && b === "create") {
      state.head = args[args.indexOf("--head") + 1]
      state.merged = false
      if (create.code !== 0) return { code: 1, stdout: "", stderr: "GraphQL: no permission\nmore" }
      const url = `${ORIGIN}/pull/${12 + state.prs.length}`
      state.prs.push({ url, headRefName: state.head, title: args[args.indexOf("--title") + 1], body: args[args.indexOf("--body") + 1], open: true, author: asking, isCrossRepository: false, baseRefName: args[args.indexOf("--base") + 1] })
      return { code: 0, stdout: `Creating pull request\n${url}\n`, stderr: "" }
    }
    if (a === "pr" && b === "merge") {
      state.merges += 1
      state.method = args[3]
      if (merge !== undefined) return merge(state)
      const refusal = blocked()
      if (refusal !== null) return { code: 1, stdout: "", stderr: refusal }
      const pr = prOf(args[2])
      const tree = squashTree(pr.headRefName)
      if (tree === null) return { code: 1, stdout: "", stderr: "Pull request is not mergeable" }
      const who = { GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" }
      const commit = inBare(["commit-tree", tree, "-p", "main", "-m", `${pr.title ?? pr.headRefName} (#${pr.url.split("/").pop()})`], who).stdout.trim()
      inBare(["update-ref", "refs/heads/main", commit])
      pr.open = false
      pr.merged = true
      state.merged = true
      return { code: 0, stdout: "", stderr: "" }
    }
    if (a === "pr" && b === "view") {
      if (view !== undefined) return view(state)
      const pr = prOf(args[2])
      const oid = inBare(["rev-parse", "main"]).stdout.trim()
      if (pr.merged) return { code: 0, stdout: JSON.stringify({ state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", mergeCommit: { oid } }), stderr: "" }
      return { code: 0, stdout: JSON.stringify(squashTree(pr.headRefName) === null ? { state: "OPEN", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", mergeCommit: null } : { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", mergeCommit: null }), stderr: "" }
    }
    throw new Error(`unexpected gh ${args.join(" ")}`)
  }
  return { gh, calls, tokens, state }
}

/**
 * Someone's pull request on "GitHub": a branch `branch` off main holding `files`, opened by `author`, listed by the fake
 * `gh` in `fake` with the given `body`, fork flag and base branch, and with `listedFiles` as its changed files when
 * given (otherwise what the branch changes). Returns its URL.
 */
export async function plantPullRequest(repo, fake, { branch, files, body = "", author = "someone_else", isCrossRepository = false, baseRefName = "main", listedFiles, number = 90 + fake.state.prs.length }) {
  const other = await secondClone(repo)
  git(other, ["switch", "-q", "-c", branch])
  await writeAll(other, files)
  git(other, ["add", "-A"])
  git(other, ["commit", "-q", "-m", `planted ${branch}`])
  git(other, ["push", "-q", "origin", branch])
  const url = `${ORIGIN}/pull/${number}`
  fake.state.prs.push({ url, headRefName: branch, body, open: true, author, isCrossRepository, baseRefName, ...(listedFiles === undefined ? {} : { files: listedFiles }) })
  return url
}

export const noWait = async () => {}
