import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { bytes, diskRunSet, expectedFixture, methodFixture, planFixture } from "./helpers/run-set.mjs";
import { dataRoot, repository, workRoot } from "./helpers/paths.mjs";
import { jsonBytes, sha256 } from "../core.mjs";

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
  // A plan naming a dataset id this producer does not recognize is refused loudly as a typed, invalid-input
  // contract violation -- never a silent hold that a caller could mistake for the distinct, unrelated "native
  // prerequisites unmet" signal below.
  const unsupportedFilename = path.join(root, "unsupported-plan.json");
  fs.writeFileSync(unsupportedFilename, bytes(planFixture()));
  const unsupportedOutput = path.join(root, "must-not-exist-unsupported");
  const unsupported = run(["run", "--plan", unsupportedFilename, "--output", unsupportedOutput]);
  assert.equal(unsupported.status, 4, unsupported.stderr);
  assert.equal(JSON.parse(unsupported.stderr).code, "UNSUPPORTED_DATASET");
  assert.equal(fs.existsSync(unsupportedOutput), false);

  const dataset = JSON.parse(fs.readFileSync(path.join(dataRoot, "dataset.json")));
  const plan = planFixture();
  plan.dataset = { id: dataset.id, version: dataset.version, sha256: sha256(fs.readFileSync(path.join(dataRoot, "dataset.json"))) };
  plan.fixtureManifestSha256 = sha256(fs.readFileSync(path.join(dataRoot, "fixture-manifest.json")));
  plan.checkerManifestSha256 = sha256(fs.readFileSync(path.join(dataRoot, "check-expectations.json")));
  const expected = { schemaVersion: 1, cells: dataset.cases.flatMap(definition => ["gpt-6-astra", "claude-opus-5"].map((model, index) => {
    const cell = expectedFixture(plan, definition.mode === "deterministic").cells[0];
    cell.id = `${definition.id}-${index + 1}`;
    cell.caseId = definition.id;
    if (cell.executionKind === "deterministic") cell.repetition = index + 1;
    else { cell.subject.model = model; cell.judge.model = model; }
    return cell;
  })) };
  plan.expectedCells = { path: "expected-cells.json", sha256: sha256(jsonBytes(expected)) };
  const filename = path.join(root, "plan.json");
  fs.writeFileSync(path.join(root, "expected-cells.json"), jsonBytes(expected));
  fs.writeFileSync(filename, bytes(plan));
  // A genuinely dataset-bound plan reaches the producer's output-root authorization check, so its output must be a
  // real sibling root -- not nested under the plan's own input root, which that check correctly refuses.
  const output = path.join(workRoot("cli-consumer-native-output"), "must-not-exist");
  // No parent-owned T13 preflight reaches the shipping CLI route, so conditional admission still refuses -- for a
  // supported, correctly validated dataset this time, not for an unrecognized one.
  const held = run(["run", "--plan", filename, "--output", output]);
  assert.equal(held.status, 3, held.stderr);
  assert.equal(JSON.parse(held.stderr).status, "unavailable");
  assert.equal(JSON.parse(held.stderr).code, "NATIVE_QUALIFICATION_REQUIRED");
  // The denominator is frozen before any native prerequisite is attempted: a validated, dataset-bound plan's output
  // root is really published -- run-set.json, the frozen plan and expected cells -- with an honest unqualified
  // producer status, never silently withheld the way an unmapped dataset id's refusal withholds it above.
  assert.equal(fs.existsSync(output), true);
  const producerStatus = JSON.parse(fs.readFileSync(path.join(output, "producer-status.json")));
  assert.equal(producerStatus.status, "unavailable");
  assert.equal(producerStatus.reason, "native_producer_not_qualified");
  assert.equal(fs.existsSync(path.join(output, "run-set.json")), true);
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

