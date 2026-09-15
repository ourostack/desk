#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const schemaVersion = 1;
const polarities = new Set(["must", "must_not"]);
const evidenceTypes = new Set(["response", "tool_call", "file", "git", "state", "timing"]);

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (!hasText(value)) fail(`${label} must be a non-empty string`);
    if (seen.has(value)) fail(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function normalizeSource(content) {
  return content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
}

function contractFingerprint(suite) {
  return crypto.createHash("sha256").update(JSON.stringify(suite)).digest("hex");
}

function utcTimestamp(value, field) {
  const match = hasText(value) && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u);
  if (!match) fail(`result receipt run.${field} must be a valid UTC ISO timestamp`);
  const [, year, month, day, hour, minute, second, fraction = "0"] = match;
  const parts = [year, month, day, hour, minute, second, fraction.padEnd(3, "0")].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], parts[6]);
  if ([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()].some((part, index) => part !== parts[index])) {
    fail(`result receipt run.${field} must be a valid UTC ISO timestamp`);
  }
  return date.getTime();
}

function escapes(root, target) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function sourceFile(repoRoot, source) {
  if (!hasText(source) || path.isAbsolute(source)) fail(`source path must be repo-relative: ${source}`);
  const root = fs.realpathSync(repoRoot);
  const candidate = path.resolve(root, source);
  if (escapes(root, candidate)) fail(`source path escapes repo root: ${source}`);
  if (!fs.existsSync(candidate)) fail(`missing source: ${source}`);
  const resolved = fs.realpathSync(candidate);
  if (escapes(root, resolved)) fail(`source path resolves outside repo root: ${source}`);
  if (!fs.statSync(resolved).isFile()) fail(`missing source: ${source}`);
  return resolved;
}

