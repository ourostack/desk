#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const fs = require("node:fs");

const checker = path.resolve(__dirname, "../plugins/desk/skills/pr-surface-hygiene/check-visual-proof.cjs");
const image = "![Parser fixture, not product proof](https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000543)";
const reason = "No visual change: Only the retry backoff calculation changes; no output or interface changes.";

function run(body, visualChange = "unknown", args = []) {
  return spawnSync(process.execPath, [checker, "--stdin", "--visual-change", visualChange, ...args], {
    input: body,
    encoding: "utf8",
  });
}

test("GivenMissingProof_WhenPreparing_RefusesPublication", () => {
  assert.equal(fs.existsSync(checker), true, "PR preparation needs an executable visual-proof gate");
  const result = run("## What\nAdjust the results page.");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inline image|No visual change/u);
});

for (const [name, body] of [
  ["markdown image", image],
  ["HTML image", '<img alt="Safe fixture" width="640" src="https://images.test/capture.png">'],
  ["reference image", "![Safe fixture][proof]\n\n[proof]: https://images.test/capture.png"],
  ["linked image", `[${image}](https://images.test/full.png)`],
]) {
  test(`Given${name}_WhenVisibleChange_AcceptsInlineProof`, () => {
    const result = run(body, "yes");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /inline image/iu);
  });
}

for (const [name, body] of [
  ["empty", ""],
  ["link only", "[Screenshot](https://images.test/capture.png)"],
  ["commented image", `<!-- ${image} -->`],
  ["fenced image", `\`\`\`md\n${image}\n\`\`\``],
  ["tilde fence", `~~~md\n${image}\n~~~`],
  ["indented code", `    ${image}`],
  ["inline code", `\`${image}\``],
  ["escaped image", `\\${image}`],
  ["relative image", "![Safe fixture](./capture.png)"],
  ["placeholder URL", "![Capture](https://example.com/screenshot.png)"],
  ["empty source", '<img alt="Capture" src="">'],
  ["lazy source only", '<img data-src="https://images.test/capture.png">'],
  ["source inside alt", '<img alt="example src=\'https://images.test/capture.png\'">'],
  ["escaped HTML", '\\<img src="https://images.test/capture.png">'],
  ["data URL", '<img src="data:image/png;base64,AAAA">'],
  ["missing reference", "![Safe fixture][missing]"],
  ["blank reason", "No visual change:"],
  ["placeholder reason", "No visual change: <reason>"],
  ["template reason", "No visual change: TODO describe why"],
  ["commented reason", `<!-- ${reason} -->`],
  ["fenced reason", `\`\`\`\n${reason}\n\`\`\``],
]) {
  test(`Given${name}_WhenChecking_RejectsMissingProof`, () => {
    const result = run(body);
    assert.equal(result.status, 1, result.stdout);
  });
}

test("GivenSpecificReason_WhenNonvisual_AcceptsExplanation", () => {
  const result = run(reason, "no");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reason.*review/iu);
});

test("GivenSpecificReason_WhenVisibleChange_RejectsBypass", () => {
  const result = run(reason, "yes");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /visible|visual change/iu);
});

test("GivenPrivacyReason_WhenVisibleChange_RejectsWithheldProof", () => {
  const result = run("No visual change: Screenshots withheld because they contain private messages.", "yes");
  assert.equal(result.status, 1, result.stdout);
});

test("GivenBodyEdited_WhenRechecked_DoesNotReuseEarlierSuccess", () => {
  assert.equal(run(image).status, 0);
  assert.equal(run("Removed proof").status, 1);
});

test("GivenInvalidInvocation_WhenChecking_FailsExplicitly", () => {
  for (const args of [["--unknown"], ["--visual-change", "maybe"], ["--body", "/missing/visual-proof-body.md"]]) {
    const result = spawnSync(process.execPath, [checker, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.notEqual(result.stderr.trim(), "");
  }
});

test("GivenMalformedEvent_WhenChecking_FailsExplicitly", () => {
  const result = spawnSync(process.execPath, [checker, "--event", __filename], { encoding: "utf8" });
  assert.equal(result.status, 2, "invalid JSON must fail, not pass as an empty PR");
});

for (const [file, status] of [["image.json", 0], ["null.json", 1], ["missing.json", 2]]) {
  test(`Given${file}_WhenCheckingEvent_ReturnsExpectedStatus`, () => {
    const result = spawnSync(process.execPath, [checker, "--event", path.join(__dirname, "../tests/fixtures/pr-visual-proof", file)], { encoding: "utf8" });
    assert.equal(result.status, status, result.stderr);
  });
}

test("GivenTemplateOnly_WhenCheckingBody_RejectsInstructionsAsProof", () => {
  const result = spawnSync(process.execPath, [checker, "--body", path.join(path.dirname(checker), "resources/pull-request-template.md")], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout);
});

for (const [file, classification, status] of [
  ["inline-proof.html", "yes", 0],
  ["nonvisual.md", "no", 0],
  ["nonvisual.md", "yes", 1],
]) {
  test(`Given${file}_WhenClassified${classification}_ChecksFixtureBody`, () => {
    const result = spawnSync(process.execPath, [checker, "--body", path.join(__dirname, "../tests/fixtures/pr-visual-proof", file), "--visual-change", classification], { encoding: "utf8" });
    assert.equal(result.status, status, result.stderr);
  });
}
