// A real executable hook records its shell and Node descendant's OS arguments.
export function hookArgvScript({ nestedMutation = false, subdirectory = false, nestedCommit = false } = {}) {
  const probe = `
const fs = require("node:fs"), cp = require("node:child_process");
const pid = process.ppid;
let kernel;
if (process.platform === "linux") kernel = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean);
else if (process.platform === "win32") kernel = [cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "').CommandLine"], {encoding:"utf8"}).trim()];
else kernel = [cp.execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {encoding:"utf8"}).trim()];
const row = {hook:process.argv[1], args:process.argv.slice(2), kernel, cwd:process.cwd(), gitDir:process.env.GIT_DIR, commonDir:process.env.GIT_COMMON_DIR, toolCommit:process.env.DESK_TOOL_COMMIT ?? null};
row.nestedMutation = process.env.DESK_HOOK_NESTED_MUTATION === "1";
row.nestedCommit = process.env.DESK_HOOK_NESTED_COMMIT === "1";
row.ancestors = [];
if (process.platform === "linux") {
  let at = pid;
  for (let i = 0; i < 5 && at > 0; i++) {
    try {
      row.ancestors.push(fs.readFileSync("/proc/" + at + "/cmdline", "utf8").split("\\0").filter(Boolean));
      const status = fs.readFileSync("/proc/" + at + "/status", "utf8");
      at = Number(/^PPid:\\s+(\\d+)/m.exec(status)[1]);
    } catch { break }
  }
}
if (process.platform === "darwin") {
  let at = pid;
  for (let i = 0; i < 5 && at > 0; i++) {
    const observed = cp.execFileSync("/bin/ps", ["-p", String(at), "-o", "ppid=", "-o", "command="], {encoding:"utf8"}).trim();
    const parent = /^(\\d+)\\s+([\\s\\S]*)$/.exec(observed);
    if (!parent) break;
    row.ancestors.push([parent[2]]);
    at = Number(parent[1]);
  }
}
row.topRaw = cp.execFileSync("git", ["rev-parse", "--show-toplevel"], {encoding:"utf8"});
row.top = row.topRaw.trim();
row.topReal = fs.realpathSync.native(row.top);
row.cwdReal = fs.realpathSync.native(row.cwd);
// Observe both the unchanged configured policy and the effective private routing overlay.
const hookConfig = cp.spawnSync("git", ["config", "--show-scope", "--get-all", "core.hooksPath"], {encoding:"utf8"}).stdout.trim();
const scopes = hookConfig ? hookConfig.split("\\n").map((line) => {
  const tab = line.indexOf("\\t");
  return {scope:line.slice(0, tab), value:line.slice(tab + 1)};
}) : [];
row.hooksPath = scopes.filter((entry) => entry.scope !== "command").at(-1)?.value ?? "";
row.effectiveHooksPath = scopes.at(-1)?.value ?? "";
if (process.env.DESK_HOOK_PROFILE_PROBE === "1") {
  row.profile = {
    count: process.env.GIT_CONFIG_COUNT,
    optionalLocks: process.env.GIT_OPTIONAL_LOCKS,
    slots: Array.from({length:Number(process.env.GIT_CONFIG_COUNT ?? 0)}, (_, i) => [process.env["GIT_CONFIG_KEY_" + i], process.env["GIT_CONFIG_VALUE_" + i]]),
    effective: ["safe.bareRepository", "credential.interactive", "core.fsmonitor"].map((key) => cp.spawnSync("git", ["config", "--get", key], {encoding:"utf8"}).stdout.trim()),
  };
}
if (row.hook.includes("commit-msg") && row.args.length) row.message = fs.readFileSync(row.args[0], "utf8");
fs.appendFileSync(process.env.DESK_HOOK_LOG, JSON.stringify(row) + "\\n");
`
  const discovery = `
const fs = require("node:fs"), cp = require("node:child_process"), path = require("node:path");
const cwd = process.cwd();
const topRaw = cp.execFileSync("git", ["rev-parse", "--show-toplevel"], {encoding:"utf8"});
const row = {shellPwdRaw:fs.readFileSync(0, "utf8"), cwd, topRaw, top:topRaw.trim(),
  cwdReal:fs.realpathSync.native(cwd), topReal:fs.realpathSync.native(topRaw.trim()),
  parentReal:fs.realpathSync.native(path.dirname(cwd))};
if (process.env.DESK_HOOK_SUBDIRECTORY_LOG) fs.appendFileSync(process.env.DESK_HOOK_SUBDIRECTORY_LOG, JSON.stringify(row) + "\\n");
if (path.basename(cwd) !== "project" || row.topReal !== row.parentReal) process.exit(42);
`
  const projectProbe = `pwd -P | "$DESK_HOOK_NODE" -e '${discovery.replace(/'/gu, "'\\''")}'`
  const verifyProject = `${projectProbe} || exit $?\n`
  const readFromProject = subdirectory ? `cd project || exit 41\n${verifyProject}cd .. || exit 41\n` : ""
  const mutation = nestedMutation ? `${subdirectory ? "cd project || exit 41\n" : ""}DESK_HOOK_NESTED_MUTATION=1 git update-index --refresh --force-write-index || exit $?\n` : ""
  const journal = nestedCommit ? `desk_nested_event() {
  [ -n "$DESK_HOOK_NESTED_LOG" ] || return 0
  desk_nested=false
  [ "$DESK_HOOK_NESTED_COMMIT" = "1" ] && desk_nested=true
  printf '{"phase":"%s","nested":%s,"status":%s}\\n' "$1" "$desk_nested" "$2" >> "$DESK_HOOK_NESTED_LOG"
}
desk_nested_head() {
  [ -n "$DESK_HOOK_NESTED_LOG" ] || return 0
  desk_head=$(git rev-parse --verify HEAD)
  desk_head_status=$?
  if [ "$desk_head_status" -eq 0 ]; then
    printf '{"phase":"%s","nested":false,"status":0,"head":"%s"}\\n' "$1" "$desk_head" >> "$DESK_HOOK_NESTED_LOG"
  else
    desk_nested_event "$1" "$desk_head_status"
  fi
}
desk_nested_event post-enter null || exit 43
` : ""
  const commit = nestedCommit ? `if [ "$DESK_HOOK_NESTED_COMMIT" = "1" ]; then
  desk_nested_event guard-exit 0 || exit 43
  exit 0
fi
cd project
code=$?
desk_nested_event project-cd "$code" || exit 43
[ "$code" -eq 0 ] || exit 41
${projectProbe}
code=$?
desk_nested_event discovery-exit "$code" || exit 43
[ "$code" -eq 0 ] || exit "$code"
desk_nested_head head-before || exit 43
set -- git commit --allow-empty -qm "nested message witness"
if [ -n "$DESK_HOOK_NESTED_LOG" ]; then
  printf '{"phase":"nested-start","nested":false,"argv":["%s","%s","%s","%s","%s"]}\\n' "$@" >> "$DESK_HOOK_NESTED_LOG" || exit 43
fi
DESK_HOOK_NESTED_COMMIT=1 "$@"
code=$?
desk_nested_event nested-exit "$code" || exit 43
desk_nested_head head-after || exit 43
[ "$code" -eq 0 ] || exit "$code"
` : ""
  const probeEvent = nestedCommit ? 'desk_nested_event post-probe "$code" || exit 43\n' : ""
  const exitEvent = nestedCommit ? "desk_nested_event post-exit 0 || exit 43\n" : ""
  return `#!/bin/sh\n${journal}${readFromProject}"$DESK_HOOK_NODE" -e '${probe.replace(/'/gu, "'\\''")}' -- "$0" "$@"\ncode=$?\n${probeEvent}[ "$code" -eq 0 ] || exit "$code"\n${mutation}${commit}${exitEvent}case "$0" in *pre-commit*) exit "\${DESK_HOOK_EXIT:-0}";; esac\nexit 0\n`
}
