#!/usr/bin/env node
"use strict";

// Drives the scheduled Superpowers refresh after its commit is pushed: open or update the pull request, dispatch the
// repository's CI workflows on the refresh branch (pull request events raised by the workflow token start no runs,
// but a dispatch does), wait for every job, and merge when all of them and any ruleset-required check pass, then
// dispatch the Desk release. Anything short of that files or updates one `upstream-refresh` issue with each failed
// job's own errors and exits non-zero, so an undelivered refresh is a failed run, never a green one. A major upstream
// release is labelled as one and files a `superpowers-major` issue with upstream's release notes, so what is new gets
// adopted in Desk rather than only shipped.
//
// `pending` is the daily check's cheap gate: when the open refresh pull request already carries the payload this run
// would push, it neither pushes nor reruns CI, and fails the run because the refresh is still not on main.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const LABEL = "upstream-refresh";
const MAJOR_LABEL = "superpowers-major";
const ISSUE_TITLE = "Superpowers upstream refresh needs attention";
const UPSTREAM_NOTES = "RELEASE-NOTES.md";
// GitHub refuses a body over 65,536 characters; the notes get what the rest of the body leaves, cut per section.
const NOTES_BUDGET = 40_000;
const ANNOTATION_LIMIT = 3;
const ANNOTATION_LENGTH = 300;
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

function major(release) {
  const from = Number(release.superpowers.from.split(".")[0]);
  const to = Number(release.superpowers.to.split(".")[0]);
  return to > from ? { from, to } : null;
}

function notesMarkdown(report) {
  const notes = report.release.notes ?? [];
  if (notes.length === 0) {
    return [`Upstream's ${UPSTREAM_NOTES} has no section for a version after the one Desk shipped, so this refresh brings unreleased upstream changes; the changed files below are the whole story.`];
  }
  const full = `https://github.com/${report.repository}/blob/${report.commit}/${UPSTREAM_NOTES}`;
  const share = Math.floor(NOTES_BUDGET / notes.length);
  return notes.flatMap((note) => {
    const body = note.body.length > share
      ? `${note.body.slice(0, share).trimEnd()}…\n\n[Read the full release notes](${full})`
      : note.body;
    return [`<details><summary>${note.heading}</summary>`, "", body, "", "</details>", ""];
  }).slice(0, -1);
}

function majorNotice(release) {
  const crossed = major(release);
  if (!crossed) return [];
  const range = release.range
    ? ` The refresh moved Desk's Superpowers compatibility floor from \`${release.range.from}\` to \`${release.range.to}\` in ${list(release.range.files)}, so CI qualifies Desk against it.`
    : "";
  return [
    `> **Major upstream release: Superpowers ${crossed.from} → ${crossed.to}.**${range} Read the release notes below for anything Desk's adapter (\`plugins/desk/skills/using-superpowers-with-desk\`, \`plugins/desk/mcp/src/activation/superpowers-context.js\`) should change or adopt; the \`${MAJOR_LABEL}\` issue tracks that.`,
    "",
  ];
}

function referencesLine(report) {
  const references = report.desk_references ?? [];
  if (references.length === 0) return [];
  return [`- Desk files that still name a removed upstream file: ${references.map((reference) => `\`${reference.path}\` in ${list(reference.files)}`).join("; ")}.`];
}

function pullRequestBody({ report, runUrl }) {
  const { release } = report;
  return [
    ...majorNotice(release),
    `This refresh vendors [obra/superpowers@${report.commit.slice(0, 12)}](https://github.com/${report.repository}/commit/${report.commit}) (upstream version ${release.superpowers.upstream}) into \`plugins/superpowers/\`. The selected files are byte-identical to upstream, and \`upstream-sources.lock.json\` records each path and SHA-256.`,
    "",
    `- Superpowers ${release.superpowers.from} → ${release.superpowers.to}. Desk gains the changelog fragment \`${release.fragment}\`, and the release workflow takes its next version when this merges.`,
    `- Changed: ${list(report.updated_paths)}.`,
    `- Added: ${list(report.added_paths)}.`,
    `- Removed: ${list(report.removed_paths)}.`,
    `- File mode changed: ${list(report.mode_changed_paths)}.`,
    `- New upstream skills not selected (a person or agent decides whether to add them): ${list(report.unselected_skills)}.`,
    ...referencesLine(report),
    "",
    "## What upstream changed",
    "",
    ...notesMarkdown(report),
    "",
    `The [scheduled refresh](${runUrl}) opened this pull request, dispatches CI on it and merges it when every check passes. If a check fails, it stays open, the run fails and an \`${LABEL}\` issue explains why.`,
  ].join("\n");
}

