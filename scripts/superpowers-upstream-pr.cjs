#!/usr/bin/env node
"use strict";

// Drives the scheduled Superpowers refresh after its commit is pushed: open or update the pull request, dispatch the
// repository's CI workflows on the refresh branch (pull request events raised by the workflow token start no runs,
// but a dispatch does), wait for every job, and merge when all of them and any ruleset-required check pass. A failing
// or missing check leaves the pull request open and files one `upstream-refresh` issue for an agent to pick up.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const LABEL = "upstream-refresh";
const ISSUE_TITLE = "Superpowers upstream refresh needs attention";
const TITLE_PREFIX = "Refresh Superpowers from upstream";

function createGh({ run, env }) {
  function call(args, { input, allowFailure = false } = {}) {
    const result = run("gh", args, { encoding: "utf8", input, env, maxBuffer: 20 * 1024 * 1024 });
    const ok = result.status === 0;
    const error = ok ? "" : String(result.stderr || result.error?.message || `exit ${result.status}`).trim();
    if (!ok && !allowFailure) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${error}`);
    return { ok, stdout: ok ? result.stdout : "", error };
  }
  return {
    call,
    json: (args) => JSON.parse(call(args).stdout),
  };
}

function alphaNumber(version, core) {
  const match = /^(\d+\.\d+\.\d+)-alpha\.(\d+)$/u.exec(String(version));
  return match && match[1] === core ? Number(match[2]) : null;
}

// The next Desk alpha that neither main nor any other open pull request has claimed, so a refresh cannot collide
// with a release that is already in review.
function nextDeskVersion({ gh, repo, current, branch }) {
  const core = current.split("-")[0];
  const claimed = [alphaNumber(current, core)];
  if (claimed[0] === null) throw new Error(`Desk version ${current} is not an alpha release`);
  const pulls = gh.json(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "headRefName,headRefOid"]);
  for (const pull of pulls) {
    if (pull.headRefName === branch) continue;
    const manifest = gh.call([
      "api", `repos/${repo}/contents/plugins/desk/.claude-plugin/plugin.json?ref=${pull.headRefOid}`, "--jq", ".content",
    ], { allowFailure: true });
    if (!manifest.ok) continue;
    const version = JSON.parse(Buffer.from(manifest.stdout, "base64").toString("utf8")).version;
    const number = alphaNumber(version, core);
    if (number !== null) claimed.push(number);
  }
  return `${core}-alpha.${Math.max(...claimed) + 1}`;
}

function list(paths) {
  return paths.length === 0 ? "none" : paths.map((file) => `\`${file}\``).join(", ");
}

function pullRequestBody({ report, runUrl }) {
  const { release } = report;
  return [
    `This refresh vendors [obra/superpowers@${report.commit.slice(0, 12)}](https://github.com/${report.repository}/commit/${report.commit}) (upstream version ${release.superpowers.upstream}) into \`plugins/superpowers/\`. The selected files are byte-identical to upstream, and \`upstream-sources.lock.json\` records each path and SHA-256.`,
    "",
    `- Superpowers ${release.superpowers.from} → ${release.superpowers.to}; Desk ${release.desk.from} → ${release.desk.to}.`,
    `- Changed: ${list(report.updated_paths)}.`,
    `- Added: ${list(report.added_paths)}.`,
    `- Removed: ${list(report.removed_paths)}.`,
    `- File mode changed: ${list(report.mode_changed_paths)}.`,
    `- New upstream skills not selected (a person or agent decides whether to add them): ${list(report.unselected_skills)}.`,
    "",
    `The [scheduled refresh](${runUrl}) opened this pull request, dispatches CI on it and merges it when every check passes. If a check fails, it stays open and an \`${LABEL}\` issue explains why.`,
  ].join("\n");
}

function findPullRequest({ gh, repo, branch, base }) {
  const pulls = gh.json(["pr", "list", "--repo", repo, "--head", branch, "--base", base, "--state", "open", "--json", "number,url"]);
  return pulls[0] ?? null;
}

