#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const defaultRepoRoot = path.resolve(__dirname, "..");
const defaultMcpRoot = path.join(defaultRepoRoot, "plugins", "desk", "mcp");
const activationManifestPath = "plugins/desk/activation/desk.activation.json";
const copilotBundlePath = "plugins/desk/activation/copilot-root.flattened-bundle.json";
const evidencePath = "plugins/desk/activation/host-capability-evidence.md";
const supportMatrixPath = "plugins/desk/activation/support-matrix.json";
const requiredEvidenceColumns = [
  "host_id",
  "surface",
  "disposition",
  "source_paths",
  "evidence_command_or_doc",
  "unsupported_primitives",
  "fallback_behavior",
];

function readText(repoRoot, relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(repoRoot, relativePath) {
  return JSON.parse(readText(repoRoot, relativePath));
}

// Legacy providers (Ponytail) and the loose-skill catalog ship elsewhere; a repository may omit them.
function readJsonIfPresent(repoRoot, relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath)) ? readJson(repoRoot, relativePath) : undefined;
}

function splitMarkdownRow(row) {
  return row.trim().replace(/^\|/u, "").replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function splitList(value) {
  if (value === "none") return [];
  return value.replace(/^none$/u, "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEvidenceTable(content) {
  const tableRows = content.split(/\r?\n/u).filter((line) => line.startsWith("|"));
  const columns = splitMarkdownRow(tableRows[0] ?? "");
  if (!sameJson(columns, requiredEvidenceColumns)) {
    throw new Error(`support-matrix evidence columns drifted in ${evidencePath}`);
  }
  return tableRows.slice(2).map((line) => {
    const values = splitMarkdownRow(line);
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    return {
      ...row,
      source_paths: splitList(row.source_paths),
      unsupported_primitives: splitList(row.unsupported_primitives),
    };
  });
}

function expectedSupportMatrix(repoRoot) {
  return {
    schema_version: 1,
    generated_from: {
      activation_manifest: activationManifestPath,
      host_capability_evidence: evidencePath,
    },
    hosts: parseEvidenceTable(readText(repoRoot, evidencePath)),
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}

function countOccurrences(value, phrase) {
  return value.split(phrase).length - 1;
}

function assertLightweightCopilotStartupHookSource(source, errors) {
  if (!/const foundationPath = path\.join\(pluginRoot,\s*"skills",\s*"using-desk",\s*"SKILL\.md"\);/u.test(source)) {
    errors.push("startup-composition Copilot hook must read the canonical using-desk skill at runtime");
  }
  if (!/const foundation = fs\.readFileSync\(foundationPath,\s*"utf8"\)\.trimEnd\(\);/u.test(source)) {
    errors.push("startup-composition Copilot hook must read only the canonical using-desk skill body");
  }
  const readCount = (source.match(/\breadFileSync\(/gu) ?? []).length;
  if (readCount !== 1) {
    errors.push(`startup-composition Copilot hook must keep exactly one local file read; found ${readCount}`);
  }
  if (/\b(?:spawnSync|execSync|execFileSync|fork|fetch)\b/u.test(source)) {
    errors.push("startup-composition Copilot hook must not execute commands or fetch network resources");
  }
  if (/"node:(?:child_process|http|https|net|dns|tls)"/u.test(source)) {
    errors.push("startup-composition Copilot hook must stay local-only and avoid network or process modules");
  }
  if (/\b(?:readdirSync|opendirSync|globSync|task\.md)\b/u.test(source)) {
    errors.push("startup-composition Copilot hook must not scan workspace or task files");
  }
  if (/path\.join\([^)]*"skills"[^)]*"(?:session-start|session-start-migrations|rfc[^"]*|first-run-bootstrap)"/iu.test(source)) {
    errors.push("startup-composition Copilot hook must not read onboarding, migration, session-start, or RFC files");
  }
}

function skillBody(value) {
  return value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim();
}

function pushMismatch(errors, label, actual, expected) {
  if (!sameJson(actual, expected)) {
    errors.push(`${label} drift: committed host-facing artifact does not match generated expectation`);
  }
}

function findActivationDependency(activation, id) {
  return activation.dependencies.find((dependency) => dependency.id === id);
}

function checkSupportMatrix({ repoRoot, errors, checked }) {
  checked.push("support-matrix");
  const activation = readJson(repoRoot, activationManifestPath);
  const evidenceRows = parseEvidenceTable(readText(repoRoot, evidencePath));
  const matrix = readJson(repoRoot, supportMatrixPath);
  pushMismatch(errors, "support-matrix", matrix, expectedSupportMatrix(repoRoot));

  for (const hostSupport of activation.host_support) {
    const row = evidenceRows.find((candidate) => candidate.host_id === hostSupport.host);
    if (!row) {
      errors.push(`support-matrix missing evidence row for ${hostSupport.host}`);
    } else {
      if (!row.disposition.startsWith(`${hostSupport.status}-`)) {
        errors.push(`support-matrix evidence disposition drift for ${hostSupport.host}`);
      }
      if (row.fallback_behavior !== hostSupport.fallback_behavior) {
        errors.push(`support-matrix fallback drift for ${hostSupport.host}`);
      }
    }
  }
}

async function checkCopilotBundle({ repoRoot, mcpRoot, methodId, errors, checked }) {
  checked.push("copilot-bundle");
  const { buildCopilotBundle, validateCopilotPackagingContract } = await import(pathToFileURL(
    path.join(mcpRoot, "src", "activation", "copilot-bundle.js"),
  ).href);
  const activation = readJson(repoRoot, activationManifestPath);
  const bundle = readJson(repoRoot, copilotBundlePath);
  pushMismatch(errors, "copilot-bundle", bundle, buildCopilotBundle({ activation }));

  checked.push("copilot-plugin-metadata");
  const contractErrors = validateCopilotPackagingContract({
    activation,
    bundle,
    deskPlugin: readJson(repoRoot, "plugins/desk/plugin.json"),
    [methodId === "superpowers" ? "superpowersPlugin" : "workSuitePlugin"]: readJson(repoRoot, `plugins/${methodId}/plugin.json`),
    plainLanguagePlugin: readJson(repoRoot, "plugins/plain-language/plugin.json"),
    ponytailPlugin: readJsonIfPresent(repoRoot, "plugins/ponytail-upstream/plugin.json"),
  });
  if (contractErrors.length > 0) {
    errors.push(`copilot-plugin-metadata drift: ${contractErrors.join("; ")}`);
  }
}

function checkCodexPlugin({ repoRoot, methodId, errors, checked }) {
  checked.push("codex-plugin");
  const activation = readJson(repoRoot, activationManifestPath);
  const deskPlugin = readJson(repoRoot, "plugins/desk/.codex-plugin/plugin.json");
  const methodPlugin = readJson(repoRoot, `plugins/${methodId}/.codex-plugin/plugin.json`);
  const methodLabel = methodId === "superpowers" ? "Superpowers" : "Work Suite";
  const plainLanguagePlugin = readJson(repoRoot, "plugins/plain-language/.codex-plugin/plugin.json");
  const methodLock = findActivationDependency(activation, methodId)?.lock?.version;
  const plainLanguageLock = findActivationDependency(activation, "plain-language")?.lock?.version;
  const codex = deskPlugin.activation?.codex;

  if (deskPlugin.version !== activation.version) {
    errors.push("codex-plugin Desk version drift");
  }
  if (deskPlugin.skills !== "./skills/" || deskPlugin.mcpServers !== "./.mcp.json") {
    errors.push("codex-plugin Desk surfaces drift");
  }
  if (codex?.defaultMode !== "global-personal") {
    errors.push("codex-plugin default activation mode drift");
  }
  if (!sameJson(codex?.optOutModes, ["project-local", "manual-only"])) {
    errors.push("codex-plugin opt-out modes drift");
  }
  if (codex?.targets?.["desk:worker"]?.source !== "agents/worker.toml") {
    errors.push("codex-plugin desk:worker source drift");
  }
  if (codex?.targets?.["desk:worker"]?.default !== true) {
    errors.push("codex-plugin desk:worker default drift");
  }
  if (codex?.mcpServers?.desk?.manualRegistration !== false) {
    errors.push("codex-plugin Desk MCP manual-registration drift");
  }
  if (!sameJson(codex?.manualSetupSteps ?? [], [])) {
    errors.push("codex-plugin manual setup steps drift");
  }
  if (codex?.dependencies?.[methodId]?.version !== methodPlugin.version) {
    errors.push(`codex-plugin ${methodLabel} dependency version drift`);
  }
  if (methodPlugin.version !== methodLock) {
    errors.push(`codex-plugin ${methodLabel} provider lock drift`);
  }
  if (codex?.dependencies?.["plain-language"]?.version !== plainLanguagePlugin.version) {
    errors.push("codex-plugin Plain Language dependency version drift");
  }
  if (plainLanguagePlugin.version !== plainLanguageLock) {
    errors.push("codex-plugin Plain Language provider lock drift");
  }
}

function checkClaudePlugin({ repoRoot, methodId, errors, checked }) {
  checked.push("claude-plugin");
  const activation = readJson(repoRoot, activationManifestPath);
  const deskPlugin = readJson(repoRoot, "plugins/desk/.claude-plugin/plugin.json");
  const methodPlugin = readJson(repoRoot, `plugins/${methodId}/.claude-plugin/plugin.json`);
  const methodLabel = methodId === "superpowers" ? "Superpowers" : "Work Suite";
  const plainLanguagePlugin = readJson(repoRoot, "plugins/plain-language/.claude-plugin/plugin.json");
  const claudeActivation = activation.host_activation?.claude;
  const methodLock = findActivationDependency(activation, methodId)?.lock?.version;
  const plainLanguageLock = findActivationDependency(activation, "plain-language")?.lock?.version;

  if (deskPlugin.version !== activation.version) {
    errors.push("claude-plugin Desk version drift");
  }
  if (!Array.isArray(deskPlugin.agents) || !deskPlugin.agents.includes("./agents/worker.md")) {
    errors.push("claude-plugin worker exposure drift");
  }
  if (deskPlugin.skills !== "./skills/" || deskPlugin.mcpServers !== "./.mcp.json") {
    errors.push("claude-plugin Desk surfaces drift");
  }
  if (deskPlugin.outputStyles !== "./output-styles/") {
    errors.push("claude-plugin output style surface drift");
  }
  if (deskPlugin.dependencies?.[0]?.name !== methodId || deskPlugin.dependencies?.[0]?.version !== findActivationDependency(activation, methodId)?.version_range) {
    errors.push(`claude-plugin ${methodLabel} dependency drift`);
  }
  if (claudeActivation?.dependencies?.[methodId]?.version !== methodPlugin.version) {
    errors.push(`claude-plugin ${methodLabel} activation dependency version drift`);
  }
  if (methodPlugin.version !== methodLock) {
    errors.push(`claude-plugin ${methodLabel} provider lock drift`);
  }
  if (
    deskPlugin.dependencies?.[1]?.name !== "plain-language" ||
    deskPlugin.dependencies?.[1]?.version !== findActivationDependency(activation, "plain-language")?.version_range
  ) {
    errors.push("claude-plugin Plain Language dependency drift");
  }
  if (plainLanguagePlugin.version !== plainLanguageLock) {
    errors.push("claude-plugin Plain Language provider lock drift");
  }
  if (claudeActivation?.targets?.["desk:worker"]?.source !== "agents/worker.md") {
    errors.push("claude-plugin activation worker source drift");
  }
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) return {};
  return Object.fromEntries(match[1]
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(":");
      return [key.trim(), rest.join(":").trim().replace(/^"|"$/gu, "")];
    }));
}

