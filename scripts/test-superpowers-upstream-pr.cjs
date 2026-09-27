#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  createGh,
  main,
  parseArgs,
  publish,
  pullRequestBody,
  sleepSync,
} = require("./superpowers-upstream-pr.cjs");

const repo = "owner/desk";
const branch = "superpowers-upstream";
const sha = "a".repeat(40);
const runUrl = "https://github.com/owner/desk/actions/runs/1";
const report = {
  repository: "obra/superpowers",
  commit: "b".repeat(40),
  updated_paths: ["skills/a/SKILL.md"],
  added_paths: [],
  removed_paths: ["skills/a/old.md"],
  mode_changed_paths: [],
  unselected_skills: ["skills/new-skill"],
  release: {
    superpowers: { from: "6.3.0", to: "6.4.2", upstream: "6.4.2" },
    fragment: "plugins/desk/changelog.d/superpowers-6.4.2.md",
  },
};

const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const fail = (stderr) => ({ status: 1, stdout: "", stderr });

// A scripted gh: each route matches the joined arguments and returns a result (or a function of the call).
function fakeGh(routes) {
  const calls = [];
  const run = (command, args, options) => {
    assert.equal(command, "gh");
    assert.equal(options.encoding, "utf8");
    const line = args.join(" ");
    calls.push({ line, input: options.input });
    const route = routes.find(([pattern]) => (typeof pattern === "string" ? line.startsWith(pattern) : pattern.test(line)));
    assert.ok(route, `unexpected gh call: ${line}`);
    return typeof route[1] === "function" ? route[1](line, calls) : route[1];
  };
  return { run, calls, gh: createGh({ run, env: {} }) };
}

function clock(start = Date.parse("2026-09-27T00:00:00Z")) {
  let current = start;
  return { now: () => current, sleep: (ms) => { current += ms; } };
}

const created = new Date(Date.parse("2026-09-27T00:00:05Z")).toISOString();
const stale = new Date(Date.parse("2026-09-26T00:00:00Z")).toISOString();

function runsRoute(workflow, runs) {
  return [new RegExp(`^api repos/${repo}/actions/workflows/${workflow.replace(".", "\\.")}/runs\\?branch=${branch}&event=workflow_dispatch&head_sha=${sha}&per_page=20$`), runs];
}

function publishWith(routes, overrides = {}) {
  const fake = fakeGh(routes);
  const { now, sleep } = clock();
  const result = publish({
    gh: fake.gh, repo, branch, base: "main", sha, report, workflows: ["ci.yml", "lint.yml"], runUrl,
    sleep, now, pollMs: 30_000, timeoutMs: 10 * 60_000, ...overrides,
  });
  return { result, calls: fake.calls };
}

// A stale run from an earlier dispatch is ignored, and of two runs for this dispatch the newest is the one read.
const completed = (id, conclusion = "success") => ok({ workflow_runs: [
  { id: 99, status: "completed", conclusion: "success", created_at: stale, html_url: "https://old" },
  { id: 98, status: "completed", conclusion: "failure", created_at: new Date(Date.parse(created) - 1000).toISOString(), html_url: "https://older" },
  { id, status: "completed", conclusion, created_at: created, html_url: `https://run/${id}` },
] });
const jobs = (id, list) => [`api repos/${repo}/actions/runs/${id}/jobs?per_page=100`, ok({ jobs: list })];
const noRules = [`api repos/${repo}/rules/branches/main`, ok([])];
const existingPull = [`pr list --repo ${repo} --head ${branch} --base main --state open --json number,url`, ok([{ number: 7, url: "https://github.com/owner/desk/pull/7" }])];
const labelExists = [`label list --repo ${repo} --search upstream-refresh`, ok([{ name: "upstream-refresh" }])];

