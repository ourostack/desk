#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const pluginRoot = path.join(repoRoot, "plugins", "desk");
const skillPath = path.join(pluginRoot, "skills", "using-desk", "SKILL.md");
const installedRfcPath = path.join(pluginRoot, "docs", "agentic-engineering-v2-rfc.md");
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

// Run both startup hooks in a sandbox: a temporary HOME whose ~/desk fallback exists, and a crew-shaped
// workspace (`_meta/` plus `desks/`) standing in for an overlay's checkout. Nothing reads the operator's real
// configuration.
function withStartupSandbox(body) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "using-desk-startup-")));
  try {
    const home = path.join(scratch, "home");
    const fallback = path.join(home, "desk");
    const crew = path.join(scratch, "crew-checkout");
    const codeRepo = path.join(scratch, "code-repo");
    const solo = path.join(scratch, "solo-desk");
    for (const dir of [path.join(fallback, "_meta"), path.join(fallback, "_archive"), path.join(solo, "_meta"), path.join(solo, "_archive"), path.join(crew, "_meta"), path.join(crew, "desks"), codeRepo]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const malformed = path.join(scratch, "bad-binding.json");
    fs.writeFileSync(malformed, "{");
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot, PLUGIN_ROOT: pluginRoot };
    for (const key of ["DESK", "DESK_ACTIVATION_CONFIG", "CODEX_HOME", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR"]) {
      delete env[key];
    }
    body({ env, fallback, solo, crew, codeRepo, malformed });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function runClaudeHook({ env, cwd, projectDir, args = [] }) {
  const result = spawnSync("bash", [path.join(pluginRoot, "hooks", "session-start.sh"), ...args], {
    cwd,
    encoding: "utf8",
    env: projectDir ? { ...env, CLAUDE_PROJECT_DIR: projectDir } : env,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

function runCopilotHook({ env, cwd, sessionCwd }) {
  const result = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "copilot-session-start.cjs")], {
    cwd,
    encoding: "utf8",
    env,
    input: sessionCwd ? JSON.stringify({ timestamp: Date.now(), cwd: sessionCwd, source: "new" }) : "",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).additionalContext;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function startupLine(context) {
  const lines = context.split("\n").filter((line) => line.startsWith("Desk startup:"));
  assert.equal(lines.length, 1, "startup must carry exactly one Desk startup line");
  return lines[0];
}

function checkStartupHooks(skill) {
  const foundation = skill.trimEnd();
  withStartupSandbox(({ env, fallback, solo, crew, codeRepo, malformed }) => {
    const contexts = {
      claude: runClaudeHook({ env, cwd: codeRepo, projectDir: codeRepo }),
      copilot: runCopilotHook({ env, cwd: codeRepo, sessionCwd: codeRepo }),
    };
    for (const [host, context] of Object.entries(contexts)) {
      assert.equal(countOccurrences(context, foundation), 1, `${host} startup must inject the using-desk foundation exactly once`);
      const rfcLines = context.split("\n").filter((line) => line.startsWith("Desk RFC:"));
      assert.deepEqual(rfcLines, [`Desk RFC: ${installedRfcPath}`], `${host} startup must carry one Desk RFC line naming the installed RFC`);
      assert.ok(path.isAbsolute(installedRfcPath) && fs.existsSync(installedRfcPath), `${host} Desk RFC path must exist in the installed plugin`);
      assert.ok(context.indexOf("\nDesk RFC: ") >= context.indexOf(foundation) + foundation.length, `${host} Desk RFC line must follow the foundation`);
      // Outside a desk, the line names the home fallback honestly and defers to desk_status.
      const line = startupLine(context);
      assert.match(line, new RegExp(`\\$DESK is ${escapeRegExp(fallback)} \\(a home-folder fallback\\)`, "u"), `${host} must say the root came from a home-folder fallback`);
      assert.match(line, /desk_status reports the root Desk actually bound/u, `${host} must defer to desk_status for the bound root`);
      assert.match(line, /desk:session-start.*authoritative workspace scan/u);
    }

    // Overlay case on Claude: the Desk server also receives CLAUDE_PROJECT_DIR, so the crew-shaped project folder is
    // the root it binds, and the line names it.
    const claudeOverlay = startupLine(runClaudeHook({ env, cwd: crew, projectDir: crew }));
    assert.match(claudeOverlay, new RegExp(`\\$DESK is ${escapeRegExp(crew)} \\(this session's project folder is a desk\\)`, "u"), "claude must name the desk-shaped project folder");
    assert.ok(!claudeOverlay.includes(fallback), "claude must not name the home fallback when the project folder is a desk");

    // Overlay case on Copilot: only an overlay launcher binds the session folder; plain Desk binds the fallback. The
    // line names both and never asserts a single root the server may not use.
    const copilotOverlay = {
      "copilot (session folder from hook input)": runCopilotHook({ env, cwd: codeRepo, sessionCwd: crew }),
      "copilot (session folder from process cwd)": runCopilotHook({ env, cwd: crew }),
      "copilot (both)": runCopilotHook({ env, cwd: crew, sessionCwd: crew }),
    };
    for (const [host, context] of Object.entries(copilotOverlay)) {
      const line = startupLine(context);
      assert.ok(line.startsWith(`Desk startup: this session's folder ${crew} is a desk, but Desk without an overlay binds ${fallback} (a home-folder fallback); an overlay that launches Desk in this folder binds ${crew} instead.`), `${host}: ${line}`);
      assert.match(line, /desk_status reports the root Desk actually bound, and it wins\./u, `${host} must say desk_status wins`);
      assert.doesNotMatch(line, /\$DESK is/u, `${host} must not assert a single root`);
    }

    // A plain Copilot session opened inside a desk other than the bound one names both, and agrees when they match.
    const other = runCopilotHook({ env: { ...env, DESK: solo }, cwd: crew, sessionCwd: crew });
    assert.ok(startupLine(other).startsWith(`Desk startup: this session's folder ${crew} is a desk, but Desk without an overlay binds ${solo} (the DESK environment variable);`), startupLine(other));
    const same = runCopilotHook({ env: { ...env, DESK: crew }, cwd: crew, sessionCwd: crew });
    assert.ok(startupLine(same).startsWith(`Desk startup: $DESK is ${crew} (the DESK environment variable).`), startupLine(same));

    // An unreadable saved binding is reported as unreadable on both hosts, never as "no desk is bound yet".
    const unreadable = {
      claude: runClaudeHook({ env: { ...env, DESK_ACTIVATION_CONFIG: malformed }, cwd: codeRepo, projectDir: codeRepo }),
      copilot: runCopilotHook({ env: { ...env, DESK_ACTIVATION_CONFIG: malformed }, cwd: codeRepo, sessionCwd: codeRepo }),
    };
    for (const [host, context] of Object.entries(unreadable)) {
      const line = startupLine(context);
      assert.match(line, /^Desk startup: Desk's root configuration could not be read \(.*must be valid JSON\), so this hook cannot say which desk is bound\. desk_status reports the actual state\./u, `${host}: ${line}`);
      assert.doesNotMatch(line, /no desk is bound yet|setup mode/u, `${host} must not claim setup mode for an unreadable binding`);
    }

    // When the hook cannot run Desk's resolver, both hosts say so and still carry the RFC line. On Windows the
    // Claude plugin root uses backslashes, so the RFC path keeps that separator.
    const couldNot = /^Desk startup: Desk could not resolve its root in this hook\. Invoke desk:session-start now for the authoritative workspace scan before other work; desk_status reports the root Desk actually bound\.$/u;
    const bare = path.join(codeRepo, "bare-plugin");
    fs.mkdirSync(path.join(bare, "skills", "using-desk"), { recursive: true });
    fs.copyFileSync(skillPath, path.join(bare, "skills", "using-desk", "SKILL.md"));
    const bareClaude = runClaudeHook({ env: { ...env, CLAUDE_PLUGIN_ROOT: bare }, cwd: codeRepo, projectDir: codeRepo });
    assert.match(startupLine(bareClaude), couldNot, "claude must say it could not resolve the root");
    assert.ok(bareClaude.includes(`\nDesk RFC: ${bare}/docs/agentic-engineering-v2-rfc.md\n`), "claude RFC line uses the plugin root");
    const bareCopilot = runCopilotHook({ env: { ...env, PLUGIN_ROOT: bare }, cwd: codeRepo, sessionCwd: codeRepo });
    assert.match(startupLine(bareCopilot), couldNot, "copilot must say it could not resolve the root");
    const windowsRoot = "C:\\Users\\someone\\.claude\\plugins\\cache\\ourostack\\desk\\3.2.0";
    const windowsClaude = runClaudeHook({ env: { ...env, CLAUDE_PLUGIN_ROOT: windowsRoot }, cwd: codeRepo, projectDir: codeRepo, args: [skillPath] });
    assert.ok(windowsClaude.includes(`\nDesk RFC: ${windowsRoot}\\docs\\agentic-engineering-v2-rfc.md\n`), "claude RFC line keeps Windows separators");
    assert.match(startupLine(windowsClaude), couldNot);

    // A host that leaves stdin open must not stall startup: the hook stops waiting and uses the process folder.
    const started = Date.now();
    const open = spawnSync("bash", ["-c", `exec "${process.execPath}" "${path.join(pluginRoot, "hooks", "copilot-session-start.cjs")}" < <(exec sleep 8 </dev/null 2>/dev/null)`], { cwd: crew, encoding: "utf8", env });
    const elapsed = Date.now() - started;
    assert.equal(open.status, 0, open.stderr);
    assert.ok(elapsed < 4000, `copilot hook must stop waiting for stdin; took ${elapsed} ms`);
    assert.ok(startupLine(JSON.parse(open.stdout).additionalContext).startsWith(`Desk startup: this session's folder ${crew} is a desk`), "after the stdin timeout the hook uses the process folder");
  });
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

  const expectedSections = [
    "Human and agent",
    "Alignment, then ownership",
    "Coaching the collaboration",
    "Authority",
    "Waste judgment",
    "Cite every factual claim",
    "Own the stack",
    "Engineering work",
    "Source and channels",
    "Durable context and attribution",
    "Requirements that arrive during execution",
    "Visual proof when it helps",
    "Instruction coherence",
    "Child agents",
    "The RFC",
  ];
  const headings = [...skill.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(headings, expectedSections, "using-desk must carry exactly the fifteen foundation sections, in order");
  for (const title of expectedSections) {
    assertSinglePhysicalLine(section(skill, title), `using-desk ${title}`);
  }

  assertSectionConcepts(section(skill, "Human and agent"), [
    /The human supplies intent.*authority.*endpoint/u,
    /The agent owns execution.*sequencing.*verification.*cleanup/u,
    /never hands the human a step it could do itself/u,
  ]);

  assertSectionConcepts(section(skill, "Alignment, then ownership"), [
    /states? (?:its|your) assumptions/iu,
    /question.*human judgment.*forward/iu,
    /definition of done/iu,
    /explicit go/iu,
    /proportionate/iu,
    /own the sequence to done/iu,
    /keep producing while (?:a|any) question is pending/iu,
    /genuine human gate \(voice, meaning anything sent as the human; a decision that is theirs;/u,
    /frontload in one batch everything you will need from (?:them|the human) for the whole outcome/iu,
    /whenever (?:they are|the human is) about to step away/iu,
    /access, settings only they can change, decisions(?: and|,) reviews/iu,
    /`interaction-style` holds the procedure/u,
    /When the human opens a conversation, stay in it/u,
    /design talk goes through `superpowers:brainstorming`/u,
    /already-authorized background work may continue/iu,
    /nothing new starts on (?:that|the) topic until they close it or say go/iu,
    /context size.*not (?:a )?reasons? to stop/iu,
    /one decision group at a time.*recommendation/iu,
  ]);

  assertSectionConcepts(section(skill, "Coaching the collaboration"), [
    /steps handed over one at a time/iu,
    /micromanag/iu,
    /one-shot request/iu,
    /glue/iu,
    /same correction.*record it durably in the desk/iu,
    /let's step back and reset how we're working/u,
    /concrete adjustment/iu,
    /once/iu,
    /never (?:becomes )?a recurring gate/iu,
    /Ambitious delegation is welcome/u,
    /shape an overbroad ask into an assessable outcome/iu,
    /rather than shrinking it/iu,
  ]);

  assertSectionConcepts(section(skill, "Authority"), [
    /human's verb/iu,
    /investigate and review cover gathering evidence only/iu,
    /ship/iu,
    /Access is not ownership/u,
    /explicit instruction not to write overrides/iu,
    /never widen your own permissions/iu,
    /`preflight-actions` holds the procedure/u,
  ]);

  assertSectionConcepts(section(skill, "Waste judgment"), [
    /Before and during work, check that each step adds justifiable, necessary, non-duplicative value/u,
    /human never needs to know the vocabulary/iu,
    /smallest sufficient change at the nearest layer you own/iu,
    /fold ad-hoc steps into the plan/iu,
    /parallelize independent work/iu,
    /redesign/iu,
    /"No waste" never means dropping proof/u,
  ]);

  assertSectionConcepts(section(skill, "Engineering work"), [
    /`desk:using-superpowers-with-desk`/u,
    /`superpowers:requesting-code-review`/u,
  ]);

  assertSectionConcepts(section(skill, "Source and channels"), [
    /recorded source/iu,
    /Changes reach the channel, the branch consumers track, through the repository's normal flow/u,
    /branch from it in a worktree and merge back through a pull request/u,
    /Never pin a commit; a hash is evidence only/u,
    /reviewers and evaluators use the channel as it stands/u,
    /default branch/iu,
    /`git-hygiene` holds the procedure/u,
  ]);

  assertSectionPhrases(section(skill, "Durable context and attribution"), "using-desk Durable context and attribution", [
    "live in the desk, a Git repository",
    "private or sensitive operational evidence, which stays outside Git",
    "(`session-resumption`)",
    "commit and push",
    "Keep nothing durable in host memory or configuration folders",
    "thin pointers to the desk",
    "one durable task",
    "You own the desk's organization: file work where its scope fits, name things from the outcome, and when something could be better organized, tidy it and say so in one line rather than asking.",
    "Never add AI attribution",
    "`Co-Authored-By` trailers",
  ]);

  assertSectionPhrases(section(skill, "Cite every factual claim"), "using-desk Cite every factual claim", [
    "Every factual claim you make to a human or an agent",
    "inline link to its primary source",
    "labeled as inference or unverified",
    "your own actions link to their artifact",
    "before it has happened",
    "cites the historical data behind it or carries no number",
    "`evidence-discipline` holds the procedure",
  ]);

  assertSectionPhrases(section(skill, "Own the stack"), "using-desk Own the stack", [
    "rule, tool or plugin we own",
    "fix it rather than work around it or stop",
    "creative and scrappy before declaring yourself stuck",
    "`friction-management`",
    "kaizen card",
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
    "rendered, installed, merged, rollout",
    "terminal success line",
    "supplements rather than replaces",
    "Capture only the relevant bounded view",
    "secrets or sensitive/private content",
    "strongest safe alternative",
    "artificial screenshots",
  ]);

  assertSectionPhrases(section(skill, "Instruction coherence"), "using-desk Instruction coherence", [
    "confusing, redundant or in conflict",
    "record the friction",
    "must not be silently confused",
    "one owner",
    "triggered skills keep their procedures",
  ]);

  assertSectionPhrases(section(skill, "Child agents"), "using-desk Child agents", [
    "not assumed to rerun startup hooks",
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
    "early-return framing is input, not authority",
    "root retains final accountability",
  ]);

  assertSectionPhrases(section(skill, "The RFC"), "using-desk The RFC", [
    "Agentic Engineering V2 RFC",
    "`Desk RFC:` line",
    "from any repository",
    "on demand",
  ]);
  assert.doesNotMatch(
    section(skill, "The RFC"),
    /plugins\/desk\/docs/u,
    "using-desk must point at the installed RFC path the hooks append, not a repository-relative path",
  );

  assert.doesNotMatch(section(skill, "Source and channels"), /Work on the channel/u, "the foundation must not read as permission to commit straight to the channel");
  assert.doesNotMatch(skill, /froz|freez/iu, "using-desk must not describe frozen candidates or freezing: work tracks channels");
  assert.doesNotMatch(skill, /durable naming/iu, "the agent owns naming; it is not a human gate");

  // Rules owned elsewhere: send approval (operator-voice-comments), the form-tool ban (operator preference),
  // human pull request approval (repository policy) and the hard-wrap rule (Plain Language).
  assert.doesNotMatch(skill, /hard-wrap|physical line/iu, "the hard-wrap rule belongs to Plain Language");
  assert.doesNotMatch(skill, /ask_user|form-style|form tool/iu, "the form-tool ban is an operator preference");
  assert.doesNotMatch(skill, /human (?:PR|pull request) approval|approve the pull request/iu, "human PR approval is repository policy");
  assert.doesNotMatch(skill, /approv\w* (?:of )?(?:that |the )?content|in the (?:human's|operator's) (?:name|voice)/iu, "send approval belongs to operator-voice-comments");

  // Injected at every startup, so it stays compact: each rule is a sentence or two and procedure lives in the owning
  // skill. The ceiling rose from 6500 to 8000 bytes for the four collaboration rules Ari approved on 2026-09-25.
  const skillBytes = Buffer.byteLength(skill, "utf8");
  assert.ok(skillBytes >= 4500 && skillBytes <= 8000, `using-desk should stay about 5-8 KB; found ${skillBytes} bytes`);

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

  checkStartupHooks(skill);

  console.log("using-desk foundation contract passed.");
}

main();