function tomlStringValue(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "mu"));
  return match?.[1];
}

function checkWorkerSources({ repoRoot, errors, checked }) {
  checked.push("worker-sources");
  const claudeWorker = readText(repoRoot, "plugins/desk/agents/worker.md");
  const codexWorker = readText(repoRoot, "plugins/desk/agents/worker.toml");
  const copilotWorker = readText(repoRoot, "plugins/desk/agents/worker.agent.md");
  const outputStyleWorker = readText(repoRoot, "plugins/desk/output-styles/worker.md");
  const plainLanguage = readText(repoRoot, "plugins/plain-language/skills/plain-language/SKILL.md");
  const codexAdapter = readText(repoRoot, "plugins/desk/mcp/src/activation/adapters/codex.js");
  const workerFacts = [
    ["claude", parseFrontmatter(claudeWorker).name],
    ["codex", tomlStringValue(codexWorker, "name")],
    ["copilot", parseFrontmatter(copilotWorker).name],
  ];

  for (const [host, name] of workerFacts) {
    if (name !== "worker") {
      errors.push(`worker-sources ${host} worker name drift`);
    }
  }
  for (const [host, body] of [
    ["claude", claudeWorker],
    ["codex", codexWorker],
    ["copilot", copilotWorker],
  ]) {
    if (!body.includes("I'm **worker**") || !body.includes("$DESK")) {
      errors.push(`worker-sources ${host} body drift`);
    }
  }
  if (!claudeWorker.includes("desk:session-start")) {
    errors.push("worker-sources claude session-start prompt drift");
  }
  for (const [surface, body] of [
    ["claude", claudeWorker],
    ["codex-subagent", codexWorker],
    ["copilot", copilotWorker],
    ["claude-output-style", outputStyleWorker],
  ]) {
    if (!body.includes("using-desk")) {
      errors.push(`worker-sources ${surface} using-desk activation drift`);
    }
    if (!body.includes("Never hard-wrap authored prose") || !body.includes("authored/changed prose")) {
      errors.push(`worker-sources ${surface} no-hard-wrap invariant drift`);
    }
  }
  // Plain Language owns the hard-wrap rule; Desk no longer ships a principles file.
  if (!plainLanguage.includes("Never hard-wrap authored prose") || !plainLanguage.includes("changed in the current task")) {
    errors.push("worker-sources plain-language no-hard-wrap rule drift");
  }
  if (fs.existsSync(path.join(repoRoot, "plugins/desk/principles.md"))) {
    errors.push("worker-sources retired principles file present");
  }
  if (!codexAdapter.includes("Never hard-wrap authored prose") || !codexAdapter.includes("authored/changed prose")) {
    errors.push("worker-sources codex activation no-hard-wrap invariant drift");
  }
  if (!codexAdapter.includes("Apply the \\`plain-language\\` skill to every human-readable response and artifact")) {
    errors.push("worker-sources codex activation Plain Language invariant drift");
  }
}

