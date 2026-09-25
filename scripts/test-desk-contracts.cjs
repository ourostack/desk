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
  requires(file, "orchestration scopes native review to the diff boundary on the channel", /requesting-code-review[\s\S]+diff boundary[\s\S]+candidate branch[\s\S]+head it reviewed[\s\S]+evidence/iu);
  contract("orchestration names no frozen candidate or frozen brief", () => {
    assert.doesNotMatch(text(file), /froz|freez/iu);
  });
  requires(file, "orchestration gathers every human judgment before go", /Align new work before go[\s\S]+every decision[\s\S]+entangled[\s\S]+one batch[\s\S]+recommendation/iu);
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

// The rules that `principles.md` used to hold each live in exactly one owner.
contract("principles.md is gone and nothing points at it", () => {
  assert.equal(fs.existsSync(path.join(root, "plugins/desk/principles.md")), false);
  const skillsRoot = path.join(root, "plugins/desk/skills");
  const offenders = [];
  for (const name of fs.readdirSync(skillsRoot)) {
    const file = path.join(skillsRoot, name, "SKILL.md");
    if (fs.existsSync(file) && /principles\.md|Invariant \d|Sub-invariant/u.test(fs.readFileSync(file, "utf8"))) offenders.push(name);
  }
  for (const file of ["plugins/desk/agents/worker.md", "plugins/desk/agents/worker.agent.md", "plugins/desk/agents/worker.toml", "plugins/desk/output-styles/worker.md"]) {
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

// Hard-wrapped Markdown prose in the skills this change touched. Skills that are fully unwrapped
// must stay that way; skills that still carry older wrapped prose must not mix a long (edited)
// line into a wrapped paragraph, which is how an edit inside a wrapped paragraph shows up.
function proseUnits(file) {
  const lines = text(file).split("\n");
  let start = 0;
  if (lines[0] === "---") start = lines.indexOf("---", 1) + 1;
  const units = [];
  let inCode = false;
  let unit = [];
  const flush = () => { if (unit.length > 0) units.push(unit); unit = []; };
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/u.test(line)) { inCode = !inCode; flush(); continue; }
    if (inCode) continue;
    if (/^\s*$|^\s*(?:#|\||>|<|---\s*$)/u.test(line)) { flush(); continue; }
    if (/^\s*(?:[-*+] |\d+\. )/u.test(line)) flush();
    unit.push({ number: index + 1, line });
  }
  flush();
  return units;
}
for (const file of [
  "plugins/desk/skills/cdp-headed-browser/SKILL.md",
  "plugins/desk/skills/content-routing/SKILL.md",
  "plugins/desk/skills/curator/SKILL.md",
  "plugins/desk/skills/evidence-discipline/SKILL.md",
  "plugins/desk/skills/friction-management/SKILL.md",
  "plugins/desk/skills/git-hygiene/SKILL.md",
  "plugins/desk/skills/lesson-capture/SKILL.md",
  "plugins/desk/skills/preflight-actions/SKILL.md",
  "plugins/desk/skills/repo-handling/SKILL.md",
  "plugins/desk/skills/session-resumption/SKILL.md",
  "plugins/desk/skills/using-desk/SKILL.md",
  "plugins/desk/skills/work-orchestration/SKILL.md",
  "plugins/plain-language/skills/plain-language/SKILL.md",
]) {
  contract(`${file} prose is not hard-wrapped`, () => {
    const wrapped = proseUnits(file).filter((unit) => unit.length > 1).map((unit) => unit[1].number);
    assert.deepEqual(wrapped, []);
  });
}
for (const file of [
  "plugins/desk/skills/interaction-style/SKILL.md",
  "plugins/desk/skills/operator-voice-comments/SKILL.md",
  "plugins/desk/skills/peer-pr-review/SKILL.md",
  "plugins/desk/skills/pr-feedback-on-own-pr/SKILL.md",
  "plugins/desk/skills/pr-review-interrogation/SKILL.md",
  "plugins/desk/skills/runtime-symptom-investigation/SKILL.md",
]) {
  contract(`${file} has no edited line inside a wrapped paragraph`, () => {
    const mixed = proseUnits(file).filter((unit) => unit.length > 1 && unit.some(({ line }) => line.length > 100)).map((unit) => unit[0].number);
    assert.deepEqual(mixed, []);
  });
}
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