test("the actual CLI refuses to compare runs across different dataset versions", () => {
  // Neither id is a registered alpha dataset, so this isolates the CLI's own cross-version refusal from the
  // separate, unrelated alpha-matrix structural validation `bundle()` runs for a registered dataset id.
  const left = diskRunSet(root, { id: "cross-version-left", withSeed: true, datasetId: "unrelated-dataset-a" });
  const right = diskRunSet(root, { id: "cross-version-right", status: "passed", withSeed: true, datasetId: "unrelated-dataset-b" });
  const result = run(["compare", "--left", left.filename, "--right", right.filename]);
  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "not_comparable");
  assert.equal(output.scored, false);
  assert.equal(output.compatibility.compatible, false);
  assert.equal(output.compatibility.reason, "DATASET_VERSION_MISMATCH");
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
    repository: "ourostack/desk",
    ref: "refs/heads/main",
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
    // Only the push trigger filters paths; every pull request runs the workflow so main's required "CI gate" check always reports.
    assert.equal(workflow.split(`- "${trigger}"`).length, 2, trigger);
  }
  // The single existing verified-pack upload stays last; the status step publishes no second artifact.
  assert.equal(job.split("uses: actions/upload-artifact@v4").length, 2);
});

// A bounded model of the GitHub path-filter syntax these filters actually use: whole-path anchoring from the
// repository root, `*` matching any characters except `/`, `**` matching any characters including `/`, and the
// `**/` prefix matching zero or more leading directory segments (documented: `**/README.md` matches `README.md`
// and `js/README.md`). It is deliberately NOT a complete reimplementation of every documented pattern feature —
// `?` (zero or one of the preceding character) and `!` negation are not modelled — and a maintained assertion
// below proves both workflow filter blocks use neither, so this bounded model is sufficient for them.
function triggerMatches(pattern, target) {
  const escape = (value) => value.replace(/[.+^${}()|[\]\\?]/gu, "\\$&");
  let expression = "";
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith("**/", index)) {
      expression += "(?:.*/)?";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      expression += ".*";
      index += 2;
    } else if (pattern[index] === "*") {
      expression += "[^/]*";
      index += 1;
    } else {
      expression += escape(pattern[index]);
      index += 1;
    }
  }
  return new RegExp(`^${expression}$`, "u").test(target);
}

