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
  /desk:using-superpowers-with-desk[\s\S]+existing task[\s\S]+prior approval without reopening/iu,
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
  requires(file, "orchestration scopes native review to the diff boundary on the channel", /requesting-code-review[\s\S]+diff boundary[\s\S]+candidate branch[\s\S]+head it reviewed[\s\S]+evidence/iu);
  contract("orchestration names no frozen candidate or frozen brief", () => {
    assert.doesNotMatch(text(file), /froz|freez/iu);
  });
  requires(file, "orchestration gathers every human judgment before go", /Align new work before go[\s\S]+every decision[\s\S]+entangled[\s\S]+one batch[\s\S]+recommendation/iu);
  contract("orchestration never downgrades explicit human approval", () => {
    assert.doesNotMatch(text(file), /needs-human-approval[\s\S]{0,120}(?:otherwise )?map(?:s)? it to blocking `needs reviewer gate`/iu);
  });
}

// Reviewers and evaluators use the current candidate on the channel; a commit hash is evidence only. The one
// statement of that rule ("There is no frozen candidate") is the only frozen wording a skill may carry.
contract("no skill freezes a candidate, brief, source or review input", () => {
  const skillsDir = path.join(root, "plugins", "desk", "skills");
  const offenders = fs.readdirSync(skillsDir)
    .map((name) => `plugins/desk/skills/${name}/SKILL.md`)
    .filter((file) => fs.existsSync(path.join(root, file)))
    .filter((file) => /frozen[- ](?:candidate|brief|input|review|source|base|sha|ref|commit)|freeze the review/iu.test(text(file).replace(/there is no frozen candidate/giu, "")));
  assert.deepEqual(offenders, []);
});

