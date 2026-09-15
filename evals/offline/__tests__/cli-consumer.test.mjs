import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { bytes, diskRunSet, methodFixture, planFixture } from "./helpers/run-set.mjs";
import { dataRoot, repository, workRoot } from "./helpers/paths.mjs";

const root = workRoot("cli-consumer");
const cli = path.join(repository, "scripts/skill-evals.cjs");
const preload = path.join(repository, "evals/offline/__tests__/helpers/deny-sdk-preload.mjs");
const run = args => spawnSync(process.execPath, ["--import", preload, cli, "offline", ...args], { cwd: repository, encoding: "utf8", timeout: 15000 });

test("the shipping CLI reports static help, typed invalid invocations and a truthful native hold", () => {
  const help = run(["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /offline compare/);
  assert.match(help.stdout, /offline run --plan/);
  for (const args of [[], ["help", "extra"], ["validate"], ["validate", "--dataset", "x", "--dataset", "y"], ["validate", "--dataset", "--bad", "--fixtures", "x"], ["compare", "--left", "x"], ["run", "--plan", "x"]]) {
    const result = run(args);
    assert.equal(result.status, 4, result.stderr);
    assert.equal(JSON.parse(result.stderr).kind, "offline_error");
  }
  const filename = path.join(root, "plan.json");
  fs.writeFileSync(filename, bytes(planFixture()));
  const output = path.join(root, "must-not-exist");
  // No parent-owned T13 preflight reaches the shipping CLI route, so conditional admission still refuses.
  const held = run(["run", "--plan", filename, "--output", output]);
  assert.equal(held.status, 3, held.stderr);
  assert.equal(JSON.parse(held.stderr).status, "unavailable");
  assert.equal(JSON.parse(held.stderr).code, "NATIVE_QUALIFICATION_REQUIRED");
  assert.equal(fs.existsSync(output), false);
});

test("the actual CLI compares complete sealed inventories without calling them scored evaluations", () => {
  const left = diskRunSet(root, { id: "complete-left", withSeed: true });
  const right = diskRunSet(root, { id: "complete-right", status: "passed", withSeed: true });
  const result = run(["compare", "--left", left.filename, "--right", right.filename]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "compatible");
  assert.equal(output.scored, false);
  assert.equal(output.grade, null);
  assert.equal(output.left.cells[0].status, "product_failure");
  assert.equal(output.right.cells[0].status, "passed");
  assert.equal("winner" in output, false);
});

test("the actual CLI retains unpublished, pending and unstarted cells as not comparable", () => {
  const complete = diskRunSet(root, { id: "complete-control", deterministic: true });
  for (const options of [{ id: "unpublished", published: false, deterministic: true }, { id: "pending", closed: false, deterministic: true }, { id: "unstarted", started: false, deterministic: true }]) {
    const incomplete = diskRunSet(root, options);
    const result = run(["compare", "--left", complete.filename, "--right", incomplete.filename]);
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.right.inventoryComplete, false);
    assert.equal(output.right.cells.length, 1);
  }
});

test("method comparison consumes source, non-method and method raw-byte manifests", () => {
  const left = diskRunSet(root, { id: "method-left", dimension: "method", method: methodFixture("before") });
  const right = diskRunSet(root, { id: "method-right", dimension: "method", method: methodFixture("after") });
  const result = run(["compare", "--left", left.filename, "--right", right.filename]);
  assert.equal(result.status, 0, result.stderr);
  fs.unlinkSync(path.join(right.root, "source-manifest.json"));
  const missing = run(["compare", "--left", left.filename, "--right", right.filename]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).compatibility.reason, "METHOD_SOURCE_PROOF_REQUIRED");
});

test("a complete run set cannot be compared to the same retained attempt again", () => {
  const fixture = diskRunSet(root, { id: "duplicate-input" });
  const result = run(["compare", "--left", fixture.filename, "--right", fixture.filename]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).compatibility.reason, "DUPLICATE_COMPARISON_INPUT");
});

test("a newly sealed plan cannot re-label a receipt produced against an older plan", () => {
  const left = diskRunSet(root, { id: "stale-plan-left" });
  const right = diskRunSet(root, { id: "stale-plan-right" });
  left.plan.candidate.sourceCommit = "c".repeat(40);
  left.runSet.plan = left.put("plan.json", left.plan);
  left.save();
  const result = run(["compare", "--left", left.filename, "--right", right.filename]);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(JSON.parse(result.stderr).code, "RECEIPT_PLAN_MISMATCH");
});