function checkHumanizePackaging({ repoRoot, errors, checked }) {
  checked.push("humanize-skill");
  const deskSkillRoot = path.join(repoRoot, "plugins", "desk", "skills", "humanize");
  const standaloneSkillRoot = path.join(repoRoot, "skills", "humanize");
  const manifest = readJsonIfPresent(repoRoot, "manifest.json") ?? { skills: [] };

  for (const file of ["SKILL.md", "LICENSE"]) {
    if (!fs.existsSync(path.join(deskSkillRoot, file))) {
      errors.push(`humanize-skill Desk bundle missing ${file}`);
    }
  }
  if (fs.existsSync(standaloneSkillRoot)) {
    errors.push("humanize-skill remains in the standalone skill catalog");
  }
  if (manifest.skills.some((skill) => skill.name === "humanize")) {
    errors.push("humanize-skill remains exported from the standalone manifest");
  }
}

function effectiveClaudeStartup(repoRoot) {
  const deskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desk-claude-startup-"));
  try {
    const result = spawnSync(
      "bash",
      [path.join(repoRoot, "plugins", "desk", "hooks", "session-start.sh")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: path.join(repoRoot, "plugins", "desk"),
          DESK: deskRoot,
        },
      },
    );
    if (result.status !== 0) {
      throw new Error(`Claude SessionStart hook failed: ${result.stderr.trim()}`);
    }
    const payload = JSON.parse(result.stdout);
    return payload.hookSpecificOutput?.additionalContext ?? "";
  } finally {
    fs.rmSync(deskRoot, { recursive: true, force: true });
  }
}