{
  // Green path: an existing pull request is updated, both workflows are dispatched and polled, every job passes,
  // a ruleset-required check is present, the pull request merges and any open refresh issue is closed.
  let polls = 0;
  const { result, calls } = publishWith([
    existingPull,
    [`pr edit 7 --repo ${repo}`, ok("")],
    [`workflow run ci.yml --repo ${repo} --ref ${branch}`, ok("")],
    [`workflow run lint.yml --repo ${repo} --ref ${branch}`, ok("")],
    runsRoute("ci.yml", () => {
      polls += 1;
      return polls === 1
        ? ok({ workflow_runs: [] })
        : ok({ workflow_runs: [{ id: 11, status: polls === 2 ? "in_progress" : "completed", conclusion: "success", created_at: created, html_url: "https://run/11" }] });
    }),
    runsRoute("lint.yml", completed(12)),
    jobs(11, [{ name: "desk MCP test suite", conclusion: "success", html_url: "https://job/1" }]),
    jobs(12, [{ name: "Validate skills", conclusion: "success", html_url: "https://job/2" }]),
    [`api repos/${repo}/rules/branches/main`, ok([
      { type: "pull_request", parameters: {} },
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Validate skills" }] } },
    ])],
    [`pr merge 7 --repo ${repo} --merge --match-head-commit ${sha} --delete-branch`, ok("")],
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 20`, ok([{ number: 3 }])],
    [`issue close 3 --repo ${repo}`, ok("")],
    [`workflow run desk-release.yml --repo ${repo} --ref main`, ok("")],
  ]);
  assert.equal(result.outcome, "merged");
  // The merge used the workflow token, which starts no push-triggered run, so the Desk release is dispatched on main.
  assert.equal(result.message, "Every check passed, the refresh merged and the Desk release was dispatched.");
  assert.equal(calls.at(-1).line, `workflow run desk-release.yml --repo ${repo} --ref main`);
  assert.equal(result.pull, "https://github.com/owner/desk/pull/7");
  assert.equal(polls, 3);
  assert.deepEqual(result.jobs.map((job) => job.conclusion), ["success", "success"]);
  const edit = calls.find((call) => call.line.startsWith("pr edit 7"));
  assert.match(edit.line, /--title Refresh Superpowers from upstream bbbbbbbbbbbb --body-file -/u);
  assert.match(edit.input, /byte-identical to upstream/u);
  assert.match(edit.input, /Superpowers 6\.3\.0 → 6\.4\.2\. Desk gains the changelog fragment `plugins\/desk\/changelog\.d\/superpowers-6\.4\.2\.md`, and the release workflow takes its next version when this merges\./u);
  assert.match(edit.input, /Changed: `skills\/a\/SKILL.md`\./u);
  assert.match(edit.input, /Added: none\./u);
  assert.match(edit.input, /New upstream skills not selected .*: `skills\/new-skill`\./u);
  assert.match(calls.find((call) => call.line.startsWith("issue close 3")).line, /Resolved: https:\/\/github\.com\/owner\/desk\/pull\/7 passed every check and merged\./u);
}

{
  // A new pull request is created; a failed job, a job still reporting only its status, a workflow that never
  // started and a missing required check all leave it open and file one labelled issue, creating the label first.
  let listed = 0;
  const { result, calls } = publishWith([
    [`pr list --repo ${repo} --head ${branch}`, () => {
      listed += 1;
      return listed === 1 ? ok([]) : ok([{ number: 8, url: "https://github.com/owner/desk/pull/8" }]);
    }],
    [`pr create --repo ${repo} --head ${branch} --base main`, ok("https://github.com/owner/desk/pull/8\n")],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(21, "failure")),
    runsRoute("lint.yml", ok({ workflow_runs: [] })),
    jobs(21, [
      { name: "desk MCP test suite", conclusion: "failure", html_url: "https://job/21" },
      { name: "desk runtime pack", conclusion: null, status: "queued", html_url: "https://job/22" },
    ]),
    [`api repos/${repo}/rules/branches/main`, fail("gh: Not Found (HTTP 404)")],
    [`label list --repo ${repo} --search upstream-refresh`, ok([{ name: "upstream-refresh-old" }])],
    [`label create upstream-refresh --repo ${repo}`, ok("")],
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, ok([])],
    [`issue create --repo ${repo} --title Superpowers upstream refresh needs attention --label upstream-refresh`, ok("https://github.com/owner/desk/issues/9\n")],
  ], { timeoutMs: 60_000 });
  assert.equal(result.outcome, "checks-failed");
  assert.equal(result.issue, "https://github.com/owner/desk/issues/9");
  assert.deepEqual(result.jobs.map((job) => [job.name, job.conclusion]), [
    ["desk MCP test suite", "failure"],
    ["desk runtime pack", "queued"],
    ["lint.yml (no run started)", "missing"],
  ]);
  const issue = calls.find((call) => call.line.startsWith("issue create"));
  assert.match(issue.input, /https:\/\/github\.com\/owner\/desk\/pull\/8 is open at `a{40}`/u);
  assert.match(issue.input, /- CI did not finish within 1 minutes\./u);
  assert.match(issue.input, /- ci\.yml: \[desk MCP test suite\]\(https:\/\/job\/21\) — failure/u);
  assert.match(issue.input, /- lint\.yml: lint\.yml \(no run started\) — missing/u);
  assert.ok(calls.some((call) => call.line.startsWith("label create upstream-refresh")));
}

{
  // A required check that CI never produced blocks the merge, and a second failure comments on the open issue.
  const { result, calls } = publishWith([
    existingPull,
    [`pr edit 7`, ok("")],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(31)),
    runsRoute("lint.yml", ok({ workflow_runs: [{ id: 32, status: "completed", conclusion: "cancelled", created_at: created, html_url: "https://run/32" }] })),
    jobs(31, [{ name: "desk MCP test suite", conclusion: "success", html_url: "https://job/31" }]),
    jobs(32, []),
    [`api repos/${repo}/rules/branches/main`, ok([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Claude Code plugin load" }] } }])],
    labelExists,
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, ok([{ number: 4, url: "https://github.com/owner/desk/issues/4" }])],
    [`issue comment 4 --repo ${repo} --body-file -`, ok("")],
  ]);
  assert.equal(result.outcome, "checks-failed");
  assert.equal(result.issue, "https://github.com/owner/desk/issues/4");
  const comment = calls.find((call) => call.line.startsWith("issue comment 4"));
  assert.match(comment.input, /- Required check `Claude Code plugin load` did not pass\./u);
  assert.match(comment.input, /- lint\.yml: \[lint\.yml \(no jobs\)\]\(https:\/\/run\/32\) — cancelled/u);
}

{
  // A run with no jobs and no conclusion yet reports its status.
  const { result } = publishWith([
    existingPull,
    ["pr edit 7", ok("")],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(41)),
    runsRoute("lint.yml", ok({ workflow_runs: [{ id: 42, status: "completed", conclusion: null, created_at: created, html_url: "https://run/42" }] })),
    jobs(41, [{ name: "a", conclusion: "success", html_url: "https://job/41" }]),
    [`api repos/${repo}/actions/runs/42/jobs?per_page=100`, ok({ jobs: [] })],
    noRules,
    labelExists,
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, ok([])],
    ["issue create", ok("https://github.com/owner/desk/issues/10\n")],
  ], { workflows: ["ci.yml", "lint.yml"] });
  assert.equal(result.outcome, "checks-failed");
  assert.equal(result.jobs[1].conclusion, "completed");
}

{
  // Every check passed but the workflow token cannot merge: the pull request stays open with an explaining comment.
  const { result, calls } = publishWith([
    existingPull,
    ["pr edit 7", ok("")],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(51)),
    runsRoute("lint.yml", ok({ workflow_runs: [{ id: 52, status: "completed", conclusion: null, created_at: created, html_url: "https://run/52" }] })),
    jobs(51, [{ name: "a", conclusion: "success", html_url: "https://job/51" }]),
    jobs(52, [{ name: "b", conclusion: "success", html_url: "https://job/52" }]),
    noRules,
    ["pr merge 7", fail("GraphQL: Protected branch rules not configured for this branch (mergePullRequest)")],
    ["pr comment 7", ok("")],
  ]);
  assert.equal(result.outcome, "merge-blocked");
  assert.match(result.message, /could not merge: GraphQL: Protected branch rules/u);
  assert.match(calls.find((call) => call.line.startsWith("pr comment 7")).input, /stays open/u);
}

{
  // The workflow token may not open pull requests: the refresh files an issue that points at the pushed branch.
  const { result, calls } = publishWith([
    [`pr list --repo ${repo} --head ${branch}`, ok([])],
    ["pr create", fail("pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)")],
    labelExists,
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, ok([])],
    ["issue create", ok("https://github.com/owner/desk/issues/11\n")],
  ]);
  assert.equal(result.outcome, "pull-request-blocked");
  assert.equal(result.pull, null);
  assert.match(calls.find((call) => call.line.startsWith("issue create")).input, /Settings → Actions → General → Workflow permissions.*compare\/main\.\.\.superpowers-upstream/su);
  assert.equal(calls.some((call) => call.line.startsWith("workflow run")), false);
}

{
  // gh failures carry stderr, then the spawn error, then the exit status.
  for (const [result, pattern] of [
    [{ status: 1, stdout: "", stderr: "HTTP 403" }, /gh pr list failed: HTTP 403/u],
    [{ status: null, stdout: "", stderr: "", error: new Error("spawn gh ENOENT") }, /failed: spawn gh ENOENT/u],
    [{ status: 4, stdout: "", stderr: "" }, /failed: exit 4/u],
  ]) {
    assert.throws(() => createGh({ run: () => result }).json(["pr", "list"]), pattern);
  }
  assert.deepEqual(createGh({ run: () => fail("nope") }).call(["x"], { allowFailure: true }), { ok: false, stdout: "", stderr: "nope", error: "nope" });
  assert.equal(createGh({ run: () => fail("nope") }).json(["x"], { allowFailure: true }), null);
  assert.match(pullRequestBody({ report, runUrl }), /Superpowers 6\.3\.0 → 6\.4\.2\. Desk gains the changelog fragment/u);
  const started = Date.now();
  sleepSync(5);
  assert.ok(Date.now() - started >= 4);
}

{
  for (const [argv, pattern] of [
    [[], /usage: superpowers-upstream-pr\.cjs/u],
    [["bogus"], /usage: superpowers-upstream-pr\.cjs/u],
    [["publish", "repo", "x"], /unknown or incomplete argument: repo/u],
    [["publish", "--repo"], /unknown or incomplete argument: --repo/u],
    // Desk no longer takes a version in the refresh pull request, so there is no next-free-alpha command.
    [["next-desk-version", "--repo", repo, "--current", "3.2.0-alpha.1", "--branch", branch], /usage: superpowers-upstream-pr\.cjs publish/u],
    [["publish", "--repo", repo], /publish requires --branch, --base, --sha, --report, --workflows, --run-url/u],
  ]) {
    assert.throws(() => parseArgs(argv), pattern);
  }
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "superpowers-upstream-pr-"));
  try {
    const reportPath = path.join(tempRoot, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const summaryPath = path.join(tempRoot, "summary.md");
    const { run } = fakeGh([
      [`pr list --repo ${repo} --head ${branch}`, ok([])],
      ["pr create", fail("not permitted")],
      labelExists,
      ["issue list", ok([])],
      ["issue create", ok("https://github.com/owner/desk/issues/12\n")],
    ]);
    let output = "";
    const argv = ["publish", "--repo", repo, "--branch", branch, "--base", "main", "--sha", sha, "--report", reportPath, "--workflows", "ci.yml,", "--run-url", runUrl];
    assert.equal(main(argv, { run, env: { GITHUB_STEP_SUMMARY: summaryPath }, stdout: { write(value) { output += value; } } }), 0);
    assert.match(output, /^## Superpowers upstream refresh: pull-request-blocked\n\nnot permitted\n\nIssue: https:\/\/github\.com\/owner\/desk\/issues\/12\n/u);
    assert.equal(fs.readFileSync(summaryPath, "utf8"), output);

    // Poll and timeout options reach the wait loop; a merged run writes to stdout only when there is no summary file.
    let polls = 0;
    const merged = fakeGh([
      existingPull,
      ["pr edit 7", ok("")],
      ["workflow run", ok("")],
      runsRoute("ci.yml", () => {
        polls += 1;
        return polls < 3 ? ok({ workflow_runs: [] }) : completed(61);
      }),
      jobs(61, [{ name: "a", conclusion: "success", html_url: "https://job/61" }]),
      noRules,
      ["pr merge 7", ok("")],
      ["issue list", ok([])],
    ]);
    const { now, sleep } = clock();
    output = "";
    assert.equal(main([...argv.slice(0, 11), "--workflows", "ci.yml", "--run-url", runUrl, "--poll-seconds", "1", "--timeout-minutes", "5"], {
      run: merged.run, env: {}, stdout: { write(value) { output += value; } }, sleep, now,
    }), 0);
    assert.match(output, /^## Superpowers upstream refresh: merged\n/u);
    assert.match(output, /- ci\.yml: \[a\]\(https:\/\/job\/61\) — success/u);
    assert.equal(now(), Date.parse("2026-09-27T00:00:00Z") + 2000);

    // The CLI reports usage errors on stderr.
    const script = path.join(__dirname, "superpowers-upstream-pr.cjs");
    const usage = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: superpowers-upstream-pr\.cjs/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

{
  // Live regression (run 36324891964): Actions may not create pull requests, and `gh label list --search` printed
  // nothing at all, not `[]`, when the label did not exist yet. The fallback must still push through to an issue.
  const empty = { status: 0, stdout: "", stderr: "" };
  const { result, calls } = publishWith([
    [`pr list --repo ${repo} --head ${branch}`, empty],
    ["pr create", fail("pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)")],
    [`label list --repo ${repo} --search upstream-refresh`, empty],
    [`label create upstream-refresh --repo ${repo} --force`, ok("")],
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, empty],
    ["issue create", ok("https://github.com/owner/desk/issues/38\n")],
  ]);
  assert.equal(result.outcome, "pull-request-blocked");
  assert.equal(result.issue, "https://github.com/owner/desk/issues/38");
  assert.match(result.message, /GitHub Actions is not permitted to create or approve pull requests/u);
  assert.ok(calls.some((call) => call.line.startsWith("label create upstream-refresh")));
}

{
  // Empty or malformed output where JSON is required is a named error that carries gh's stderr, never a token.
  const token = `ghs_${"A".repeat(36)}`;
  const reply = (stdout, stderr) => createGh({ run: () => ({ status: 0, stdout, stderr }) });
  assert.throws(() => reply("", "").json(["api", "repos/o/r/actions/runs/1/jobs"]), /^Error: gh api repos\/o\/r\/actions\/runs\/1\/jobs returned no JSON \(no stderr\)$/u);
  assert.throws(() => reply("  \n", "rate limited").json(["api", "x"]), /gh api x returned no JSON \(stderr: rate limited\)/u);
  assert.throws(() => reply("{", `warning for ${token}`).json(["api", "x"]), (error) => {
    assert.match(error.message, /gh api x returned invalid JSON: .+ \(stderr: warning for \[redacted\]\)/u);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.throws(() => createGh({ run: () => fail(`bad credentials ${token}`) }).json(["pr", "list"]), (error) => {
    assert.match(error.message, /gh pr list failed: bad credentials \[redacted\]/u);
    return true;
  });
  assert.deepEqual(reply("", "no labels").json(["label", "list"], { list: true }), []);
  assert.deepEqual(createGh({ run: () => ({ status: 0, stdout: "[1]" }) }).json(["x"]), [1]);
  assert.deepEqual(createGh({ run: () => ({ status: 0 }) }).json(["x"], { list: true }), []);
}

{
  // A ruleset read that prints nothing adds no required check, but malformed output stops the merge.
  const base = [
    existingPull,
    ["pr edit 7", ok("")],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(71)),
    runsRoute("lint.yml", completed(72)),
    jobs(71, [{ name: "a", conclusion: "success", html_url: "https://job/71" }]),
    jobs(72, [{ name: "b", conclusion: "success", html_url: "https://job/72" }]),
  ];
  // A refused release dispatch still reports the merge, and says how to release by hand.
  const quiet = publishWith([
    ["workflow run desk-release.yml", fail("HTTP 403: Resource not accessible by integration")],
    ...base,
    [`api repos/${repo}/rules/branches/main`, { status: 0, stdout: "", stderr: "" }],
    ["pr merge 7", ok("")],
    ["issue list", ok([])],
  ]);
  assert.equal(quiet.result.outcome, "merged");
  assert.equal(quiet.result.message, "Every check passed and the refresh merged, but the Desk release could not be dispatched: HTTP 403: Resource not accessible by integration. Dispatch desk-release.yml on main.");
  assert.throws(
    () => publishWith([...base, [`api repos/${repo}/rules/branches/main`, { status: 0, stdout: "<html>", stderr: "" }]]),
    /gh api repos\/owner\/desk\/rules\/branches\/main returned invalid JSON/u,
  );
}

console.log("Superpowers upstream pull request tests passed.");
