// A real executable hook records its shell and Node descendant's OS arguments.
export function hookArgvScript() {
  const probe = `
const fs = require("node:fs"), cp = require("node:child_process");
const pid = process.ppid;
let kernel;
if (process.platform === "linux") kernel = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean);
else if (process.platform === "win32") kernel = [cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "').CommandLine"], {encoding:"utf8"}).trim()];
else kernel = [cp.execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {encoding:"utf8"}).trim()];
const row = {hook:process.argv[1], args:process.argv.slice(2), kernel, cwd:process.cwd(), gitDir:process.env.GIT_DIR, toolCommit:process.env.DESK_TOOL_COMMIT ?? null};
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
row.hooksPath = cp.spawnSync("git", ["config", "--get", "core.hooksPath"], {encoding:"utf8"}).stdout.trim();
if (row.hook.includes("commit-msg") && row.args.length) row.message = fs.readFileSync(row.args[0], "utf8");
fs.appendFileSync(process.env.DESK_HOOK_LOG, JSON.stringify(row) + "\\n");
`
  return `#!/bin/sh\n"$DESK_HOOK_NODE" -e '${probe.replace(/'/gu, "'\\''")}' -- "$0" "$@"\ncode=$?\n[ "$code" -eq 0 ] || exit "$code"\ncase "$0" in *pre-commit*) exit "\${DESK_HOOK_EXIT:-0}";; esac\nexit 0\n`
}