// The worker bodies no longer carry an invariants block, so nothing may describe one; operator rules keep a documented home.
contract("no doc or skill describes the retired invariants block", () => {
  for (const file of ["plugins/desk/skills/lesson-capture/SKILL.md", "plugins/desk/docs/agent-files.md", "plugins/desk/README.md"]) {
    assert.doesNotMatch(text(file), /core invariants|skills\/invariants|skills, invariants/iu, file);
  }
});
contract("directory-structure documents where operator rules live", () => {
  const skill = text("plugins/desk/skills/directory-structure/SKILL.md");
  assert.match(skill, /^ {2}AGENTS\.md +# .*operator preferences/mu);
  assert.match(skill, /^ {4}operator-rules\.md +# /mu);
});

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

// The three worker bodies carry identity and context only; every rule has one owner elsewhere.
const workerBodies = [
  "plugins/desk/agents/worker.md",
  "plugins/desk/agents/worker.agent.md",
  "plugins/desk/agents/worker.toml",
];

// Each rule the bodies used to restate, and the owner that now holds it alone.
const ownedRules = [
  [/Core invariants|Operating invariants/u, "using-desk and the skills"],
  [/^## (?:My )?[Ss]kills$/mu, "the host's skill listing"],
  [/Selected engineering lifecycle|desk:superpowers-integration/u, "using-desk \"Engineering work\""],
  [/Prereqs first/u, "session-start"],
  [/Desk MCP health guard/u, "session-start"],
  [/One decision group per message/u, "using-desk \"Alignment, then ownership\""],
  [/Slugs are permanent/u, "nothing: the agent names from the outcome (start-task)"],
  [/tidy up my desk/iu, "interaction-style"],
  [/Cite every factual claim/u, "using-desk and evidence-discipline"],
  [/Own the stack/u, "using-desk"],
  [/Commit \+ push/u, "using-desk \"Durable context and attribution\""],
  [/Long-lived work, bounded processes/u, "session-resumption"],
  [/Delivery has an owner|cleanup_pending/u, "task-lifecycle"],
  [/Friction is about how worker operated|Mark friction items landed/u, "friction-management"],
  [/harness-local memory/u, "using-desk \"Durable context and attribution\""],
  [/announce parallel work/u, "interaction-style"],
  [/self-modify agent permissions/u, "using-desk \"Authority\" and preflight-actions"],
  [/Authorization follows verb/u, "using-desk \"Authority\""],
  [/Honor approved work/u, "using-superpowers-with-desk"],
  [/Ask only when blocked/iu, "using-desk and interaction-style"],
  [/Lead with action|no trailing offers/iu, "Plain Language and interaction-style"],
  [/Plain Language output/u, "Plain Language"],
  [/Primary sources before recommendations/u, "evidence-discipline"],
  [/Never hard-wrap/u, "Plain Language"],
  [/Fixtures or refusal/u, "evidence-discipline"],
  [/frozen/iu, "nothing: there is no frozen candidate"],
];

for (const file of workerBodies) {
  contract(`${file} carries identity and context only`, () => {
    const body = text(file);
    for (const [pattern, owner] of ownedRules) {
      assert.doesNotMatch(body, pattern, `restates a rule owned by ${owner}`);
    }
    for (const required of [
      "I'm **worker**",
      "the full `using-desk` foundation exactly once",
      "Do not duplicate it here; use `desk:session-start` for the authoritative workspace scan.",
      "`desk_status` reports",
      "## Operator preferences",
      "`$DESK/AGENTS.md`",
      "## Tell me what you want to work on",
      "## Overlays",
    ]) assert.ok(body.includes(required), `missing identity or context: ${required}`);
    assert.ok(Buffer.byteLength(body) <= 4096, `body is ${Buffer.byteLength(body)} bytes; identity and context fit in 4 KB`);
  });
}

// The Codex owned block adds activation text around the injected using-desk foundation; it restates no owned rule either.
for (const mode of ["global-personal", "project-local"]) {
  contract(`the Codex ${mode} owned block restates no owned rule`, () => {
    const foundation = text("plugins/desk/skills/using-desk/SKILL.md").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim();
    const block = text(`plugins/desk/mcp/__tests__/fixtures/activation/codex/${mode}/generated-instructions.md`).split("# BEGIN desk activation:")[1];
    assert.ok(block && block.includes(foundation), "the owned block injects the using-desk foundation");
    const owned = block.replace(foundation, "");
    for (const [pattern, owner] of ownedRules) {
      assert.doesNotMatch(owned, pattern, `restates a rule owned by ${owner}`);
    }
  });
}

contract("the three worker bodies share one identity and context text", () => {
  const shared = (body) => body.slice(body.indexOf("I'm **worker**")).split("\n'''", 1)[0].trim();
  const [claude, copilot, codex] = workerBodies.map((file) => shared(text(file)));
  assert.equal(copilot, claude, "worker.agent.md drifted from worker.md");
  assert.equal(codex, claude, "worker.toml drifted from worker.md");
});

// Worker surfaces select Desk + Superpowers + Plain Language only.
for (const file of workerBodies) {
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

// The rules that `principles.md` used to hold each live in exactly one owner.
contract("principles.md is gone and nothing points at it", () => {
  assert.equal(fs.existsSync(path.join(root, "plugins/desk/principles.md")), false);
  const skillsRoot = path.join(root, "plugins/desk/skills");
  const offenders = [];
  for (const name of fs.readdirSync(skillsRoot)) {
    const file = path.join(skillsRoot, name, "SKILL.md");
    if (fs.existsSync(file) && /principles\.md|Invariant \d|Sub-invariant/u.test(fs.readFileSync(file, "utf8"))) offenders.push(name);
  }
  for (const file of workerBodies) {
    if (/principles\.md/u.test(text(file))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
requires(
  "plugins/desk/skills/interaction-style/SKILL.md",
  "interaction-style lists the return-control anti-patterns",
  /phase-ticker[\s\S]+permission-seeking[\s\S]+one item per reply[\s\S]+"are we good\?"/iu,
);
requires(
  "plugins/desk/skills/interaction-style/SKILL.md",
  "interaction-style answers new input in words before editing",
  /Respond before editing[\s\S]+words[\s\S]+suggestion as a command[\s\S]+conflict[\s\S]+refinement/iu,
);
requires(
  "plugins/desk/skills/interaction-style/SKILL.md",
  "interaction-style names phantom limits and the only valid stops",
  /No phantom limits[\s\S]+already in the codebase[\s\S]+defer this as a follow-up[\s\S]+ship a WIP PR[\s\S]+context is getting deep[\s\S]+let me summarize progress and hand off[\s\S]+real blocker[\s\S]+all work (?:is )?complete[\s\S]+explicit stop/iu,
);
requires(
  "plugins/desk/skills/interaction-style/SKILL.md",
  "announced parallel work starts in the announcing message",
  /announce parallel work[\s\S]+same message[\s\S]+tool calls that start it/iu,
);
contract("interaction-style maps host commands to their Desk owners", () => {
  const body = subsection("plugins/desk/skills/interaction-style/SKILL.md", "Host commands that duplicate the desk");
  for (const row of ["store_memory", "/plan", "/tasks", "/review", "/autopilot", "/init"]) assert.ok(body.includes(row), row);
  assert.match(body, /desk:using-superpowers-with-desk/u);
  assert.match(body, /superpowers:requesting-code-review/u);
});
requires(
  "plugins/desk/skills/interaction-style/SKILL.md",
  "self-review goes to a reviewer, not the operator",
  /requesting-code-review[\s\S]{0,300}not (?:to )?the operator/iu,
);
contract("evidence-discipline triggers on any claim that depends on external or mutable facts", () => {
  const frontmatter = text("plugins/desk/skills/evidence-discipline/SKILL.md").split("---", 3)[1];
  assert.match(frontmatter, /recommendation or claim[\s\S]+external,\s+mutable\s+or\s+unverified\s+facts/iu);
  assert.match(frontmatter, /answer you have arrived at is\s+complex/iu);
  assert.match(frontmatter, /Not needed for a routine\s+status/iu);
  assert.doesNotMatch(frontmatter, /Invoke ONLY/u);
});
requires(
  "plugins/desk/skills/evidence-discipline/SKILL.md",
  "evidence-discipline owns primary sources before recommendations",
  /## Primary sources before recommendations[\s\S]+Verified fact[\s\S]+inference[\s\S]+Unknown[\s\S]+Decision[\s\S]+Do not hand back while material evidence remains readable/u,
);
requires(
  "plugins/desk/skills/evidence-discipline/SKILL.md",
  "evidence-discipline owns fixtures or refusal for estimates",
  /## Fixtures or refusal[\s\S]+cites them[\s\S]+strips the estimate[\s\S]+Inheritance does NOT excuse the estimate/u,
);
requires(
  "plugins/desk/skills/evidence-discipline/SKILL.md",
  "evidence-discipline owns evidence precedence by claim kind",
  /## Evidence precedence[\s\S]+desk[\s\S]+intent, approval[\s\S]+source systems?[\s\S]+mutable facts[\s\S]+session history[\s\S]+execution[\s\S]+never erases an approved decision/iu,
);
requires(
  "plugins/desk/skills/evidence-discipline/SKILL.md",
  "evidence-discipline owns answering the governing question",
  /## Answer the governing question[\s\S]+simplest[\s\S]+why[\s\S]+question that was actually asked[\s\S]+adjacent/iu,
);
requires(
  "plugins/desk/skills/session-resumption/SKILL.md",
  "session-resumption owns the protected-evidence boundary",
  /## Protected evidence[\s\S]+raw transcripts, credentials, private measurement(?: and|,) customer data[\s\S]+outside Git[\s\S]+approved private evidence location[\s\S]+only pointers and derived, non-sensitive summaries/iu,
);
contract("operator-voice-comments owns approval of anything sent in the operator's name", () => {
  const skill = text("plugins/desk/skills/operator-voice-comments/SKILL.md");
  const frontmatter = skill.split("---", 3)[1];
  assert.match(frontmatter, /sent or scheduled in the operator's name/iu);
  assert.match(frontmatter, /email[\s\S]+calendar/iu);
  assert.match(skill, /## Approval before anything is sent[\s\S]+exact audience and content[\s\S]+"go" on the work is not approval to send/iu);
});
contract("preflight-actions' ownership axis never waives send approval", () => {
  const skill = text("plugins/desk/skills/preflight-actions/SKILL.md");
  assert.match(skill, /ownership axis never waives send approval[\s\S]{0,400}`operator-voice-comments`/iu);
  assert.match(skill, /without another permission loop when the action is in the agent's own role and does not speak for the operator/iu);
  assert.match(text("plugins/desk/skills/operator-voice-comments/SKILL.md"), /does not speak for the operator[\s\S]{0,120}follows `preflight-actions`/iu);
});
contract("git-hygiene fetches only checkouts the task owns", () => {
  const skill = text("plugins/desk/skills/git-hygiene/SKILL.md");
  assert.match(skill, /fetch and pull steps in this skill apply only to checkouts the task owns/iu);
  assert.match(skill, /1\. In a checkout the task owns, run `git fetch` first/u);
  assert.doesNotMatch(skill, /"pull latest" is the authorization/iu);
});
contract("repo-handling and git-hygiene state the same clone rule word for word", () => {
  const rule = "A clone the task does not own is never mutated: no fetch, pull, checkout, switch, stash, reset or branch. Read it with `git show` on refs it already has, through the hosting service's source API, or from your own clone or worktree. The single exception: the operator's explicit instruction to update that specific clone authorizes that update, because authority follows the verb (`using-desk` \"Authority\").";
  for (const file of ["plugins/desk/skills/repo-handling/SKILL.md", "plugins/desk/skills/git-hygiene/SKILL.md"]) {
    assert.equal(text(file).split(rule).length - 1, 1, `${file} must state the clone rule exactly once`);
  }
});

// Hard-wrapped Markdown prose: every Desk and Crew skill, and Plain Language, keeps each paragraph and list item on
// one physical line (Plain Language: never hard-wrap authored prose). A new skill is covered without being listed.
// Blockquote paragraphs count as prose units too. These are not prose: YAML frontmatter, ``` and ~~~ fences, indented
// code (four columns past the enclosing list item's content, after a blank line), headings, tables (with or without
// a leading pipe), HTML blocks and comments, thematic breaks and explicit hard breaks (two trailing spaces or a
// backslash).
// Known false negatives, accepted because they are rare in skills: a wrapped line whose continuation starts with `#`,
// `<`, `|` or `N. ` ends the unit early; a blockquote's lazy continuation line (no `>`) starts a new unit; a setext
// heading's text line counts as prose. Indented code inside a list is recognized only relative to the most recent
// list item's content column, not a full CommonMark container model.
function proseUnits(file) {
  return proseUnitsOf(text(file));
}
function proseUnitsOf(markdown) {
  const lines = markdown.split("\n");
  let start = 0;
  if (lines[0] === "---") start = lines.indexOf("---", 1) + 1;
  const units = [];
  let fence = null;
  let block = null; // "code", "table", "html" or "comment" until the block ends
  let inQuote = false;
  let listIndent = 0; // content column of the most recent list item; 0 outside a list
  let previousBlank = true;
  let unit = [];
  const flush = () => { if (unit.length > 0) units.push(unit); unit = []; };
  const indentOf = (value) => value.match(/^ */u)[0].length;
  const delimiterRow = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/u;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].replace(/\t/gu, "    ");
    const blank = /^\s*$/u.test(line);
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      previousBlank = false;
      continue;
    }
    if (fenceMatch) { flush(); fence = fenceMatch[1]; previousBlank = false; continue; }
    if (block === "comment") {
      if (line.includes("-->")) block = null;
      previousBlank = false;
      continue;
    }
    if (block !== null) {
      if (blank) block = null;
      else if (block === "code" && indentOf(line) < listIndent + 4) block = null;
      else { previousBlank = false; continue; }
    }
    if (blank) { flush(); previousBlank = true; continue; }
    if (listIndent > 0 && previousBlank && indentOf(line) < listIndent && !/^\s*(?:[-*+] |\d+\. )/u.test(line)) listIndent = 0;
    if (previousBlank && indentOf(line) >= listIndent + 4) { flush(); block = "code"; previousBlank = false; continue; }
    const quote = /^\s*>+ ?(.*)$/u.exec(line);
    if (quote !== null && !inQuote) flush();
    if (quote === null && inQuote) flush();
    inQuote = quote !== null;
    const body = inQuote ? quote[1] : line;
    if (/^\s*$/u.test(body)) { flush(); previousBlank = true; continue; }
    previousBlank = false;
    if (/^\s{0,3}<!--/u.test(body)) { flush(); if (!body.includes("-->")) block = "comment"; continue; }
    if (/^\s{0,3}<\/?[A-Za-z]/u.test(body)) { flush(); block = "html"; continue; }
    if (index + 1 < lines.length && body.includes("|") && delimiterRow.test(lines[index + 1])) { flush(); block = "table"; continue; }
    if (/^\s*(?:#|\|)|^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|=+\s*)$/u.test(body)) { flush(); continue; }
    const listItem = /^(\s*(?:[-*+]|\d+\.) +)/u.exec(body);
    if (listItem) { flush(); listIndent = listItem[1].length; }
    unit.push({ number: index + 1, line: lines[index] });
    if (/(?: {2}|\\)$/u.test(lines[index])) flush();
  }
  flush();
  return units;
}
contract("the hard-wrap detector skips code, tables and HTML, and still catches a wrap", () => {
  const wrapped = (markdown) => proseUnitsOf(markdown).filter((unit) => unit.length > 1).map((unit) => unit[0].number);
  const notProse = {
    "tilde fence": "Intro.\n\n~~~\nfirst code line\nsecond code line\n~~~\n",
    "indented code": "Intro.\n\n    first code line\n    second code line\n",
    "indented code in a list item": "- item\n\n      first code line\n      second code line\n",
    "table without a leading pipe": "Name | Value\n--- | ---\nalpha | one\nbeta | two\n",
    "HTML block": "<details>\n<summary>More</summary>\nfirst html line\nsecond html line\n</details>\n",
    "HTML comment": "<!--\nfirst comment line\nsecond comment line\n-->\n",
    "thematic break under a paragraph": "One paragraph.\n***\nAnother paragraph.\n",
  };
  for (const [label, markdown] of Object.entries(notProse)) assert.deepEqual(wrapped(markdown), [], label);
  const prose = {
    "wrapped paragraph": "A paragraph that was\nwrapped at a column.\n",
    "wrapped list item": "- a list item that was\n  wrapped at a column\n",
    "wrapped blockquote": "> a quote that was\n> wrapped at a column\n",
    "wrapped paragraph after indented code": "Intro.\n\n    code\n\nA paragraph that was\nwrapped at a column.\n",
    "wrapped paragraph after a list": "- item\n\nA paragraph that was\nwrapped at a column.\n",
  };
  for (const [label, markdown] of Object.entries(prose)) assert.equal(wrapped(markdown).length, 1, label);
});
function skillFiles(plugin) {
  const dir = path.join(root, "plugins", plugin, "skills");
  return fs.readdirSync(dir)
    .map((name) => `plugins/${plugin}/skills/${name}/SKILL.md`)
    .filter((file) => fs.existsSync(path.join(root, file)));
}
const unwrappedSkills = [...skillFiles("desk"), ...skillFiles("crew"), "plugins/plain-language/skills/plain-language/SKILL.md"];
contract("the hard-wrap check covers every Desk and Crew skill", () => {
  assert.ok(skillFiles("desk").length >= 40, "expected the Desk skill set");
  assert.ok(skillFiles("crew").length >= 3, "expected the Crew skill set");
});
for (const file of unwrappedSkills) {
  contract(`${file} prose is not hard-wrapped`, () => {
    const wrapped = proseUnits(file).filter((unit) => unit.length > 1).map((unit) => unit[1].number);
    assert.deepEqual(wrapped, []);
  });
  // Joining a line that ended in a hyphenated word leaves "worker- driven"; a suspended hyphen ("file- or project-") is fine.
  contract(`${file} has no hyphen left over from unwrapping`, () => {
    const split = proseUnits(file).flat().filter(({ line }) => /[A-Za-z]- (?!and |or |to )[A-Za-z]/u.test(line)).map(({ number }) => number);
    assert.deepEqual(split, []);
  });
}
// Organization: the agent owns how work is filed, named and tidied (spec §6a). Each rule lives in one owner skill;
// using-desk carries the one-sentence summary.
const organizationSkills = [...skillFiles("desk"), ...skillFiles("crew")];
const skillsContaining = (pattern) => organizationSkills.filter((file) => pattern.test(text(file)));
contract("no skill tells the agent to propose a name or wait for naming confirmation", () => {
  const namingProposal = [
    /propos\w*[^.\n]{0,40}\bslugs?\b/iu,
    /slug[- ]permanence|slugs are permanent/iu,
    /Proposing new task/u,
    /durable naming/iu,
    /\b(?:slug|name)s?\b[^.\n]{0,40}\boperator[- ]confirm|\boperator[- ]confirm\w*[^.\n]{0,20}(?:at creation|\bslug|\bname)/iu,
    /wait for (?:the )?(?:operator|human)?[' s]*confirmation before creating/iu,
    /what should the slug be|unless you object/iu,
  ];
  const offenders = [];
  for (const file of [...organizationSkills, "plugins/desk/skills/work-orchestration/SKILL.md"]) {
    for (const pattern of namingProposal) if (pattern.test(text(file))) offenders.push(`${file} ${pattern}`);
  }
  assert.deepEqual(offenders, []);
});
contract("using-desk carries the organization sentence exactly once", () => {
  const sentence = "You own the desk's organization: file work where its scope fits, name things from the outcome, and when something could be better organized, tidy it and say so in one line rather than asking.";
  assert.equal(text("plugins/desk/skills/using-desk/SKILL.md").split(sentence).length - 1, 1);
});
contract("track-card-format owns the scope line and says it drives routing", () => {
  const skill = text("plugins/desk/skills/track-card-format/SKILL.md");
  assert.match(skill.split("```yaml", 2)[1].split("```", 1)[0], /^scope: "<what belongs>; not <what doesn't>"$/mu);
  assert.match(skill, /## Scope line[\s\S]+one line[\s\S]+240 characters[\s\S]+`track_create` requires it[\s\S]+`track_update`[\s\S]+`track_missing_scope`/u);
  assert.match(skill, /scope lines? (?:is|are) how new work is routed|routes? new work by (?:its|the) scope line/iu);
});
contract("start-task names from the outcome and routes by scope lines", () => {
  const skill = text("plugins/desk/skills/start-task/SKILL.md");
  assert.match(skill, /Name the task from the outcome[\s\S]+no proposal/iu);
  assert.match(skill, /Route by scope line[\s\S]+`scope:`[\s\S]+clearly fits[\s\S]+new track[\s\S]+`track_create`[\s\S]+scope line/iu);
  assert.match(skill, /follow-up, a re-review or a retry of the same outcome is a new iteration of the existing task/iu);
  assert.match(skill, /never (?:file work under|create) a track named after a person[\s\S]{0,80}catch-all/iu);
  assert.match(skill, /## Path B[\s\S]+announce[\s\S]+one line/iu);
});
contract("start-task reopens a finished task for another round of the same job", () => {
  const skill = text("plugins/desk/skills/start-task/SKILL.md");
  assert.match(skill, /`done` or archived[\s\S]{0,400}reopen[\s\S]{0,400}`processing`[\s\S]{0,200}why/iu);
  assert.match(skill, /`<task>\/_iterations\/<YYYY-MM-DD>-<slug>\/`/u);
  assert.match(text("plugins/desk/skills/task-lifecycle/SKILL.md"), /^\| `done` → `processing` \| NOTIFY \|[^\n]*reopen/imu);
});
contract("interaction-style and operator-voice-comments point at the one estimate rule", () => {
  for (const file of ["plugins/desk/skills/interaction-style/SKILL.md", "plugins/desk/skills/operator-voice-comments/SKILL.md"]) {
    assert.match(text(file), /`evidence-discipline` "Fixtures or refusal"/u, file);
  }
});
contract("directory-structure says what may sit where", () => {
  const skill = text("plugins/desk/skills/directory-structure/SKILL.md");
  const where = skill.split("## What may sit where\n", 2)[1].split("\n## ", 1)[0];
  assert.match(where, /everything else is loose/u);
  assert.match(where, /desk root[\s\S]+`desks\/`[\s\S]+`AGENTS\.md`, `README\.md`, `CLAUDE\.md`[\s\S]+dotfiles[\s\S]+track root[\s\S]+`track\.md`/u);
  assert.equal(skill.match(/everything else is loose/giu).length, 1, "state the loose rule once");
  assert.doesNotMatch(skill, /Nothing is loose/u, "\"Nothing is loose\" contradicts the allow-list it introduces");
  assert.doesNotMatch(skill, /confirm the destination/iu, "the agent decides where a file goes; it never asks");
  assert.match(skill, /decides the destination[\s\S]{0,300}one line/iu);
  assert.match(skill, /^ {6}_iterations\/ +# /mu, "the layout names where a task with no repositories keeps its iterations");
  assert.match(skill, /reports, status notes and handoffs belong in a task or iteration folder/iu);
  assert.match(skill, /`task_move`[\s\S]+`track_rename`/u);
  assert.match(skill, /`desk_doctor`[\s\S]{0,200}`loose_file`/u);
});
contract("interaction-style owns tidy-and-announce and its safety rules", () => {
  const skill = text("plugins/desk/skills/interaction-style/SKILL.md");
  const section = skill.split("## 2. Organization: tidy and announce\n", 2)[1].split("\n## ", 1)[0];
  assert.match(section, /"I'm going to tidy up my desk a bit: [^"]+ Say if you mind\."/u);
  assert.match(section, /proceed without waiting/iu);
  assert.match(section, /never[\s\S]{0,80}how (?:they|the human) would like it fixed/iu);
  assert.match(section, /Git[\s\S]{0,60}reversible/iu);
  assert.match(section, /never deletes? content/iu);
  assert.match(section, /own desk subtree[\s\S]{0,80}peer's crew desk is theirs/iu);
  assert.match(section, /explicit instruction not to write/iu);
  assert.match(section, /objects?[\s\S]{0,40}revert/iu);
});
contract("interaction-style owns the frontloading procedure", () => {
  const body = subsection("plugins/desk/skills/interaction-style/SKILL.md", "Frontload what you need from the human");
  for (const pattern of [/one batch/iu, /whole outcome/iu, /about to step away/iu, /access/iu, /settings only they can change/iu, /decisions that are theirs/iu, /reviews or approvals/iu, /task card/iu]) {
    assert.match(body, pattern);
  }
});
contract("peer-pr-review names the review from the PR's theme without a proposal", () => {
  const skill = text("plugins/desk/skills/peer-pr-review/SKILL.md");
  assert.match(skill, /\*\*Name the review from the PR's theme\.\*\*[\s\S]{0,400}no proposal/iu);
});
contract("task-lifecycle owns one job, one task", () => {
  assert.match(
    text("plugins/desk/skills/task-lifecycle/SKILL.md"),
    /## One job is one task[\s\S]+follow-up[\s\S]+re-review[\s\S]+retry[\s\S]+iteration of (?:that|the existing) task[\s\S]+`duplicate_job`/iu,
  );
});
contract("evidence-discipline owns the citation procedure and the estimate rule", () => {
  const skill = text("plugins/desk/skills/evidence-discipline/SKILL.md");
  const section = skill.split("## Cite every factual claim\n", 2)[1].split("\n## ", 1)[0];
  for (const pattern of [
    /inline link to its primary source/iu,
    /`file:line`[\s\S]+pull request[\s\S]+commit[\s\S]+CI run[\s\S]+issue[\s\S]+documentation URL[\s\S]+command with its output/iu,
    /Markdown file MUST have its inline links/u,
    /share a link/iu,
    /source column/iu,
    /inference or unverified/iu,
    /own actions[\s\S]+link to the artifact[\s\S]+before it has happened/iu,
    /estimate cites the historical data behind it or carries no number/iu,
    /pointer to its protected location/iu,
  ]) assert.match(section, pattern);
  assert.match(skill.split("---", 3)[1], /factual claim/iu);
});
contract("each organization and citation rule has one owner", () => {
  const owners = [
    [/tidy up my desk a bit/iu, ["plugins/desk/skills/interaction-style/SKILL.md"]],
    [/<what belongs>; not <what doesn't>/u, ["plugins/desk/skills/track-card-format/SKILL.md"]],
    [/everything else is loose/iu, ["plugins/desk/skills/directory-structure/SKILL.md"]],
    [/never deletes? content|never changes a task's `?status/iu, ["plugins/desk/skills/interaction-style/SKILL.md"]],
    [/strip (?:it|them) at composition time|strip the number|strips the estimate|drop the number|Inheritance does not excuse/iu, ["plugins/desk/skills/evidence-discipline/SKILL.md"]],
    [/^## One job is one task$/mu, ["plugins/desk/skills/task-lifecycle/SKILL.md"]],
    [/source column/iu, ["plugins/desk/skills/evidence-discipline/SKILL.md"]],
    [/^### Frontload what you need from the human$/mu, ["plugins/desk/skills/interaction-style/SKILL.md"]],
    [/^## Cite every factual claim$/mu, ["plugins/desk/skills/evidence-discipline/SKILL.md", "plugins/desk/skills/using-desk/SKILL.md"]],
    [/^## Own the stack$/mu, ["plugins/desk/skills/using-desk/SKILL.md"]],
  ];
  for (const [pattern, expected] of owners) assert.deepEqual(skillsContaining(pattern).sort(), [...expected].sort(), String(pattern));
});

contract("friction-management keeps its lead-in next to its list", () => {
  assert.match(text("plugins/desk/skills/friction-management/SKILL.md"), /rough edge:\n\n1\. decide the scope/u);
});
requires(
  "plugins/desk/skills/repo-handling/SKILL.md",
  "repo-handling keeps other people's repositories read-only",
  /## Other people's repositories[\s\S]+remote URL[\s\S]+read-only[\s\S]+checkout[\s\S]+established contribution path[\s\S]+never (?:create|clone)[\s\S]+without explicit/iu,
);
requires(
  "plugins/desk/skills/preflight-actions/SKILL.md",
  "preflight-actions owns requests to widen the agent's permissions",
  /## Widening the agent's permissions[\s\S]+guardrail[\s\S]+permissions screen[\s\S]+config snippet[\s\S]+operator (?:to )?apply[\s\S]+wait[\s\S]+never retry[\s\S]+denial[\s\S]+never (?:edit|change|modify) (?:your|its) own permissions/iu,
);
contract("preflight-actions triggers on permission-widening requests", () => {
  assert.match(text("plugins/desk/skills/preflight-actions/SKILL.md").split("---", 3)[1], /widen[\s\S]{0,60}permissions|stop (?:being )?prompt/iu);
});
requires(
  "plugins/desk/skills/curator/SKILL.md",
  "curator rejects deferrals dressed up as no-ops",
  /not enough data yet[\s\S]+wait and see[\s\S]+revisit next session/iu,
);
requires(
  "plugins/desk/skills/curator/SKILL.md",
  "curator encodes human gates as self-checks with named escalation",
  /### Encoding a human gate[\s\S]+name the gate and why[\s\S]+self-check[\s\S]+named escalation/iu,
);
requires(
  "plugins/desk/skills/content-routing/SKILL.md",
  "content-routing persists callable-back artifacts when drafted",
  /## Callable-back artifacts land when drafted[\s\S]+grep[\s\S]+no-write/iu,
);
contract("content-routing routes always-on rules to a foundation, not principles or bodies", () => {
  const skill = text("plugins/desk/skills/content-routing/SKILL.md");
  assert.match(skill, /always-on foundation/u);
  assert.match(skill, /`using-desk`/u);
});
requires(
  "plugins/desk/skills/lesson-capture/SKILL.md",
  "lesson-capture fixes the process shape behind a repeatedly broken rule",
  /keeps being broken[\s\S]+process/iu,
);
requires(
  "plugins/desk/skills/friction-management/SKILL.md",
  "friction-management logs what the operator teaches",
  /operator teaches[\s\S]+even offhand[\s\S]+no-write/iu,
);

assert.equal(
  contractFailures.length,
  0,
  `Desk content contracts failed:\n${contractFailures.join("\n")}`,
);

console.log("Desk content contracts passed.");
