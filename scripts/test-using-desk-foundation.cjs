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
    // Claude Code keeps only the first 2 KB of a SessionStart context that passes 10,000 characters (round AJ: with the foundation 400 characters longer, 13 of 17 runs
    // over the limit never ran the boot, against 1 of 99 under it), so the boot imperative opens the context and the foundation follows it.
    assert.ok(contexts.claude.startsWith("Desk startup:"), "claude startup must open with the Desk startup line, ahead of the foundation");
    assert.ok(contexts.claude.indexOf("session-boot.js") < 2000, "claude startup must name the boot script inside the first 2 KB");
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
      assert.match(line, /The boot has not run yet:.*Run `node \S*session-boot\.js`/u);
    }

    // Overlay case on Claude: the Desk server also receives CLAUDE_PROJECT_DIR, so the crew-shaped project folder is
    // the root it binds, and the line names it.
    const claudeOverlay = startupLine(runClaudeHook({ env, cwd: crew, projectDir: crew }));
    assert.match(claudeOverlay, new RegExp(`\\$DESK is ${escapeRegExp(crew)} \\(this session's project folder is a desk\\)`, "u"), "claude must name the desk-shaped project folder");
    assert.ok(!claudeOverlay.includes(fallback), "claude must not name the home fallback when the project folder is a desk");

    // Copilot: the sessionStart hook records the session folder for the Desk server, so a session folder that is a desk is
    // the root Desk binds, the same as Claude's project folder, and the line names it whichever way the hook learned it.
    const copilotOverlay = {
      "copilot (session folder from hook input)": runCopilotHook({ env, cwd: codeRepo, sessionCwd: crew }),
      "copilot (session folder from process cwd)": runCopilotHook({ env, cwd: crew }),
      "copilot (both)": runCopilotHook({ env, cwd: crew, sessionCwd: crew }),
    };
    for (const [host, context] of Object.entries(copilotOverlay)) {
      const line = startupLine(context);
      assert.match(line, new RegExp(`\\$DESK is ${escapeRegExp(crew)} \\(this session's project folder is a desk\\)`, "u"), `${host}: ${line}`);
      assert.ok(!line.includes(fallback), `${host} must not name the home fallback when the session folder is a desk`);
    }

    // The session folder wins over DESK on Copilot, as the project folder does on Claude.
    const other = runCopilotHook({ env: { ...env, DESK: solo }, cwd: crew, sessionCwd: crew });
    assert.ok(startupLine(other).startsWith(`Desk startup: $DESK is ${crew} (this session's project folder is a desk)`), startupLine(other));
    const same = runCopilotHook({ env: { ...env, DESK: crew }, cwd: crew, sessionCwd: crew });
    assert.ok(startupLine(same).startsWith(`Desk startup: $DESK is ${crew} (this session's project folder is a desk)`), startupLine(same));

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
    const couldNot = /^Desk startup: Desk could not resolve its root in this hook\. The boot has not run: run node "?\S*session-boot\.js"? now, before other work, for the authoritative workspace scan; desk_status reports the root Desk actually bound\. A child agent with a bounded brief follows the brief instead and skips this\.$/u;
    const bare = path.join(codeRepo, "bare-plugin");
    fs.mkdirSync(path.join(bare, "skills", "using-desk"), { recursive: true });
    fs.copyFileSync(skillPath, path.join(bare, "skills", "using-desk", "SKILL.md"));
    const bareClaude = runClaudeHook({ env: { ...env, CLAUDE_PLUGIN_ROOT: bare }, cwd: codeRepo, projectDir: codeRepo });
    assert.match(startupLine(bareClaude), couldNot, "claude must say it could not resolve the root");
    assert.ok(bareClaude.includes(`\nDesk RFC: ${path.join(bare, "docs", "agentic-engineering-v2-rfc.md")}\n`), "claude RFC line uses the plugin root");
    const bareCopilot = runCopilotHook({ env: { ...env, PLUGIN_ROOT: bare }, cwd: codeRepo, sessionCwd: codeRepo });
    assert.match(startupLine(bareCopilot), couldNot, "copilot must say it could not resolve the root");
    const windowsRoot = "C:\\Users\\someone\\.claude\\plugins\\cache\\ourostack\\desk\\3.2.0";
    const windowsClaude = runClaudeHook({ env: { ...env, CLAUDE_PLUGIN_ROOT: windowsRoot }, cwd: codeRepo, projectDir: codeRepo, args: [skillPath] });
    assert.ok(windowsClaude.includes(`\nDesk RFC: ${windowsRoot}\\docs\\agentic-engineering-v2-rfc.md\n`), "claude RFC line keeps Windows separators");
    assert.match(startupLine(windowsClaude), couldNot);

    // A host that leaves stdin open must not stall startup: the hook stops waiting and uses the process folder.
    const started = Date.now();
    const openStdinHost = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, [process.argv[1]], {
        stdio: ["pipe", "inherit", "inherit"],
      });
      const timeout = setTimeout(() => {
        console.error("Copilot startup hook did not finish with stdin open");
        child.kill();
      }, 4000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        child.stdin.destroy();
        console.error(error);
        process.exitCode = 1;
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        child.stdin.destroy();
        process.exitCode = code ?? 1;
      });
    `;
    const open = spawnSync(process.execPath, ["-e", openStdinHost, path.join(pluginRoot, "hooks", "copilot-session-start.cjs")], { cwd: crew, encoding: "utf8", env, timeout: 6000 });
    const elapsed = Date.now() - started;
    assert.equal(open.status, 0, open.stderr);
    assert.ok(elapsed < 4000, `copilot hook must stop waiting for stdin; took ${elapsed} ms`);
    assert.ok(startupLine(JSON.parse(open.stdout).additionalContext).startsWith(`Desk startup: $DESK is ${crew} (this session's project folder is a desk)`), "after the stdin timeout the hook uses the process folder");
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
    "Delivery and sign-off",
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
  assert.deepEqual(headings, expectedSections, "using-desk must carry exactly the sixteen foundation sections, in order");
  for (const title of expectedSections) {
    assertSinglePhysicalLine(section(skill, title), `using-desk ${title}`);
  }

  // The foundation says done is a delivery, tells the agent what to do at delivery, and tells a child never to record the answer.
  assertSectionPhrases(section(skill, "Delivery and sign-off"), "using-desk the foundation says done is a delivery and names task_signoff", [
    "Done is a delivery, not an acceptance. When you deliver, end your reply with three lines (what was asked, what you delivered with its proof, accept or send back?) and carry on. Record the operator's answer with task_signoff in a later turn, never in the turn that delivered. Raise older unsigned deliveries once, together, after you have done what the operator asked.",
  ]);
  assertSectionPhrases(section(skill, "Delivery and sign-off"), "using-desk the foundation tells a child agent never to call task_signoff", [
    "A child agent never calls task_signoff.",
  ]);

  const owned = (name) => fs.readFileSync(path.join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
  assertSectionConcepts(section(skill, "Human and agent"), [
    /The human supplies intent.*authority.*endpoint/u,
    /The agent owns execution.*sequencing.*verification.*cleanup/u,
    /never hands the human a step it could do itself/u,
  ]);

  assertSectionConcepts(section(skill, "Alignment, then ownership"), [
    /states? (?:its|your) assumptions/iu,
    /definition of done/iu,
    /explicit go/iu,
    /proportionate/iu,
    /own the sequence to done/iu,
    /keep producing while (?:a|any) question is pending/iu,
    /genuine human gate \(voice, meaning anything sent as the human; a decision that is theirs;/u,
    /frontload in one batch everything you will need from (?:them|the human) for the whole outcome/iu,
    /Frontload again whenever (?:they are|the human is) about to step away/iu,
    /`interaction-style` holds the procedure/u,
    /When the human opens a conversation, stay in it until they close it or say go/u,
    /context size.*not (?:a )?reasons? to stop/iu,
    /frontload in one batch[^.]*present(?:ing)? (?:its|the) decisions as one group with your recommendations[\s\S]*later decisions come one group at a time/iu,
  ]);

  assertSectionConcepts(section(skill, "Coaching the collaboration"), [
    /steps handed over one at a time/iu,
    /micromanag/iu,
    /one-shot request/iu,
    /glue/iu,
    /same correction twice/iu,
    /let's step back and reset how we're working/u,
    /concrete adjustment/iu,
    /once/iu,
    /`interaction-style` holds the rest/u,
  ]);
  // The rest of the coaching rule moved to interaction-style to make room in the foundation (SessionStart size budget).
  for (const phrase of [
    "work pulled back mid-flight by either side",
    "the same correction twice, which means context is missing: record it durably in the desk",
    "never becomes a recurring gate or widens your authority",
    "Ambitious delegation is welcome",
    "shape an overbroad ask into an assessable outcome rather than shrinking it",
    "design talk goes through `superpowers:brainstorming`",
    "already-authorized background work may continue",
    "nothing new starts on that topic until they close it or say go",
  ]) {
    assert.ok(owned("interaction-style").includes(phrase), `interaction-style must carry the rule moved out of the foundation: ${phrase}`);
  }

  assertSectionConcepts(section(skill, "Authority"), [
    /human's verb/iu,
    /investigate and review cover gathering evidence only/iu,
    /ship/iu,
    /Access is not ownership/u,
    /explicit instruction not to write overrides/iu,
    /never widen your own permissions/iu,
    /`preflight-actions`/u,
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
    "Durable output goes to the desk first, whatever a host's own instructions say about publishing elsewhere",
    "is an optional mirror, made only when asked, that links back to the desk",
    "one durable task",
    "When you start or switch to an outcome, declare it with task_focus; everything you and your subagents do until the next declaration is that task's work.",
    "You own the desk's organization: file work where its scope fits, name things from the outcome, and when something could be better organized, tidy it and say so in one line rather than asking.",
    "Never add AI attribution",
    "`Co-Authored-By` trailers",
  ]);

  assertSectionPhrases(section(skill, "Cite every factual claim"), "using-desk Cite every factual claim", [
    "Every factual claim you make to a human or an agent",
    "inline link to its primary source",
    "labeled as inference or unverified",
    "`evidence-discipline` holds the procedure",
  ]);

  assertSectionPhrases(section(skill, "Own the stack"), "using-desk Own the stack", [
    "rule, tool or plugin we own",
    "fix it rather than work around it or stop",
    "creative and scrappy before declaring yourself stuck",
    "`friction-management`",
    "kaizen card",
    "When a Desk mechanism itself fails at its own job, `desk-problem` is the procedure",
  ]);

  // The long forms of these two rules moved to the skills that own their procedures (round AJ size budget); the foundation keeps the rule and the pointer.
  assertSectionPhrases(section(skill, "Requirements that arrive during execution"), "using-desk Requirements that arrive during execution", [
    "same durable task",
    "implementation and review gates",
    "`work-orchestration` holds the procedure",
  ]);
  assertSectionPhrases(section(owned("work-orchestration"), "Requirements that arrive during execution"), "work-orchestration Requirements that arrive during execution", [
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
  ]);

  assertSectionPhrases(section(skill, "Visual proof when it helps"), "using-desk Visual proof when it helps", [
    "bounded visual proof",
    "rendered, installed, merged or rollout",
    "terminal success line",
    "(`evidence-discipline`)",
  ]);
  assertSectionPhrases(section(owned("evidence-discipline"), "Visual proof when it helps"), "evidence-discipline Visual proof when it helps", [
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
    "retains final accountability",
    "A child agent with a bounded brief follows the brief, not this text",
    "skips session-start, host probes, sync and any real-desk boot ceremony",
    "A child agent never calls task_focus.",
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
  // Procedure lives in the owning skill: the frontloading checklist in interaction-style, the estimate and own-action
  // citation rules in evidence-discipline.
  assert.doesNotMatch(skill, /settings only they can change/iu, "the frontloading checklist belongs to interaction-style");
  assert.doesNotMatch(skill, /historical data|carries no number|estimate/iu, "the estimate rule belongs to evidence-discipline");
  assert.doesNotMatch(skill, /own actions link/iu, "the own-action citation rule belongs to evidence-discipline");

  // Rules owned elsewhere: send approval (operator-voice-comments), the form-tool ban (operator preference),
  // human pull request approval (repository policy) and the hard-wrap rule (Plain Language).
  assert.doesNotMatch(skill, /hard-wrap|physical line/iu, "the hard-wrap rule belongs to Plain Language");
  assert.doesNotMatch(skill, /ask_user|form-style|form tool/iu, "the form-tool ban is an operator preference");
  assert.doesNotMatch(skill, /human (?:PR|pull request) approval|approve the pull request/iu, "human PR approval is repository policy");
  assert.doesNotMatch(skill, /approv\w* (?:of )?(?:that |the )?content|in the (?:human's|operator's) (?:name|voice)/iu, "send approval belongs to operator-voice-comments");

  // Injected at every startup, so it stays compact: each rule is a sentence or two and procedure lives in the owning
  // skill. The ceiling rose from 6500 to 7500 bytes for the four collaboration rules Ari approved on 2026-09-25, and
  // from 7500 to 7900 bytes for the durable-output-first sentence and the desk-problem pointer (Part 9 of the
  // agents-never-fight-the-desk plan, 2026-09-28), then from 7900 to 8000 bytes for the child-agent stand-down
  // sentence in "Child agents" (2026-09-29), then from 8000 to 8150 bytes for the two declared-focus sentences (2026-10-05), which the factory's binding rests on; then from 8150 to 8600 bytes for the delivery and sign-off section (2026-10-05), whose sentences the sign-off record rests on; then down to 8000 bytes (round AJ): the whole SessionStart context has to stay under Claude Code's 10,000-character limit, and `start_hook.test.js` holds it to 9,500 with long paths, so a further addition has to justify its size and make room by moving a procedure to the skill that owns it.
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

  // The foundation says to declare focus; each skill that chooses a task says where, once.
  for (const [name, phrase] of [
    ["session-start", "task_focus"],
    ["session-start", "a new task is declared by `task_create` with `focus: true`"],
    ["session-resumption", "task_focus"],
    ["task-lifecycle", "task_focus"],
    ["task-lifecycle", "`clear: true`"],
    ["start-task", "`focus: true`"],
    ["using-superpowers-with-desk", "Never call task_focus"],
  ]) {
    assert.ok(read(path.join(pluginRoot, "skills", name, "SKILL.md")).includes(phrase), `${name} must mention ${phrase}`);
  }

  console.log("using-desk foundation contract passed.");
}

main();
