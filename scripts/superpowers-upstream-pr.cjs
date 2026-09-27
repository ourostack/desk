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
const RELEASE_WORKFLOW = "desk-release.yml";

// gh never prints a token, but a diagnostic may echo a credential it was handed; mask anything shaped like one.
function redact(text) {
  return text.replace(/\b(?:gh[opsur]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, "[redacted]");
}

function createGh({ run, env }) {
  function call(args, { input, allowFailure = false } = {}) {
    const result = run("gh", args, { encoding: "utf8", input, env, maxBuffer: 20 * 1024 * 1024 });
    const ok = result.status === 0;
    const stderr = redact(String(result.stderr ?? "").trim());
    const error = ok ? "" : redact(String(result.stderr || result.error?.message || `exit ${result.status}`).trim());
    if (!ok && !allowFailure) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${error}`);
    return { ok, stdout: ok ? String(result.stdout ?? "") : "", stderr, error };
  }
  // Some gh list commands print nothing at all, not `[]`, when nothing matches (for example `gh label list
  // --search` with no match), so a list read treats empty output as an empty list. Any other empty or malformed
  // output is a named error that carries gh's own stderr.
  // With allowFailure, a refused call returns null instead of throwing.
  function json(args, { list = false, allowFailure = false } = {}) {
    const { ok, stdout, stderr } = call(args, { allowFailure });
    if (!ok) return null;
    const command = `gh ${args.slice(0, 2).join(" ")}`;
    const context = stderr === "" ? "no stderr" : `stderr: ${stderr}`;
    if (stdout.trim() === "") {
      if (list) return [];
      throw new Error(`${command} returned no JSON (${context})`);
    }
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(`${command} returned invalid JSON: ${error.message} (${context})`);
    }
  }
  return { call, json };
}

function list(paths) {
  return paths.length === 0 ? "none" : paths.map((file) => `\`${file}\``).join(", ");
}

function pullRequestBody({ report, runUrl }) {
  const { release } = report;
  return [
    `This refresh vendors [obra/superpowers@${report.commit.slice(0, 12)}](https://github.com/${report.repository}/commit/${report.commit}) (upstream version ${release.superpowers.upstream}) into \`plugins/superpowers/\`. The selected files are byte-identical to upstream, and \`upstream-sources.lock.json\` records each path and SHA-256.`,
    "",
    `- Superpowers ${release.superpowers.from} → ${release.superpowers.to}. Desk gains the changelog fragment \`${release.fragment}\`, and the release workflow takes its next version when this merges.`,
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
  const pulls = gh.json(["pr", "list", "--repo", repo, "--head", branch, "--base", base, "--state", "open", "--json", "number,url"], { list: true });
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
  // Without read access to rulesets there is nothing extra to require; malformed output still stops the merge.
  const rules = gh.json(["api", `repos/${repo}/rules/branches/${base}`], { list: true, allowFailure: true });
  if (rules === null) return [];
  return rules
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
  const labels = gh.json(["label", "list", "--repo", repo, "--search", LABEL, "--json", "name"], { list: true });
  if (!labels.some((label) => label.name === LABEL)) {
    gh.call(["label", "create", LABEL, "--repo", repo, "--force", "--color", "5319E7", "--description", "The scheduled Superpowers upstream refresh needs an agent"]);
  }
  const [open] = gh.json(["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--limit", "1", "--json", "number,url"], { list: true });
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
  const open = gh.json(["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--limit", "20", "--json", "number"], { list: true });
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
  // A merge made with the workflow token starts no push-triggered run, so the Desk release is dispatched on main.
  const released = gh.call(["workflow", "run", RELEASE_WORKFLOW, "--repo", repo, "--ref", base], { allowFailure: true });
  const message = released.ok
    ? "Every check passed, the refresh merged and the Desk release was dispatched."
    : `Every check passed and the refresh merged, but the Desk release could not be dispatched: ${released.error}. Dispatch ${RELEASE_WORKFLOW} on ${base}.`;
  return { outcome: "merged", pull: pull.url, issue: null, jobs, message };
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
    publish: ["repo", "branch", "base", "sha", "report", "workflows", "run-url"],
  }[command];
  if (!required) throw new Error("usage: superpowers-upstream-pr.cjs publish --option value ...");
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
  const { options } = parseArgs(argv);
  const gh = createGh({ run, env });
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

module.exports = { createGh, main, parseArgs, publish, pullRequestBody, sleepSync };
