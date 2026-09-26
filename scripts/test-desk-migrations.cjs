#!/usr/bin/env node
"use strict";

// Exercises Desk's session-start migrations without touching a real Claude or
// Agency configuration. A fake `claude` placed first on PATH records every call,
// keeps installed plugins, their manifests and marketplaces in files this test
// controls, models marketplace-scoped dependency errors, and can fail chosen
// commands; HOME, CLAUDE_CONFIG_DIR and AGENCY_TOML all point into a temporary
// directory.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const deskRoot = path.join(repoRoot, "plugins", "desk");
const migrationsDir = path.join(deskRoot, "migrations");
const MOVE_ID = "01-move-to-ourostack-desk";
const MOVE_FILE = path.join(migrationsDir, `${MOVE_ID}.md`);
const TIDY_ID = "02-tidy-desk";
const TIDY_FILE = path.join(migrationsDir, `${TIDY_ID}.md`);
const MOVE_LINE = `Desk has moved to ourostack/desk. Run the move-to-ourostack-desk migration now (desk:session-start-migrations): ${MOVE_FILE}`;
const SECTIONS = ["Detect", "Safety check", "Migrate", "Announce"];
const BASH_SECTIONS = new Set(["Detect", "Safety check", "Migrate"]);

function which(tool) {
  const result = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}
const BASH = which("bash");
assert.ok(which("jq"), "the migration harness needs jq, as Desk's session start does");

// Dependencies each plugin's manifest declares, as on the v2-alpha marketplace.
// Work Suite depends on Plain Language and Ponytail from its own marketplace.
const FAKE_CLAUDE = `#!/usr/bin/env bash
# Test double for the Claude Code CLI. Records every call. Keeps installed plugins
# as "<id>|<scope>|<project path>" lines in a state file, writes each plugin's
# manifest to its install path, keeps marketplaces in the config files the real
# CLI writes, reports marketplace-scoped dependency errors, and fails any call
# matching the FAKE_CLAUDE_FAIL regex.
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_LOG"
if [ -n "\${FAKE_CLAUDE_FAIL:-}" ] && printf '%s\\n' "$*" | grep -Eq "$FAKE_CLAUDE_FAIL"; then
  echo "fake claude: failing $*" >&2
  exit 1
fi
state="$FAKE_CLAUDE_STATE"
touch "$state"
cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
known="$cfg/plugins/known_marketplaces.json"
settings="$cfg/settings.json"
[ "$1" = plugin ] || { echo "fake claude: unexpected arguments: $*" >&2; exit 2; }
shift
cmd="$1"; shift
if [ "$cmd" = marketplace ]; then cmd="marketplace-$1"; shift; fi
scope=user; json=0; pos=()
while [ $# -gt 0 ]; do
  case "$1" in
    --scope|-s) scope="$2"; shift 2 ;;
    --json) json=1; shift ;;
    --keep-data) shift ;;
    -*) echo "fake claude: unknown flag $1" >&2; exit 2 ;;
    *) pos+=("$1"); shift ;;
  esac
done
here="$(pwd -P)"
edit() {
  local file="$1"; shift
  [ -s "$file" ] || { mkdir -p "$(dirname "$file")"; echo '{}' > "$file"; }
  jq "$@" "$file" > "$file.next" && mv "$file.next" "$file"
}
has_marketplace() { [ -s "$known" ] && jq -e --arg n "$1" 'has($n)' "$known" >/dev/null; }
install_path() { printf '%s/plugins/cache/%s/%s/0.0.0' "$cfg" "\${1#*@}" "\${1%@*}"; }
deps_of() {
  case "$1" in
    desk) echo "superpowers plain-language" ;;
    work-suite) echo "plain-language ponytail-upstream" ;;
    legacy-overlay) echo "desk plain-language" ;;
  esac
}
manifest_deps() { jq -r '.dependencies[]? | if type == "string" then . else .name end' "$(install_path "$1")/.claude-plugin/plugin.json" 2>/dev/null; }
installed() { grep -q "^$1|" "$state"; }
add_plugin() {
  local id="$1" sc="$2" project=""
  [ "$sc" = user ] || project="$here"
  installed "$id" || printf '%s|%s|%s\\n' "$id" "$sc" "$project" >> "$state"
  local dir; dir="$(install_path "$id")/.claude-plugin"
  mkdir -p "$dir"
  jq -n --arg n "\${id%@*}" --arg d "$(deps_of "\${id%@*}")" '{name: $n, dependencies: ($d | split(" ") | map(select(length > 0)) | map({name: ., version: "0.0.0"}))}' > "$dir/plugin.json"
}
case "$cmd" in
  list)
    if [ "$json" = 1 ]; then
      out="[]"
      while IFS='|' read -r id sc project; do
        [ -n "$id" ] || continue
        errs="[]"
        for dep in $(manifest_deps "$id"); do
          installed "$dep@\${id#*@}" || errs="$(jq -c --arg e "Dependency \\"$dep@\${id#*@}\\" is not installed" '. + [$e]' <<< "$errs")"
        done
        out="$(jq -c --arg id "$id" --arg sc "$sc" --arg pp "$project" --arg ip "$(install_path "$id")" --argjson errs "$errs" \\
          '. + [{id: $id, scope: $sc, enabled: true, installPath: $ip} + (if $pp == "" then {} else {projectPath: $pp} end) + (if ($errs | length) > 0 then {errors: $errs} else {} end)]' <<< "$out")"
      done < "$state"
      printf '%s\\n' "$out"
    elif [ ! -s "$state" ]; then
      echo "No plugins installed."
    else
      printf 'Installed plugins:\\n\\n'
      while IFS='|' read -r id sc project; do
        printf '  \\342\\235\\257 %s\\n    Version: 0.0.0\\n    Scope: %s\\n    Status: \\342\\234\\224 enabled\\n\\n' "$id" "$sc"
      done < "$state"
    fi
    ;;
  install)
    id="\${pos[0]}"
    has_marketplace "\${id#*@}" || { echo "Marketplace \${id#*@} not found" >&2; exit 1; }
    add_plugin "$id" "$scope"
    if [ -z "\${FAKE_CLAUDE_NO_DEPS:-}" ]; then
      for dep in $(deps_of "\${id%@*}"); do add_plugin "$dep@\${id#*@}" user; done
    fi
    ;;
  uninstall)
    id="\${pos[0]}"
    line="$(grep "^$id|$scope|" "$state" | head -n 1)"
    [ -n "$line" ] || { echo "Plugin \\"$id\\" is not installed in $scope scope" >&2; exit 1; }
    project="\${line##*|}"
    if [ -n "$project" ] && [ "$project" != "$here" ]; then echo "Plugin \\"$id\\" is not installed in this project" >&2; exit 1; fi
    grep -vxF "$line" "$state" > "$state.next"; mv "$state.next" "$state"
    # Like the real CLI: removing a plugin another plugin depends on only warns.
    while IFS='|' read -r other sc pp; do
      [ "\${other#*@}" = "\${id#*@}" ] || continue
      for dep in $(manifest_deps "$other"); do
        [ "$dep" = "\${id%@*}" ] && echo "warning: $id is required by $other" >&2
      done
    done < "$state"
    ;;
  marketplace-add)
    src="\${pos[0]}"; repo="\${src%%#*}"
    case "$repo" in
      ourostack/desk) name=ourostack ;;
      ourostack/ouroboros-skills) name=ouroboros-skills ;;
      *) echo "fake claude: unknown marketplace $src" >&2; exit 2 ;;
    esac
    if [ "$src" = "$repo" ]; then source="{\\"source\\":\\"github\\",\\"repo\\":\\"$repo\\"}"; else source="{\\"source\\":\\"github\\",\\"repo\\":\\"$repo\\",\\"ref\\":\\"\${src#*#}\\"}"; fi
    edit "$known" --arg n "$name" --argjson s "$source" '.[$n] = ((.[$n] // {}) + {source: $s})'
    edit "$settings" --arg n "$name" --argjson s "$source" '.extraKnownMarketplaces[$n] = ((.extraKnownMarketplaces[$n] // {}) + {source: $s})'
    ;;
  marketplace-update)
    has_marketplace "\${pos[0]}" || { echo "Marketplace \${pos[0]} not found" >&2; exit 1; }
    ;;
  marketplace-remove)
    name="\${pos[0]}"
    has_marketplace "$name" || { echo "Marketplace $name not found" >&2; exit 1; }
    edit "$known" --arg n "$name" 'del(.[$n])'
    edit "$settings" --arg n "$name" 'del(.extraKnownMarketplaces[$n])'
    grep -v "^[^|]*@$name|" "$state" > "$state.next"; mv "$state.next" "$state"
    ;;
  *)
    echo "fake claude: unexpected arguments: plugin $cmd" >&2
    exit 2
    ;;
esac
`;

