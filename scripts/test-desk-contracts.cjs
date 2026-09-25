#!/usr/bin/env node
"use strict";

// Content contracts for the skills and agent surfaces Desk owns. These checks
// moved here from the Work Suite contract script when Desk moved to its own
// repository: the Work Suite checks stayed with Work Suite, and the Desk checks
// keep running in this repository's CI.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const contractFailures = [];

function text(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function json(file) {
  return JSON.parse(text(file));
}

function contract(label, check) {
  try {
    check();
  } catch (error) {
    contractFailures.push(`${label}: ${error.message.split("\n", 1)[0]}`);
  }
}

function requires(file, label, pattern) {
  contract(label, () => assert.match(text(file), pattern));
}

function subsection(file, heading) {
  const body = text(file).split(`### ${heading}\n`, 2)[1];
  assert.ok(body, `${file} is missing subsection ${heading}`);
  return body.split(/\n#{2,3} /u, 1)[0];
}

// Work orchestration, the Superpowers seam and the task lifecycle.
requires(
  "plugins/desk/skills/work-orchestration/SKILL.md",
  "Desk alpha delegates engineering without repeating approval",
  /desk:superpowers-integration[\s\S]+existing task[\s\S]+prior approval without reopening/iu,
);
contract("Superpowers owns the engineering method", () => {
  assert.match(text("plugins/desk/skills/work-orchestration/SKILL.md"), /Superpowers owns discovery, planning, execution and verification/u);
});
requires(
  "plugins/desk/skills/work-orchestration/SKILL.md",
  "plans ship the smallest coherent usable milestones",
  /smallest coherent[\s\S]+usable milestone[\s\S]+real consumer/iu,
);
requires(
  "plugins/desk/skills/work-orchestration/SKILL.md",
  "later qualification does not block an independently usable slice",
  /qualification[\s\S]+continue[\s\S]+must not block[\s\S]+independently usable/iu,
);
requires(
  "plugins/desk/skills/using-superpowers-with-desk/SKILL.md",
  "the selected lifecycle delivers through incremental milestones",
  /incremental delivery[\s\S]+smallest coherent[\s\S]+working artifact[\s\S]+consumer/iu,
);
contract("a clear task can stay task-card-only", () => {
  assert.match(text("plugins/desk/skills/task-lifecycle/SKILL.md"), /clear task can remain task-card-only/u);
});
contract("done names the delivery evidence", () => {
  assert.match(text("plugins/desk/skills/task-lifecycle/SKILL.md"), /release\/install, consuming-surface smoke, resource dispositions and durable state/u);
});
contract("the lifecycle has no operator planning-doc approval gate", () => {
  assert.doesNotMatch(text("plugins/desk/skills/task-lifecycle/SKILL.md"), /Operator approves the planning doc/u);
});
contract("start-task hands off through the Superpowers seam", () => {
  assert.match(text("plugins/desk/skills/start-task/SKILL.md"), /Hand off through `desk:using-superpowers-with-desk`/u);
});
contract("session resumption moves clear work straight to processing", () => {
  assert.match(text("plugins/desk/skills/session-resumption/SKILL.md"), /transition clear work directly to `processing`/u);
});

// Git hygiene, runtime investigation, curation and friction.
contract("git hygiene description names ref changes, failures and proof reuse", () => {
  assert.match(
    text("plugins/desk/skills/git-hygiene/SKILL.md").split("---", 3)[1],
    /after every ref change[\s\S]+required check fails[\s\S]+validation proof may be reused/iu,
  );
});
contract("git hygiene attributes failures only after they occur", () => {
  assert.match(
    subsection("plugins/desk/skills/git-hygiene/SKILL.md", "Attribute failures after they happen"),
    /do not establish[\s\S]+baseline preemptively[\s\S]+check fails[\s\S]+may be\s+pre-existing[\s\S]+target CI[\s\S]+exact target SHA[\s\S]+same command[\s\S]+clean merge-base worktree[\s\S]+recorded[\s\S]+reproducible baseline[\s\S]+commit[\s\S]+unknown remains failed/iu,
  );
});
contract("git hygiene reuses proof only while its inputs match", () => {
  assert.match(
    subsection("plugins/desk/skills/git-hygiene/SKILL.md", "Reuse proof only while inputs match"),
    /reuse[\s\S]+only while[\s\S]+source\/diff\s+fingerprint[\s\S]+exact command and selection[\s\S]+dependency and[\s\S]+configuration fingerprint[\s\S]+environment all match[\s\S]+input\s+changed[\s\S]+rerun/iu,
  );
});
contract("git hygiene defers expensive gates to the final exact SHA", () => {
  const body = subsection("plugins/desk/skills/git-hygiene/SKILL.md", "Final-candidate expensive gates");
  assert.match(
    body,
    /coverage[\s\S]+fully instrumented builds[\s\S]+exception[\s\S]+routine every-push[\s\S]+targeted build[\s\S]+test[\s\S]+formatter/iu,
  );
  assert.match(
    body,
    /after the last[\s\S]+source[\s\S]+configuration[\s\S]+dependency mutation[\s\S]+exact candidate SHA[\s\S]+before final delivery/iu,
  );
  assert.match(
    body,
    /SHA[\s\S]+relevant input[\s\S]+changes[\s\S]+invalidate[\s\S]+rerun[\s\S]+not waived/iu,
  );
});
contract("git hygiene rechecks executable repository configuration after ref changes", () => {
  const body = subsection("plugins/desk/skills/git-hygiene/SKILL.md", "Folder trust is path trust, not revision trust");
  assert.match(
    body,
    /after every ref change[\s\S]+inspect[\s\S]+repository-owned\s+executable[\s\S]+before[\s\S]+(?:load|run)/iu,
  );
  assert.match(
    body,
    /command-bearing file[\s\S]+diff it against[\s\S]+protected base[\s\S]+explicit approval[\s\S]+before executing/iu,
  );
});
contract("runtime investigation proves causality and removes diagnostic changes", () => {
  assert.match(
    subsection("plugins/desk/skills/runtime-symptom-investigation/SKILL.md", "Prove the cause before changing behavior"),
    /do not change product behavior[\s\S]+counterfactual[\s\S]+symptom[\s\S]+record every temporary diagnostic change[\s\S]+before handback[\s\S]+reverse only that diagnostic delta[\s\S]+verify[\s\S]+absent[\s\S]+preserve unrelated concurrent changes[\s\S]+fingerprint is evidence, not ownership[\s\S]+never[\s\S]+concurrent user or tool change/iu,
  );
});
requires(
  "plugins/desk/skills/curator/SKILL.md",
  "curator triages existing rules before encoding",
  /already have covered[\s\S]+loading[\s\S]+placement[\s\S]+enforcement[\s\S]+regression evidence[\s\S]+instead of writing the rule twice/iu,
);
requires(
  "plugins/desk/skills/curator/SKILL.md",
  "curator consolidates governing rules before adding prose",
  /conflict[\s\S]+consolidate[\s\S]+one owner[\s\S]+buried[\s\S]+cut or simplify[\s\S]+before adding[\s\S]+root cause/iu,
);
requires(
  "plugins/desk/skills/friction-management/SKILL.md",
  "friction captures question-shaped workflow failures",
  /operator asks why[\s\S]+omitted[\s\S]+diverged[\s\S]+unexpected[\s\S]+rule already exists[\s\S]+loaded[\s\S]+verified cause[\s\S]+existing rules did not prevent/iu,
);

for (const file of [
  "plugins/desk/skills/work-orchestration/SKILL.md",
]) {
  requires(file, "orchestration checks authority before mutation", /before[\s\S]{0,100}(branch|worktree|source edit)[\s\S]{0,140}(authority|contribution path)|(?:authority|contribution path)[\s\S]{0,140}before[\s\S]{0,100}(branch|worktree|source edit)/iu);
  requires(file, "orchestration uses an explicit DAG", /explicit DAG/iu);
  requires(file, "orchestration rejects array-order inference", /repos\[\][\s\S]+never[\s\S]+(?:order|dependency)/iu);
  requires(file, "orchestration rejects invalid dependency graphs", /cycle[\s\S]+unknown dependenc[\s\S]+failed predecessor/iu);
  requires(file, "orchestration coordinates shared version files", /shared[\s\S]+version[\s\S]+serializ|version[\s\S]+conflict/iu);
  requires(file, "orchestration leaves task lifecycle to Desk", /Desk[\s\S]+task[\s\S]+iteration[\s\S]+state/iu);
  requires(file, "orchestration returns nested review to its parent", /nested[\s\S]+parent/iu);
  requires(file, "orchestration preserves explicit human approval", /needs-human-approval[\s\S]+hard exception/iu);
  requires(file, "orchestration scopes native review to a frozen diff boundary", /requesting-code-review[\s\S]+diff boundary[\s\S]+frozen candidate/iu);
  contract("orchestration never downgrades explicit human approval", () => {
    assert.doesNotMatch(text(file), /needs-human-approval[\s\S]{0,120}(?:otherwise )?map(?:s)? it to blocking `needs reviewer gate`/iu);
  });
}

// Desk CI and configuration.
contract("CI runs the skill evaluation contracts", () => {
  assert.match(
    text(".github/workflows/validate-skills.yml"),
    /name: Validate skill eval contracts[\s\S]+node scripts\/test-skill-evals\.cjs && node scripts\/skill-evals\.cjs validate/u,
  );
});

contract("CI runs these Desk content contracts", () => {
  assert.match(text(".github/workflows/validate-skills.yml"), /node scripts\/test-desk-contracts\.cjs/u);
});

contract("coverage exclusion list has no campaign additions", () => {
  assert.deepEqual(
    json("plugins/desk/mcp/config/coverage-gate.json").exclusions.map(({ path: file }) => file).sort(),
    ["scripts/validate-skills.cjs"],
  );
});

// Worker surfaces select Desk + Superpowers + Plain Language only.
for (const file of [
  "plugins/desk/agents/worker.md",
  "plugins/desk/agents/worker.agent.md",
  "plugins/desk/agents/worker.toml",
  "plugins/desk/output-styles/worker.md",
]) {
  contract(`${file} carries no Ponytail or retired Work Suite instruction`, () => {
    const body = text(file);
    // Standalone Desk selects Desk + Superpowers + Plain Language only, so no worker
    // surface may carry an active Ponytail instruction or declare it as a dependency.
    assert.doesNotMatch(body, /Ponytail coding/u);
    assert.doesNotMatch(body, /ponytail-upstream/u);
    assert.doesNotMatch(body, /four-phase doing skills|Phase 1.4 dispatch|strict TDD|after signoff/iu);
    assert.doesNotMatch(body, /proof proportional to risk/iu);
  });
}

// Preview feedback privacy and identity.
contract("preview feedback requires explicit capture and confirmed sharing", () => {
  const skill = text("plugins/desk/skills/preview-feedback/SKILL.md");
  for (const required of ["explicit capture", "exact excerpt", "exact destination", "confirmation", "tombstone", "_meta/preview-feedback.md"]) {
    assert.ok(skill.includes(required), `missing preview-feedback boundary: ${required}`);
  }
  // The private feedback API is retired: the skill must say so rather than
  // sending the agent looking for a tool that no longer exists, and must not
  // offer preserved private records as material to publish.
  assert.match(skill, /There is no `desk_feedback` tool in this build/u);
  assert.match(skill, /Never fall back/u);
  assert.match(skill, /Do not migrate, copy, summarize, index, or quote it/u);
  // The destination must be unambiguous and must not collide with an
  // iteration's PR-review `feedback.md`.
  assert.match(skill, /It is not an iteration's `feedback\.md`/u);
});

contract("preview feedback entries are deterministically targetable in plain Markdown", () => {
  const skill = text("plugins/desk/skills/preview-feedback/SKILL.md");
  for (const required of [
    "`pf-YYYYMMDD-<alias>-NN`",
    "smallest number from `01` upward",
    "it never changes",
    "matches more than one entry",
    "Refuse rather than guess.",
    "Allocation is conflict-aware",
    "the unpublished entry does not keep it",
    "then `100`, `101` and onward",
  ]) {
    assert.ok(skill.includes(required), `missing preview-feedback identity rule: ${required}`);
  }
  // Amendment must require the ID *and* the current text, not one or the other.
  assert.match(skill, /needs the exact entry ID \*\*and\*\* the participant's confirmation of the excerpt currently in the file/u);

  // Two entries, one alias, one date — the case that made a bare
  // date/alias heading ambiguous. Each must be reachable on its own, and an
  // amendment must keep the ID it was reached by.
  const entryHeading = /^## (pf-\d{8}-[a-z0-9][a-z0-9-]*-\d{2,}) — (\d{4}-\d{2}-\d{2}) — ([a-z0-9][a-z0-9-]*)$/mu;
  const file = [
    "# Preview feedback",
    "",
    "## pf-20260914-ari-01 — 2026-09-14 — ari",
    "Preview: 3.2.0-alpha.3",
    "",
    "The agent asked for go at the right point.",
    "",
    "## pf-20260914-ari-02 — 2026-09-14 — ari",
    "",
    "It repeated the same design choice three times.",
    "",
  ].join("\n");

  const entries = file.split(/\n(?=## )/u).filter((block) => entryHeading.test(block));
  const ids = entries.map((block) => block.match(entryHeading)[1]);
  assert.deepEqual(ids, ["pf-20260914-ari-01", "pf-20260914-ari-02"]);
  assert.equal(new Set(ids).size, ids.length, "same-day entries from one alias must not share an ID");

  const select = (id, blocks = entries) => blocks.filter((block) => block.startsWith(`## ${id} `));
  for (const id of ids) {
    assert.equal(select(id).length, 1, `${id} must resolve to exactly one entry`);
  }
  assert.equal(select("pf-20260914-ari-03").length, 0, "an unknown ID must resolve to nothing, not to a neighbour");

  // The documented sequence rule: smallest unused two-digit number for that
  // date and alias, read back from the file rather than counted from memory.
  const sequenceOf = (id) => id.slice(id.lastIndexOf("-") + 1);
  const nextSequence = (date, alias, blocks) => {
    const used = new Set(blocks
      .map((block) => block.match(entryHeading))
      .filter((match) => match && match[2] === date && match[3] === alias)
      .map((match) => sequenceOf(match[1])));
    for (let candidate = 1; ; candidate += 1) {
      const padded = String(candidate).padStart(2, "0");
      if (!used.has(padded)) return padded;
    }
  };
  assert.equal(nextSequence("2026-09-14", "ari", entries), "03");
  assert.equal(nextSequence("2026-09-15", "ari", entries), "01", "a new date restarts the sequence");
  assert.equal(nextSequence("2026-09-14", "rowan", entries), "01", "a different alias restarts the sequence");

  // The sequence widens past two digits instead of running out, so a
  // hundredth entry on one day still has an ID the convention allows.
  const saturated = Array.from({ length: 99 }, (_, index) => {
    const padded = String(index + 1).padStart(2, "0");
    return `## pf-20260914-ari-${padded} — 2026-09-14 — ari\n\nEntry ${padded}.\n`;
  });
  assert.equal(saturated.every((block) => entryHeading.test(block)), true);
  assert.equal(nextSequence("2026-09-14", "ari", saturated), "100");
  const hundredth = `## pf-20260914-ari-100 — 2026-09-14 — ari\n\nThe hundredth thing said that day.\n`;
  assert.equal(hundredth.match(entryHeading)[1], "pf-20260914-ari-100");
  assert.equal(select("pf-20260914-ari-100", [...saturated, hundredth]).length, 1);
  assert.equal(select("pf-20260914-ari-10", [...saturated, hundredth]).length, 1, "a widened ID must not be confused with a shorter one");
  assert.equal(nextSequence("2026-09-14", "ari", [...saturated, hundredth]), "101");

  // A losing writer renumbers its own unpublished draft; the entry that
  // actually landed keeps the ID it was published under.
  const landedElsewhere = `## pf-20260914-ari-03 — 2026-09-14 — ari\n\nMerged from another checkout.\n`;
  const refreshed = [...entries, landedElsewhere];
  const draftSequence = nextSequence("2026-09-14", "ari", entries);
  assert.equal(draftSequence, "03", "the draft was allocated against the stale file");
  assert.equal(
    select(`pf-20260914-ari-${draftSequence}`, refreshed).length,
    1,
    "the refreshed file already holds that ID, so the draft must not publish under it",
  );
  const retrySequence = nextSequence("2026-09-14", "ari", refreshed);
  assert.equal(retrySequence, "04");
  const retried = `## pf-20260914-ari-${retrySequence} — 2026-09-14 — ari\n\nThe draft, republished under a free ID.\n`;
  const published = [...refreshed, retried];
  const publishedIds = published.map((block) => block.match(entryHeading)[1]);
  assert.equal(new Set(publishedIds).size, publishedIds.length, "publication must not create a duplicate ID");
  assert.deepEqual(publishedIds, [
    "pf-20260914-ari-01",
    "pf-20260914-ari-02",
    "pf-20260914-ari-03",
    "pf-20260914-ari-04",
  ]);
  assert.match(select("pf-20260914-ari-03", published)[0], /Merged from another checkout/u, "the landed entry keeps its ID and its words");

  // Correcting the first and withdrawing the second leaves both IDs intact and
  // still individually addressable.
  const amended = [
    entries[0].replace(
      "The agent asked for go at the right point.",
      "The agent asked for go at the right point.\n\nCorrected 2026-09-15: tightened the wording.",
    ),
    `## ${ids[1]} — 2026-09-14 — ari\n\nWithdrawn 2026-09-15 by ari: said in the wrong place.\n`,
  ];
  assert.deepEqual(amended.map((block) => block.match(entryHeading)[1]), ids);
  assert.equal(select(ids[0], amended).length, 1);
  assert.equal(select(ids[1], amended).length, 1);
  assert.match(select(ids[0], amended)[0], /Corrected 2026-09-15/u);
  assert.match(select(ids[1], amended)[0], /Withdrawn 2026-09-15 by ari/u);
  assert.doesNotMatch(select(ids[1], amended)[0], /It repeated the same design choice/u);
});

assert.equal(
  contractFailures.length,
  0,
  `Desk content contracts failed:\n${contractFailures.join("\n")}`,
);

console.log("Desk content contracts passed.");
