// An in-memory GitHub for flush tests: answers the exact `gh` calls the flush
// makes (version, `auth token`, and `api` requests) from a small model of
// repositories, Git objects, refs, pull requests and comments. Nothing here
// reaches the network or runs a process.
//
// Every call is recorded as `{ args, token, input }`, with the token kept as
// given so tests can assert where it went (and where it never went).

import { createHash } from "node:crypto"

import { gitBlobSha } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

export const TOKEN = "ghp_SENTINEL"
export const BOT = "github-actions[bot]"

const hash = (value) => createHash("sha1").update(JSON.stringify(value)).digest("hex")
const ok = (json, status = 200) => ({ code: 0, stdout: json === undefined ? "" : JSON.stringify(json), stderr: "", status })
export const httpError = (status, message) => ({ code: 1, stdout: JSON.stringify({ message }), stderr: `gh: ${message} (HTTP ${status})\n` })

export function fakeGitHub({
  store = "ourostack/factory",
  account = "contributor",
  push = true,
  version = "gh version 2.54.0 (2024-07-31)\nhttps://github.com/cli/cli/releases/tag/v2.54.0\n",
  visibility = {},
  fork = "absent",
  forkReadyOnCreate = false,
  mainFacts = {},
  extraMainEntries = [],
  intercept = null,
} = {}) {
  const calls = []
  const trees = new Map()
  const commits = new Map()
  const blobs = new Map()
  const repos = new Map()
  const pulls = []
  const comments = new Map()
  const files = new Map()

  const putTree = (entries) => {
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const sha = hash(["tree", sorted])
    trees.set(sha, new Map(sorted))
    return sha
  }
  const putCommit = (tree, parents, message = "commit") => {
    const sha = hash(["commit", tree, parents, message, commits.size])
    commits.set(sha, { tree, parents, message })
    return sha
  }
  const factsOf = (commitSha) => {
    const root = trees.get(commits.get(commitSha).tree)
    const facts = root.get("facts")
    return facts?.type === "tree" ? trees.get(facts.sha) : new Map()
  }

  // Every blob path under a tree, `dir/name` style.
  const filesOf = (treeSha, prefix = "") => {
    const out = new Map()
    for (const [name, entry] of trees.get(treeSha) ?? []) {
      if (entry.type === "tree") for (const [sub, sha] of filesOf(entry.sha, `${prefix}${name}/`)) out.set(sub, sha)
      else out.set(`${prefix}${name}`, entry.sha)
    }
    return out
  }
  // A new tree from `treeSha` with `path` set to blob `sha`, creating folders as needed.
  const withPath = (treeSha, parts, sha) => {
    const entries = new Map(trees.get(treeSha) ?? [])
    if (parts.length === 1) entries.set(parts[0], { type: "blob", sha })
    else {
      const child = entries.get(parts[0])
      entries.set(parts[0], { type: "tree", sha: withPath(child?.type === "tree" ? child.sha : null, parts.slice(1), sha) })
    }
    return putTree([...entries])
  }
  const DATA = /^(?:facts|labels)\//u

  const factsEntries = Object.entries(mainFacts).map(([name, bytes]) => {
    const sha = gitBlobSha(bytes)
    blobs.set(sha, Buffer.from(bytes).toString("utf8"))
    return [name, { type: "blob", sha }]
  })
  const factsTree = putTree([...factsEntries, ...extraMainEntries])
  const rootTree = putTree([["README.md", { type: "blob", sha: "a".repeat(40) }], ["facts", { type: "tree", sha: factsTree }]])
  const mainCommit = putCommit(rootTree, [])
  const [storeOwner, storeName] = store.split("/")
  repos.set(store.toLowerCase(), { meta: { full_name: store, private: false, fork: false, default_branch: "main", permissions: { push } }, refs: new Map([["heads/main", mainCommit]]) })
  const forkName = `${account}/${storeName}`
  const addFork = (ready) => {
    repos.set(forkName.toLowerCase(), {
      meta: { full_name: forkName, private: false, fork: true, parent: { full_name: store }, default_branch: "main", permissions: { push: true } },
      refs: ready ? new Map([["heads/main", repos.get(store.toLowerCase()).refs.get("heads/main")]]) : new Map(),
      pending: !ready,
    })
  }
  if (fork === "ready") addFork(true)
  if (fork === "pending") addFork(false)

  const repo = (name) => repos.get(name.toLowerCase())
  const storeRepo = () => repo(store)

  function prFiles(pr) {
    const head = repo(pr.headRepo).refs.get(`heads/${pr.head.ref}`)
    const main = storeRepo().refs.get("heads/main")
    const before = filesOf(commits.get(main).tree)
    return [...filesOf(commits.get(head).tree)].filter(([name, sha]) => DATA.test(name) && before.get(name) !== sha).map(([name]) => ({ filename: name }))
  }

  function api(method, route, body) {
    const [pathPart, query = ""] = route.split("?")
    const params = new URLSearchParams(query)
    // GitHub's paging: `per_page` (default 30, at most 100) items of page `page` (default 1).
    const paged = (items) => {
      const perPage = Math.min(100, Number(params.get("per_page") ?? 30))
      const page = Number(params.get("page") ?? 1)
      return ok(items.slice((page - 1) * perPage, page * perPage))
    }
    let m
    if (method === "GET" && (m = /^repos\/([^/]+\/[^/]+)$/u.exec(pathPart))) {
      const wanted = m[1]
      if (typeof visibility[wanted] === "number") return httpError(visibility[wanted], "Forbidden or missing")
      const found = repo(wanted)
      if (found) return ok(found.meta)
      if (visibility[wanted] === "public" || visibility[wanted] === "private") return ok({ full_name: wanted, private: visibility[wanted] === "private" })
      return httpError(404, "Not Found")
    }
    if (method === "POST" && pathPart === `repos/${store}/forks`) {
      if (!repo(forkName)) addFork(forkReadyOnCreate)
      return ok(repo(forkName).meta, 202)
    }
    if (method === "POST" && (m = /^repos\/([^/]+\/[^/]+)\/merge-upstream$/u.exec(pathPart))) {
      const target = repo(m[1])
      target.refs.set(`heads/${body.branch}`, storeRepo().refs.get(`heads/${body.branch}`))
      return ok({ merge_type: "fast-forward" })
    }
    if (method === "GET" && (m = /^repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/u.exec(pathPart))) {
      const target = repo(m[1])
      if (!target) return httpError(404, "Not Found")
      if (target.pending) return httpError(409, "Git Repository is empty.")
      const sha = target.refs.get(`heads/${m[2]}`)
      return sha ? ok({ ref: `refs/heads/${m[2]}`, object: { sha, type: "commit" } }) : httpError(404, "Not Found")
    }
    if (method === "GET" && (m = /^repos\/([^/]+\/[^/]+)\/branches\/(.+)$/u.exec(pathPart))) {
      const sha = repo(m[1])?.refs.get(`heads/${m[2]}`)
      if (!sha) return httpError(404, "Branch not found")
      return ok({ name: m[2], commit: { sha, commit: { tree: { sha: commits.get(sha).tree } } } })
    }
    if (method === "GET" && (m = /^repos\/([^/]+\/[^/]+)\/git\/trees\/([0-9a-f]+)$/u.exec(pathPart))) {
      const tree = trees.get(m[2])
      if (!tree) return httpError(404, "Not Found")
      return ok({ sha: m[2], truncated: false, tree: [...tree].map(([name, entry]) => ({ path: name, mode: entry.type === "tree" ? "040000" : "100644", ...entry })) })
    }
    if (method === "POST" && (m = /^repos\/([^/]+\/[^/]+)\/git\/trees$/u.exec(pathPart))) {
      let sha = body.base_tree
      for (const entry of body.tree) {
        const blob = gitBlobSha(Buffer.from(entry.content, "utf8"))
        blobs.set(blob, entry.content)
        sha = withPath(sha, entry.path.split("/"), blob)
      }
      return ok({ sha, tree: [...trees.get(sha)].map(([name, entry]) => ({ path: name, ...entry })) }, 201)
    }
    if (method === "GET" && (m = /^repos\/([^/]+\/[^/]+)\/git\/commits\/([0-9a-f]+)$/u.exec(pathPart))) {
      const commit = commits.get(m[2])
      if (!commit) return httpError(404, "Not Found")
      return ok({ sha: m[2], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) })
    }
    if (method === "POST" && (m = /^repos\/([^/]+\/[^/]+)\/git\/commits$/u.exec(pathPart))) {
      const sha = putCommit(body.tree, body.parents, body.message)
      return ok({ sha, tree: { sha: body.tree }, parents: body.parents.map((parent) => ({ sha: parent })) }, 201)
    }
    if (method === "PATCH" && (m = /^repos\/([^/]+\/[^/]+)\/git\/refs\/(heads\/.+)$/u.exec(pathPart))) {
      const target = repo(m[1])
      if (!target.refs.has(m[2])) return httpError(422, "Reference does not exist")
      target.refs.set(m[2], body.sha)
      return ok({ ref: `refs/${m[2]}`, object: { sha: body.sha, type: "commit" } })
    }
    if (method === "POST" && (m = /^repos\/([^/]+\/[^/]+)\/git\/refs$/u.exec(pathPart))) {
      const target = repo(m[1])
      const name = body.ref.replace(/^refs\//u, "")
      if (target.refs.has(name)) return httpError(422, "Reference already exists")
      target.refs.set(name, body.sha)
      return ok({ ref: body.ref, object: { sha: body.sha, type: "commit" } }, 201)
    }
    if (method === "GET" && pathPart === `repos/${store}/pulls`) {
      const state = params.get("state")
      const head = params.get("head")
      const matching = pulls.filter((pr) => pr.state === state && pr.head.label === head)
      if (params.get("direction") === "desc") matching.sort((a, b) => b.number - a.number)
      return paged(matching.map(publicPr))
    }
    if (method === "POST" && pathPart === `repos/${store}/pulls`) {
      const [owner, ref] = body.head.includes(":") ? body.head.split(":") : [storeOwner, body.head]
      const number = 100 + pulls.length + 1
      const pr = {
        number, state: "open", merged_at: null, title: body.title, body: body.body,
        head: { ref, label: `${owner}:${ref}` }, base: { ref: body.base }, headRepo: owner === storeOwner ? store : forkName,
        html_url: `https://github.com/${store}/pull/${number}`,
      }
      pulls.push(pr)
      return ok(publicPr(pr), 201)
    }
    if (method === "PATCH" && (m = new RegExp(`^repos/${store}/pulls/(\\d+)$`, "u").exec(pathPart))) {
      const pr = pulls.find((item) => item.number === Number(m[1]))
      pr.body = body.body
      return ok(publicPr(pr))
    }
    if (method === "GET" && (m = new RegExp(`^repos/${store}/issues/(\\d+)/comments$`, "u").exec(pathPart))) {
      return paged(comments.get(Number(m[1])) ?? [])
    }
    if (method === "GET" && (m = new RegExp(`^repos/${store}/pulls/(\\d+)/files$`, "u").exec(pathPart))) {
      return paged(files.get(Number(m[1])) ?? [])
    }
    return httpError(404, `unmodelled ${method} ${route}`)
  }

  function publicPr(pr) {
    return { number: pr.number, state: pr.state, merged_at: pr.merged_at, title: pr.title, body: pr.body, head: { ref: pr.head.ref, label: pr.head.label }, base: pr.base, html_url: pr.html_url }
  }

  function answer(args, options) {
    if (args.length === 1 && args[0] === "--version") return { code: 0, stdout: version, stderr: "" }
    if (args[0] === "auth" && args[1] === "token") {
      return args[3] === account ? { code: 0, stdout: `${TOKEN}\n`, stderr: "" } : { code: 1, stdout: "", stderr: `no oauth token found for ${args[3]}\n` }
    }
    if (args[0] !== "api") return { code: 1, stdout: "", stderr: "unknown command\n" }
    if (options.token !== TOKEN) return httpError(401, "Bad credentials")
    const method = args[args.indexOf("--method") + 1]
    const route = args.find((arg, index) => index > 0 && /^repos\//u.test(arg))
    const body = args.includes("--input") ? JSON.parse(options.input) : undefined
    return api(method, route, body)
  }

  const runner = async (args, options = {}) => {
    const call = { args: [...args], token: options.token, input: options.input, timeoutMs: options.timeoutMs }
    calls.push(call)
    const intercepted = intercept?.(call, calls.length - 1)
    if (intercepted !== undefined) return intercepted
    return answer(args, options)
  }

  return {
    runner,
    calls,
    blobs,
    pulls,
    forkName,
    storeMain: () => storeRepo().refs.get("heads/main"),
    mainFacts: () => factsOf(storeRepo().refs.get("heads/main")),
    /** Every data file (`facts/…`, `labels/…`) on the store's main, path to blob SHA. */
    mainFiles: () => new Map([...filesOf(commits.get(storeRepo().refs.get("heads/main")).tree)].filter(([name]) => DATA.test(name))),
    /** Every data file on a branch of a repository, or `null` without that branch. */
    headFiles: (repoName, branch) => {
      const sha = repo(repoName)?.refs.get(`heads/${branch}`)
      return sha ? new Map([...filesOf(commits.get(sha).tree)].filter(([name]) => DATA.test(name))) : null
    },
    headFacts: (repoName, branch) => {
      const sha = repo(repoName)?.refs.get(`heads/${branch}`)
      return sha ? factsOf(sha) : null
    },
    ref: (repoName, branch) => repo(repoName)?.refs.get(`heads/${branch}`) ?? null,
    commit: (sha) => commits.get(sha),
    setForkReady() {
      const target = repo(forkName)
      target.pending = false
      target.refs.set("heads/main", storeRepo().refs.get("heads/main"))
    },
    /** Moves the store's main on with an unrelated commit, as another merge would. */
    advanceMain() {
      const main = storeRepo().refs.get("heads/main")
      const root = new Map(trees.get(commits.get(main).tree))
      root.set(`NOTE-${commits.size}.md`, { type: "blob", sha: "b".repeat(40) })
      storeRepo().refs.set("heads/main", putCommit(putTree([...root]), [main], "other"))
    },
    /** Merges the open intake PR into the store's main, as the store's merge workflow would. */
    mergeOpenPr() {
      const pr = pulls.find((item) => item.state === "open")
      const headSha = repo(pr.headRepo).refs.get(`heads/${pr.head.ref}`)
      const main = storeRepo().refs.get("heads/main")
      let tree = commits.get(main).tree
      for (const [name, sha] of filesOf(commits.get(headSha).tree)) if (DATA.test(name)) tree = withPath(tree, name.split("/"), sha)
      storeRepo().refs.set("heads/main", putCommit(tree, [main, headSha], "merge"))
      pr.state = "closed"
      pr.merged_at = "merged"
      return pr
    },
    /** Rejects the open intake PR the way the store's merge workflow does: a comment, then close. */
    rejectOpenPr(body, login = BOT) {
      const pr = pulls.find((item) => item.state === "open")
      files.set(pr.number, prFiles(pr))
      comments.set(pr.number, [...(comments.get(pr.number) ?? []), { user: { login, type: login === BOT ? "Bot" : "User" }, body }])
      pr.state = "closed"
      return pr
    },
    addClosedPr({ comment = null, commentBy = BOT, fileNames = [], merged = false, headLabel = null }) {
      const number = 100 + pulls.length + 1
      const [owner, ref] = (headLabel ?? `${storeOwner}:intake/0000000000000000`).split(":")
      pulls.push({ number, state: "closed", merged_at: merged ? "merged" : null, title: "Factory intake", body: "1", head: { ref, label: `${owner}:${ref}` }, base: { ref: "main" }, headRepo: store, html_url: `https://github.com/${store}/pull/${number}` })
      if (comment !== null) comments.set(number, [{ user: { login: commentBy, type: commentBy === BOT ? "Bot" : "User" }, body: comment }])
      files.set(number, fileNames.map((name) => ({ filename: name.includes("/") ? name : `facts/${name}` })))
      return number
    },
  }
}