// Text in Desk that still names an upstream file the refresh removed. Vendored files, the lock and release history
// name old paths on purpose and are skipped.
function referencesToRemoved(removedPaths, files) {
  const skipped = (file) => file.startsWith("plugins/superpowers/") || file === "upstream-sources.lock.json"
    || /(^|\/)CHANGELOG\.md$/u.test(file) || file.includes("/changelog.d/");
  return removedPaths.flatMap((removed) => {
    const relative = removed.replace(/^skills\//u, "");
    const base = removed.split("/").at(-1);
    const needles = [relative, ...(/^(SKILL|README)\.md$/u.test(base) || base.length < 10 ? [] : [base])];
    const naming = files.filter((file) => !skipped(file.path) && needles.some((needle) => file.text.includes(needle))).map((file) => file.path);
    return naming.length === 0 ? [] : [{ path: removed, files: naming }];
  });
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
    return jobs.map((job) => ({ workflow, id: job.id ?? null, name: job.name, conclusion: job.conclusion ?? job.status, url: job.html_url }));
  });
}

function ensureLabel({ gh, repo, name, color, description }) {
  const labels = gh.json(["label", "list", "--repo", repo, "--search", name, "--json", "name"], { list: true });
  if (!labels.some((label) => label.name === name)) {
    gh.call(["label", "create", name, "--repo", repo, "--force", "--color", color, "--description", description]);
  }
}

