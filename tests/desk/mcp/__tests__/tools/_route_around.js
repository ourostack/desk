import assert from "node:assert/strict"

// A result that left its change uncommitted carries `route_around` (#561, #623): the read-back first, then the steps that
// finish the commit, and the read-backs for "committed here" and "published". Returns the failure without the route, so a
// test can still compare the rest of it exactly.
export function notCommitted(commit) {
  assert.ok(commit && typeof commit === "object", "a commit failure is an object")
  const { route_around: route, ...rest } = commit
  assertRoute(route)
  return rest
}

// A result that carries a route opens with its `next` sentence (#623): the first key, saying what to do with the route first.
export function assertNextFirst(answer) {
  assert.equal(Object.keys(answer)[0], "next", "the answer opens with the next step")
  assert.match(answer.next, /^The change is on disk but not committed/u)
}

// Every argv a step runs, one command per entry.
export const argvsOf = (step) => [step.argv ?? []].flatMap((a) => (Array.isArray(a[0]) ? a : a.length ? [a] : []))

// The Git subcommand an argv runs (after any `-C <dir>`), or null when it is not Git.
function gitVerb(argv) {
  if (argv[0] !== "git") return null
  let i = 1
  while (argv[i] === "-C" || argv[i] === "--git-dir") i += 2
  return argv[i]
}

// Step 1 of every route only reads (a failed or timed-out commit can still have landed): a Git read, or finish-commit without --commit.
export function readsOnly(step) {
  const argvs = argvsOf(step)
  return argvs.length > 0 && argvs.every((argv) => ["diff", "log", "status", "show", "ls-files", "rev-parse"].includes(gitVerb(argv)) ||
    (String(argv[1] ?? "").endsWith("finish-commit.js") && !argv.includes("--commit")))
}

// The paths a commit failure's route names, in the order the route gives them: the captured change's `--path` flags, else the
// `git diff HEAD -- <paths>` read of a route without a capture.
export function routedPaths(route) {
  const [first] = argvsOf(route.steps[0])
  if (first.includes("--path")) return first.flatMap((arg, i) => (first[i - 1] === "--path" ? [arg] : []))
  return first.slice(first.indexOf("--") + 1)
}

export function assertRoute(route) {
  assert.ok(route && typeof route === "object", "a result that is not committed carries route_around")
  assert.equal(typeof route.summary, "string")
  assert.ok(Array.isArray(route.steps) && route.steps.length >= 2, "route_around has steps")
  assert.ok(readsOnly(route.steps[0]), "step 1 only reads")
  for (const step of route.steps) {
    assert.equal(typeof step.step, "string")
    for (const argv of argvsOf(step)) {
      for (const banned of ["stash", "--force", "-f", "--no-verify", "-a", "-A"]) assert.ok(!argv.includes(banned), `route_around never runs ${banned}`)
      // R1, R2 (0972 on #625): no route commits whatever the paths hold, resets an index entry or moves a branch by hand.
      const verb = gitVerb(argv)
      if (verb !== null) assert.ok(!["add", "commit", "reset", "update-ref", "checkout", "restore", "worktree", "push", "rm", "mv", "update-index"].includes(verb), `route_around never runs git ${verb}`)
    }
  }
  assert.ok(!JSON.stringify(route).includes("DESK_TOOL_COMMIT"), "route_around never names or sets the card guard's override")
  assert.ok(Array.isArray(route.committed_locally_when?.argv), "route_around says how to read back the local commit")
}