function effectiveCopilotStartup(repoRoot) {
  const pluginRoot = path.join(repoRoot, "plugins", "desk");
  const plugin = readJson(repoRoot, "plugins/desk/plugin.json");
  if (plugin.hooks !== "./hooks/copilot-hooks.json") {
    throw new Error("Desk Copilot plugin must register ./hooks/copilot-hooks.json");
  }

  const hookManifest = readJson(repoRoot, path.posix.join("plugins/desk", plugin.hooks));
  if (hookManifest.version !== 1) {
    throw new Error("Desk Copilot hook manifest must use version 1");
  }

  const sessionStartHooks = hookManifest.hooks?.sessionStart;
  if (!Array.isArray(sessionStartHooks) || sessionStartHooks.length !== 1) {
    throw new Error("Desk Copilot hook manifest must configure exactly one sessionStart hook");
  }

  const command = sessionStartHooks[0]?.bash;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Desk Copilot sessionStart hook must configure a bash command");
  }

  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "desk-copilot-startup-"));
  try {
    const result = spawnSync("bash", ["-lc", command], {
      cwd: pluginRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        COPILOT_PLUGIN_DATA: pluginData,
        DESK: path.join(pluginData, "desk"),
        PLUGIN_ROOT: pluginRoot,
      },
    });
    if (result.status !== 0) {
      throw new Error(`Copilot sessionStart hook failed: ${result.stderr.trim()}`);
    }
    const payload = JSON.parse(result.stdout);
    return payload.additionalContext ?? "";
  } finally {
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
}

