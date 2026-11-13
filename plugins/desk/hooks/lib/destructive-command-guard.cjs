"use strict";

// Refuses a shell command that removes or moves away something its author did not create: a git checkout (`rm -rf ~/code/desk` took every
// linked worktree with it), a linked worktree removed with `rm` instead of `git worktree remove`, or a Colima/Lima VM
// (`colima delete -f` on a default profile). It runs as a Claude `PreToolUse` and Copilot `preToolUse` hook on shell calls, in subagents too.
//
// The reader is deliberately small: it splits a command into simple commands, follows `cd`, simple `NAME=value` assignments, `~`, `$VAR`
// and wrappers (`sudo`, `env`, `bash -c`, `eval`, `$(...)`), and judges `rm`, `mv`, `colima` and `limactl`. A command it cannot resolve (a
// computed path, an unknown variable, an unmatched quote) is allowed: a guard that bricks the shell does more harm than the accident it stops.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "time"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "nice", "xargs"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const LIMA_DELETE = new Set(["delete", "remove", "rm", "factory-reset"]);
const GLOB = /[*?[]/u;
const MAX_ENTRIES = 100;
const MAX_DEPTH = 3;

const MESSAGES = {
  main: (subject) => `Leave it where it is, or ask its owner if it has to go. Desk refused this because ${subject} a git checkout (it holds a .git directory), and removing or moving one breaks every linked worktree that points at it, including other sessions' running worktrees. To clean up your own work, remove only the files and worktrees you created.`,
  worktree: (subject, target) => `Leave this worktree, or remove it with \`git worktree remove\` if you created it. Desk refused this because ${subject} a linked git worktree, and \`rm\` leaves git's record of it behind and can delete another session's work. Run \`git worktree remove ${target}\` for one you created in this session; ask its owner about any other.`,
  vm: (tool, start, stop) => `Use a dedicated profile with a new name (\`${start}\`), not an existing one. Desk refused \`${tool}\` because it deletes a whole VM and every container in it, and Desk can't tell whether you created this one in this session, so it refuses them all. Stop your own profile when you are done (\`${stop}\`); to delete one that already existed, ask its owner.`,
};

/** Splits `text` into simple commands (`{ words }`, each word `{ text, dynamic }`), subshell marks (`{ op }`) and the text of every `$(...)` or backtick substitution. Null when the quoting does not close. */
function lex(text) {
  const items = [];
  const inner = [];
  let words = [];
  let word = null;
  let drop = false;
  let heredocs = [];
  const add = (chars) => { word ??= { text: "", dynamic: false }; word.text += chars; };
  const flushWord = () => { if (word) { if (!drop) words.push(word); drop = false; word = null; } };
  const flushCommand = () => { flushWord(); if (words.length > 0) items.push({ words }); words = []; };
  // The end of the substitution that opens at `from` (`$(` or a backtick); its body goes to `inner` and the word is no longer a literal.
  const substitute = (from) => {
    const open = text[from] === "`" ? "`" : "(";
    let depth = 1;
    let j = from + (open === "`" ? 1 : 2);
    for (; j < text.length && depth > 0; j++) {
      if (open === "`") { if (text[j] === "`") depth = 0; } else if (text[j] === "(") depth++; else if (text[j] === ")") depth--;
    }
    if (depth > 0) return -1;
    const bodyStart = from + (open === "`" ? 1 : 2);
    inner.push(text.slice(bodyStart, j - 1));
    add(text.slice(from, j));
    word.dynamic = true;
    return j - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      if (text[i + 1] === "\n") i++; else add(text[++i] ?? "");
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      add(text.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      add("");
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") add(text[++i] ?? "");
        else if (text[i] === "`" || (text[i] === "$" && text[i + 1] === "(")) { i = substitute(i); if (i < 0) return null; } else add(text[i]);
      }
      if (i >= text.length) return null;
    } else if (c === "`" || (c === "$" && text[i + 1] === "(")) {
      i = substitute(i);
      if (i < 0) return null;
    } else if (c === "#" && !word) {
      while (i < text.length && text[i + 1] !== "\n") i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      flushWord();
    } else if (c === "\n") {
      flushCommand();
      for (const delimiter of heredocs) {
        const lines = text.slice(i + 1).split("\n");
        const end = lines.findIndex((line) => line.trim() === delimiter);
        i += end < 0 ? text.length : lines.slice(0, end + 1).join("\n").length;
      }
      heredocs = [];
    } else if (c === ";" || c === "|" || c === "&") {
      flushCommand();
    } else if (c === "(" || c === ")") {
      flushCommand();
      items.push({ op: c });
    } else if (c === "<" || c === ">") {
      const heredoc = c === "<" && text[i + 1] === "<" && text[i + 2] !== "<" ? /^<<-?\s*(?:"([^"]*)"|'([^']*)'|\\?([^\s;&|()<>]+))/u.exec(text.slice(i)) : null;
      flushWord();
      if (heredoc) {
        heredocs.push(heredoc[1] ?? heredoc[2] ?? heredoc[3]);
        i += heredoc[0].length - 1;
      } else {
        while (text[i + 1] === ">" || text[i + 1] === "&") i++;
        drop = true;
      }
    } else {
      add(c);
    }
  }
  flushCommand();
  return { items, inner };
}

