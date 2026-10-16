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
  const verifyProject = `pwd -P | "$DESK_HOOK_NODE" -e '${discovery.replace(/'/gu, "'\\''")}' || exit $?\n`
  const readFromProject = subdirectory ? `cd project || exit 41\n${verifyProject}cd .. || exit 41\n` : ""
  const mutation = nestedMutation ? `${subdirectory ? "cd project || exit 41\n" : ""}DESK_HOOK_NESTED_MUTATION=1 git update-index --refresh --force-write-index || exit $?\n` : ""
  const commit = nestedCommit ? `[ "$DESK_HOOK_NESTED_COMMIT" = "1" ] && exit 0\ncd project || exit 41\n${verifyProject}DESK_HOOK_NESTED_COMMIT=1 git commit --allow-empty -qm "nested message witness" || exit $?\n` : ""
  return `#!/bin/sh\n${readFromProject}"$DESK_HOOK_NODE" -e '${probe.replace(/'/gu, "'\\''")}' -- "$0" "$@"\ncode=$?\n[ "$code" -eq 0 ] || exit "$code"\n${mutation}${commit}case "$0" in *pre-commit*) exit "\${DESK_HOOK_EXIT:-0}";; esac\nexit 0\n`
}
