#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const maxSkillDescriptionLength = 1024;
const requiredDeskMcpPackageScripts = {
  "activation:support-matrix:generate": "node scripts/generate-support-matrix.js",
  "activation:copilot-bundle:generate": "node scripts/generate-copilot-bundle.js",
  "runtime:deps-pack:build": "node scripts/build-runtime-deps-pack.js",
  "runtime:deps-pack:verify": "node scripts/verify-runtime-deps-pack.js",
  "artifact:vector-pack:build": "node scripts/build-vector-pack.js",
  "artifact:snapshot:build": "node scripts/build-snapshot.js",
  "artifact:snapshot:verify": "node scripts/verify-snapshot.js",
  "artifact:validate": "node scripts/validate-artifacts.js",
};
function repoPath(filePath, { repoRoot = process.cwd() } = {}) {
  return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
}

function readText(filePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  return fsImpl.readFileSync(repoPath(filePath, options), "utf8");
}

function readJson(filePath, options = {}) {
  return JSON.parse(readText(filePath, options));
}

function exists(filePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  return fsImpl.existsSync(repoPath(filePath, options));
}

function readDir(filePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  return fsImpl.readdirSync(repoPath(filePath, options));
}

function stat(filePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  return fsImpl.statSync(repoPath(filePath, options));
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function frontmatterBlock(body) {
  return body.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? null;
}

function frontmatterScalar(frontmatter, key) {
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`, "u"));
    if (!match) {
      continue;
    }
    const value = match[1].trim();
    if (["|", "|-", ">", ">-"].includes(value)) {
      const blockLines = [];
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        if (/^\S[^:]*:\s*/u.test(lines[blockIndex])) {
          break;
        }
        blockLines.push(lines[blockIndex].replace(/^\s{2,}/u, ""));
      }
      return blockLines.join("\n").trim();
    }
    if (!isQuotedYamlScalar(value) && /:\s/u.test(value)) {
      throw new Error(`${key} inline scalar contains ': '; quote it or use a block scalar`);
    }
    return value.replace(/^"|"$/gu, "").replace(/^'|'$/gu, "");
  }
  return null;
}

function isQuotedYamlScalar(value) {
  return /^(['"]).*\1$/u.test(value);
}

// The loose-skill catalog (manifest.json plus skills/) is optional: this
// repository ships plugins only, so an absent catalog has nothing to validate.
function validateManifest(options = {}) {
  if (!exists("manifest.json", options)) {
    console.log("No loose-skill manifest.json; skipped the skill catalog.");
    return;
  }
  const manifest = readJson("manifest.json", options);
  if (!Array.isArray(manifest.skills)) {
    throw new Error("manifest.skills must be an array");
  }

  const names = new Set();
  for (const skill of manifest.skills) {
    if (!skill || typeof skill !== "object") {
      throw new Error("every skill entry must be an object");
    }
    if (typeof skill.name !== "string" || skill.name.trim() === "") {
      throw new Error(`invalid skill name: ${JSON.stringify(skill)}`);
    }
    if (names.has(skill.name)) {
      throw new Error(`duplicate skill name: ${skill.name}`);
    }
    names.add(skill.name);

    if (typeof skill.path !== "string" || !skill.path.endsWith("/SKILL.md")) {
      throw new Error(`${skill.name}: path must point at SKILL.md`);
    }
    if (!exists(skill.path, options)) {
      throw new Error(`${skill.name}: missing ${skill.path}`);
    }
    if (typeof skill.description !== "string" || skill.description.trim() === "") {
      throw new Error(`${skill.name}: description is required`);
    }
    if (!Array.isArray(skill.tags) || skill.tags.length === 0) {
      throw new Error(`${skill.name}: tags must be a non-empty array`);
    }

    const body = readText(skill.path, options);
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) {
      throw new Error(`${skill.name}: missing YAML frontmatter`);
    }
    const declaredName = frontmatter[1].match(/^name:\s*"?([^"\n]+)"?\s*$/m)?.[1];
    if (declaredName !== skill.name) {
      throw new Error(`${skill.name}: frontmatter name is ${declaredName ?? "missing"}`);
    }
  }

  console.log(`Validated ${manifest.skills.length} skills.`);
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(version));
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split(".") : [] };
}

function compareCore(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  return 0;
}

// Semantic-version precedence: a release outranks its prereleases, and numeric
// prerelease identifiers compare numerically (alpha.10 > alpha.9).
function compareSemver(left, right) {
  const core = compareCore(left, right);
  if (core !== 0) return core;
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/u.test(x) && /^\d+$/u.test(y);
    return numeric ? Number(x) - Number(y) : x < y ? -1 : 1;
  }
  return 0;
}

// A dependency names an exact version or a caret range, with npm semver
// semantics. A caret range admits versions at or above its floor that keep the
// left-most non-zero component (^6.3.0 admits 6.x, ^0.2.2 admits 0.2.x). A
// prerelease is admitted only when the floor is a prerelease of the same
// major.minor.patch (^1.0.0-alpha.2 admits 1.0.0-alpha.3 and 1.0.0, not 1.1.0-beta).
function satisfiesVersion(version, requirement) {
  if (!String(requirement).startsWith("^")) return version === requirement;
  const floor = parseSemver(String(requirement).slice(1));
  const actual = parseSemver(version);
  if (floor === null || actual === null) return false;
  if (compareSemver(actual, floor) < 0) return false;
  if (actual.prerelease.length > 0 && (floor.prerelease.length === 0 || compareCore(actual, floor) !== 0)) return false;
  const pinned = floor.core[0] !== 0 ? 1 : floor.core[1] !== 0 ? 2 : 3;
  return floor.core.slice(0, pinned).every((part, index) => actual.core[index] === part);
}

function validatePluginMetadata(options = {}) {
  const marketplacePath = path.join(".claude-plugin", "marketplace.json");
  const marketplace = readJson(marketplacePath, options);
  for (const plugin of marketplace.plugins ?? []) {
    if (typeof plugin.source !== "string") {
      continue;
    }
    const pluginPath = path.posix.join(plugin.source, ".claude-plugin", "plugin.json");
    if (!exists(pluginPath, options)) {
      throw new Error(`${plugin.name}: marketplace source is missing ${pluginPath}`);
    }
    const manifest = readJson(pluginPath, options);
    if (plugin.name !== manifest.name) {
      throw new Error(`${plugin.name}: marketplace name does not match ${pluginPath} name ${manifest.name}`);
    }
    if (plugin.version !== manifest.version) {
      throw new Error(`${plugin.name}: marketplace version ${plugin.version} does not match ${pluginPath} version ${manifest.version}`);
    }
    if (typeof manifest.hooks === "string" && path.posix.normalize(manifest.hooks) === "hooks/hooks.json") {
      throw new Error(`${plugin.name}: ${pluginPath} must not declare hooks/hooks.json; Claude Code loads it automatically and rejects the duplicate`);
    }
  }

  const marketplaceVersions = new Map((marketplace.plugins ?? []).map((plugin) => [plugin.name, plugin.version]));
  for (const plugin of marketplace.plugins ?? []) {
    if (typeof plugin.source !== "string") {
      continue;
    }
    const pluginPath = path.posix.join(plugin.source, ".claude-plugin", "plugin.json");
    for (const dependency of readJson(pluginPath, options).dependencies ?? []) {
      const name = typeof dependency === "string" ? dependency : dependency.name;
      const version = typeof dependency === "string" ? undefined : dependency.version;
      if (!marketplaceVersions.has(name)) {
        throw new Error(`${plugin.name}: ${pluginPath} depends on ${name}, which is not in the marketplace`);
      }
      if (version !== undefined && !satisfiesVersion(marketplaceVersions.get(name), version)) {
        throw new Error(`${plugin.name}: ${pluginPath} requires ${name} ${version}, but the marketplace ships ${marketplaceVersions.get(name)}`);
      }
    }
  }

  console.log("Validated plugin metadata.");
}

function validateDeskMcpPackageScripts(options = {}) {
  const packagePath = path.join("plugins", "desk", "mcp", "package.json");
  const packageJson = readJson(packagePath, options);
  for (const [scriptName, command] of Object.entries(requiredDeskMcpPackageScripts)) {
    if (packageJson.scripts?.[scriptName] !== command) {
      throw new Error(`desk MCP package script ${scriptName} must be ${command}`);
    }
    const targetPath = path.join("plugins", "desk", "mcp", command.replace(/^node\s+scripts\//u, "scripts/"));
    if (!exists(targetPath, options)) {
      throw new Error(`desk MCP package script ${scriptName} target is missing: ${targetPath}`);
    }
  }

  console.log(`Validated ${Object.keys(requiredDeskMcpPackageScripts).length} desk MCP package scripts.`);
}

function runDeskFreshnessChecks(options = {}) {
  const {
    childStdio = "inherit",
    repoRoot = process.cwd(),
    spawnSync = defaultSpawnSync,
  } = options;
  validateDeskMcpPackageScripts(options);

  const usingDeskFoundationResult = spawnSync(process.execPath, ["scripts/test-using-desk-foundation.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((usingDeskFoundationResult.status ?? 1) !== 0) {
    throw new Error("using-desk foundation contract tests failed");
  }

  const gitHygieneContractResult = spawnSync(process.execPath, ["scripts/test-git-hygiene-contracts.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((gitHygieneContractResult.status ?? 1) !== 0) {
    throw new Error("git-hygiene contract tests failed");
  }

  const hostManifestResult = spawnSync(process.execPath, ["scripts/test-desk-host-manifests.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((hostManifestResult.status ?? 1) !== 0) {
    throw new Error("desk host manifest freshness tests failed");
  }

  const generatedArtifactResult = spawnSync(process.execPath, ["scripts/test-desk-generated-artifacts.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((generatedArtifactResult.status ?? 1) !== 0) {
    throw new Error("desk generated artifact freshness tests failed");
  }
}

function listSkillFiles(dir, options, out) {
  let entries;
  try {
    entries = readDir(dir, options);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") {
      continue;
    }
    const full = path.join(dir, entry);
    if (stat(full, options).isDirectory()) {
      listSkillFiles(full, options, out);
    } else if (entry === "SKILL.md") {
      out.push(full);
    }
  }
  return out;
}

// Enforces the Agent Skills spec frontmatter limits on EVERY skill in the repo
// (https://agentskills.io/specification): name <=64 chars + matches its directory,
// description non-empty + <=1024 chars. A description over 1024 chars fails to load
// in the Copilot CLI and other Agent Skills runtimes. The authoring rubric for
// writing tight descriptions lives in the skill-management skill.
function validateSkillDescriptionLimits(options = {}) {
  const maxLen = maxSkillDescriptionLength;
  const maxNameLen = 64;
  const files = [];
  for (const root of ["skills", "plugins"]) {
    if (exists(root, options)) {
      listSkillFiles(root, options, files);
    }
  }
  for (const file of files) {
    const frontmatter = frontmatterBlock(readText(file, options));
    if (!frontmatter) {
      throw new Error(`${file}: missing YAML frontmatter`);
    }
    const name = frontmatterScalar(frontmatter, "name");
    const description = frontmatterScalar(frontmatter, "description");
    const dir = path.basename(path.dirname(file));
    if (!hasText(name)) {
      throw new Error(`${file}: frontmatter name is missing`);
    }
    if (name.length > maxNameLen) {
      throw new Error(`${file}: frontmatter name exceeds ${maxNameLen} characters (${name.length})`);
    }
    if (name !== dir) {
      throw new Error(`${file}: frontmatter name "${name}" does not match directory "${dir}"`);
    }
    if (!hasText(description)) {
      throw new Error(`${file}: frontmatter description is missing`);
    }
    if (description.length > maxLen) {
      throw new Error(`${file}: frontmatter description exceeds ${maxLen} characters (${description.length})`);
    }
  }
  console.log(`Validated ${files.length} skill descriptions within ${maxLen} characters.`);
}

function validateAll(options = {}) {
  validateSkillDescriptionLimits(options);
  validateManifest(options);
  validatePluginMetadata(options);
  runDeskFreshnessChecks(options);
}

function run({
  stderr = process.stderr,
  stdout = process.stdout,
  validateAllFn = validateAll,
  ...options
} = {}) {
  try {
    validateAllFn({ ...options, stderr, stdout });
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function startCli({
  isMain = require.main === module,
  runFn = run,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  if (!isMain) return null;
  const code = runFn();
  setExitCode(code);
  return code;
}

module.exports = {
  readJson,
  run,
  runDeskFreshnessChecks,
  satisfiesVersion,
  startCli,
  validateAll,
  validateDeskMcpPackageScripts,
  validateManifest,
  validatePluginMetadata,
  validateSkillDescriptionLimits,
};

startCli();