/** The word's text with `~` and `$NAME` resolved, or null when it is computed or names an unknown variable. */
function expand(entry, state) {
  if (entry.dynamic) return null;
  let text = entry.text;
  if (text === "~" || text.startsWith("~/")) text = os.homedir() + text.slice(1);
  else if (text.startsWith("~")) return null;
  let known = true;
  text = text.replace(/\$(?:\{(\w+)\}|(\w+))/gu, (_, braced, bare) => {
    const name = braced ?? bare;
    const value = state.vars[name] ?? state.env[name] ?? (name === "HOME" ? os.homedir() : undefined);
    if (value === undefined) known = false;
    return value ?? "";
  });
  return known ? text : null;
}

const checkoutAt = (dir) => {
  let stat;
  try { stat = fs.lstatSync(path.join(dir, ".git")); } catch { return null; }
  if (stat.isDirectory()) return { kind: "main", at: dir };
  if (!stat.isFile()) return null;
  try { return /^gitdir:.*[\\/]worktrees[\\/]/u.test(fs.readFileSync(path.join(dir, ".git"), "utf8").slice(0, 1000)) ? { kind: "worktree", at: dir } : null; } catch { return null; }
};

/** The first git checkout at `dir` or up to `depth` folders below it (so `rm -rf ~/code` is caught, as well as `rm -rf ~/code/desk`). */
function findCheckout(dir, depth) {
  const own = checkoutAt(dir);
  if (own || depth === 0) return own;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const found = findCheckout(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/** The absolute paths an operand names: itself, or what its last-segment wildcard matches. Empty when it cannot be resolved. */
function targets(entry, state) {
  const text = expand(entry, state);
  if (!text || (!path.isAbsolute(text) && !state.cwd)) return [];
  const resolved = path.resolve(state.cwd ?? path.parse(process.cwd()).root, text);
  if (!GLOB.test(resolved)) return [resolved];
  const folder = path.dirname(resolved);
  if (GLOB.test(folder)) return [];
  const pattern = path.basename(resolved);
  const match = new RegExp(`^${pattern.replace(/[.+^${}()|\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "u");
  try {
    return fs.readdirSync(folder).filter((name) => match.test(name) && (pattern.startsWith(".") || !name.startsWith("."))).map((name) => path.join(folder, name));
  } catch { return []; }
}

/** The refusal for removing or moving `target`, or null when it is not, and holds no, git checkout. */
function judgeTarget(target) {
  let real;
  let stat;
  try {
    real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    stat = fs.lstatSync(real);
  } catch { return null; }
  if (path.basename(real) === ".git") {
    const owner = checkoutAt(path.dirname(real));
    return owner && (owner.kind === "main" ? MESSAGES.main(`${real} is inside`) : MESSAGES.worktree(`${real} is inside`, owner.at));
  }
  if (!stat.isDirectory()) return null;
  const found = findCheckout(real, MAX_DEPTH - 1);
  if (!found) return null;
  const subject = found.at === real ? `${real} is` : `${real} holds ${found.at}, which is`;
  return found.kind === "main" ? MESSAGES.main(subject) : MESSAGES.worktree(subject, found.at);
}

function judgeCommand(words, state, depth) {
  let i = 0;
  const assigned = {};
  for (; i < words.length; i++) {
    const text = words[i].text;
    const assignment = /^([A-Za-z_]\w*)=/u.exec(text);
    if (assignment) assigned[assignment[1]] = expand({ ...words[i], text: text.slice(assignment[0].length) }, state);
    else if (!KEYWORDS.has(text) && !WRAPPERS.has(path.basename(text)) && !(i > 0 && text.startsWith("-"))) break;
  }
  if (i === words.length) {
    for (const [name, value] of Object.entries(assigned)) if (value !== null) state.vars[name] = value;
    return null;
  }
  const command = path.basename(words[i].text);
  const args = words.slice(i + 1);
  const operands = args.filter((word, index) => !word.text.startsWith("-") || (args.slice(0, index).some((earlier) => earlier.text === "--")));
  if (command === "cd" || command === "pushd") {
    const dir = args.find((word) => !word.text.startsWith("-") || word.text === "-");
    const text = dir ? expand(dir, state) : os.homedir();
    state.cwd = text && text !== "-" && (path.isAbsolute(text) || state.cwd) ? path.resolve(state.cwd ?? "", text) : null;
  } else if (command === "popd") {
    state.cwd = null;
  } else if (SHELLS.has(command) || command === "eval") {
    const flag = command === "eval" ? -1 : args.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word.text));
    const script = command === "eval" ? args.map((word) => word.text).join(" ") : args[flag + 1]?.text;
    if ((flag >= 0 || command === "eval") && script) return judge(script, { ...state, vars: { ...state.vars } }, depth + 1);
  } else if (command === "rm" || command === "mv") {
    for (const operand of command === "mv" ? operands.slice(0, -1) : operands) {
      for (const target of targets(operand, state)) {
        const reason = judgeTarget(target);
        if (reason) return reason;
      }
    }
  } else if (command === "colima" && args.some((word) => word.text === "delete")) {
    return MESSAGES.vm("colima delete", "colima start -p <new-name>", "colima stop -p <new-name>");
  } else if (command === "limactl" && args.some((word) => LIMA_DELETE.has(word.text))) {
    return MESSAGES.vm("limactl delete", "limactl start --name <new-name>", "limactl stop <new-name>");
  }
  return null;
}

function judge(text, state, depth) {
  if (depth > 3) return null;
  const lexed = lex(text);
  if (!lexed) return null;
  const saved = [];
  for (const item of lexed.items) {
    if (item.op === "(") { saved.push({ cwd: state.cwd, vars: { ...state.vars } }); continue; }
    if (item.op === ")") { Object.assign(state, saved.pop() ?? {}); continue; }
    const reason = judgeCommand(item.words, state, depth);
    if (reason) return reason;
  }
  for (const body of lexed.inner) {
    const reason = judge(body, { ...state, vars: { ...state.vars } }, depth + 1);
    if (reason) return reason;
  }
  return null;
}

/** The refusal message for a shell `command` run in `cwd`, or null to allow it. Never throws: whatever it cannot read, it allows. */
function judgeShellCommand(command, cwd, env = process.env) {
  try {
    if (typeof command !== "string" || !/\b(?:rm|mv|colima|limactl)\b/u.test(command)) return null;
    return judge(command, { cwd: typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null, vars: {}, env }, 0);
  } catch {
    return null;
  }
}

/** The hook's answer for one payload, in the host's shape: `{}` to allow, or its deny JSON. */
function decide(payload, host, env = process.env) {
  let args = payload?.toolArgs ?? payload?.tool_input;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
  const tool = String(payload?.toolName ?? payload?.tool_name ?? "").toLowerCase();
  const reason = tool === "bash" ? judgeShellCommand(args?.command, payload?.cwd, env) : null;
  if (!reason) return {};
  const denial = { permissionDecision: "deny", permissionDecisionReason: reason };
  return host === "claude" ? { hookSpecificOutput: { hookEventName: "PreToolUse", ...denial } } : denial;
}

// The command line of the entry file `hooks/destructive-command-guard.cjs`. Any failure answers `{}`: a broken guard must not stop a shell.
function main(argv = process.argv, stdin = process.stdin, stdout = process.stdout) {
  let input = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => { input += chunk; });
  stdin.on("end", () => {
    let answer = {};
    try { answer = decide(JSON.parse(input), argv[2]); } catch { /* fail open */ }
    stdout.write(`${JSON.stringify(answer)}\n`);
  });
}

module.exports = { decide, judgeShellCommand, main };
