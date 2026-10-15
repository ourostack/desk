// A real executable hook records its shell and Node descendant's OS arguments.
export function hookArgvScript({ nestedMutation = false, subdirectory = false } = {}) {
  const probe = `
const fs = require("node:fs"), cp = require("node:child_process");
const pid = process.ppid;
let kernel;
if (process.platform === "linux") kernel = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean);
else if (process.platform === "win32") kernel = [cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "').CommandLine"], {encoding:"utf8"}).trim()];
else kernel = [cp.execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {encoding:"utf8"}).trim()];
const row = {hook:process.argv[1], args:process.argv.slice(2), kernel, cwd:process.cwd(), gitDir:process.env.GIT_DIR, toolCommit:process.env.DESK_TOOL_COMMIT ?? null};
row.nestedMutation = process.env.DESK_HOOK_NESTED_MUTATION === "1";
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
row.top = cp.execFileSync("git", ["rev-parse", "--show-toplevel"], {encoding:"utf8"}).trim();
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
  const readFromProject = subdirectory ? 'expected=$(pwd -P)\ncd project || exit 41\ntop=$(git rev-parse --show-toplevel) || exit $?\n[ "$top" = "$expected" ] || exit 42\nif [ -n "$DESK_HOOK_SUBDIRECTORY_LOG" ]; then printf "%s\\n" "$(pwd -P)" "$top" >> "$DESK_HOOK_SUBDIRECTORY_LOG" || exit $?; fi\ncd .. || exit 41\n' : ""
  const mutation = nestedMutation ? `${subdirectory ? "cd project || exit 41\n" : ""}DESK_HOOK_NESTED_MUTATION=1 git update-index --refresh --force-write-index || exit $?\n` : ""
  return `#!/bin/sh\n${readFromProject}"$DESK_HOOK_NODE" -e '${probe.replace(/'/gu, "'\\''")}' -- "$0" "$@"\ncode=$?\n[ "$code" -eq 0 ] || exit "$code"\n${mutation}case "$0" in *pre-commit*) exit "\${DESK_HOOK_EXIT:-0}";; esac\nexit 0\n`
}