function openOrUpdatePullRequest({ gh, repo, branch, base, title, body }) {
  const existing = findPullRequest({ gh, repo, branch, base });
  if (existing) {
    gh.call(["pr", "edit", String(existing.number), "--repo", repo, "--title", title, "--body-file", "-"], { input: body });
    return { pull: existing, error: null };
  }
  const created = gh.call(
    ["pr", "create", "--repo", repo, "--head", branch, "--base", base, "--title", title, "--body-file", "-"],
    { input: body, allowFailure: true },
  );
  if (!created.ok) return { pull: null, error: created.error };
  return { pull: findPullRequest({ gh, repo, branch, base }), error: null };
}

function requiredContexts({ gh, repo, base }) {
  const rules = gh.call(["api", `repos/${repo}/rules/branches/${base}`], { allowFailure: true });
  if (!rules.ok) return [];
  return JSON.parse(rules.stdout)
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters.required_status_checks.map((check) => check.context));
}

function dispatchAndWait({ gh, repo, branch, sha, workflows, sleep, now, pollMs, timeoutMs }) {
  const dispatchedAt = now();
  for (const workflow of workflows) {
    gh.call(["workflow", "run", workflow, "--repo", repo, "--ref", branch]);
  }
  const deadline = dispatchedAt + timeoutMs;
  for (;;) {
    const runs = workflows.map((workflow) => {
      const { workflow_runs: candidates } = gh.json([
        "api", `repos/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&event=workflow_dispatch&head_sha=${sha}&per_page=20`,
      ]);
      const run = candidates
        .filter((candidate) => Date.parse(candidate.created_at) >= dispatchedAt - 60_000)
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
      return { workflow, run: run ?? null };
    });
    if (runs.every(({ run }) => run?.status === "completed")) return { runs, timedOut: false };
    if (now() >= deadline) return { runs, timedOut: true };
    sleep(pollMs);
  }
}

function collectJobs({ gh, repo, runs }) {
  return runs.flatMap(({ workflow, run }) => {
    if (run === null) return [{ workflow, name: `${workflow} (no run started)`, conclusion: "missing", url: null }];
    const { jobs } = gh.json(["api", `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]);
    if (jobs.length === 0) return [{ workflow, name: `${workflow} (no jobs)`, conclusion: run.conclusion ?? run.status, url: run.html_url }];
    return jobs.map((job) => ({ workflow, name: job.name, conclusion: job.conclusion ?? job.status, url: job.html_url }));
  });
}

function fileIssue({ gh, repo, body }) {
  const labels = gh.json(["label", "list", "--repo", repo, "--search", LABEL, "--json", "name"]);
  if (!labels.some((label) => label.name === LABEL)) {
    gh.call(["label", "create", LABEL, "--repo", repo, "--color", "5319E7", "--description", "The scheduled Superpowers upstream refresh needs an agent"]);
  }
  const [open] = gh.json(["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--limit", "1", "--json", "number,url"]);
  if (open) {
    gh.call(["issue", "comment", String(open.number), "--repo", repo, "--body-file", "-"], { input: body });
    return open.url;
  }
  return gh.call(
    ["issue", "create", "--repo", repo, "--title", ISSUE_TITLE, "--label", LABEL, "--body-file", "-"],
    { input: body },
  ).stdout.trim();
}

function closeIssues({ gh, repo, pullUrl }) {
  const open = gh.json(["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--limit", "20", "--json", "number"]);
  for (const issue of open) {
    gh.call(["issue", "close", String(issue.number), "--repo", repo, "--comment", `Resolved: ${pullUrl} passed every check and merged.`]);
  }
}

function jobLine(job) {
  return `- ${job.workflow}: ${job.url ? `[${job.name}](${job.url})` : job.name} — ${job.conclusion}`;
}

function publish({ gh, repo, branch, base, sha, report, workflows, runUrl, sleep, now, pollMs, timeoutMs }) {
  const title = `${TITLE_PREFIX} ${report.commit.slice(0, 12)}`;
  const { pull, error } = openOrUpdatePullRequest({ gh, repo, branch, base, title, body: pullRequestBody({ report, runUrl }) });
  if (!pull) {
    const issue = fileIssue({ gh, repo, body: [
      `The [scheduled refresh](${runUrl}) pushed \`${branch}\` at \`${sha}\` but could not open a pull request: ${error}`,
      "",
      `If the message says GitHub Actions may not create pull requests, a repository admin can allow it under Settings → Actions → General → Workflow permissions, or an agent can open the pull request from [the branch](https://github.com/${repo}/compare/${base}...${branch}).`,
    ].join("\n") });
    return { outcome: "pull-request-blocked", pull: null, issue, jobs: [], message: error };
  }

  const { runs, timedOut } = dispatchAndWait({ gh, repo, branch, sha, workflows, sleep, now, pollMs, timeoutMs });
  const jobs = collectJobs({ gh, repo, runs });
  const passed = new Set(jobs.filter((job) => job.conclusion === "success").map((job) => job.name));
  const missingRequired = requiredContexts({ gh, repo, base }).filter((context) => !passed.has(context));
  const failed = jobs.filter((job) => job.conclusion !== "success");
  if (timedOut || failed.length > 0 || missingRequired.length > 0) {
    const problems = [
      ...(timedOut ? [`- CI did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`] : []),
      ...failed.map(jobLine),
      ...missingRequired.map((context) => `- Required check \`${context}\` did not pass.`),
    ];
    const issue = fileIssue({ gh, repo, body: [
      `${pull.url} is open at \`${sha}\` because not every check passed on the [scheduled refresh](${runUrl}):`,
      "",
      ...problems,
      "",
      "Fix the cause on the pull request branch or in Desk, then merge it once every check passes. The next scheduled run rebuilds the branch from main.",
    ].join("\n") });
    return { outcome: "checks-failed", pull: pull.url, issue, jobs, message: problems.join("\n") };
  }

  const merged = gh.call(
    ["pr", "merge", String(pull.number), "--repo", repo, "--merge", "--match-head-commit", sha, "--delete-branch"],
    { allowFailure: true },
  );
  if (!merged.ok) {
    const message = `Every check passed, but the workflow token could not merge: ${merged.error}`;
    gh.call(["pr", "comment", String(pull.number), "--repo", repo, "--body-file", "-"], {
      input: `${message}\n\nBranch protection or repository settings may require a person to merge. The pull request stays open.`,
    });
    return { outcome: "merge-blocked", pull: pull.url, issue: null, jobs, message };
  }
  closeIssues({ gh, repo, pullUrl: pull.url });
  return { outcome: "merged", pull: pull.url, issue: null, jobs, message: "Every check passed and the refresh merged." };
}