function fileIssue({ gh, repo, body }) {
  ensureLabel({ gh, repo, name: LABEL, color: "5319E7", description: "The scheduled Superpowers upstream refresh needs an agent" });
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

// One open adoption issue per upstream major: it carries the release notes so an agent works out what Desk should
// change or take up, whether or not CI passes.
function fileAdoptionIssue({ gh, repo, report, pull }) {
  const crossed = major(report.release);
  const title = `Superpowers ${crossed.to}: adopt what's new`;
  const open = gh.json(["issue", "list", "--repo", repo, "--label", MAJOR_LABEL, "--state", "open", "--limit", "20", "--json", "number,title,url"], { list: true });
  const existing = open.find((issue) => issue.title === title);
  if (existing) return existing.url;
  const body = [
    `Superpowers ${report.release.superpowers.to} crossed a major version (${crossed.from} → ${crossed.to}); ${pull.url} vendors it.`,
    "",
    "Read upstream's release notes below and decide, for each change, what Desk needs:",
    "",
    "- `plugins/desk/skills/using-superpowers-with-desk/SKILL.md` still selects the right entry and its handoff still matches what the provider skills now do.",
    "- `plugins/desk/mcp/src/activation/superpowers-context.js` still maps every path the provider's helpers produce.",
    "- Hook packaging (`plugins/superpowers/hooks/`, `scripts/superpowers-hook-compat.cjs`) is still needed, or upstream now covers it.",
    "- New or unselected upstream skills, and anything new worth adopting. Record a real product decision rather than guessing it.",
    "",
    "Close this issue with a note of what Desk adopted and what was decided.",
    "",
    "## What upstream changed",
    "",
    ...notesMarkdown(report),
  ].join("\n");
  return gh.call(["issue", "create", "--repo", repo, "--title", title, "--label", MAJOR_LABEL, "--body-file", "-"], { input: body }).stdout.trim();
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

// A failed job's own error lines (a job's id is its check run's id). Reading them is best effort.
function failureLines({ gh, repo, job }) {
  if (job.id === null || job.id === undefined) return [];
  const annotations = gh.json(["api", `repos/${repo}/check-runs/${job.id}/annotations?per_page=50`], { list: true, allowFailure: true }) ?? [];
  return annotations
    .filter((annotation) => annotation.annotation_level === "failure")
    .slice(0, ANNOTATION_LIMIT)
    .map((annotation) => {
      const message = String(annotation.message).replace(/\s+/gu, " ").trim();
      return `  - ${message.length > ANNOTATION_LENGTH ? `${message.slice(0, ANNOTATION_LENGTH)}…` : message}`;
    });
}

function publish({ gh, repo, branch, base, sha, report, workflows, runUrl, sleep, now, pollMs, timeoutMs }) {
  const crossed = major(report.release);
  const title = `${TITLE_PREFIX} ${report.commit.slice(0, 12)}${crossed ? ` (major: ${report.release.superpowers.from} → ${report.release.superpowers.to})` : ""}`;
  const { pull, error } = openOrUpdatePullRequest({ gh, repo, branch, base, title, body: pullRequestBody({ report, runUrl }) });
  if (!pull) {
    const issue = fileIssue({ gh, repo, body: [
      `The [scheduled refresh](${runUrl}) pushed \`${branch}\` at \`${sha}\` but could not open a pull request: ${error}`,
      "",
      `If the message says GitHub Actions may not create pull requests, a repository admin can allow it under Settings → Actions → General → Workflow permissions, or an agent can open the pull request from [the branch](https://github.com/${repo}/compare/${base}...${branch}).`,
    ].join("\n") });
    return { outcome: "pull-request-blocked", delivered: false, pull: null, issue, jobs: [], message: error };
  }
  let adoption = null;
  if (crossed) {
    ensureLabel({ gh, repo, name: MAJOR_LABEL, color: "D93F0B", description: "A major Superpowers upstream release for Desk to adopt" });
    gh.call(["pr", "edit", String(pull.number), "--repo", repo, "--add-label", MAJOR_LABEL]);
    adoption = fileAdoptionIssue({ gh, repo, report, pull });
  }

  const { runs, timedOut } = dispatchAndWait({ gh, repo, branch, sha, workflows, sleep, now, pollMs, timeoutMs });
  const jobs = collectJobs({ gh, repo, runs });
  const passed = new Set(jobs.filter((job) => job.conclusion === "success").map((job) => job.name));
  const missingRequired = requiredContexts({ gh, repo, base }).filter((context) => !passed.has(context));
  const failed = jobs.filter((job) => job.conclusion !== "success");
  if (timedOut || failed.length > 0 || missingRequired.length > 0) {
    const problems = [
      ...(timedOut ? [`- CI did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`] : []),
      ...failed.flatMap((job) => [jobLine(job), ...failureLines({ gh, repo, job })]),
      ...missingRequired.map((context) => `- Required check \`${context}\` did not pass.`),
    ];
    const issue = fileIssue({ gh, repo, body: [
      `${pull.url} is open at \`${sha}\` because not every check passed on the [scheduled refresh](${runUrl}):`,
      "",
      ...problems,
      "",
      "Fix the cause on the pull request branch or in Desk, then merge it once every check passes. The next scheduled run rebuilds the branch from main.",
    ].join("\n") });
    return { outcome: "checks-failed", delivered: false, pull: pull.url, issue, jobs, adoption, message: problems.join("\n") };
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
    const issue = fileIssue({ gh, repo, body: `${pull.url} passed every check on the [scheduled refresh](${runUrl}), but ${message.replace(/^Every check passed, but /u, "")}\n\nMerge it at \`${sha}\` once the cause is fixed; the Desk release follows.` });
    return { outcome: "merge-blocked", delivered: false, pull: pull.url, issue, jobs, adoption, message };
  }
  closeIssues({ gh, repo, pullUrl: pull.url });
  // A merge made with the workflow token starts no push-triggered run, so the Desk release is dispatched on main.
  const released = gh.call(["workflow", "run", RELEASE_WORKFLOW, "--repo", repo, "--ref", base], { allowFailure: true });
  if (released.ok) {
    return { outcome: "merged", delivered: true, pull: pull.url, issue: null, jobs, adoption, message: "Every check passed, the refresh merged and the Desk release was dispatched." };
  }
  const message = `Every check passed and the refresh merged, but the Desk release could not be dispatched: ${released.error}. Dispatch ${RELEASE_WORKFLOW} on ${base}.`;
  const issue = fileIssue({ gh, repo, body: `${pull.url} merged from the [scheduled refresh](${runUrl}), but Desk users do not have it yet. ${message.replace(/^Every check passed and the refresh merged, but /u, "The ")}` });
  return { outcome: "merged", delivered: false, pull: pull.url, issue, jobs, adoption, message };
}

function payload(lock) {
  const source = lock?.sources?.find((entry) => entry.id === "obra-superpowers");
  return source ? JSON.stringify(source.files.map((file) => [file.sourcePath, file.sha256])) : null;
}

function pending({ gh, repo, branch, base, lock, now }) {
  const [open] = gh.json(["pr", "list", "--repo", repo, "--head", branch, "--base", base, "--state", "open", "--json", "number,url,createdAt"], { list: true });
  if (!open) return { rerun: true, outcome: "no-open-refresh", message: "No refresh pull request is open, so this run refreshes, pushes and runs CI." };
  const carried = gh.json(["api", "-H", "Accept: application/vnd.github.raw+json", `repos/${repo}/contents/upstream-sources.lock.json?ref=${branch}`], { allowFailure: true });
  if (carried === null || payload(carried) !== payload(lock)) {
    return { rerun: true, outcome: "upstream-moved", message: `${open.url} carries an older upstream payload, so this run refreshes it and runs CI.` };
  }
  const [issue] = gh.json(["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--limit", "1", "--json", "number,url"], { list: true });
  const days = Math.floor((now() - Date.parse(open.createdAt)) / 86_400_000);
  return {
    rerun: false,
    outcome: "pending",
    message: `${open.url} has carried this upstream payload for ${days} days and is still not on main.${issue ? ` See ${issue.url}.` : ""} The weekly run reruns CI on it; fix the cause there or in Desk.`,
  };
}

function summaryMarkdown(result) {
  return [
    `## Superpowers upstream refresh: ${result.outcome}`,
    "",
    result.message,
    "",
    ...(result.pull ? [`Pull request: ${result.pull}`] : []),
    ...(result.issue ? [`Issue: ${result.issue}`] : []),
    ...(result.adoption ? [`Adoption issue: ${result.adoption}`] : []),
    ...(result.jobs ?? []).map(jobLine),
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
    pending: ["repo", "branch", "base", "lock"],
  }[command];
  if (!required) throw new Error("usage: superpowers-upstream-pr.cjs publish|pending --option value ...");
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
  const output = (lines) => {
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, lines.map(([key, value]) => `${key}=${value}\n`).join(""));
  };
  if (command === "pending") {
    const result = pending({ gh, repo: options.repo, branch: options.branch, base: options.base, lock: JSON.parse(fs.readFileSync(options.lock, "utf8")), now });
    output([["rerun", String(result.rerun)]]);
    if (!result.rerun) {
      const summary = summaryMarkdown(result);
      if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
      stdout.write(summary);
      return 1;
    }
    stdout.write(`${result.message}\n`);
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
  output([["outcome", result.outcome], ["delivered", String(result.delivered)], ...(result.issue ? [["issue", result.issue]] : [])]);
  // A refresh that did not reach Desk's users fails the run; its issue already says why.
  return result.delivered ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createGh, main, parseArgs, pending, publish, pullRequestBody, referencesToRemoved, sleepSync };
