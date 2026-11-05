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
  pending,
  publish,
  pullRequestBody,
  referencesToRemoved,
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
  assert.equal(result.delivered, true);
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
    labelExists,
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, ok([])],
    ["issue create", ok("https://github.com/owner/desk/issues/13\n")],
  ]);
  assert.equal(result.outcome, "merge-blocked");
  assert.equal(result.delivered, false);
  assert.match(result.message, /could not merge: GraphQL: Protected branch rules/u);
  assert.match(calls.find((call) => call.line.startsWith("pr comment 7")).input, /stays open/u);
  // An undelivered refresh always leaves an issue, not only a comment on the pull request.
  assert.equal(result.issue, "https://github.com/owner/desk/issues/13");
  assert.match(calls.find((call) => call.line.startsWith("issue create")).input, /https:\/\/github\.com\/owner\/desk\/pull\/7.*could not merge/su);
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
    const outputPath = path.join(tempRoot, "output.txt");
    const { run } = fakeGh([
      [`pr list --repo ${repo} --head ${branch}`, ok([])],
      ["pr create", fail("not permitted")],
      labelExists,
      ["issue list", ok([])],
      ["issue create", ok("https://github.com/owner/desk/issues/12\n")],
    ]);
    let output = "";
    const argv = ["publish", "--repo", repo, "--branch", branch, "--base", "main", "--sha", sha, "--report", reportPath, "--workflows", "ci.yml,", "--run-url", runUrl];
    // A refresh that did not reach main fails the run, so the scheduled run is red instead of a silent green, and
    // tells the workflow it already reported so the generic failure step does not comment a second time.
    assert.equal(main(argv, { run, env: { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath }, stdout: { write(value) { output += value; } } }), 1);
    assert.match(output, /^## Superpowers upstream refresh: pull-request-blocked\n\nnot permitted\n\nIssue: https:\/\/github\.com\/owner\/desk\/issues\/12\n/u);
    assert.equal(fs.readFileSync(summaryPath, "utf8"), output);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "outcome=pull-request-blocked\ndelivered=false\nissue=https://github.com/owner/desk/issues/12\n");

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
    labelExists,
    ["issue create", ok("https://github.com/owner/desk/issues/14\n")],
  ]);
  assert.equal(quiet.result.outcome, "merged");
  // Merged but not released is still not delivered: the run fails and an issue says how to release.
  assert.equal(quiet.result.delivered, false);
  assert.equal(quiet.result.issue, "https://github.com/owner/desk/issues/14");
  assert.match(quiet.calls.find((call) => call.line.startsWith("issue create")).input, /Dispatch desk-release\.yml on main/u);
  assert.equal(quiet.result.message, "Every check passed and the refresh merged, but the Desk release could not be dispatched: HTTP 403: Resource not accessible by integration. Dispatch desk-release.yml on main.");
  assert.throws(
    () => publishWith([...base, [`api repos/${repo}/rules/branches/main`, { status: 0, stdout: "<html>", stderr: "" }]]),
    /gh api repos\/owner\/desk\/rules\/branches\/main returned invalid JSON/u,
  );
}