function codexActivationInput(manifest, mode) {
  return {
    manifest,
    mode,
    existingConfig: [
      "# user-authored Codex config",
      "model = \"gpt-5.4\"",
      "approval_policy = \"on-request\"",
      "",
    ].join("\n"),
    existingInstructions: [
      "# user-authored Codex guidance",
      "Keep repo-local rules intact.",
      "",
    ].join("\n"),
    pluginRoot: "plugins/desk",
    deskRoot: mode === "project-local" ? ".desk" : "~/desk",
    runtimeCacheDir: mode === "project-local"
      ? ".codex/desk-runtime-cache"
      : "~/.cache/ouroboros-skills/desk",
  };
}

async function checkStartupComposition({ repoRoot, mcpRoot, errors, checked }) {
  checked.push("startup-composition");
  const { materializeCodexActivation } = await import(pathToFileURL(
    path.join(mcpRoot, "src", "activation", "adapters", "codex.js"),
  ).href);
  const manifest = readJson(repoRoot, activationManifestPath);
  const activationTarget = manifest.provides.activation_targets.find((target) => (
    target.id === "desk:worker"
  ));
  if (!sameJson(activationTarget?.startup, {
    foundation: "skills/using-desk/SKILL.md",
    authoritative_scan: "skills/session-start/SKILL.md",
  })) {
    errors.push("startup-composition desk:worker startup contract drift");
  }
  const startups = [
    ["claude", effectiveClaudeStartup(repoRoot)],
    [
      "codex",
      materializeCodexActivation(codexActivationInput(manifest, "global-personal"))
        .generatedInstructions,
    ],
  ];
  try {
    startups.splice(1, 0, ["copilot", effectiveCopilotStartup(repoRoot)]);
  } catch (error) {
    errors.push(`startup-composition copilot hook execution failed: ${error.message}`);
  }
  const foundation = skillBody(readText(
    repoRoot,
    "plugins/desk/skills/using-desk/SKILL.md",
  ));
  const installedRfc = {
    claude: path.join(repoRoot, "plugins", "desk", "docs", "agentic-engineering-v2-rfc.md"),
    copilot: path.join(repoRoot, "plugins", "desk", "docs", "agentic-engineering-v2-rfc.md"),
    // The Codex fixtures materialize from the relative plugin root "plugins/desk".
    codex: "plugins/desk/docs/agentic-engineering-v2-rfc.md",
  };
  for (const [host, startup] of startups) {
    const foundationCount = countOccurrences(startup, foundation);
    if (foundationCount !== 1) {
      errors.push(`startup-composition ${host} must include the canonical using-desk body exactly once; found ${foundationCount}`);
    }
    // The foundation names the RFC only through this line, so the path must be the installed one and must exist.
    const rfcLines = startup.split("\n").filter((line) => line.startsWith("Desk RFC:"));
    if (rfcLines.length !== 1 || rfcLines[0] !== `Desk RFC: ${installedRfc[host]}` || !fs.existsSync(path.resolve(repoRoot, installedRfc[host]))) {
      errors.push(`startup-composition ${host} must carry one Desk RFC line naming the installed RFC that exists; found ${JSON.stringify(rfcLines)}`);
    }
    for (const phrase of [
      "The human supplies intent",
      "The agent owns execution",
      "must not be silently confused",
    ]) {
      const count = countOccurrences(startup, phrase);
      if (count !== 1) {
        errors.push(`startup-composition ${host} must include "${phrase}" exactly once; found ${count}`);
      }
    }
  }

  const copilotWorker = readText(repoRoot, "plugins/desk/agents/worker.agent.md");
  if (copilotWorker.includes(foundation)) {
    errors.push("startup-composition Copilot agent body must not duplicate the canonical using-desk body");
  }
  if (/Compact working foundation carried once in this Copilot agent source/u.test(copilotWorker)) {
    errors.push("startup-composition Copilot agent source must not claim it carries using-desk inline");
  }
  if (!/sessionStart` hook injects the full `using-desk` foundation exactly once/u.test(copilotWorker)) {
    errors.push("startup-composition Copilot agent source must describe runtime injection from the Desk-owned sessionStart hook");
  }

  const sessionStartHook = readText(repoRoot, "plugins/desk/hooks/session-start.sh");
  // A hook-side partial scan duplicates desk:session-start, adds boot work, and can disagree with synchronized workspace state.
  if (/find\s+.*task\.md|(^|[;&|]\s*|\$\()\s*(git|gh|curl)\s/mu.test(sessionStartHook)) {
    errors.push("startup-composition Claude hook must not scan tasks or run git, gh, or curl");
  }
  const copilotSessionStartHook = readText(repoRoot, "plugins/desk/hooks/copilot-session-start.cjs");
  assertLightweightCopilotStartupHookSource(copilotSessionStartHook, errors);
  const sessionStartSkill = readText(repoRoot, "plugins/desk/skills/session-start/SKILL.md");
  if (!/authoritative.*scan/iu.test(sessionStartSkill)) {
    errors.push("startup-composition desk:session-start must declare the authoritative scan");
  }
}

async function expectedCodexFixtures({ repoRoot, mcpRoot }) {
  const { materializeCodexActivation } = await import(pathToFileURL(
    path.join(mcpRoot, "src", "activation", "adapters", "codex.js"),
  ).href);
  const manifest = readJson(repoRoot, activationManifestPath);
  return {
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-config.toml":
      materializeCodexActivation(codexActivationInput(manifest, "global-personal")).generatedConfig,
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-instructions.md":
      materializeCodexActivation(codexActivationInput(manifest, "global-personal")).generatedInstructions,
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-config.toml":
      materializeCodexActivation(codexActivationInput(manifest, "project-local")).generatedConfig,
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-instructions.md":
      materializeCodexActivation(codexActivationInput(manifest, "project-local")).generatedInstructions,
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/manual-only/generated-config.toml":
      materializeCodexActivation(codexActivationInput(manifest, "manual-only")).generatedConfig,
  };
}

async function checkCodexFixtures({ repoRoot, mcpRoot, errors, checked }) {
  checked.push("codex-fixtures");
  const expected = await expectedCodexFixtures({ repoRoot, mcpRoot });
  for (const [relativePath, content] of Object.entries(expected)) {
    if (normalizeNewlines(readText(repoRoot, relativePath)) !== normalizeNewlines(content)) {
      errors.push(`codex-fixtures drift: ${relativePath}`);
    }
  }
}

async function verifyDeskHostManifests(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const mcpRoot = options.mcpRoot ?? path.join(repoRoot, "plugins", "desk", "mcp");
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const errors = [];
  const checked = [];

  try {
    const { selectEngineeringMethod } = await import(pathToFileURL(
      path.join(mcpRoot, "src", "activation", "validate.js"),
    ).href);
    const activation = readJson(repoRoot, activationManifestPath);
    const methodId = selectEngineeringMethod(activation.provides.activation_targets.find((target) => target.id === "desk:worker").depends_on);
    checkSupportMatrix({ repoRoot, errors, checked });
    await checkCopilotBundle({ repoRoot, mcpRoot, methodId, errors, checked });
    checkCodexPlugin({ repoRoot, methodId, errors, checked });
    checkClaudePlugin({ repoRoot, methodId, errors, checked });
    checkWorkerSources({ repoRoot, errors, checked });
    checkHumanizePackaging({ repoRoot, errors, checked });
    await checkStartupComposition({ repoRoot, mcpRoot, errors, checked });
    await checkCodexFixtures({ repoRoot, mcpRoot, errors, checked });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    io.stderr.write("Desk host manifest verification failed\n");
    for (const error of errors) io.stderr.write(`- ${error}\n`);
  } else {
    io.stdout.write(`Desk host manifests verified for ${checked.join(", ")}\n`);
  }
  return {
    ok: errors.length === 0,
    errors,
    checked,
  };
}

async function runCli(options = {}) {
  try {
    const result = await verifyDeskHostManifests(options);
    return result.ok ? 0 : 1;
  } catch (error) {
    const io = options.io ?? { stderr: process.stderr };
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  defaultMcpRoot,
  defaultRepoRoot,
  runCli,
  verifyDeskHostManifests,
};