test("CLI input errors never bypass dataset and raw journal validation", () => {
  const dataset = JSON.parse(fs.readFileSync(path.join(dataRoot, "dataset.json")));
  dataset.cases[0].fixture = "unbound-fixture";
  const filename = path.join(root, "bad-dataset.json");
  fs.writeFileSync(filename, bytes(dataset));
  assert.equal(run(["validate", "--dataset", filename, "--fixtures", path.join(dataRoot, "fixture-manifest.json")]).status, 4);
  const left = diskRunSet(root, { id: "bad-journal-left" });
  const right = diskRunSet(root, { id: "bad-journal-right" });
  fs.appendFileSync(path.join(left.root, "attempt-journal.jsonl"), "partial");
  assert.equal(run(["compare", "--left", left.filename, "--right", right.filename]).status, 4);
});

const legacy = args => spawnSync(process.execPath, ["--import", preload, cli, ...args], { cwd: repository, encoding: "utf8", timeout: 15000 });
const publicHead = "1".repeat(40);
const publicPreviousHead = "2".repeat(40);
const publicRequest = (change = () => {}) => {
  const value = {
    schemaVersion: 1,
    kind: "relevant_revision_request",
    repository: "owner/public-alpha",
    ref: "refs/pull/17/merge",
    head: publicHead,
    previousHeads: [publicPreviousHead],
    changedPaths: ["evals/offline/fixed-controller.mjs"],
    events: [{ eventId: "delivery-1", receivedAt: "2026-09-15T00:00:00Z", head: publicHead }],
  };
  change(value);
  return value;
};
const publish = (name, value) => {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, bytes(value));
  return filename;
};

test("the shipping CLI publishes a relevant-revision status that no candidate can turn green by itself", () => {
  const help = legacy(["help"]);
  assert.equal(help.status, 1, help.stdout);
  assert.match(help.stderr, /revision --request/);
  const request = publish("public-revision-request.json", publicRequest());
  const status = legacy(["revision", "--request", request]);
  assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.kind, "relevant_revision_status");
  assert.equal(report.relevance.relevant, true);
  assert.equal(report.status, "pending");
  assert.equal(report.green, false);
  assert.equal(report.scored, false);
  assert.equal(report.grade, null);
  assert.equal(report.trustedControls.available, false);
  assert.equal(report.revision.head, publicHead);
  assert.equal(report.runIdentity, report.revision.revisionId);
  // A candidate that also rewrites the trusted controller and its public workflow is still only data.
  const rewritten = publish("candidate-control-rewrite.json", publicRequest(value => { value.changedPaths = ["scripts/skill-evals.cjs", ".github/workflows/desk-mcp-tests.yml", "evals/offline/cases/v2-alpha-v1/check-expectations.json"]; }));
  const rewrittenReport = JSON.parse(legacy(["revision", "--request", rewritten]).stdout);
  assert.equal(rewrittenReport.status, "pending");
  assert.equal(rewrittenReport.green, false);
  assert.deepEqual(rewrittenReport.relevance.trustedControlPaths, ["scripts/skill-evals.cjs", ".github/workflows/desk-mcp-tests.yml", "evals/offline/cases/v2-alpha-v1/check-expectations.json"]);
  const selfApproved = publish("candidate-self-approval.json", publicRequest(value => { value.approvedRevision = publicHead; }));
  const refused = legacy(["revision", "--request", selfApproved]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /UNTRUSTED_CONTROL_SOURCE/);
});

test("the current unexecuted relevant source of this repository remains pending", () => {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  const request = publish("current-source-request.json", {
    schemaVersion: 1,
    kind: "relevant_revision_request",
    repository: "shared-internal-tools/ms-desk",
    ref: "refs/heads/v2-alpha",
    head: head.stdout.trim(),
    previousHeads: [],
    changedPaths: ["evals/offline/fixed-controller.mjs", "scripts/skill-evals.cjs", ".github/workflows/desk-mcp-tests.yml", "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md"],
    events: [{ eventId: "current-source", receivedAt: "2026-09-15T00:00:00Z", head: head.stdout.trim() }],
  });
  const report = JSON.parse(legacy(["revision", "--request", request]).stdout);
  assert.equal(report.relevance.relevant, true);
  assert.deepEqual(report.relevance.paths.map(entry => entry.category), ["evaluator_source", "evaluator_source", "workflow_control", "own_desk"]);
  assert.equal(report.status, "pending");
  assert.equal(report.green, false);
  assert.equal(report.grade, null);
  assert.deepEqual(report.results, []);
  assert.equal(report.reason, "NO_RESULT_RETURNED");
});