{
  // Live regression (runs 38280011058 to 41488986364): a failed job's own error is what an agent needs, so the issue
  // carries each failed job's failure annotations, not only a link to the log.
  const { result, calls } = publishWith([
    existingPull,
    ["pr edit 7", ok("")],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(81, "failure")),
    runsRoute("lint.yml", completed(82)),
    jobs(81, [{ id: 801, name: "Validate skills", conclusion: "failure", html_url: "https://job/801" }]),
    jobs(82, [{ id: 802, name: "b", conclusion: "success", html_url: "https://job/802" }]),
    [`api repos/${repo}/check-runs/801/annotations?per_page=50`, ok([
      { annotation_level: "notice", message: "a notice that is not an error" },
      { annotation_level: "failure", message: "desk: plugins/desk/.claude-plugin/plugin.json requires superpowers ^6.3.0, but the marketplace ships 7.0.1" },
      { annotation_level: "failure", message: `x`.repeat(900) },
      { annotation_level: "failure", message: "third" },
      { annotation_level: "failure", message: "fourth is beyond the limit" },
    ])],
    noRules,
    labelExists,
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, ok([])],
    ["issue create", ok("https://github.com/owner/desk/issues/15\n")],
  ]);
  assert.equal(result.outcome, "checks-failed");
  assert.equal(result.delivered, false);
  const body = calls.find((call) => call.line.startsWith("issue create")).input;
  assert.match(body, /- ci\.yml: \[Validate skills\]\(https:\/\/job\/801\) — failure\n {2}- desk: plugins\/desk\/\.claude-plugin\/plugin\.json requires superpowers \^6\.3\.0, but the marketplace ships 7\.0\.1\n/u);
  assert.match(body, / {2}- x{300}…\n {2}- third\n/u);
  assert.doesNotMatch(body, /fourth is beyond the limit|a notice/u);
  // An unreadable annotation list never hides the failure itself.
  const unreadable = publishWith([
    existingPull,
    ["pr edit 7", ok("")],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(83, "failure")),
    runsRoute("lint.yml", completed(84)),
    jobs(83, [{ id: 803, name: "Windows suite", conclusion: "failure", html_url: "https://job/803" }]),
    jobs(84, [{ id: 804, name: "b", conclusion: "success", html_url: "https://job/804" }]),
    [`api repos/${repo}/check-runs/803/annotations?per_page=50`, fail("HTTP 403")],
    noRules,
    labelExists,
    [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, ok([])],
    ["issue create", ok("https://github.com/owner/desk/issues/16\n")],
  ]);
  assert.match(unreadable.calls.find((call) => call.line.startsWith("issue create")).input, /\[Windows suite\]\(https:\/\/job\/803\) — failure\n/u);
}

const majorReport = {
  ...report,
  removed_paths: ["skills/brainstorming/spec-document-reviewer-prompt.md"],
  release: {
    superpowers: { from: "6.4.5", to: "7.0.2", upstream: "7.0.2" },
    fragment: "plugins/desk/changelog.d/superpowers-7.0.2.md",
    range: { from: "^6.3.0", to: "^7.0.2", files: ["plugins/desk/.claude-plugin/plugin.json", "plugins/desk/activation/desk.activation.json"] },
    notes: [
      { version: "7.0.2", heading: "v7.0.2 (2026-11-03)", body: "Brainstorming asks fewer questions.\n\n### Hooks\n\n- Copilot on Windows now gets the bootstrap." },
      { version: "7.0.0", heading: "v7.0.0 (2026-10-09)", body: "Brainstorming, rebuilt from scratch." },
    ],
  },
  desk_references: [{ path: "skills/brainstorming/spec-document-reviewer-prompt.md", files: ["plugins/desk/skills/x/SKILL.md"] }],
};

