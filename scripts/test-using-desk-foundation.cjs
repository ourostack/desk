#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const skillPath = path.join(repoRoot, "plugins", "desk", "skills", "using-desk", "SKILL.md");
const maxCodexSkillDescriptionLength = 1024;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function listSkillFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSkillFiles(fullPath, out);
    } else if (entry.name === "SKILL.md") {
      out.push(fullPath);
    }
  }
  return out;
}

function frontmatterScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"));
  if (!match) {
    return null;
  }
  return match[1].trim().replace(/^['"]|['"]$/gu, "");
}

function section(markdown, title) {
  const heading = `## ${title}\n\n`;
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `using-desk must include the ${title} section`);
  const contentStart = start + heading.length;
  const nextLevelTwo = markdown.indexOf("\n## ", contentStart);
  const nextLevelOne = markdown.indexOf("\n# ", contentStart);
  const candidates = [nextLevelTwo, nextLevelOne].filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : markdown.length;
  return markdown.slice(contentStart, end).trim();
}

function assertSinglePhysicalLine(body, label) {
  assert.equal(body.split("\n").length, 1, `${label} prose must stay on one physical line`);
}

function assertSectionPhrases(body, label, phrases) {
  assertSinglePhysicalLine(body, label);
  for (const phrase of phrases) {
    assert.match(body, new RegExp(escapeRegExp(phrase), "iu"), `${label} must mention "${phrase}"`);
  }
}

function assertSectionConcepts(body, concepts) {
  assertSinglePhysicalLine(body, "using-desk section");
  for (const concept of concepts) {
    assert.match(body, concept);
  }
}

function main() {
  assert.ok(fs.existsSync(skillPath), `missing skill file: ${path.relative(repoRoot, skillPath)}`);

  const skill = read(skillPath);
  const frontmatterMatch = skill.match(/^---\n([\s\S]*?)\n---/u);
  assert.ok(frontmatterMatch, "using-desk skill must include YAML frontmatter");

  const frontmatter = frontmatterMatch[1];
  assert.equal(frontmatterScalar(frontmatter, "name"), "using-desk");

  const description = frontmatterScalar(frontmatter, "description");
  assert.ok(description, "using-desk skill must include a description");
  assert.ok(
    description.length <= maxCodexSkillDescriptionLength,
    `using-desk description exceeds ${maxCodexSkillDescriptionLength} characters`,
  );

  const usingDeskSkills = listSkillFiles(path.join(repoRoot, "plugins", "desk", "skills"))
    .filter((filePath) => /(^|\n)name:\s*["']?using-desk["']?\s*$/mu.test(read(filePath)));
  assert.equal(
    usingDeskSkills.length,
    1,
    `expected exactly one using-desk skill definition, found ${usingDeskSkills.length}`,
  );
  assert.equal(usingDeskSkills[0], skillPath, "using-desk must live at plugins/desk/skills/using-desk/SKILL.md");

  assertSectionConcepts(section(skill, "Human and agent"), [
    /human supplies intent.*authority.*endpoint/iu,
    /agent owns.*sequencing.*verification.*cleanup/iu,
  ]);

  assertSectionPhrases(section(skill, "Durable work and authority"), "using-desk Durable work and authority", [
    "one durable work identity",
    "Tasks, notes, evidence, and follow-on execution should converge",
    "Authority comes from the selected runtime and overlay surface",
    "provider-specific setup stays out of this foundation",
  ]);

  assertSectionPhrases(section(skill, "Durable context and attribution"), "using-desk Durable context and attribution", [
    "lives in the desk, a Git repository",
    "machine-local memory or config directory",
    "thin pointer to the desk",
    "Never add AI attribution",
    "`Co-Authored-By` trailers",
  ]);
  assertSectionConcepts(section(skill, "Delegation calibration"), [
    /underdelegat/iu,
    /overdelegat|overbroad/iu,
    /bounded help/iu,
    /does not expand.*authority/iu,
    /coach.*once.*continue/iu,
  ]);

  assertSectionConcepts(section(skill, "Source authority before work begins"), [
    /recorded source authority/iu,
    /moving branch/iu,
    /frozen candidate/iu,
  ]);

  assertSectionPhrases(
    section(skill, "Requirements that arrive during execution"),
    "using-desk Requirements that arrive during execution",
    [
      "same durable task",
      "governing spec",
      "numbered plan",
      "progress ledger",
      "dependencies",
      "sequencing",
      "authority",
      "tests",
      "review evidence",
      "invalidated evidence",
      "unaffected authorized work moving",
      "implementation and review gates",
      "must not silently absorb contradictory scope",
      "must not restart the whole task without cause",
      "must not return control merely because the plan changed",
    ],
  );

  assertSectionPhrases(section(skill, "Visual proof when it helps"), "using-desk Visual proof when it helps", [
    "working or doing logs",
    "intermediate milestones",
    "pull request opened, reviewed, or merged states",
    "consumer-visible",
    "rendered, installed, merged, rollout",
    "terminal success line",
    "Visual proof supplements rather than replaces",
    "system-of-record evidence, tests, logs, API/DB verification, or authority checks",
    "Capture only the relevant bounded view",
    "do not expose secrets or sensitive/private content",
    "strongest safe alternative",
    "Do not turn nonvisual terminal work into artificial screenshots",
  ]);

  assertSectionPhrases(section(skill, "Flow judgment"), "using-desk Flow judgment", [
    "waiting, repeated synchronization, avoidable rework, or churn",
    "delay, batching, freezing, or resequencing",
    "not maximum agent utilization",
    "verification, review, safety, authority, and real urgency controls intact",
  ]);

  assertSectionPhrases(section(skill, "Instruction coherence"), "using-desk Instruction coherence", [
    "must not be silently confused",
    "stable foundation",
    "adapters bridge into an engineering stack",
    "detailed procedures stay with the skills that actually run them",
  ]);

  assertSectionPhrases(section(skill, "The RFC is on demand"), "using-desk The RFC is on demand", [
    "plugins/desk/docs/agentic-engineering-v2-rfc.md",
    "does not automatically read the RFC",
    "on demand",
  ]);

  assertSectionPhrases(section(skill, "Child-agent boundary"), "using-desk Child-agent boundary", [
    "in-process children are not assumed to rerun startup hooks",
    "outcome",
    "scope",
    "authority",
    "source",
    "write set",
    "dependencies",
    "success evidence",
    "prohibited actions",
    "return contract",
    "no new authority",
    "no new durable task identity",
    "root retains final accountability",
  ]);

  assertSectionPhrases(section(skill, "What this skill does not own"), "using-desk What this skill does not own", [
    "does not own startup choreography, provider activation, approval mechanics, or detailed orchestration and lifecycle procedures",
    "`using-superpowers-with-desk` chooses the engineering entry path",
    "triggered skills keep their own operational clauses",
  ]);

  assert.doesNotMatch(
    skill,
    /git fetch origin|git pull origin main|git rev-list --count HEAD\.\.origin\/main|git worktree add/u,
    "using-desk must keep detailed git procedure in git-hygiene instead of duplicating it",
  );

  assert.doesNotMatch(
    skill,
    /(?<!not\s)\bonly\b[^.\n]{0,80}\b(final|terminal)[ -]?(delivery|state|stage)\b/iu,
    "using-desk must not regress to terminal-state-only visual proof guidance",
  );

  assert.doesNotMatch(skill, /\bADO\b|\bTeams\b|\bMicrosoft\b|\bPWF\b|submissionId|approvals_create/u);

  console.log("using-desk foundation contract passed.");
}

main();