function summaryMarkdown(result) {
  return [
    `## Superpowers upstream refresh: ${result.outcome}`,
    "",
    result.message,
    "",
    ...(result.pull ? [`Pull request: ${result.pull}`] : []),
    ...(result.issue ? [`Issue: ${result.issue}`] : []),
    ...result.jobs.map(jobLine),
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!/^--[a-z-]+$/u.test(rest[index]) || rest[index + 1] === undefined) {
      throw new Error(`unknown or incomplete argument: ${rest[index]}`);
    }
    options[rest[index].slice(2)] = rest[index + 1];
  }
  const required = {
    "next-desk-version": ["repo", "current", "branch"],
    publish: ["repo", "branch", "base", "sha", "report", "workflows", "run-url"],
  }[command];
  if (!required) throw new Error("usage: superpowers-upstream-pr.cjs <next-desk-version|publish> --option value ...");
  const missing = required.filter((key) => options[key] === undefined);
  if (missing.length > 0) throw new Error(`${command} requires --${missing.join(", --")}`);
  return { command, options };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(argv = process.argv.slice(2), {
  run = spawnSync,
  env = process.env,
  stdout = process.stdout,
  sleep = sleepSync,
  now = Date.now,
} = {}) {
  const { command, options } = parseArgs(argv);
  const gh = createGh({ run, env });
  if (command === "next-desk-version") {
    stdout.write(`${nextDeskVersion({ gh, repo: options.repo, current: options.current, branch: options.branch })}\n`);
    return 0;
  }
  const result = publish({
    gh,
    repo: options.repo,
    branch: options.branch,
    base: options.base,
    sha: options.sha,
    report: JSON.parse(fs.readFileSync(options.report, "utf8")),
    workflows: options.workflows.split(",").filter(Boolean),
    runUrl: options["run-url"],
    sleep,
    now,
    pollMs: Number(options["poll-seconds"] ?? 30) * 1000,
    timeoutMs: Number(options["timeout-minutes"] ?? 110) * 60_000,
  });
  const summary = summaryMarkdown(result);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  stdout.write(summary);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createGh, main, nextDeskVersion, parseArgs, publish, pullRequestBody, sleepSync };