test("the public workflow reports relevant-revision status without carrying any credential", () => {
  const workflow = fs.readFileSync(path.join(repository, ".github/workflows/desk-mcp-tests.yml"), "utf8");
  const lines = workflow.split("\n");
  const start = lines.indexOf("  desk-mcp-tests:");
  const end = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/u.test(line));
  const job = lines.slice(start, end === -1 ? lines.length : end).join("\n");
  assert.match(job, /node scripts\/skill-evals\.cjs revision --request/);
  assert.match(job, /permissions:\n {6}contents: read/);
  assert.doesNotMatch(job, /secrets\./);
  assert.doesNotMatch(workflow, /\/Users\/|\.local\/state|private-reports/);
  for (const trigger of ["evals/offline/**", "evals/*.json", "AGENTIC-ENGINEERING-V2.md"]) {
    assert.equal(workflow.split(`- "${trigger}"`).length, 3, trigger);
  }
  // The single existing verified-pack upload stays last; the status step publishes no second artifact.
  assert.equal(job.split("uses: actions/upload-artifact@v4").length, 2);
});

// GitHub filter patterns are character-based: `*` matches any characters except `/`, `**` matches any characters
// including `/`. A segment-based approximation would wrongly let `**/package.json` cover a root manifest.
function triggerMatches(pattern, target) {
  const escape = (value) => value.replace(/[.+^${}()|[\]\\?]/gu, "\\$&");
  const expression = pattern.split("**").map((part) => escape(part).replace(/\*/gu, "[^/]*")).join(".*");
  return new RegExp(`^${expression}$`, "u").test(target);
}

function workflowPathFilters(workflow) {
  const lines = workflow.split("\n");
  const blocks = [];
  for (const [index, line] of lines.entries()) {
    if (line !== "    paths:") continue;
    const filters = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const match = lines[cursor].match(/^ {6}- "(.+)"$/u);
      if (!match) break;
      filters.push(match[1]);
    }
    blocks.push(filters);
  }
  return blocks;
}

function embeddedStatusGuard(workflow) {
  const lines = workflow.split("\n");
  const start = lines.findIndex(line => line.trim() === "- name: Report relevant-revision evaluation status");
  assert.notEqual(start, -1, "the workflow must report relevant-revision status");
  const open = lines.findIndex((line, index) => index > start && line.trim() === "node -e '");
  assert.notEqual(open, -1, "the status step must embed its refusal script");
  const close = lines.findIndex((line, index) => index > open && line.trim() === "'");
  assert.notEqual(close, -1, "the embedded refusal script must terminate");
  return lines.slice(open + 1, close).map(line => line.slice(12)).join("\n");
}

test("the public status step refuses a forbidden evaluation state before it publishes anything", () => {
  const workflow = fs.readFileSync(path.join(repository, ".github/workflows/desk-mcp-tests.yml"), "utf8");
  const guard = path.join(root, "workflow-status-guard.cjs");
  fs.writeFileSync(guard, `${embeddedStatusGuard(workflow)}\n`);
  const runGuard = (status, name) => {
    const cwd = path.join(root, `guard-${name}`);
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "revision-status.json"), bytes(status));
    const summary = path.join(cwd, "summary.md");
    const result = spawnSync(process.execPath, [guard], { cwd, encoding: "utf8", timeout: 15000, env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
    return { ...result, summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "" };
  };
  const pending = { schemaVersion: 1, kind: "relevant_revision_status", relevance: { relevant: true, categories: ["evaluator_source"], paths: [], trustedControlPaths: [] }, status: "pending", green: false, scored: false, grade: null, reason: "NO_RESULT_RETURNED" };
  const allowed = runGuard(pending, "pending");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /relevant=true categories=evaluator_source status=pending reason=NO_RESULT_RETURNED/);
  assert.match(allowed.summary, /## Relevant-revision evaluation status/);
  assert.match(allowed.summary, /"status": "pending"/);
  // Every forbidden public evaluation state must be refused before a single byte reaches a reporting surface.
  for (const [forged, name] of [
    [{ ...pending, status: "evaluated", green: true, scored: true, grade: { summary: "forged" } }, "evaluated"],
    [{ ...pending, green: true }, "green"],
    [{ ...pending, grade: { summary: "forged" } }, "graded"],
    [{ ...pending, scored: true }, "scored"],
    [{ ...pending, status: "evaluated" }, "status-only"],
  ]) {
    const refused = runGuard(forged, name);
    assert.notEqual(refused.status, 0, name);
    assert.equal(refused.stdout, "", `${name} must publish no log line`);
    assert.equal(refused.summary, "", `${name} must append no job summary`);
    assert.match(refused.stderr, /Public CI cannot publish a green or graded evaluation status/, name);
    assert.doesNotMatch(refused.stderr, /"green": true|forged/, `${name} must not echo the forbidden status`);
  }
});