function sourceFingerprint(sources, repoRoot = process.cwd()) {
  if (!Array.isArray(sources) || sources.length === 0) fail("sources must be a non-empty array");
  unique(sources, "source path");
  const entries = sources.slice().sort().map((source) => {
    const file = sourceFile(repoRoot, source);
    const hash = crypto.createHash("sha256").update(normalizeSource(fs.readFileSync(file, "utf8"))).digest("hex");
    return `${source.replaceAll(path.sep, "/")}\n${hash}\n`;
  });
  return crypto.createHash("sha256").update(entries.join("")).digest("hex");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${file}: ${error.message}`);
  }
}

const revisionKinds = { request: "relevant_revision_request", controls: "trusted_evaluation_controls", status: "relevant_revision_status" };
const requestKeys = ["schemaVersion", "kind", "repository", "ref", "head", "previousHeads", "changedPaths", "events"];
const controlsKeys = ["schemaVersion", "kind", "source", "approvedRevision", "controls"];
// A candidate contributes repository, ref, exact head and public source bytes. Anything that would let it name its
// own grader, model, runtime, baseline, workflow auth, approval point or grade is refused rather than trusted.
const candidateControlKeys = new Set(["controls", "control", "fixture", "grader", "judge", "model", "reasoningEffort", "contextTier", "runtime", "baseline", "auth", "credentials", "secrets", "workflow", "approvedRevision", "grade", "green", "scored", "status"]);
const authReasons = new Set(["native_producer_not_qualified", "native_qualification_required", "auth_unavailable", "capacity_unavailable"]);
const gradedAttemptStatuses = new Set(["passed", "product_failure", "inconclusive"]);
const terminalDispositions = new Set(["AUTH_FAILURE", "RUNTIME_FAILURE", "CANCELLED", "HISTORY_GAP", "INVALID_GRADE", "MALFORMED_GRADE"]);
// Ordered: the first matching rule classifies the path. Own-desk Markdown is checked first so an unrelated desk note
// is never promoted by a later prefix, and the catch-all keeps every unclassified path explicitly not relevant.
const relevanceRules = [
  ["own_desk", false, (value) => value.startsWith("desk/")],
  ["alpha", true, (value) => value === "AGENTIC-ENGINEERING-V2.md" || value.startsWith("evals/offline/cases/") || value.startsWith("evals/engineering-v2-")],
  ["evaluator_source", true, (value) => value.startsWith("evals/") || value === "scripts/skill-evals.cjs" || value === "scripts/test-skill-evals.cjs"],
  ["workflow_control", true, (value) => value.startsWith(".github/workflows/")],
  ["runtime_source", true, (value) => value.startsWith("plugins/desk/mcp/") || value === "upstream-sources.lock.json" || value.endsWith("/package.json") || value.endsWith("/package-lock.json")],
  ["selected_source", true, (value) => value.startsWith("plugins/") || value.startsWith("skills/") || value.startsWith("worker/") || value === "manifest.json" || value === "AGENTS.md" || value === "CLAUDE.md"],
  ["unrelated", false, () => true],
];
const trustedControlPath = (value) => value.startsWith(".github/workflows/") || value.startsWith("evals/offline/cases/") || value === "scripts/skill-evals.cjs" || value === "evals/offline/fixed-controller.mjs";
const commitId = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const boundedText = (value, maximum) => hasText(value) && value.length <= maximum;
const repoRelativePath = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\\") && !value.includes("\0") && !value.startsWith("/") && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

function refuse(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  return `${JSON.stringify(value)}`;
}

function controlsFingerprint(controls) {
  return crypto.createHash("sha256").update(canonicalValue(controls)).digest("hex");
}

function exactly(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateRevisionRequest(request) {
  if (!isObject(request)) refuse("INVALID_REVISION_REQUEST", "a relevant-revision request must be an object of candidate identity fields");
  for (const key of Object.keys(request)) {
    if (candidateControlKeys.has(key)) refuse("UNTRUSTED_CONTROL_SOURCE", `candidate revision data cannot carry the trusted control field ${key}`);
  }
  if (!exactly(request, requestKeys) || request.schemaVersion !== schemaVersion || request.kind !== revisionKinds.request) {
    refuse("INVALID_REVISION_REQUEST", `a relevant-revision request requires exactly ${requestKeys.join(", ")}`);
  }
  if (!boundedText(request.repository, 1024) || !boundedText(request.ref, 1024) || !commitId(request.head)) {
    refuse("INVALID_REVISION_REQUEST", "a revision is keyed by repository, ref and one exact head");
  }
  if (!Array.isArray(request.previousHeads) || request.previousHeads.length > 64 || !request.previousHeads.every(commitId) || new Set(request.previousHeads).size !== request.previousHeads.length || request.previousHeads.includes(request.head)) {
    refuse("INVALID_REVISION_REQUEST", "previous heads must be unique earlier commits, never the current head");
  }
  if (!Array.isArray(request.changedPaths) || request.changedPaths.length > 4096) refuse("INVALID_REVISION_REQUEST", "changed paths must be a bounded array");
  for (const value of request.changedPaths) {
    if (!repoRelativePath(value)) refuse("INVALID_CHANGED_PATH", `a changed path must stay inside the public repository: ${JSON.stringify(value)}`);
  }
  if (!Array.isArray(request.events) || request.events.length > 512) refuse("INVALID_REVISION_REQUEST", "revision events must be a bounded array");
  for (const event of request.events) {
    if (!exactly(event, ["eventId", "receivedAt", "head"]) || !boundedText(event.eventId, 256) || !commitId(event.head) || !Number.isFinite(Date.parse(event.receivedAt))) {
      refuse("INVALID_REVISION_EVENT", "every revision event retains its delivery id, receipt time and observed head");
    }
  }
  return request;
}

function validateTrustedControls(value, candidate) {
  if (value === undefined || value === null) return null;
  if (!exactly(value, controlsKeys) || value.schemaVersion !== schemaVersion || value.kind !== revisionKinds.controls || !commitId(value.approvedRevision) || !isObject(value.controls)) {
    refuse("INVALID_TRUSTED_CONTROLS", `trusted controls require exactly ${controlsKeys.join(", ")} at an approved revision`);
  }
  if (value.source !== "trusted_controller") refuse("UNTRUSTED_CONTROL_SOURCE", "evaluation controls must come from the trusted controller, never from the candidate");
  if (value.approvedRevision === candidate.head || candidate.previousHeads.includes(value.approvedRevision)) {
    refuse("CANDIDATE_SELF_APPROVAL", "a candidate revision cannot be the approved revision that supplies its own trusted controls");
  }
  return value;
}

function classifyChangedPaths(changedPaths) {
  const paths = changedPaths.map((value) => {
    const [category, relevant] = relevanceRules.find(([, , matches]) => matches(value));
    return { path: value, category, relevant };
  });
  const categories = [...new Set(paths.filter((entry) => entry.relevant).map((entry) => entry.category))].sort();
  return { relevant: categories.length > 0, categories, paths, trustedControlPaths: changedPaths.filter(trustedControlPath) };
}

// Duplicate deliveries of one revision converge on a single run identity; no delivery record is dropped.
function reconcileEvents(candidate, revisionId) {
  const seen = new Set();
  let primary = null;
  return candidate.events.map((event) => {
    const current = event.head === candidate.head;
    let disposition = "foreign_head";
    let duplicateOf = null;
    if (seen.has(event.eventId)) {
      disposition = "redelivery";
      duplicateOf = event.eventId;
    } else if (current && primary === null) {
      disposition = "primary";
      primary = event.eventId;
    } else if (current) {
      disposition = "duplicate";
      duplicateOf = primary;
    } else if (candidate.previousHeads.includes(event.head)) {
      disposition = "superseded_head";
    }
    seen.add(event.eventId);
    return { ...event, disposition, duplicateOf, runIdentity: current ? revisionId : null };
  });
}

function reconcileResult({ value, candidate, trusted, fingerprint }) {
  if (!isObject(value) || value.schemaVersion !== schemaVersion) return { disposition: "MALFORMED_RESULT", revision: null };
  const published = value.revision;
  if (!isObject(published) || !hasText(published.repository) || !hasText(published.ref) || !commitId(published.head) || !isObject(published.controls)) {
    return { disposition: "MISSING_REVISION_BINDING", revision: null };
  }
  const observed = { repository: published.repository, ref: published.ref, head: published.head };
  if (published.repository !== candidate.repository) return { disposition: "REPOSITORY_MISMATCH", revision: observed };
  if (published.head !== candidate.head) return { disposition: candidate.previousHeads.includes(published.head) ? "PREVIOUS_HEAD" : "FOREIGN_HEAD", revision: observed };
  if (published.ref !== candidate.ref) return { disposition: "REF_MISMATCH", revision: observed };
  if (trusted === null) return { disposition: "TRUSTED_CONTROLS_UNAVAILABLE", revision: observed };
  if (controlsFingerprint(published.controls.baseline ?? null) !== controlsFingerprint(trusted.controls.baseline)) return { disposition: "BASELINE_CHANGED", revision: observed };
  if (controlsFingerprint(published.controls) !== fingerprint) return { disposition: "CONTROL_FINGERPRINT_MISMATCH", revision: observed };
  if (value.status !== "complete") return { disposition: authReasons.has(value.reason) ? "AUTH_FAILURE" : "RUNTIME_FAILURE", revision: observed };
  const history = value.attemptStatuses;
  if (!Array.isArray(history) || history.length !== value.attempts || value.attempts !== value.expectedCells || value.unstarted !== 0 || history.some((entry) => !isObject(entry) || !hasText(entry.status))) {
    return { disposition: "HISTORY_GAP", revision: observed };
  }
  if (history.some((entry) => entry.status === "cancelled")) return { disposition: "CANCELLED", revision: observed };
  if (history.some((entry) => !gradedAttemptStatuses.has(entry.status))) return { disposition: "RUNTIME_FAILURE", revision: observed };
  if (value.scored !== true || value.grade === null || value.grade === undefined) return { disposition: "INVALID_GRADE", revision: observed };
  if (!isObject(value.grade) || Object.keys(value.grade).length === 0) return { disposition: "MALFORMED_GRADE", revision: observed };
  return { disposition: "COMPATIBLE", revision: observed, grade: value.grade };
}

// Source-level status only: this reconciles a relevant revision against results that already returned. It never
// dispatches a run, calls a model or grades anything, so relevant current source stays pending until a compatible
// result for that exact head and those exact frozen controls is published back to it.
function revisionStatus({ request, trustedControls = null, results = [] }) {
  const candidate = validateRevisionRequest(request);
  const trusted = validateTrustedControls(trustedControls, candidate);
  if (!Array.isArray(results)) refuse("INVALID_REVISION_RESULTS", "published results must be an array");
  const relevance = classifyChangedPaths(candidate.changedPaths);
  const fingerprint = trusted === null ? null : controlsFingerprint(trusted.controls);
  const revisionId = crypto.createHash("sha256").update(canonicalValue([candidate.repository, candidate.ref, candidate.head, fingerprint])).digest("hex");
  const reconciled = results.map((value, index) => ({ index, ...reconcileResult({ value, candidate, trusted, fingerprint }) }));
  const compatible = reconciled.filter((entry) => entry.disposition === "COMPATIBLE");
  const terminal = reconciled.find((entry) => terminalDispositions.has(entry.disposition));
  let status = "pending";
  let reason = results.length === 0 ? "NO_RESULT_RETURNED" : "NO_COMPATIBLE_RESULT";
  let grade = null;
  if (!relevance.relevant) {
    status = "not_applicable";
    reason = "NO_RELEVANT_PATH_CHANGED";
  } else if (compatible.length > 1) {
    status = "failed";
    reason = "MULTIPLE_COMPATIBLE_RESULTS";
  } else if (compatible.length === 1) {
    status = "evaluated";
    reason = "COMPATIBLE_RESULT_RETURNED";
    grade = compatible[0].grade;
  } else if (terminal !== undefined) {
    status = "failed";
    reason = terminal.disposition;
  }
  return {
    schemaVersion,
    kind: revisionKinds.status,
    revision: { repository: candidate.repository, ref: candidate.ref, head: candidate.head, controlsFingerprint: fingerprint, revisionId },
    runIdentity: revisionId,
    trustedControls: { available: trusted !== null, approvedRevision: trusted === null ? null : trusted.approvedRevision, controlsFingerprint: fingerprint },
    relevance,
    events: reconcileEvents(candidate, revisionId),
    results: reconciled.map((entry) => ({ index: entry.index, disposition: entry.disposition, revision: entry.revision })),
    status,
    green: status === "evaluated",
    scored: status === "evaluated",
    grade,
    reason,
  };
}

function revisionOptions(args) {
  const values = { "--request": null, "--controls": null };
  const resultFiles = [];
  if (args.length === 0 || args.length % 2 !== 0) fail(usage());
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!hasText(value) || value.startsWith("--")) fail(usage());
    if (key === "--result") resultFiles.push(value);
    else if (!Object.hasOwn(values, key) || values[key] !== null) fail(usage());
    else values[key] = value;
  }
  if (values["--request"] === null) fail(usage());
  return { request: values["--request"], controls: values["--controls"], results: resultFiles };
}

function revisionCommand(args) {
  const options = revisionOptions(args);
  return revisionStatus({
    request: readJson(path.resolve(options.request)),
    trustedControls: options.controls === null ? null : readJson(path.resolve(options.controls)),
    results: options.results.map((filename) => readJson(path.resolve(filename))),
  });
}

function loadSuites(repoRoot) {
  const directory = path.join(repoRoot, "evals");
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) fail(`missing evals directory: ${directory}`);
  const files = fs.readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
  if (files.length === 0) fail("no eval suites found");
  return files.map((file) => ({ file: path.join(directory, file), suite: readJson(path.join(directory, file)) }));
}

function validateSuite(suite, repoRoot, label) {
  if (!isObject(suite)) fail(`${label}: suite must be an object`);
  if (suite.schemaVersion !== schemaVersion) fail(`${label}: schemaVersion must be ${schemaVersion}`);
  if (!hasText(suite.id)) fail(`${label}: suite id must be a non-empty string`);
  if (!hasText(suite.description)) fail(`${label}: suite description must be a non-empty string`);
  if (!Array.isArray(suite.sources) || suite.sources.length === 0) fail(`${label}: sources must be a non-empty array`);
  if (!/^[a-f0-9]{64}$/u.test(suite.reviewedSourceFingerprint)) fail(`${label}: reviewedSourceFingerprint must be a SHA-256 hex string`);
  if (!Array.isArray(suite.requirements) || suite.requirements.length === 0) fail(`${label}: requirements must be a non-empty array`);
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) fail(`${label}: cases must be a non-empty array`);

  const requirements = new Set();
  for (const requirement of suite.requirements) {
    if (!isObject(requirement) || !hasText(requirement.id) || !hasText(requirement.description)) {
      fail(`${label}: every requirement needs an id and description`);
    }
    if (requirements.has(requirement.id)) fail(`${label}: duplicate requirement id: ${requirement.id}`);
    requirements.add(requirement.id);
  }

  const caseIds = new Set();
  const checkIds = new Set();
  const covered = new Set();
  let checks = 0;
  for (const testCase of suite.cases) {
    if (!isObject(testCase) || !hasText(testCase.id) || !hasText(testCase.description) || !hasText(testCase.prompt) || !Array.isArray(testCase.checks)) {
      fail(`${label}: every case needs an id, description, prompt, and checks`);
    }
    if (caseIds.has(testCase.id)) fail(`${label}: duplicate case id: ${testCase.id}`);
    caseIds.add(testCase.id);
    let must = 0;
    let mustNot = 0;
    for (const check of testCase.checks) {
      if (!isObject(check) || !hasText(check.id) || !polarities.has(check.polarity) || !evidenceTypes.has(check.evidenceType) || !hasText(check.description) || !Array.isArray(check.covers) || check.covers.length === 0) {
        fail(`${label}: every check needs id, polarity, evidenceType, covers, and description`);
      }
      if (checkIds.has(check.id)) fail(`${label}: duplicate check id: ${check.id}`);
      checkIds.add(check.id);
      unique(check.covers, "covered requirement id");
      for (const requirement of check.covers) {
        if (!requirements.has(requirement)) fail(`${label}: check ${check.id} covers unknown requirement: ${requirement}`);
        covered.add(requirement);
      }
      if (check.polarity === "must") must += 1;
      if (check.polarity === "must_not") mustNot += 1;
      checks += 1;
    }
    if (must === 0 || mustNot === 0) fail(`${label}: case ${testCase.id} needs at least one must and one must_not check`);
  }
  for (const requirement of requirements) {
    if (!covered.has(requirement)) fail(`${label}: uncovered requirement: ${requirement}`);
  }

  const fingerprint = sourceFingerprint(suite.sources, repoRoot);
  if (fingerprint !== suite.reviewedSourceFingerprint) fail(`${label}: reviewedSourceFingerprint does not match current sources`);
  return {
    requirements: requirements.size,
    cases: caseIds.size,
    checks,
    requirementIds: [...requirements],
    caseIds: [...caseIds],
    checkIds: [...checkIds],
    fingerprint,
  };
}

function validateRepo(repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const suites = loadSuites(root);
  const suiteIds = new Set();
  const requirementIds = new Set();
  const caseIds = new Set();
  const checkIds = new Set();
  const totals = { suites: 0, requirements: 0, cases: 0, checks: 0, entries: [] };
  for (const entry of suites) {
    const result = validateSuite(entry.suite, root, path.relative(root, entry.file));
    if (suiteIds.has(entry.suite.id)) fail(`duplicate suite id: ${entry.suite.id}`);
    suiteIds.add(entry.suite.id);
    for (const [label, ids, seen] of [
      ["requirement", result.requirementIds, requirementIds],
      ["case", result.caseIds, caseIds],
      ["check", result.checkIds, checkIds],
    ]) {
      for (const id of ids) {
        if (seen.has(id)) fail(`duplicate ${label} id: ${id}`);
        seen.add(id);
      }
    }
    totals.suites += 1;
    totals.requirements += result.requirements;
    totals.cases += result.cases;
    totals.checks += result.checks;
    totals.entries.push({ ...entry, fingerprint: result.fingerprint });
  }
  return totals;
}

function verifyReceipt(resultFile, repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const corpus = validateRepo(root);
  const receipt = readJson(path.resolve(root, resultFile));
  if (!isObject(receipt) || receipt.schemaVersion !== schemaVersion || !hasText(receipt.suiteId) || !hasText(receipt.sourceFingerprint) || !hasText(receipt.contractFingerprint) || !Array.isArray(receipt.cases)) {
    fail("result receipt needs schemaVersion, suiteId, sourceFingerprint, contractFingerprint, and cases");
  }
  const entry = corpus.entries.find(({ suite }) => suite.id === receipt.suiteId);
  if (!entry) fail(`result receipt names unknown suite: ${receipt.suiteId}`);
  if (receipt.sourceFingerprint !== entry.fingerprint) fail("result receipt sourceFingerprint does not match current sources");
  if (receipt.contractFingerprint !== contractFingerprint(entry.suite)) fail("result receipt contractFingerprint does not match the current contract");
  if (!isObject(receipt.run)) fail("result receipt needs a run object");
  for (const field of ["actor", "model", "runtimeRevision"]) {
    if (!hasText(receipt.run[field])) fail(`result receipt run.${field} must be a non-empty string`);
  }
  const timestamps = ["startedAt", "completedAt"].map((field) => utcTimestamp(receipt.run[field], field));
  if (timestamps[1] < timestamps[0]) fail("result receipt run.completedAt must be at or after run.startedAt");

  const expectedCases = new Map(entry.suite.cases.map((testCase) => [testCase.id, testCase]));
  const resultCases = new Set();
  for (const caseResult of receipt.cases) {
    if (!isObject(caseResult) || !hasText(caseResult.id) || !Array.isArray(caseResult.checks)) fail("every result case needs an id and checks");
    if (resultCases.has(caseResult.id)) fail(`duplicate result case id: ${caseResult.id}`);
    resultCases.add(caseResult.id);
    const expectedCase = expectedCases.get(caseResult.id);
    if (!expectedCase) fail(`extra result case: ${caseResult.id}`);
    const expectedChecks = new Set(expectedCase.checks.map((check) => check.id));
    const resultChecks = new Set();
    for (const checkResult of caseResult.checks) {
      if (!isObject(checkResult) || !hasText(checkResult.id) || typeof checkResult.passed !== "boolean" || !hasText(checkResult.evidence)) {
        fail("every result check needs an id, boolean passed, and non-empty evidence");
      }
      if (resultChecks.has(checkResult.id)) fail(`duplicate result check id: ${checkResult.id}`);
      resultChecks.add(checkResult.id);
      if (!expectedChecks.has(checkResult.id)) fail(`extra result check: ${checkResult.id}`);
      if (!checkResult.passed) fail(`failed check: ${checkResult.id}`);
    }
    for (const checkId of expectedChecks) {
      if (!resultChecks.has(checkId)) fail(`missing check: ${caseResult.id}.${checkId}`);
    }
  }
  for (const caseId of expectedCases.keys()) {
    if (!resultCases.has(caseId)) fail(`missing result case: ${caseId}`);
  }
  return { suiteId: entry.suite.id, cases: expectedCases.size, checks: entry.suite.cases.reduce((total, testCase) => total + testCase.checks.length, 0) };
}

function usage() {
  return "usage: node scripts/skill-evals.cjs validate [repoRoot] | fingerprint <suite-file> [repoRoot] | verify <result-file> [repoRoot] | revision --request <request.json> [--controls <trusted-controls.json>] [--result <published-status.json>]";
}

function main(args) {
  const [command, first, second, extra] = args;
  if (!command) fail(usage());
  if (command === "revision") {
    console.log(JSON.stringify(revisionCommand(args.slice(1))));
    return;
  }
  if (extra) fail(usage());
  if (command === "validate" && !second) {
    const totals = validateRepo(first);
    console.log(`Validated ${totals.suites} suite(s), ${totals.requirements} requirement(s), ${totals.cases} case(s), ${totals.checks} check(s). behavior: UNVERIFIED - validation does not run or judge an agent.`);
    return;
  }
  if (command === "fingerprint" && first && !extra) {
    const root = path.resolve(second ?? process.cwd());
    const suite = readJson(path.resolve(root, first));
    console.log(JSON.stringify({
      sourceFingerprint: sourceFingerprint(suite.sources, root),
      contractFingerprint: contractFingerprint(suite),
    }));
    return;
  }
  if (command === "verify" && first && !extra) {
    const result = verifyReceipt(first, second);
    console.log(`Verified ${result.suiteId}: ${result.cases} case(s), ${result.checks} check(s); receipt is complete/current and evidence was not judged.`);
    return;
  }
  fail(usage());
}

if (require.main === module) {
  if (process.argv[2] === "offline") {
    const offline = require("node:url").pathToFileURL(path.join(__dirname, "..", "evals", "offline", "cli.mjs"));
    import(offline).then(module => module.main(process.argv.slice(3))).then(code => {
      if (!Number.isInteger(code) || code < 0 || code > 4) throw Object.assign(new Error("Offline entry must return an explicit exit status from zero through four"), { code: "INVALID_OFFLINE_EXIT", exitCode: 3 });
      process.exitCode = code;
    }).catch(reason => {
      const error = reason ?? { message: String(reason) };
      const exitCode = Number.isInteger(error.exitCode) && error.exitCode >= 1 && error.exitCode <= 4 ? error.exitCode : 3;
      console.error(JSON.stringify({ kind: "offline_error", status: error.status ?? (exitCode === 4 ? "invalid_input" : "infrastructure_failure"), code: error.code ?? "OFFLINE_FAILURE", message: String(error.message ?? error), artifacts: error.artifacts ?? null }));
      process.exitCode = exitCode;
    });
  } else {
    try {
      main(process.argv.slice(2));
    } catch (error) {
      console.error(`skill-evals: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { normalizeSource, contractFingerprint, sourceFingerprint, validateRepo, verifyReceipt, revisionStatus };