function parseMigration(file) {
  const text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const stem = path.basename(file, ".md");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(text);
  assert.ok(match, `${stem}: missing YAML frontmatter`);
  const frontmatter = Object.fromEntries(
    match[1].split("\n").filter(Boolean).map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
  assert.equal(frontmatter.id, stem, `${stem}: frontmatter id must match the filename stem`);
  assert.ok(frontmatter.description, `${stem}: frontmatter needs a description`);
  assert.equal(frontmatter.safety, "safe", `${stem}: only safety: safe is implemented`);
  assert.match(frontmatter.needs_restart, /^(true|false)$/u, `${stem}: needs_restart must be true or false`);
  if (frontmatter.agent_work !== undefined) {
    assert.match(frontmatter.agent_work, /^(true|false)$/u, `${stem}: agent_work must be true or false`);
  }

  const parts = match[2].split(/^## (.+)$/mu);
  assert.equal(parts[0].trim(), "", `${stem}: no text may precede the first section`);
  const headings = [];
  const blocks = {};
  for (let index = 1; index < parts.length; index += 2) {
    const heading = parts[index].trim();
    const body = parts[index + 1].trim();
    headings.push(heading);
    if (BASH_SECTIONS.has(heading)) {
      const fence = /^```bash\n([\s\S]*?)\n```$/u.exec(body);
      assert.ok(fence && !fence[1].includes("```"), `${stem}: section ${heading} must hold exactly one fenced bash block`);
      blocks[heading] = fence[1];
    } else {
      // The driver prints Announce verbatim, so it is plain text, never a code fence.
      assert.ok(body.length > 0 && !body.includes("```"), `${stem}: Announce must be plain text without a code fence`);
      blocks[heading] = body;
    }
  }
  assert.deepEqual(headings, SECTIONS, `${stem}: sections must be ${SECTIONS.join(", ")} in that order`);
  return { frontmatter, blocks };
}

// Tools the migration blocks and the fake use, for sandboxes with a restricted PATH.
const BLOCK_TOOLS = ["bash", "sh", "grep", "sed", "awk", "cp", "cat", "rm", "mv", "mkdir", "mktemp", "dirname", "head", "jq", "git", "sort", "paste", "tr", "touch"];

function makeSandbox({
  installed = [],
  oldRef,
  agencyToml = null,
  agencyBak = null,
  symlinkToml = false,
  oldBinding = null,
  newBinding = null,
  claude = true,
  withoutJq = false,
  fail = "",
  noDeps = false,
  alsoNew = false,
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desk-migration-")));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const cfg = path.join(root, "claude-config");
  const project = path.join(root, "project");
  for (const dir of [bin, home, cfg, project]) fs.mkdirSync(dir);
  const sandbox = {
    root,
    home,
    cfg,
    project,
    fakeClaude: path.join(bin, "claude"),
    state: path.join(root, "claude-installed.txt"),
    log: path.join(root, "claude-calls.log"),
    toml: path.join(root, "agency.toml"),
    tomlTarget: path.join(root, "dotfiles", "agency.toml"),
    settings: path.join(cfg, "settings.json"),
    known: path.join(cfg, "plugins", "known_marketplaces.json"),
    oldBinding: path.join(cfg, "plugins", "data", "desk-ouroboros-skills", "desk.activation.json"),
    newBinding: path.join(cfg, "plugins", "data", "desk-ourostack", "desk.activation.json"),
  };
  if (claude) fs.writeFileSync(sandbox.fakeClaude, FAKE_CLAUDE, { mode: 0o755 });
  // The Safety check requires gh; a stub keeps the test independent of the runner's tools.
  fs.writeFileSync(path.join(bin, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(sandbox.state, "");
  fs.writeFileSync(sandbox.log, "");
  fs.writeFileSync(sandbox.settings, `${JSON.stringify({ autoMemoryEnabled: false, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2)}\n`);
  if (agencyToml !== null) {
    if (symlinkToml) {
      fs.mkdirSync(path.dirname(sandbox.tomlTarget));
      fs.writeFileSync(sandbox.tomlTarget, agencyToml);
      fs.symlinkSync(sandbox.tomlTarget, sandbox.toml);
    } else {
      fs.writeFileSync(sandbox.toml, agencyToml);
    }
  }
  if (agencyBak !== null) fs.writeFileSync(`${sandbox.toml}.bak`, agencyBak);
  for (const [file, content] of [[sandbox.oldBinding, oldBinding], [sandbox.newBinding, newBinding]]) {
    if (content === null) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  let searchPath = `${bin}${path.delimiter}${process.env.PATH}`;
  if (!claude || withoutJq) {
    // A PATH holding only the tools the blocks use, so no real claude (or, if asked, no jq) can be found.
    const tools = path.join(root, "tools");
    fs.mkdirSync(tools);
    for (const tool of BLOCK_TOOLS) {
      if (withoutJq && tool === "jq") continue;
      const found = which(tool);
      if (found) fs.symlinkSync(found, path.join(tools, tool));
    }
    searchPath = `${bin}${path.delimiter}${tools}`;
  }
  sandbox.env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    AGENCY_TOML: sandbox.toml,
    FAKE_CLAUDE_LOG: sandbox.log,
    FAKE_CLAUDE_STATE: sandbox.state,
    FAKE_CLAUDE_FAIL: "",
    FAKE_CLAUDE_NO_DEPS: noDeps ? "1" : "",
  };
  // Seed the old install through the fake itself, as a user would have: the old marketplace, then each plugin.
  if (claude && oldRef !== undefined) {
    const seed = (args, cwd = root) => {
      const result = spawnSync(sandbox.fakeClaude, args, { cwd, env: sandbox.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    seed(["plugin", "marketplace", "add", `ourostack/ouroboros-skills${oldRef ? `#${oldRef}` : ""}`]);
    const settings = json(sandbox.settings);
    settings.extraKnownMarketplaces["ouroboros-skills"].autoUpdate = true;
    fs.writeFileSync(sandbox.settings, `${JSON.stringify(settings, null, 2)}\n`);
    for (const entry of installed) {
      const [id, scope = "user"] = entry.split(" ");
      seed(["plugin", "install", "--scope", scope, id], scope === "user" ? root : project);
    }
    if (alsoNew) {
      // The new Desk installed out of band, for example by following ourostack/desk SETUP.md before migrating.
      seed(["plugin", "marketplace", "add", "ourostack/desk"]);
      seed(["plugin", "install", "desk@ourostack"]);
    }
    fs.writeFileSync(sandbox.log, "");
  } else if (claude) {
    for (const entry of installed) {
      const [id, scope = "user"] = entry.split(" ");
      fs.appendFileSync(sandbox.state, `${id}|${scope}|\n`);
    }
  }
  sandbox.env.PATH = searchPath;
  sandbox.env.FAKE_CLAUDE_FAIL = fail;
  // Guard: never let a migration block reach the operator's real CLI or configuration.
  const resolved = spawnSync(BASH, ["-c", "command -v claude"], { env: sandbox.env, encoding: "utf8" });
  assert.equal(resolved.stdout.trim(), claude ? sandbox.fakeClaude : "", "only the fake claude may be reachable");
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "AGENCY_TOML"]) {
    assert.ok(sandbox.env[key].startsWith(root), `${key} must point into the sandbox`);
  }
  return sandbox;
}

function run(sandbox, script) {
  return spawnSync(BASH, ["-c", script], { cwd: sandbox.root, env: sandbox.env, encoding: "utf8" });
}

// The session-start-migrations driver: Detect; when it fires, Safety check and Migrate; on success, Migrate's report, then Announce verbatim.
function drive(sandbox, blocks) {
  if (run(sandbox, blocks.Detect).status !== 0) return { fired: false };
  const safety = run(sandbox, blocks["Safety check"]);
  assert.equal(safety.status, 0, safety.stdout + safety.stderr);
  const migrate = run(sandbox, blocks.Migrate);
  return {
    fired: true,
    migrate,
    shown: migrate.status === 0 ? `${migrate.stdout}${blocks.Announce}` : null,
  };
}

function calls(sandbox) {
  return fs.readFileSync(sandbox.log, "utf8").split("\n").filter(Boolean);
}

function mutatingCalls(sandbox) {
  return calls(sandbox).filter((line) => !/^plugin list/u.test(line));
}

function pluginList(sandbox) {
  const result = spawnSync(sandbox.fakeClaude, ["plugin", "list", "--json"], { env: sandbox.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function installedIds(sandbox) {
  return pluginList(sandbox).map((plugin) => `${plugin.id} ${plugin.scope}`).sort();
}

function assertNoLoadErrors(sandbox) {
  const broken = pluginList(sandbox).filter((plugin) => plugin.errors?.length);
  assert.deepEqual(broken.map((plugin) => `${plugin.id}: ${plugin.errors.join("; ")}`), [], "every remaining plugin must still load");
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function json(file) {
  return JSON.parse(read(file));
}

const tests = [];
function test(name, body) {
  tests.push({ name, body });
}

const migrationFiles = fs.existsSync(migrationsDir)
  ? fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".md")).sort()
  : [];

test("Desk ships the move-to-ourostack-desk migration", () => {
  assert.ok(migrationFiles.includes(`${MOVE_ID}.md`), `plugins/desk/migrations/${MOVE_ID}.md is missing`);
});

for (const name of migrationFiles) {
  test(`${name} follows the migration file format`, () => {
    parseMigration(path.join(migrationsDir, name));
  });
}

function moveMigration() {
  const migration = parseMigration(MOVE_FILE);
  assert.equal(migration.frontmatter.needs_restart, "true");
  assert.doesNotMatch(migration.blocks.Announce, /Claude Code|Agency|agency\.toml|Work Suite/u, "Announce is shown on every machine, so it names no side that may not have moved");
  return migration.blocks;
}

function withSandbox(options, body) {
  const sandbox = makeSandbox(options);
  try {
    body(sandbox);
    assert.equal(fs.existsSync(path.join(sandbox.home, ".claude")), false, "CLAUDE_CONFIG_DIR must be honored instead of ~/.claude");
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
}

const OLD_BINDING = '{"schema_version":1,"desk":{"root":"/tmp/old-desk"}}\n';
const V2 = (name, ref = "v2-alpha") => `github:ourostack/ouroboros-skills:plugins/${name}@${ref}`;
const MOVED = (name) => `github:ourostack/desk:plugins/${name}@main`;
const toml = (coordinates) => coordinates.map((coordinate) => `[[plugins.default]]\nplugin = "${coordinate}"\n`).join("\n");
const V1_LINES = [
  "github:ourostack/ouroboros-skills:plugins/desk@main",
  "github:ourostack/ouroboros-skills:plugins/crew",
  "github:ourostack/ouroboros-skills:plugins/work-suite@v2-alpha",
  "github:ourostack/ouroboros-skills:plugins/desk@v2-alpha-old",
  "github:example/other:plugins/unrelated@main",
];
const OLD_TOML = toml([V2("desk"), V2("superpowers"), V2("plain-language"), V2("crew"), ...V1_LINES]);
const NEW_TOML = toml([MOVED("desk"), MOVED("superpowers"), MOVED("plain-language"), MOVED("crew"), ...V1_LINES]);
const USER_BAK = "# the user's own agency.toml.bak\n";

test("a V2 Claude and Agency user with no V1 plugins moves completely and loses nothing", () => {
  const blocks = moveMigration();
  withSandbox({
    installed: ["desk@ouroboros-skills", "crew@ouroboros-skills project"],
    oldRef: "v2-alpha",
    agencyToml: OLD_TOML,
    agencyBak: USER_BAK,
    oldBinding: OLD_BINDING,
  }, (sandbox) => {
    const first = drive(sandbox, blocks);
    assert.ok(first.fired, "Detect must fire for a V2 install");
    assert.equal(first.migrate.status, 0, first.migrate.stdout + first.migrate.stderr);
    assert.deepEqual(mutatingCalls(sandbox), [
      "plugin marketplace add ourostack/desk",
      "plugin marketplace update ourostack",
      "plugin install --scope project crew@ourostack",
      "plugin install --scope user superpowers@ourostack",
      "plugin install --scope user plain-language@ourostack",
      "plugin install --scope user desk@ourostack",
      "plugin uninstall --scope project --keep-data crew@ouroboros-skills",
      "plugin uninstall --scope user --keep-data desk@ouroboros-skills",
      "plugin uninstall --scope user --keep-data superpowers@ouroboros-skills",
      "plugin uninstall --scope user --keep-data plain-language@ouroboros-skills",
      "plugin marketplace remove ouroboros-skills",
    ], "Migrate must issue the Claude plugin commands in order");
    assert.deepEqual(installedIds(sandbox), [
      "crew@ourostack project",
      "desk@ourostack user",
      "plain-language@ourostack user",
      "superpowers@ourostack user",
    ], "Desk and its companions, including the project-scope Crew, come back from ourostack");
    assert.equal(pluginList(sandbox).find((plugin) => plugin.id === "crew@ourostack").projectPath, sandbox.project, "Crew is reinstalled in its own project");
    assertNoLoadErrors(sandbox);

    const settings = json(sandbox.settings);
    assert.deepEqual(settings.extraKnownMarketplaces, {
      ourostack: { source: { source: "github", repo: "ourostack/desk" }, autoUpdate: true },
    }, "the new marketplace keeps automatic updates and the old one is gone");
    assert.equal(settings.autoMemoryEnabled, false, "other settings are preserved");
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "echo mine", "other settings are preserved");

    assert.equal(read(sandbox.newBinding), OLD_BINDING, "the desk binding carries over to desk-ourostack");
    assert.equal(read(sandbox.oldBinding), OLD_BINDING, "the old binding is copied, not moved");

    assert.equal(read(sandbox.toml), NEW_TOML, "only @v2-alpha coordinates move; V1 and other entries stay");
    assert.equal(read(`${sandbox.toml}.pre-ourostack-desk`), OLD_TOML, "the backup holds the original agency.toml");
    assert.equal(read(`${sandbox.toml}.bak`), USER_BAK, "the user's own agency.toml.bak is untouched");

    assert.equal(first.shown, [
      `Agency: ${sandbox.toml} now tracks github:ourostack/desk:plugins/<name>@main for crew desk plain-language superpowers. The original file is kept as ${sandbox.toml}.pre-ourostack-desk.`,
      "Its other ourostack/ouroboros-skills entries stay as they are.",
      "Claude Code: crew@ourostack, superpowers@ourostack, plain-language@ourostack, desk@ourostack now run from the ourostack marketplace (ourostack/desk), with automatic updates on.",
      "Your desk binding carried over to the new install.",
      "The old ouroboros-skills marketplace is removed.",
      blocks.Announce,
    ].join("\n"), "the operator sees exactly what changed on this machine, then Announce");
    assert.doesNotMatch(first.shown, /V1 plugins stay/u);

    // A second session: Detect stays quiet, so Migrate never runs again.
    fs.writeFileSync(sandbox.log, "");
    assert.equal(drive(sandbox, blocks).fired, false, "Detect must not fire after the move");
    // Even run directly, a second Migrate changes nothing.
    const again = run(sandbox, blocks.Migrate);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, "", "a second Migrate has nothing to report");
    assert.deepEqual(mutatingCalls(sandbox), [], "a second Migrate is a no-op");
    assert.equal(read(sandbox.toml), NEW_TOML);
    assert.equal(read(`${sandbox.toml}.pre-ourostack-desk`), OLD_TOML);
  });
});

test("Work Suite keeps loading: its Plain Language stays, and the report names the V1 removal commands", () => {
  const blocks = moveMigration();
  withSandbox({
    installed: ["desk@ouroboros-skills", "work-suite@ouroboros-skills"],
    oldRef: "v2-alpha",
  }, (sandbox) => {
    const result = drive(sandbox, blocks);
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.ok(!mutatingCalls(sandbox).includes("plugin uninstall --scope user --keep-data plain-language@ouroboros-skills"), "Work Suite's dependency must not be uninstalled");
    assert.ok(!mutatingCalls(sandbox).includes("plugin marketplace remove ouroboros-skills"));
    assert.deepEqual(installedIds(sandbox), [
      "desk@ourostack user",
      "plain-language@ouroboros-skills user",
      "plain-language@ourostack user",
      "ponytail-upstream@ouroboros-skills user",
      "superpowers@ourostack user",
      "work-suite@ouroboros-skills user",
    ]);
    assertNoLoadErrors(sandbox);
    assert.ok(json(sandbox.settings).extraKnownMarketplaces["ouroboros-skills"], "the old marketplace entry stays");
    assert.equal(result.shown, [
      "Claude Code: superpowers@ourostack, plain-language@ourostack, desk@ourostack now run from the ourostack marketplace (ourostack/desk), with automatic updates on.",
      "These V1 plugins stay installed from the old ouroboros-skills marketplace: plain-language@ouroboros-skills, ponytail-upstream@ouroboros-skills, work-suite@ouroboros-skills.",
      "plain-language@ouroboros-skills stays because work-suite@ouroboros-skills depends on it.",
      "V2 in ourostack/desk replaces V1. When you no longer need them, remove them with:",
      "  claude plugin uninstall work-suite@ouroboros-skills",
      "  claude plugin uninstall ponytail-upstream@ouroboros-skills",
      "  claude plugin uninstall plain-language@ouroboros-skills",
      "  claude plugin marketplace remove ouroboros-skills",
      blocks.Announce,
    ].join("\n"));
    assert.equal(drive(sandbox, blocks).fired, false, "Detect goes quiet although the old marketplace stays on v2-alpha");
  });
});

test("an unreadable manifest keeps the companions but always removes the old Desk", () => {
  const blocks = moveMigration();
  withSandbox({ installed: ["desk@ouroboros-skills", "work-suite@ouroboros-skills"], oldRef: "v2-alpha" }, (sandbox) => {
    fs.rmSync(path.join(sandbox.cfg, "plugins", "cache", "ouroboros-skills", "work-suite", "0.0.0", ".claude-plugin", "plugin.json"));
    const result = drive(sandbox, blocks);
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.deepEqual(mutatingCalls(sandbox).filter((line) => line.startsWith("plugin uninstall")), [
      "plugin uninstall --scope user --keep-data desk@ouroboros-skills",
    ], "only the old Desk is uninstalled when dependencies are unknown");
    assert.ok(!installedIds(sandbox).includes("desk@ouroboros-skills user"), "the old Desk (and its nagging hook) is gone");
    assert.match(result.shown, /superpowers@ouroboros-skills stays because the dependencies of work-suite@ouroboros-skills could not be read\./u);
    assert.match(result.shown, /plain-language@ouroboros-skills stays because the dependencies of work-suite@ouroboros-skills could not be read\./u);
    assert.doesNotMatch(result.shown, /desk@ouroboros-skills/u);
    assert.equal(drive(sandbox, blocks).fired, false, "Detect goes quiet once the old Desk is gone");
  });
});

test("a V1 plugin that names the old Desk as a dependency keeps its companion but not the old Desk", () => {
  const blocks = moveMigration();
  withSandbox({ installed: ["desk@ouroboros-skills", "legacy-overlay@ouroboros-skills"], oldRef: "v2-alpha" }, (sandbox) => {
    const result = drive(sandbox, blocks);
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.ok(!installedIds(sandbox).includes("desk@ouroboros-skills user"), "the old Desk is always removed once the new Desk is installed");
    assert.ok(installedIds(sandbox).includes("plain-language@ouroboros-skills user"), "the companion it names stays");
    assert.match(result.shown, /plain-language@ouroboros-skills stays because legacy-overlay@ouroboros-skills depends on it\./u);
    assert.equal(drive(sandbox, blocks).fired, false);
  });
});

test("a machine with both the old and the new Desk installed migrates cleanly", () => {
  const blocks = moveMigration();
  withSandbox({ installed: ["desk@ouroboros-skills"], oldRef: "v2-alpha", alsoNew: true, oldBinding: OLD_BINDING }, (sandbox) => {
    const result = drive(sandbox, blocks);
    assert.ok(result.fired, "Detect keys on the old V2 install even when desk@ourostack exists");
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.deepEqual(mutatingCalls(sandbox), [
      "plugin marketplace add ourostack/desk",
      "plugin marketplace update ourostack",
      "plugin uninstall --scope user --keep-data desk@ouroboros-skills",
      "plugin uninstall --scope user --keep-data superpowers@ouroboros-skills",
      "plugin uninstall --scope user --keep-data plain-language@ouroboros-skills",
      "plugin marketplace remove ouroboros-skills",
    ], "nothing already installed from ourostack is reinstalled; the old copies are cleaned up");
    assert.deepEqual(installedIds(sandbox), ["desk@ourostack user", "plain-language@ourostack user", "superpowers@ourostack user"]);
    assertNoLoadErrors(sandbox);
    assert.equal(json(sandbox.settings).extraKnownMarketplaces.ourostack.autoUpdate, true, "automatic updates are turned on");
    assert.equal(read(sandbox.newBinding), OLD_BINDING, "the desk binding carries over");
    assert.equal(drive(sandbox, blocks).fired, false, "the second Detect exits 1");
  });
});

test("a project-scope V1 plugin's removal command runs from its project directory", () => {
  const blocks = moveMigration();
  withSandbox({ installed: ["desk@ouroboros-skills", "work-suite@ouroboros-skills project"], oldRef: "v2-alpha" }, (sandbox) => {
    const result = drive(sandbox, blocks);
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.ok(result.shown.includes(`\n  cd ${sandbox.project} && claude plugin uninstall --scope project work-suite@ouroboros-skills\n`), result.shown);
    assertNoLoadErrors(sandbox);
    // The printed command works as printed.
    const removal = spawnSync(BASH, ["-c", `cd ${sandbox.project} && claude plugin uninstall --scope project work-suite@ouroboros-skills`], { cwd: sandbox.home, env: sandbox.env, encoding: "utf8" });
    assert.equal(removal.status, 0, removal.stderr);
  });
});

test("a failed uninstall stops with a clear message, keeps the backup and converges once fixed", () => {
  const blocks = moveMigration();
  withSandbox({
    installed: ["desk@ouroboros-skills"],
    oldRef: "v2-alpha",
    agencyToml: OLD_TOML,
    oldBinding: OLD_BINDING,
    fail: "^plugin uninstall .*desk@ouroboros-skills$",
  }, (sandbox) => {
    const first = drive(sandbox, blocks);
    assert.ok(first.fired);
    assert.notEqual(first.migrate.status, 0, "Migrate must report the failure to the driver");
    assert.match(first.migrate.stderr, /could not uninstall: desk@ouroboros-skills\. Uninstall each with 'claude plugin uninstall <plugin>'/u);
    assert.ok(!mutatingCalls(sandbox).includes("plugin marketplace remove ouroboros-skills"), "the old marketplace stays while an old plugin remains");
    assert.equal(read(sandbox.toml), NEW_TOML);
    assert.equal(read(`${sandbox.toml}.pre-ourostack-desk`), OLD_TOML);

    // Before the next session a dotfiles sync brings an old coordinate back.
    fs.writeFileSync(sandbox.toml, `${OLD_TOML}# synced from dotfiles\n`);
    // The old Desk is still installed, so Detect fires again: nothing is reinstalled and the same failure is reported.
    fs.writeFileSync(sandbox.log, "");
    const second = drive(sandbox, blocks);
    assert.ok(second.fired, "Detect keeps firing while the old Desk is installed");
    assert.notEqual(second.migrate.status, 0);
    assert.ok(!mutatingCalls(sandbox).some((line) => line.startsWith("plugin install")), "nothing already on ourostack is reinstalled");
    assert.equal(read(`${sandbox.toml}.pre-ourostack-desk`), OLD_TOML, "a rerun never overwrites the original backup");
    assert.equal(read(sandbox.toml), `${NEW_TOML}# synced from dotfiles\n`);

    // Once the uninstall works, the next session finishes the move and Detect goes quiet.
    sandbox.env.FAKE_CLAUDE_FAIL = "";
    const third = drive(sandbox, blocks);
    assert.equal(third.migrate.status, 0, third.migrate.stderr);
    assert.deepEqual(installedIds(sandbox), ["desk@ourostack user", "plain-language@ourostack user", "superpowers@ourostack user"]);
    assert.ok(third.shown.includes("The old ouroboros-skills marketplace is removed."));
    assert.equal(drive(sandbox, blocks).fired, false);
    assert.equal(read(`${sandbox.toml}.pre-ourostack-desk`), OLD_TOML);
  });
});

test("Superpowers and Plain Language are installed explicitly when Desk does not pull them in", () => {
  const blocks = moveMigration();
  withSandbox({ installed: ["desk@ouroboros-skills"], oldRef: "v2-alpha", noDeps: true }, (sandbox) => {
    // Seeding without dependencies: add them as the old Desk install would have.
    for (const id of ["superpowers@ouroboros-skills", "plain-language@ouroboros-skills"]) {
      const seed = spawnSync(sandbox.fakeClaude, ["plugin", "install", id], { cwd: sandbox.root, env: sandbox.env, encoding: "utf8" });
      assert.equal(seed.status, 0, seed.stderr);
    }
    const result = drive(sandbox, blocks);
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.deepEqual(installedIds(sandbox), ["desk@ourostack user", "plain-language@ourostack user", "superpowers@ourostack user"]);
    assertNoLoadErrors(sandbox);
  });
});

test("an existing desk-ourostack binding is never overwritten, and a Claude-only move reports only Claude", () => {
  const blocks = moveMigration();
  const newer = '{"schema_version":1,"desk":{"root":"/tmp/new-desk"}}\n';
  withSandbox({ installed: ["desk@ouroboros-skills"], oldRef: "v2-alpha", oldBinding: OLD_BINDING, newBinding: newer }, (sandbox) => {
    const result = drive(sandbox, blocks);
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.equal(read(sandbox.newBinding), newer);
    assert.equal(fs.existsSync(sandbox.toml), false, "Migrate must not create agency.toml");
    assert.match(result.shown, /^Claude Code: /u);
    assert.doesNotMatch(result.shown, /Agency|agency\.toml|binding carried over|V1/u);
  });
});

test("V1 installs are never moved", () => {
  const blocks = moveMigration();
  const v1Toml = toml(V1_LINES);
  for (const oldRef of ["main", null]) {
    withSandbox({ installed: ["desk@ouroboros-skills"], oldRef, agencyToml: v1Toml }, (sandbox) => {
      assert.equal(run(sandbox, blocks.Detect).status, 1, `Detect must not fire for a marketplace on ${oldRef ?? "no ref"}`);
      const migrate = run(sandbox, blocks.Migrate);
      assert.equal(migrate.status, 0, migrate.stderr);
      assert.equal(migrate.stdout, "");
      assert.deepEqual(mutatingCalls(sandbox), [], "Migrate must leave a V1 Claude install alone");
      assert.equal(read(sandbox.toml), v1Toml, "@main, no-ref and other coordinates stay untouched");
      assert.equal(fs.existsSync(`${sandbox.toml}.pre-ourostack-desk`), false);
    });
  }
});

test("an Agency user without Claude Code moves, a symlinked agency.toml stays a symlink, and the report names only Agency", () => {
  const blocks = moveMigration();
  withSandbox({ claude: false, agencyToml: OLD_TOML, agencyBak: USER_BAK, symlinkToml: true }, (sandbox) => {
    const result = drive(sandbox, blocks);
    assert.ok(result.fired, "Detect must fire on agency.toml alone");
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.ok(fs.lstatSync(sandbox.toml).isSymbolicLink(), "agency.toml must stay a symlink");
    assert.equal(read(sandbox.tomlTarget), NEW_TOML, "the symlink target holds the rewrite");
    assert.equal(read(`${sandbox.toml}.pre-ourostack-desk`), OLD_TOML);
    assert.equal(read(`${sandbox.toml}.bak`), USER_BAK);
    assert.deepEqual(calls(sandbox), [], "no claude exists to call");
    assert.match(result.shown, /^Agency: /u);
    assert.doesNotMatch(result.shown, /Claude Code|binding|V1 plugins/u);
    assert.equal(drive(sandbox, blocks).fired, false);
  });
});

test("an Agency move is not blocked on a machine with Claude Code but no jq and only a V1 Claude install", () => {
  const blocks = moveMigration();
  withSandbox({ installed: ["desk@ouroboros-skills"], oldRef: "main", agencyToml: OLD_TOML, withoutJq: true }, (sandbox) => {
    assert.equal(spawnSync(BASH, ["-c", "command -v jq"], { env: sandbox.env }).status, 1, "jq must be absent");
    const result = drive(sandbox, blocks);
    assert.ok(result.fired);
    assert.equal(result.migrate.status, 0, result.migrate.stderr);
    assert.equal(read(sandbox.toml), NEW_TOML);
    assert.deepEqual(mutatingCalls(sandbox), []);
    assert.doesNotMatch(result.shown, /Claude Code/u);
  });
});

test("a machine already on ourostack/desk, or with no Desk, never runs the migration", () => {
  const blocks = moveMigration();
  withSandbox({ installed: ["desk@ourostack", "superpowers@ourostack", "plain-language@ourostack"], agencyToml: toml([MOVED("desk")]) }, (sandbox) => {
    assert.equal(run(sandbox, blocks.Detect).status, 1);
  });
  withSandbox({}, (sandbox) => {
    assert.equal(run(sandbox, blocks.Detect).status, 1);
  });
});

// ── 02-tidy-desk: the one-time tidy ───────────────────────────────────────
//
// Detect runs Desk's own organization checks (the doctor's findings) against
// fixture desks in temporary folders; nothing here touches a real desk. The
// blocks run from a copy of the plugin with no node_modules, exactly as an
// installed plugin has none, and also from this checkout.

const TIDY_NOW = new Date();
const RECENT = new Date(TIDY_NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
const STALE = new Date(TIDY_NOW.getTime() - 55 * 24 * 60 * 60 * 1000).toISOString();
const CARD_SECRET = "a1b2c3d4e5f6a7b8c9d0";

function card(fields, body = "") {
  const lines = Object.entries(fields).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}:\n${value.map((item) => `  - '${item}'`).join("\n")}`;
    return `${key}: ${typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : value}`;
  });
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function put(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function task(track, slug, extra = {}) {
  return card({ schema_version: 1, title: slug, status: "processing", created: RECENT, updated: RECENT, track, ...extra });
}

// M4-3's clean fixture: one scoped track holding one well-named, current task.
function cleanDesk(root) {
  put(root, "billing-disputes/track.md", card({ schema_version: 1, title: "billing-disputes", status: "active", scope: "billing disputes; not payroll" }));
  put(root, "billing-disputes/refund-flow-cleanup/task.md", task("billing-disputes", "refund-flow-cleanup"));
  fs.mkdirSync(path.join(root, "_meta"), { recursive: true });
  fs.mkdirSync(path.join(root, "_archive"), { recursive: true });
  put(root, "AGENTS.md", "# Agents\n");
  put(root, "artifacts/publication-policy.json", "{}\n");
}

// M4-3's messy fixture: one of each organization finding. The person-named track is named after the fixture repository's git user.
function messyDesk(root) {
  put(root, "no-scope-track/track.md", card({ schema_version: 1, title: "no-scope-track", status: "active" }));
  put(root, "no-scope-track/keep-things-tidy/task.md", task("no-scope-track", "keep-things-tidy"));
  put(root, "fixture-owner/track.md", card({ schema_version: 1, title: "fixture-owner", status: "active", scope: "a track named after a person; not anything else" }));
  put(root, "fixture-owner/some-real-outcome/task.md", task("fixture-owner", "some-real-outcome"));
  put(root, "inbox/track.md", card({ schema_version: 1, title: "inbox", status: "active", scope: "a catch-all track; not a real outcome" }));
  put(root, "inbox/some-real-outcome/task.md", task("inbox", "some-real-outcome"));
  put(root, "no-tasks-yet/track.md", card({ schema_version: 1, title: "no-tasks-yet", status: "active", scope: "an outcome with no tasks yet; not anything else" }));
  put(root, "normal-track/track.md", card({ schema_version: 1, title: "normal-track", status: "active", scope: "holds the task-level findings; not anything else" }));
  put(root, "normal-track/hi-please-fix-this/task.md", task("normal-track", "hi-please-fix-this"));
  put(root, `normal-track/rotate-${CARD_SECRET}/task.md`, task("normal-track", `rotate-${CARD_SECRET}`));
  put(root, "normal-track/oneword/task.md", task("normal-track", "oneword"));
  put(root, "normal-track/aging-cleanup-effort/task.md", task("normal-track", "aging-cleanup-effort", { created: STALE, updated: STALE }));
  put(root, "normal-track/finished-long-ago/task.md", task("normal-track", "finished-long-ago", { status: "done", created: STALE, updated: STALE }));
  put(root, "normal-track/ship-the-refactor/task.md", task("normal-track", "ship-the-refactor", { status: "validating", artifacts: ["https://github.com/ourostack/desk/pull/4242"] }));
  put(root, "normal-track/land-the-same-refactor/task.md", task("normal-track", "land-the-same-refactor", { status: "validating" }) + "Delivery ref: https://github.com/ourostack/desk/pull/4242\n");
  put(root, "scratch-notes.txt", "stray notes\n");
  put(root, "normal-track/stray-draft.md", "not a task card\n");
  for (const name of ["AGENTS.md", "README.md", "CLAUDE.md", ".gitignore"]) put(root, name, "\n");
  fs.mkdirSync(path.join(root, "_meta"), { recursive: true });
}

// An installed plugin: the migration, the MCP's own source and the script, and no node_modules.
function installedPluginCopy(root) {
  const plugin = path.join(root, "installed-desk");
  fs.mkdirSync(path.join(plugin, "migrations"), { recursive: true });
  fs.copyFileSync(TIDY_FILE, path.join(plugin, "migrations", `${TIDY_ID}.md`));
  fs.cpSync(path.join(deskRoot, "mcp", "src"), path.join(plugin, "mcp", "src"), { recursive: true });
  fs.mkdirSync(path.join(plugin, "mcp", "scripts"), { recursive: true });
  fs.copyFileSync(path.join(deskRoot, "mcp", "scripts", "tidy-status.js"), path.join(plugin, "mcp", "scripts", "tidy-status.js"));
  fs.copyFileSync(path.join(deskRoot, "mcp", "package.json"), path.join(plugin, "mcp", "package.json"));
  return plugin;
}

function gitIn(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const HOST_BINDING_VARS = ["CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "DESK_ACTIVATION_CONFIG", "CODEX_HOME", "DESK", "DESK_PERSON", "DESK_IDENTITY", "DESK_TOOLS_ROOT", "DESK_TOOLS_PERSON", "DESK_PLUGIN_ROOT"];

function withTidyDesk({ build = messyDesk, crew = false, git = true, record = null, pluginRoot = "installed" } = {}, body) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desk-tidy-migration-")));
  try {
    const desk = path.join(root, "desk");
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    fs.mkdirSync(desk);
    const own = crew ? path.join(desk, "desks", "bob") : desk;
    if (crew) {
      put(desk, "_meta/desks.md", "| alias | identity |\n|---|---|\n| alice | alice |\n| bob | bob |\n");
      messyDesk(path.join(desk, "desks", "alice"));
      fs.mkdirSync(own, { recursive: true });
    }
    build(own);
    if (record !== null) put(own, "_meta/organization.json", `${JSON.stringify(record)}\n`);
    if (git) {
      gitIn(desk, "init", "-q");
      gitIn(desk, "config", "user.name", "Fixture Owner");
      gitIn(desk, "config", "user.email", "fixture@example.com");
      gitIn(desk, "add", "-A");
      gitIn(desk, "commit", "-q", "-m", "fixture");
    }
    const env = { ...process.env, HOME: home, DESK: desk, DESK_PLUGIN_ROOT: pluginRoot === "installed" ? installedPluginCopy(root) : deskRoot };
    for (const key of HOST_BINDING_VARS) if (!["DESK", "DESK_PLUGIN_ROOT"].includes(key)) delete env[key];
    // The session's identity is set so `gh` is never asked; on a crew desk bob is this session.
    env.DESK_IDENTITY = "nobody-in-the-registry";
    if (crew) env.DESK_PERSON = "bob";
    const tidy = { root, desk, own, env, run: (script, extraEnv = {}) => spawnSync(BASH, ["-c", script], { cwd: home, env: { ...env, ...extraEnv }, encoding: "utf8" }) };
    body(tidy);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function tidyMigration() {
  return parseMigration(TIDY_FILE);
}

function snapshot(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else entries.push(`${path.relative(dir, abs)}\n${fs.readFileSync(abs, "utf8")}`);
    }
  };
  walk(dir);
  return entries.join("\n\0\n");
}

test("Desk ships the tidy-desk migration: in-session agent work, no restart", () => {
  assert.ok(migrationFiles.includes(`${TIDY_ID}.md`), `plugins/desk/migrations/${TIDY_ID}.md is missing`);
  const { frontmatter } = tidyMigration();
  assert.equal(frontmatter.needs_restart, "false");
  assert.equal(frontmatter.agent_work, "true");
});

test("the tidy migration tidies and announces: announce-and-proceed wording and no question anywhere", () => {
  const text = read(TIDY_FILE);
  const { blocks } = tidyMigration();
  assert.doesNotMatch(text, /\?/u, "the tidy never asks the human anything");
  assert.match(blocks.Announce, /^I tidied up my desk a bit: <[^>]+>\. <What I left alone, if anything[^>]+> Say if you mind and I'll put anything back\. <commit link>$/u);
  assert.match(blocks.Migrate, /Do not ask first and do not wait for an answer: tidy, announce it in one line, and carry on\./u);
  assert.doesNotMatch(text, /how would you like|would you like|shall I|should I|do you want/iu);
  // The ordered Migrate steps from the brief, each with its safety rule.
  const steps = [...blocks.Migrate.matchAll(/^(\d)\. ([^.]+)\./gmu)].map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(steps, ["1 Scope lines", "2 Names", "3 Duplicates", "4 Loose files", "5 Person-named and catch-all tracks (track_person_name, track_catch_all)", "6 Empty tracks (track_empty)", "7 Record and commit"]);
  assert.match(blocks.Migrate, /only inside this session's own desk/u);
  assert.match(blocks.Migrate, /told you not to write in this session, skip the tidy/u);
  assert.match(blocks.Migrate, /Never delete content/u);
  assert.match(blocks.Migrate, /Never change a task's status/u);
  // Fix round 1: other sessions' work, loose files, judgment on merges, names in commits, the revert.
  assert.match(blocks.Migrate, /Leave alone every task and track that holds uncommitted changes[\s\S]{0,200}left alone in the announcement/u);
  assert.match(blocks.Migrate, /untracked loose file that is not ignored gets git add first, then git mv\. Leave ignored files where they are\./u);
  assert.match(blocks.Migrate, /git diff --cached --name-status -- <tidy paths>[\s\S]{0,300}stop with one line[\s\S]{0,100}commit with git commit -- <tidy paths> and nothing else, so any other staged work stays staged exactly as it was; never unstage anyone else's work\./u);
  assert.doesNotMatch(blocks.Migrate, /unstage it/u);
  assert.match(blocks.Migrate, /never write an old name that failed the credential or prompt check[\s\S]{0,200}Describe such a move by its new name only\./u);
  assert.match(blocks.Migrate, /Merge a group only when you judge that both cards describe the same outcome; leave the others and mention them\./u);
  assert.match(blocks.Migrate, /Never hide a live task: when the duplicate is not done or cancelled and the kept task is, keep the live one instead, or skip the merge\./u);
  assert.match(blocks.Migrate, /to_track when the kept task is in another track[\s\S]{0,300}re-file that track's tasks first/u);
  assert.match(blocks.Migrate, /into _meta\/ when it concerns the whole desk\. Never create a task just to hold files\. A loose folder that is clearly a task gets a card with task_create instead of a move\. A loose entry whose name fails the name rules gets an outcome name/u);
  assert.match(blocks.Migrate, /git revert --no-commit <tidy commit>, restore the record with git checkout <tidy commit> -- [^,]+organization\.json, and commit both together/u);
  assert.doesNotMatch(blocks["Safety check"], /--safety|tidy-status/u, "anything that only has to wait never fails the Safety check");
});

test("tidy Detect fires on the M4-3 messy fixture, from an installed plugin with no npm dependencies and from this checkout", () => {
  const { blocks } = tidyMigration();
  for (const pluginRoot of ["installed", "checkout"]) {
    withTidyDesk({ pluginRoot }, (tidy) => {
      const detect = tidy.run(blocks.Detect);
      assert.equal(detect.status, 0, `${pluginRoot}: ${detect.stdout}${detect.stderr}`);
      assert.equal(detect.stdout, "", "Detect is silent");
    });
  }
  withTidyDesk({}, (tidy) => {
    assert.equal(fs.existsSync(path.join(tidy.env.DESK_PLUGIN_ROOT, "mcp", "node_modules")), false);
    const status = spawnSync(process.execPath, [path.join(tidy.env.DESK_PLUGIN_ROOT, "mcp", "scripts", "tidy-status.js")], { env: tidy.env, encoding: "utf8" });
    const codes = new Set(JSON.parse(status.stdout).findings.map((finding) => finding.code));
    for (const code of ["track_missing_scope", "track_person_name", "track_catch_all", "track_empty", "name_prompt_like", "name_credential_like", "name_shape", "loose_file", "duplicate_job", "stale_task"]) {
      assert.ok(codes.has(code), `the dependency-free checks must still report ${code}`);
    }
  });
});

test("tidy Detect does not fire on the clean fixture, or once tidy_version 1 is recorded", () => {
  const { blocks } = tidyMigration();
  withTidyDesk({ build: cleanDesk }, (tidy) => assert.equal(tidy.run(blocks.Detect).status, 1));
  withTidyDesk({ record: { schema_version: 1, tidy_version: 1, tidied_at: RECENT } }, (tidy) => assert.equal(tidy.run(blocks.Detect).status, 1));
  withTidyDesk({ record: { schema_version: 1, tidy_version: 0 } }, (tidy) => assert.equal(tidy.run(blocks.Detect).status, 0));
});

test("tidy Detect never fires for a non-Git desk, without the plugin root, or on a crew desk for a peer", () => {
  const { blocks } = tidyMigration();
  withTidyDesk({ git: false }, (tidy) => assert.equal(tidy.run(blocks.Detect).status, 1));
  withTidyDesk({}, (tidy) => assert.equal(tidy.run(blocks.Detect, { DESK_PLUGIN_ROOT: "" }).status, 1));
  // Crew: alice's desk is messy, bob's (this session's own) is clean.
  withTidyDesk({ crew: true, build: cleanDesk }, (tidy) => {
    assert.equal(tidy.run(blocks.Detect).status, 1, "a peer's mess is theirs");
    assert.equal(tidy.run(blocks.Detect, { DESK_PERSON: "" }).status, 0, "with no person the tidy still fires, to say so in one line");
    assert.equal(tidy.run(blocks.Detect, { DESK_PERSON: "alice" }).status, 0, "alice's own session tidies alice's desk");
  });
});

test("tidy Migrate prints the findings and the steps, changes nothing, and never echoes a credential-like name", () => {
  const { blocks } = tidyMigration();
  withTidyDesk({}, (tidy) => {
    const before = snapshot(tidy.desk);
    assert.equal(tidy.run(blocks.Detect).status, 0);
    const safety = tidy.run(blocks["Safety check"]);
    assert.equal(safety.status, 0, safety.stdout + safety.stderr);
    const migrate = tidy.run(blocks.Migrate);
    assert.equal(migrate.status, 0, migrate.stderr);
    assert.match(migrate.stdout, new RegExp(`^Desk tools: ${tidy.desk}\\nThis script: ${tidy.desk}\\nThis session's own desk: ${tidy.desk}\\nOrganization findings in it: \\d+\\n`, "u"));
    assert.match(migrate.stdout, /\nUncommitted changes in it: 0\n/u);
    assert.match(migrate.stdout, /^ {2}track_catch_all: inbox — /mu);
    assert.match(migrate.stdout, /^ {2}name_credential_like: normal-track\/<redacted segment> — /mu);
    assert.ok(!migrate.stdout.includes(CARD_SECRET.slice(0, 6)), "no part of a credential-like name is printed");
    assert.match(migrate.stdout, new RegExp(`with: node '${tidy.env.DESK_PLUGIN_ROOT}/mcp/scripts/tidy-status\\.js' --write-record\\n`, "u"));
    assert.equal(snapshot(tidy.desk), before, "Migrate itself changes nothing; the agent does the tidy");
    assert.equal(gitIn(tidy.desk, "status", "--porcelain"), "");

    // Step 7 records the tidy; Detect then stays quiet even though findings remain.
    const recordCommand = /with: (node '[^']+' --write-record)\n/u.exec(migrate.stdout)[1];
    const record = tidy.run(recordCommand);
    assert.equal(record.status, 0, record.stderr);
    const written = json(path.join(tidy.desk, "_meta", "organization.json"));
    assert.deepEqual(Object.keys(written), ["schema_version", "tidy_version", "tidied_at"]);
    assert.equal(written.tidy_version, 1);
    assert.equal(tidy.run(blocks.Detect).status, 1);
  });
  withTidyDesk({ crew: true }, (tidy) => {
    const migrate = tidy.run(blocks.Migrate);
    assert.equal(migrate.status, 0, migrate.stderr);
    assert.match(migrate.stdout, new RegExp(`^This session's own desk: ${path.join(tidy.desk, "desks", "bob")}$`, "mu"));
    assert.ok(!/desks\/alice/u.test(migrate.stdout), "a peer's desk never appears in the tidy");
    // Run in the same environment, the printed command records bob's own desk.
    const recordCommand = /with: (node '[^']+' --write-record)\n/u.exec(migrate.stdout)[1];
    assert.equal(tidy.run(recordCommand).status, 0);
    assert.ok(fs.existsSync(path.join(tidy.desk, "desks", "bob", "_meta", "organization.json")));
    assert.equal(fs.existsSync(path.join(tidy.desk, "desks", "alice", "_meta", "organization.json")), false);
  });
});

test("tidy Migrate works on the desk_status desk, and says one line instead when the script resolves another", () => {
  const { blocks } = tidyMigration();
  withTidyDesk({}, (tidy) => {
    const agree = tidy.run(blocks.Migrate, { DESK_TOOLS_ROOT: tidy.desk });
    assert.equal(agree.status, 0, agree.stderr);
    assert.match(agree.stdout, new RegExp(`^Desk tools: ${tidy.desk}\\nThis script: ${tidy.desk}\\n`, "u"));
    assert.match(agree.stdout, new RegExp(`with: node '[^']+' --write-record --root '${tidy.desk}'\\n`, "u"));

    const other = path.join(tidy.root, "other-desk");
    fs.mkdirSync(other);
    const disagree = tidy.run(blocks.Migrate, { DESK_TOOLS_ROOT: other });
    assert.equal(disagree.status, 0, "a mismatch skips the tidy; it never fails the session");
    assert.equal(disagree.stdout, `I left my desk untidied: the Desk tools use ${other}, but the tidy found ${tidy.desk}.\n`);
  });
  withTidyDesk({ crew: true }, (tidy) => {
    const person = tidy.run(blocks.Migrate, { DESK_TOOLS_ROOT: tidy.desk, DESK_TOOLS_PERSON: "alice" });
    assert.equal(person.stdout, `I left my desk untidied: the Desk tools use ${tidy.desk} as alice, but the tidy found ${tidy.desk} as bob.\n`);
    const nobody = tidy.run(blocks.Migrate, { DESK_PERSON: "" });
    assert.equal(nobody.stdout, "I couldn't tell which desk in this crew workspace is mine, so I left every desk as it is.\n");
  });
});

test("tidy Detect stays silent on a desk whose only findings are stale tasks", () => {
  const { blocks } = tidyMigration();
  const staleOnly = (root) => {
    cleanDesk(root);
    put(root, "billing-disputes/old-refund-audit/task.md", task("billing-disputes", "old-refund-audit", { created: STALE, updated: STALE }));
  };
  withTidyDesk({ build: staleOnly }, (tidy) => {
    assert.equal(tidy.run(blocks.Detect).status, 1);
    const report = tidy.run(blocks.Migrate);
    assert.match(report.stdout, /stale_task: billing-disputes\/old-refund-audit\/task\.md — .*reported only/u);
  });
});

test("mid-merge, the Safety check passes and Migrate skips the tidy for this session with one line", () => {
  const { blocks } = tidyMigration();
  withTidyDesk({}, (tidy) => {
    fs.writeFileSync(path.join(tidy.desk, ".git", "MERGE_HEAD"), "");
    assert.equal(tidy.run(blocks["Safety check"]).status, 0, "waiting never stops the session");
    const migrate = tidy.run(blocks.Migrate);
    assert.equal(migrate.status, 0);
    assert.equal(migrate.stdout, "I left my desk untidied for now because the desk repository is in the middle of a merge; I'll tidy it in a later session.\n");
  });
});

test("tidy Migrate lists another session's uncommitted work and never prints a password from a prompt-like name", () => {
  const { blocks } = tidyMigration();
  const withSecrets = (root) => {
    messyDesk(root);
    put(root, "normal-track/please-use-pw-hunter2/task.md", task("normal-track", "please-use-pw-hunter2"));
    put(root, "login-pw-hunter2-notes.txt", "loose\n");
  };
  withTidyDesk({ build: withSecrets }, (tidy) => {
    put(tidy.desk, "normal-track/ship-the-refactor/doing.md", "another session is writing this\n");
    const migrate = tidy.run(blocks.Migrate);
    assert.equal(migrate.status, 0, migrate.stderr);
    assert.match(migrate.stdout, /^Uncommitted changes in it: 1\n {2}normal-track\/ship-the-refactor\/doing\.md$/mu);
    assert.ok(!migrate.stdout.includes("hunter"), "no part of a password value is printed");
    assert.match(migrate.stdout, /^ {2}name_credential_like: normal-track\/<redacted segment> — /mu);
  });
});

// The startup hooks name the migration file only on the old channel; the new home never carries the line.
function hookContexts() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "desk-migration-hooks-"));
  try {
    const env = {
      ...process.env,
      HOME: path.join(scratch, "home"),
      DESK: scratch,
      CLAUDE_PLUGIN_ROOT: deskRoot,
      PLUGIN_ROOT: deskRoot,
    };
    fs.mkdirSync(env.HOME);
    const claude = spawnSync(BASH, [path.join(deskRoot, "hooks", "session-start.sh")], { cwd: scratch, env, encoding: "utf8" });
    assert.equal(claude.status, 0, claude.stderr);
    const copilot = spawnSync(process.execPath, [path.join(deskRoot, "hooks", "copilot-session-start.cjs")], { cwd: scratch, env, encoding: "utf8" });
    assert.equal(copilot.status, 0, copilot.stderr);
    return {
      claude: JSON.parse(claude.stdout).hookSpecificOutput.additionalContext,
      copilot: JSON.parse(copilot.stdout).additionalContext,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const marketplace = json(path.join(repoRoot, ".claude-plugin", "marketplace.json"));
test(`startup hooks ${marketplace.name === "ouroboros-skills" ? "open with the move line and the migration's path" : "never carry the move line"}`, () => {
  for (const [host, context] of Object.entries(hookContexts())) {
    if (marketplace.name === "ouroboros-skills") {
      assert.equal(context.split("\n")[0], MOVE_LINE, `${host} startup must open with the move line naming the migration file`);
      assert.equal(context.split(MOVE_LINE).length - 1, 1, `${host} startup must carry the move line once`);
    } else {
      assert.doesNotMatch(context, /Desk has moved/u, `${host} startup must not tell users on the new home to move`);
    }
  }
});

let failures = 0;
for (const { name, body } of tests) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`not ok - ${name}\n  ${String(error.message).split("\n").join("\n  ")}`);
  }
}
console.log(failures === 0 ? `Desk migrations: ${tests.length} checks passed.` : `Desk migrations: ${failures} of ${tests.length} checks failed.`);
process.exitCode = failures === 0 ? 0 : 1;