test("every path the status routing calls relevant also starts the public workflow", () => {
  const workflow = fs.readFileSync(path.join(repository, ".github/workflows/desk-mcp-tests.yml"), "utf8");
  const blocks = workflowPathFilters(workflow);
  assert.equal(blocks.length, 2, "pull_request and push both declare path filters");
  const probes = [
    "AGENTIC-ENGINEERING-V2.md", "evals/offline/cases/v2-alpha-v1/dataset.json", "evals/engineering-v2-kernel.json",
    "evals/offline/checks.mjs", "evals/offline/fixed-controller.mjs", "evals/investigation-boundaries.json",
    "scripts/skill-evals.cjs", "scripts/test-skill-evals.cjs",
    ".github/workflows/desk-mcp-tests.yml", ".github/workflows/validate-skills.yml",
    "plugins/desk/mcp/src/index.js", "plugins/desk/mcp/package.json", "plugins/desk/mcp/package-lock.json", "upstream-sources.lock.json",
    "tools/example/package.json", "tools/example/package-lock.json",
    "package.json", "package-lock.json", "desk/package.json", "desk/tools/package-lock.json",
    "plugins/desk/principles.md", "plugins/desk/skills/start-task/SKILL.md", "skills/work-doer/SKILL.md",
    "worker/README.md", "manifest.json", "AGENTS.md", "CLAUDE.md",
  ];
  const request = publish("trigger-coverage-request.json", publicRequest(value => { value.changedPaths = probes; }));
  const report = JSON.parse(legacy(["revision", "--request", request]).stdout);
  const relevant = report.relevance.paths.filter(entry => entry.relevant).map(entry => entry.path);
  assert.deepEqual(relevant, probes, "every probe is a relevant category representative");
  for (const value of relevant) {
    for (const [index, filters] of blocks.entries()) {
      assert.ok(filters.some(pattern => triggerMatches(pattern, value)), `path filter block ${index} must start this workflow for ${value}`);
    }
  }
  // An unrelated own-desk note is neither relevant nor a reason to claim evaluation coverage.
  const unrelated = publish("trigger-unrelated-request.json", publicRequest(value => { value.changedPaths = ["desk/tasks/2026-09-15-notes.md", "desk/tools/notes.md"]; }));
  const unrelatedReport = JSON.parse(legacy(["revision", "--request", unrelated]).stdout);
  assert.equal(unrelatedReport.relevance.relevant, false);
  assert.equal(unrelatedReport.status, "not_applicable");
  assert.equal(triggerMatches("desk/**", "desk/tasks/2026-09-15-notes.md"), true);
  assert.equal(triggerMatches("evals/*.json", "evals/offline/checks.mjs"), false);
  assert.equal(triggerMatches("scripts/*.cjs", "scripts/skill-evals.cjs"), true);
  assert.equal(triggerMatches("package.json", "package.json"), true);
  assert.equal(triggerMatches("**/package.json", "desk/tools/package.json"), true);
  // A `**`-prefixed pattern still needs the separator, so the root manifest needs its own explicit trigger.
  assert.equal(triggerMatches("**/package.json", "package.json"), false);
  assert.equal(triggerMatches("evals/**", "evals/offline/cases/v2-alpha-v1/dataset.json"), true);
});