{
  // A refresh states what upstream changed: its release notes for every version it brings in, and, when upstream
  // crossed a major version, says so plainly, names the moved compatibility floor and what in Desk to read.
  const body = pullRequestBody({ report: majorReport, runUrl });
  assert.match(body, /^> \*\*Major upstream release: Superpowers 6 → 7\.\*\* The refresh moved Desk's Superpowers compatibility floor from `\^6\.3\.0` to `\^7\.0\.2` in `plugins\/desk\/\.claude-plugin\/plugin\.json`, `plugins\/desk\/activation\/desk\.activation\.json`/mu);
  assert.match(body, /## What upstream changed\n\n<details><summary>v7\.0\.2 \(2026-11-03\)<\/summary>\n\nBrainstorming asks fewer questions\.\n\n### Hooks\n\n- Copilot on Windows now gets the bootstrap\.\n\n<\/details>\n\n<details><summary>v7\.0\.0 \(2026-10-09\)<\/summary>\n\nBrainstorming, rebuilt from scratch\.\n\n<\/details>/u);
  assert.match(body, /Desk files that still name a removed upstream file: `skills\/brainstorming\/spec-document-reviewer-prompt\.md` in `plugins\/desk\/skills\/x\/SKILL\.md`\./u);
  // Without notes the body says so instead of leaving the section out.
  const plain = pullRequestBody({ report, runUrl });
  assert.match(plain, /## What upstream changed\n\nUpstream's RELEASE-NOTES\.md has no section for a version after the one Desk shipped/u);
  assert.doesNotMatch(plain, /Major upstream release/u);
  // Release notes never push the body past GitHub's limit: each section is cut with a link to the full notes.
  const long = pullRequestBody({ report: { ...majorReport, release: { ...majorReport.release, notes: [{ version: "7.0.2", heading: "v7.0.2", body: "y".repeat(70_000) }] } }, runUrl });
  assert.ok(long.length < 60_000);
  assert.match(long, /y…\n\n\[Read the full release notes\]\(https:\/\/github\.com\/obra\/superpowers\/blob\/b{40}\/RELEASE-NOTES\.md\)/u);
}

{
  // A major refresh is labelled and titled as one, and files one adoption issue with the release notes so an agent
  // works out what Desk should take from it even when CI passes and it merges on its own.
  const { result, calls } = publishWith([
    existingPull,
    ["pr edit 7 --repo owner/desk --title", ok("")],
    [`label list --repo ${repo} --search superpowers-major`, ok([])],
    [`label create superpowers-major --repo ${repo}`, ok("")],
    [`pr edit 7 --repo ${repo} --add-label superpowers-major`, ok("")],
    [`issue list --repo ${repo} --label superpowers-major --state open`, ok([{ number: 20, title: "Superpowers 6: adopt what's new", url: "https://github.com/owner/desk/issues/20" }])],
    [`issue create --repo ${repo} --title Superpowers 7: adopt what's new --label superpowers-major`, ok("https://github.com/owner/desk/issues/21\n")],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(91)),
    runsRoute("lint.yml", completed(92)),
    jobs(91, [{ name: "a", conclusion: "success", html_url: "https://job/91" }]),
    jobs(92, [{ name: "b", conclusion: "success", html_url: "https://job/92" }]),
    noRules,
    ["pr merge 7", ok("")],
    ["issue list --repo owner/desk --label upstream-refresh", ok([])],
  ], { report: majorReport });
  assert.equal(result.outcome, "merged");
  assert.equal(result.delivered, true);
  assert.equal(result.adoption, "https://github.com/owner/desk/issues/21");
  assert.match(calls.find((call) => call.line.startsWith("pr edit 7 --repo owner/desk --title")).line, /--title Refresh Superpowers from upstream bbbbbbbbbbbb \(major: 6\.4\.5 → 7\.0\.2\)/u);
  const adoption = calls.find((call) => call.line.startsWith("issue create"));
  assert.match(adoption.input, /Superpowers 7\.0\.2 crossed a major version/u);
  assert.match(adoption.input, /using-superpowers-with-desk/u);
  assert.match(adoption.input, /<details><summary>v7\.0\.0 \(2026-10-09\)<\/summary>/u);
  // A later run for the same major finds its open adoption issue and does not file another.
  const again = publishWith([
    existingPull,
    ["pr edit 7 --repo owner/desk --title", ok("")],
    [`label list --repo ${repo} --search superpowers-major`, ok([{ name: "superpowers-major" }])],
    [`pr edit 7 --repo ${repo} --add-label superpowers-major`, ok("")],
    [`issue list --repo ${repo} --label superpowers-major --state open`, ok([{ number: 21, title: "Superpowers 7: adopt what's new", url: "https://github.com/owner/desk/issues/21" }])],
    ["workflow run", ok("")],
    runsRoute("ci.yml", completed(93)),
    runsRoute("lint.yml", completed(94)),
    jobs(93, [{ name: "a", conclusion: "success", html_url: "https://job/93" }]),
    jobs(94, [{ name: "b", conclusion: "success", html_url: "https://job/94" }]),
    noRules,
    ["pr merge 7", ok("")],
    ["issue list --repo owner/desk --label upstream-refresh", ok([])],
  ], { report: majorReport });
  assert.equal(again.result.adoption, "https://github.com/owner/desk/issues/21");
  assert.equal(again.calls.some((call) => call.line.startsWith("issue create")), false);
}

{
  // Desk text that still names a removed upstream file is found by its skill-relative path or a distinctive file name.
  const files = [
    { path: "plugins/desk/skills/a/SKILL.md", text: "Dispatch brainstorming/spec-document-reviewer-prompt.md first." },
    { path: "plugins/desk/skills/b/SKILL.md", text: "See anthropic-best-practices.md." },
    { path: "plugins/desk/skills/c/SKILL.md", text: "Read SKILL.md and nothing else." },
    { path: "plugins/superpowers/skills/brainstorming/SKILL.md", text: "spec-document-reviewer-prompt.md" },
    { path: "upstream-sources.lock.json", text: "skills/writing-skills/anthropic-best-practices.md" },
    { path: "plugins/desk/CHANGELOG.md", text: "anthropic-best-practices.md" },
    { path: "plugins/desk/changelog.d/x.md", text: "anthropic-best-practices.md" },
  ];
  assert.deepEqual(referencesToRemoved([
    "skills/brainstorming/spec-document-reviewer-prompt.md",
    "skills/writing-skills/anthropic-best-practices.md",
    "skills/executing-plans/SKILL.md",
  ], files), [
    { path: "skills/brainstorming/spec-document-reviewer-prompt.md", files: ["plugins/desk/skills/a/SKILL.md"] },
    { path: "skills/writing-skills/anthropic-best-practices.md", files: ["plugins/desk/skills/b/SKILL.md"] },
  ]);
  assert.deepEqual(referencesToRemoved([], files), []);
}

{
  // Equal selected bytes and executable modes deduplicate even when unselected upstream content moved.
  const rawHook = "plugins/superpowers/hooks/upstream/run-hook.cmd";
  const tool = "plugins/superpowers/skills/a/tool.sh";
  const freshLock = { sources: [{ id: "obra-superpowers", commit: "c".repeat(40), files: [
    { sourcePath: "skills/a/tool.sh", generatedPath: tool, sha256: "1".repeat(64) },
    { sourcePath: "hooks/run-hook.cmd", generatedPath: "plugins/superpowers/hooks/run-hook.cmd", upstreamPath: rawHook, sha256: "2".repeat(64) },
  ] }] };
  const branchLock = (files) => ok({ sources: [{ id: "obra-superpowers", commit: "d".repeat(40), files }] });
  const lockRoute = (result) => [`api -H Accept: application/vnd.github.raw+json repos/${repo}/contents/upstream-sources.lock.json?ref=`, result];
  const openPull = [`pr list --repo ${repo} --head ${branch} --base main --state open --json number,url,createdAt`, ok([{ number: 7, url: "https://github.com/owner/desk/pull/7", createdAt: "2026-10-12T07:40:00Z", headRefOid: sha }])];
  const openIssue = [`issue list --repo ${repo} --label upstream-refresh --state open --limit 1`, ok([{ number: 4, url: "https://github.com/owner/desk/issues/4" }])];
  const at = () => Date.parse("2026-11-05T07:30:00Z");
  const tree = (toolMode = "100644") => ({
    sha: "b".repeat(40), url: `https://api.github.com/repos/${repo}/git/trees/${"b".repeat(40)}`, truncated: false,
    tree: [
      { path: tool, mode: toolMode, type: "blob", sha: "e".repeat(40), size: 12 },
      { path: rawHook, mode: "100755", type: "blob", sha: "f".repeat(40), size: 12 },
      { path: "plugins/superpowers/hooks/run-hook.cmd", mode: "100644", type: "blob", sha: "b".repeat(40), size: 20 },
      { path: "README.md", mode: "100755", type: "blob", sha: "d".repeat(40), size: 100 },
    ],
  });
  const treeRoute = (result = ok(tree())) => [`api repos/${repo}/git/trees/${sha}?recursive=1`, result];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "superpowers-upstream-pending-"));
  const fixtureModes = new Map([
    [path.join(tempRoot, tool), 0o644],
    [path.join(tempRoot, rawHook), 0o755],
    [path.join(tempRoot, "plugins/superpowers/hooks/run-hook.cmd"), 0o644],
  ]);
  const originalLstatSync = fs.lstatSync;
  const setMode = (file, mode) => {
    assert.ok(fixtureModes.has(file), `undeclared mode fixture: ${file}`);
    fs.chmodSync(file, mode);
    fixtureModes.set(file, mode);
  };
  try {
    if (process.platform === "win32") {
      // Windows chmod cannot set POSIX execute bits; supply only those bits for declared regular fixtures.
      fs.lstatSync = (...args) => {
        const stat = Reflect.apply(originalLstatSync, fs, args);
        const mode = fixtureModes.get(args[0]);
        if (mode !== undefined && stat?.isFile()) {
          const mask = typeof stat.mode === "bigint" ? 0o111n : 0o111;
          const executable = typeof stat.mode === "bigint" ? BigInt(mode & 0o111) : mode & 0o111;
          stat.mode = (stat.mode & ~mask) | executable;
        }
        return stat;
      };
    }
    for (const [file, mode] of fixtureModes) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "echo fixture\n");
      setMode(file, mode);
    }
    const options = { repo, branch, base: "main", lock: freshLock, root: tempRoot, now: at };
    const sameRoutes = [openPull, lockRoute(branchLock(freshLock.sources[0].files)), treeRoute(), openIssue];
    const none = fakeGh([[`pr list --repo ${repo} --head ${branch}`, ok([])]]);
    assert.deepEqual(pending({ ...options, gh: none.gh }), { rerun: true, outcome: "no-open-refresh", message: "No refresh pull request is open, so this run refreshes, pushes and runs CI." });

    const same = fakeGh(sameRoutes);
    const held = pending({ ...options, gh: same.gh });
    assert.equal(held.rerun, false);
    assert.equal(held.outcome, "pending");
    assert.match(held.message, /https:\/\/github\.com\/owner\/desk\/pull\/7 has carried this upstream payload for 23 days and is still not on main\. See https:\/\/github\.com\/owner\/desk\/issues\/4\./u);

    for (const [localMode, carriedMode] of [[0o644, "100755"], [0o755, "100644"]]) {
      setMode(path.join(tempRoot, tool), localMode);
      const modesMoved = fakeGh([openPull, lockRoute(branchLock(freshLock.sources[0].files)), treeRoute(ok(tree(carriedMode))), openIssue]);
      assert.equal(pending({ ...options, gh: modesMoved.gh }).rerun, true, "a selected executable-mode change must rerun the refresh");
    }
    setMode(path.join(tempRoot, tool), 0o644);
    assert.equal(same.calls[0].line, `pr list --repo ${repo} --head ${branch} --base main --state open --json number,url,createdAt,headRefOid`);
    assert.ok(same.calls.some((call) => call.line === `api -H Accept: application/vnd.github.raw+json repos/${repo}/contents/upstream-sources.lock.json?ref=${sha}`), "read the lock at the observed pull-request head");
    assert.ok(same.calls.some((call) => call.line === `api repos/${repo}/git/trees/${sha}?recursive=1`), "read modes from the same head, not a moving branch");

    const movedFiles = freshLock.sources[0].files.map((file, index) => index === 0 ? { ...file, sha256: "3".repeat(64) } : file);
    const moved = fakeGh([openPull, lockRoute(branchLock(movedFiles))]);
    assert.equal(pending({ ...options, gh: moved.gh }).rerun, true);

    const unreadable = fakeGh([openPull, lockRoute(fail("HTTP 404"))]);
    assert.equal(pending({ ...options, gh: unreadable.gh }).rerun, true);

    for (const [name, result, error] of [
      ["API refusal", fail("HTTP 403"), /gh api repos\/owner\/desk\/git\/trees\/.* failed: HTTP 403/u],
      ["empty output", ok(""), /returned no JSON/u],
      ["invalid JSON", ok("<html>"), /returned invalid JSON/u],
      ["missing tree", ok({}), /refresh tree/u],
      ["null response", ok("null"), /refresh tree/u],
      ["truncated tree", ok({ ...tree(), truncated: true }), /refresh tree/u],
      ["invalid truncation flag", ok({ ...tree(), truncated: "false" }), /refresh tree/u],
      ["invalid entries", ok({ ...tree(), tree: {} }), /refresh tree/u],
      ["null entry", ok({ ...tree(), tree: [null] }), /refresh tree/u],
      ["empty path", ok({ ...tree(), tree: [{ path: "" }] }), /refresh tree/u],
      ["duplicate path", ok({ ...tree(), tree: [...tree().tree, tree().tree[0]] }), /refresh tree/u],
      ["missing selected path", ok({ ...tree(), tree: tree().tree.slice(1) }), /regular.file mode/u],
      ["missing mode", ok({ ...tree(), tree: tree().tree.map((entry) => ({ ...entry, mode: undefined })) }), /regular.file mode/u],
      ["invalid mode", ok(tree("100600")), /regular.file mode/u],
      ["symlink mode", ok(tree("120000")), /regular.file mode/u],
      ["invalid entry type", ok({ ...tree(), tree: tree().tree.map((entry) => ({ ...entry, type: "tree" })) }), /regular.file mode/u],
      ["bad evidence after a mode change", ok({ ...tree(), tree: tree("100755").tree.map((entry) => entry.path === rawHook ? { ...entry, mode: "invalid" } : entry) }), /regular.file mode/u],
    ]) {
      const broken = fakeGh([openPull, lockRoute(branchLock(freshLock.sources[0].files)), treeRoute(result), openIssue]);
      assert.throws(() => pending({ ...options, gh: broken.gh }), error, name);
    }

    const noHead = fakeGh([[openPull[0], ok([{ number: 7, url: "https://github.com/owner/desk/pull/7", createdAt: "2026-10-12T07:40:00Z" }])]]);
    assert.throws(() => pending({ ...options, gh: noHead.gh }), /refresh pull request.*head/u);
    fs.rmSync(path.join(tempRoot, tool));
    assert.throws(() => pending({ ...options, gh: fakeGh(sameRoutes).gh }), /ENOENT/u);
    fs.mkdirSync(path.join(tempRoot, tool));
    assert.throws(() => pending({ ...options, gh: fakeGh(sameRoutes).gh }), /regular file/u);
    fs.rmdirSync(path.join(tempRoot, tool));
    fs.writeFileSync(path.join(tempRoot, tool), "echo fixture\n");
    setMode(path.join(tempRoot, tool), 0o644);

    // The CLI emits a refusal output only after admission succeeds; unexpected failures leave no such output.
    const lockPath = path.join(tempRoot, "lock.json");
    const outputPath = path.join(tempRoot, "output.txt");
    fs.writeFileSync(lockPath, JSON.stringify(freshLock));
    let output = "";
    const argv = ["pending", "--repo", repo, "--branch", branch, "--base", "main", "--lock", lockPath];
    assert.equal(main(argv, { run: fakeGh(sameRoutes).run, env: { GITHUB_OUTPUT: outputPath }, stdout: { write(value) { output += value; } }, now: at }), 1);
    assert.match(output, /^## Superpowers upstream refresh: pending\n/u);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "rerun=false\n");
    fs.rmSync(outputPath);
    setMode(path.join(tempRoot, tool), 0o755);
    assert.equal(main(argv, { run: fakeGh(sameRoutes).run, env: { GITHUB_OUTPUT: outputPath }, stdout: { write() {} }, now: at }), 0);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "rerun=true\n", "a mode-only change must reach the workflow's push/publish path");
    fs.rmSync(outputPath);
    setMode(path.join(tempRoot, tool), 0o644);
    const brokenTree = fakeGh([openPull, lockRoute(branchLock(freshLock.sources[0].files)), treeRoute(fail("HTTP 403")), openIssue]);
    assert.throws(() => main(argv, { run: brokenTree.run, env: { GITHUB_OUTPUT: outputPath }, stdout: { write() {} }, now: at }), /HTTP 403/u);
    assert.equal(fs.existsSync(outputPath), false, "an unexpected gate failure must not write rerun=false");
    assert.equal(main(argv, { run: fakeGh([[`pr list --repo ${repo} --head ${branch}`, ok([])]]).run, env: { GITHUB_OUTPUT: outputPath }, stdout: { write() {} }, now: at }), 0);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "rerun=true\n");
    assert.throws(() => parseArgs(["pending", "--repo", repo]), /pending requires --branch, --base, --lock/u);
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log("Superpowers upstream pull request tests passed.");