// The set of characters the bounded matcher models: literals plus `*`/`**`. Anything else — `?`, `!`, `+`,
// bracket expressions and other metacharacters — would be escaped as a literal here while GitHub gives it special
// meaning, so such a pattern must be refused rather than silently mis-modelled.
const modelledPattern = (pattern) => /^[A-Za-z0-9._/*-]+$/u.test(pattern);

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
  assert.match(workflow, /^on:\n  pull_request:\n  push:\n/mu, "every pull request starts the workflow, so no path can miss it");
  assert.equal(blocks.length, 1, "only push declares path filters");
  const probes = [
    "AGENTIC-ENGINEERING-V2.md", "evals/offline/cases/v2-alpha-v1/dataset.json", "evals/engineering-v2-kernel.json",
    "evals/offline/checks.mjs", "evals/offline/fixed-controller.mjs", "evals/investigation-boundaries.json",
    "scripts/skill-evals.cjs", "scripts/test-skill-evals.cjs",
    ".github/workflows/desk-mcp-tests.yml", ".github/workflows/validate-skills.yml",
    "plugins/desk/mcp/src/index.js", "plugins/desk/mcp/package.json", "plugins/desk/mcp/package-lock.json", "upstream-sources.lock.json",
    "tools/example/package.json", "tools/example/package-lock.json",
    "package.json", "package-lock.json", "desk/package.json", "desk/tools/package-lock.json",
    "plugins/desk/skills/using-desk/SKILL.md", "plugins/desk/skills/start-task/SKILL.md", "skills/work-doer/SKILL.md",
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
  // Documented behavior: a `**/` prefix matches zero or more directory segments, so it covers the root manifest
  // too. The explicit root entries below are retained as harmless redundancy, not as the only root coverage.
  assert.equal(triggerMatches("**/package.json", "package.json"), true);
  assert.equal(triggerMatches("evals/**", "evals/offline/cases/v2-alpha-v1/dataset.json"), true);
  for (const [index, filters] of blocks.entries()) {
    assert.equal(new Set(filters).size, filters.length, `path filter block ${index} must be duplicate-free`);
    assert.ok(filters.includes("package.json") && filters.includes("package-lock.json"), `path filter block ${index} keeps its explicit root manifest entries`);
    assert.ok(filters.includes("**/package.json") && filters.includes("**/package-lock.json"), `path filter block ${index} keeps its recursive manifest entries`);
    // The bounded matcher models `*` and `**` only; these filters must therefore use no other wildcard feature.
    for (const pattern of filters) assert.ok(modelledPattern(pattern), `path filter ${pattern} stays inside the modelled syntax`);
  }
  // The syntax guard must refuse every feature the bounded matcher does not model, not only `?` and `!`.
  for (const unsupported of ["*.jsx?", "!README.md", "page.js+", "docs/[0-9]/*.md", "docs/{a,b}/*.md", "docs/(a|b).md", "docs/a^b.md", "docs/a$b.md", "docs\\a.md"]) {
    assert.equal(modelledPattern(unsupported), false, `${unsupported} is outside the modelled syntax`);
  }
  for (const supported of [".gitattributes", "evals/offline/**", "scripts/*.cjs", "**/package-lock.json", "AGENTIC-ENGINEERING-V2.md", "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md"]) {
    assert.equal(modelledPattern(supported), true, `${supported} is inside the modelled syntax`);
  }
});

// Every row below is quoted from GitHub's official "Patterns to match file paths" table in the workflow-syntax
// reference. The bounded matcher above must agree with the documented behavior for the syntax these filters use.
test("the maintained path-filter oracle agrees with GitHub's documented pattern examples", () => {
  for (const [pattern, target] of [
    // "A README.md file anywhere in the repository." -> README.md, js/README.md
    ["**/README.md", "README.md"],
    ["**/README.md", "js/README.md"],
    // "A file with a .md suffix anywhere in the docs directory." -> docs/README.md, docs/mona/hello-world.md
    ["docs/**/*.md", "docs/README.md"],
    ["docs/**/*.md", "docs/mona/hello-world.md"],
    ["docs/**/*.md", "docs/a/markdown/file.md"],
    // "Any files in a docs directory anywhere in the repository." -> docs/hello.md, dir/docs/my-file.txt
    ["**/docs/**", "docs/hello.md"],
    ["**/docs/**", "dir/docs/my-file.txt"],
    ["**/docs/**", "space/docs/plan/space.doc"],
    // "Any files in the docs directory and its subdirectories at the root of the repository."
    ["docs/**", "docs/README.md"],
    ["docs/**", "docs/mona/octocat.txt"],
    // "All files within the root of the docs directory only."
    ["docs/*", "docs/README.md"],
    // "Matches all .js files in the repository." -> index.js, js/index.js, src/js/app.js
    ["**.js", "index.js"],
    ["**.js", "js/index.js"],
    ["**.js", "src/js/app.js"],
    // "Any file in a folder with a src suffix anywhere in the repository."
    ["**/*src/**", "a/src/app.js"],
    ["**/*src/**", "my-src/code/js/app.js"],
    // "A file with the suffix -post.md anywhere in the repository."
    ["**/*-post.md", "my-post.md"],
    ["**/*-post.md", "path/their-post.md"],
    // The same documented zero-directory case this workflow relies on for root dependency manifests.
    ["**/package.json", "package.json"],
    ["**/package.json", "desk/tools/package.json"],
  ]) assert.equal(triggerMatches(pattern, target), true, `${pattern} must match ${target}`);

  for (const [pattern, target] of [
    // "The * wildcard matches any character, but does not match slash (/)."
    ["*.js", "js/index.js"],
    ["docs/*", "docs/mona/octocat.txt"],
    ["scripts/*.cjs", "scripts/nested/child.cjs"],
    ["evals/*.json", "evals/offline/checks.mjs"],
    // "Path patterns must match the whole path, and start from the repository's root."
    ["package.json", "desk/package.json"],
    ["evals/*.json", "vendor/evals/suite.json"],
    ["docs/**", "other/docs/README.md"],
  ]) assert.equal(triggerMatches(pattern, target), false, `${pattern} must not match ${target}`);
});
