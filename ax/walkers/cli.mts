// Desk's CLI walker: every command an agent's shell can run from Desk's code, read from the syntax tree (never run).
//
// Two shapes, under the source folder:
//   - A CLI on the Ouro AX kit: each `defineCli({ name, command | commands })` call. Its doors are its commands,
//     `cli:<cli name> <command name>`, or `cli:<cli name>` for a CLI with one `command`. A command is a
//     `defineCommand({ name: "<literal>" })` call, or a call to a local helper that passes its first parameter to
//     defineCommand as the name (`const command = (name, def, run) => defineCommand({ name, ...def, run })`), followed
//     through constants and spreads. One the walker can't follow is an unwalked gap, never silently dropped.
//   - A hand-written entry point: a module with a `#!` line, one that reads `process.argv` outside any function or
//     checks `require.main === module`, or one that calls a function of its own that reads argv (`main()`), and that
//     neither defines a kit CLI nor imports one directly. It is one door, `cli:node <path>`, and each word its first
//     argument is compared with (`process.argv[2] === "get"`, or a constant or first element taken from it) is a door
//     `cli:node <path> <word>`. Words starting with `-` are flags.
//   - A shell script (a `.sh` file, or a file with a `#!` line and no script extension) is one door, `cli:<path>`, and
//     a Python script (a `.py` file with a `#!` line or an `if __name__ == "__main__":` guard, not test_*.py) is one
//     door, `cli:python3 <path>`.
// A script that a hooks file under the source registers (hooks/hooks.json, hooks/copilot-hooks.json), directly or
// through a dispatcher such as `run-hook.cmd session-start`, is the hooks walker's door, so it is claimed here.
// Vendored kits (lib/ouro-ui, lib/ouro-actions), tests and fixtures are not walked. A source with no doors at all
// is a census error, so the walker can't go blind unnoticed.
//
// `cards` is the sidecar of cards, `{ "doors": [DoorCard] }`. A card whose door isn't found is a census error.
// `handlers` are extra files or folders whose literals count as raised for every door, beside the door's own file;
// a code counts as raised as written or with its hyphens as underscores. Read-only evidence is the kit's `readOnly:
// true` on the command.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, DoorCard, Gap, WalkerOptions, WalkResult } from "../scripts/ouro-census/types.mts";

const SCRIPT = /\.[cm]?[jt]s$/;
const NOT_SCRIPT = /\.d\.[cm]?ts$|\.(test|spec)\.[cm]?[jt]s$/;
const SKIP = new Set(["node_modules", "__tests__", "test", "tests", "fixtures", ".git"]);
const VENDORED = new Set(["ouro-ui", "ouro-actions"]);

interface Found {
  door: Door;
  readOnly: boolean;
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const isText = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
const keyText = (name: ts.PropertyName | undefined): string | null => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null);
const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return SKIP.has(e.name) || (VENDORED.has(e.name) && basename(dir) === "lib") ? [] : files(path);
      return e.isFile() ? [path] : [];
    });
}

/** A `.sh` file, or a file with no extension whose first bytes are `#!`. */
function isShellScript(path: string): boolean {
  if (path.endsWith(".sh")) return true;
  if (extname(path) !== "") return false;
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") === "#!";
  } finally {
    closeSync(fd);
  }
}

/** The line of a Python script's `#!` or `if __name__ == "__main__":`, or null for a module (and for test_*.py). */
function pythonEntry(path: string): number | null {
  if (/^test_|_test\.py$/.test(basename(path))) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  if (lines[0]?.startsWith("#!")) return 1;
  const at = lines.findIndex((l) => /^if\s+__name__\s*==\s*["']__main__["']\s*:/.test(l));
  return at === -1 ? null : at + 1;
}

/** The object literal a property holds, through `name` shorthand and same-file constants. */
function resolveExpr(expr: ts.Expression, consts: Map<string, ts.Expression>, depth = 0): ts.Expression {
  if (ts.isIdentifier(expr) && consts.has(expr.text) && depth < 10) return resolveExpr(consts.get(expr.text)!, consts, depth + 1);
  if (ts.isParenthesizedExpression(expr)) return resolveExpr(expr.expression, consts, depth + 1);
  return expr;
}

/** An object literal's value for `key`, the last one written winning; a spread of a const object counts as its keys, and a
 * spread the walker can't resolve may set any key, so it leaves the value unknown. */
function property(obj: ts.ObjectLiteralExpression, key: string, consts?: Map<string, ts.Expression>, depth = 0): ts.Expression | null {
  // Without consts (a name lookup), spreads are skipped; with them (a readOnly lookup), they are followed.
  let found: ts.Expression | null = null;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && keyText(p.name) === key) found = p.initializer;
    else if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) found = p.name;
    else if (ts.isSpreadAssignment(p) && consts && depth < 10) {
      const spread = resolveExpr(p.expression, consts);
      if (ts.isObjectLiteralExpression(spread)) {
        const inner = property(spread, key, consts, depth + 1);
        if (inner) found = inner;
      } else found = null;
    } else if (ts.isSpreadAssignment(p) && consts) found = null;
  }
  return found;
}

const isTrue = (expr: ts.Expression | null): boolean => !!expr && expr.kind === ts.SyntaxKind.TrueKeyword;

interface FileFacts {
  sf: ts.SourceFile;
  consts: Map<string, ts.Expression>;
  /** Local helpers whose parameter at `index` is the command name they pass to defineCommand, and the def object's parameter. */
  helpers: Map<string, { index: number; def: number | null }>;
}

function facts(sf: ts.SourceFile): FileFacts {
  const consts = new Map<string, ts.Expression>();
  const fns = new Map<string, ts.SignatureDeclaration & { body?: ts.Node }>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) fns.set(node.name.text, node.initializer);
      else if (!consts.has(node.name.text)) consts.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) fns.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const helpers = new Map<string, { index: number; def: number | null }>();
  for (const [name, fn] of fns) {
    const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
    let found: { index: number; def: number | null } | null = null;
    const look = (node: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node) && calleeName(node) === "defineCommand" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const obj = node.arguments[0];
        const nameExpr = property(obj, "name");
        const index = nameExpr && ts.isIdentifier(nameExpr) ? params.indexOf(nameExpr.text) : -1;
        if (index >= 0) {
          const spread = obj.properties.find((p) => ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression) && params.includes(p.expression.text)) as ts.SpreadAssignment | undefined;
          found = { index, def: spread ? params.indexOf((spread.expression as ts.Identifier).text) : null };
        }
      }
      ts.forEachChild(node, look);
    };
    if (fn.body) look(fn.body);
    if (found) helpers.set(name, found);
  }
  return { sf, consts, helpers };
}

interface Command {
  name: string;
  line: number;
  readOnly: boolean;
}

/** The commands an element of `commands: [...]` (or a `command:` value) stands for, or the node the walker can't follow. */
function commandsOf(expr: ts.Expression, f: FileFacts, depth = 0): { commands: Command[]; unfollowed: ts.Node[] } {
  const target = resolveExpr(expr, f.consts);
  if (depth > 10) return { commands: [], unfollowed: [expr] };
  if (ts.isArrayLiteralExpression(target)) {
    const out = { commands: [] as Command[], unfollowed: [] as ts.Node[] };
    for (const el of target.elements) {
      const r = commandsOf(ts.isSpreadElement(el) ? el.expression : el, f, depth + 1);
      out.commands.push(...r.commands);
      out.unfollowed.push(...r.unfollowed);
    }
    return out;
  }
  if (ts.isCallExpression(target)) {
    const callee = calleeName(target);
    if (callee === "defineCommand" && target.arguments[0]) {
      const def = resolveExpr(target.arguments[0], f.consts);
      const name = ts.isObjectLiteralExpression(def) ? property(def, "name") : null;
      if (ts.isObjectLiteralExpression(def) && name && isText(name)) {
        return { commands: [{ name: name.text, line: lineOf(f.sf, name), readOnly: isTrue(property(def, "readOnly", f.consts)) }], unfollowed: [] };
      }
    }
    const helper = callee && ts.isIdentifier(target.expression) ? f.helpers.get(callee) : undefined;
    if (helper) {
      const name = target.arguments[helper.index];
      if (isText(name)) {
        const defArg = helper.def === null ? undefined : target.arguments[helper.def];
        const def = defArg ? resolveExpr(defArg, f.consts) : undefined;
        const readOnly = !!def && ts.isObjectLiteralExpression(def) && isTrue(property(def, "readOnly", f.consts));
        return { commands: [{ name: name.text, line: lineOf(f.sf, name), readOnly }], unfollowed: [] };
      }
    }
  }
  return { commands: [], unfollowed: [expr] };
}

/** Each `defineCli(...)` in a file: its doors, and the gaps the walker can't follow. */
function kitDoors(f: FileFacts): { clis: number; doors: { name: string; line: number; readOnly: boolean }[]; gaps: { line: number; what: string }[] } {
  const doors: { name: string; line: number; readOnly: boolean }[] = [];
  const gaps: { line: number; what: string }[] = [];
  let clis = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node) === "defineCli") {
      clis += 1;
      const def = node.arguments[0] ? resolveExpr(node.arguments[0], f.consts) : undefined;
      const nameExpr = def && ts.isObjectLiteralExpression(def) ? property(def, "name") : null;
      if (!def || !ts.isObjectLiteralExpression(def) || !nameExpr || !isText(nameExpr)) {
        gaps.push({ line: lineOf(f.sf, node), what: "a defineCli whose name isn't a literal" });
      } else {
        const cli = nameExpr.text;
        const one = property(def, "command");
        const many = property(def, "commands");
        if (one) {
          const r = commandsOf(one, f);
          for (const c of r.commands) doors.push({ name: cli, line: lineOf(f.sf, nameExpr), readOnly: c.readOnly });
          for (const n of r.unfollowed) gaps.push({ line: lineOf(f.sf, n), what: `${cli}'s command` });
        }
        if (many) {
          const r = commandsOf(many, f);
          for (const c of r.commands) doors.push({ name: `${cli} ${c.name}`, line: c.line, readOnly: c.readOnly });
          for (const n of r.unfollowed) gaps.push({ line: lineOf(f.sf, n), what: `a command of ${cli}` });
        }
        if (!one && !many) gaps.push({ line: lineOf(f.sf, node), what: `${cli} with neither command nor commands` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(f.sf);
  return { clis, doors, gaps };
}

/** `process`, or `globalThis.process`. */
const isProcess = (n: ts.Node): boolean =>
  (ts.isIdentifier(n) && n.text === "process") || (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "globalThis" && n.name.text === "process");
const isArgv = (n: ts.Node): boolean => ts.isPropertyAccessExpression(n) && isProcess(n.expression) && n.name.text === "argv";
/** `require.main === module`. */
const isMainCheck = (n: ts.Node): boolean =>
  ts.isBinaryExpression(n) &&
  [n.left, n.right].some((s) => ts.isPropertyAccessExpression(s) && ts.isIdentifier(s.expression) && s.expression.text === "require" && s.name.text === "main") &&
  [n.left, n.right].some((s) => ts.isIdentifier(s) && s.text === "module");

/** Whether a node reads `process.argv` anywhere inside it. */
function readsArgv(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isArgv(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * The node that makes a module an entry point, or null: a `#!` line, a top-level argv read or main check outside any
 * function, or a top-level call (`main()`, `await main()`, `main().catch(...)`) to a function of the file that reads
 * argv.
 */
function entryNode(sf: ts.SourceFile): ts.Node | null {
  if (sf.text.startsWith("#!")) return sf.statements[0] ?? sf;
  const argvFns = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && readsArgv(st)) argvFns.add(st.name.text);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && readsArgv(d.initializer)) argvFns.add(d.name.text);
      }
    }
  }
  let found: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (isArgv(n) || isMainCheck(n) || (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && argvFns.has(n.expression.text))) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** `process.argv[2]`. */
const isFirstWord = (n: ts.Node): boolean => ts.isElementAccessExpression(n) && isArgv(n.expression) && ts.isNumericLiteral(n.argumentExpression) && n.argumentExpression.text === "2";
/** `process.argv.slice(2)`. */
const isArgs = (n: ts.Node): boolean =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && isArgv(n.expression.expression) && n.expression.name.text === "slice" && ts.isNumericLiteral(n.arguments[0] ?? n) && (n.arguments[0] as ts.NumericLiteral).text === "2";

/** The words the first argument is compared with, at the literal's line. */
function firstWords(sf: ts.SourceFile): Map<string, number> {
  const wordVars = new Set<string>();
  const argsVars = new Set<string>();
  const visitDecl = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name) && isFirstWord(n.initializer)) wordVars.add(n.name.text);
      if (ts.isIdentifier(n.name) && isArgs(n.initializer)) argsVars.add(n.name.text);
      if (ts.isArrayBindingPattern(n.name) && isArgs(n.initializer)) {
        const first = n.name.elements[0];
        if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) wordVars.add(first.name.text);
      }
    }
    ts.forEachChild(n, visitDecl);
  };
  visitDecl(sf);
  const isWord = (n: ts.Expression): boolean =>
    isFirstWord(n) ||
    (ts.isIdentifier(n) && wordVars.has(n.text)) ||
    (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && argsVars.has(n.expression.text) && ts.isNumericLiteral(n.argumentExpression) && n.argumentExpression.text === "0");
  const words = new Map<string, number>();
  const add = (lit: ts.Node) => {
    if (isText(lit) && !lit.text.startsWith("-") && lit.text.length > 0 && !words.has(lit.text)) words.set(lit.text, lineOf(sf, lit));
  };
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
      if (isWord(n.left)) add(n.right);
      if (isWord(n.right)) add(n.left);
    }
    if (ts.isSwitchStatement(n) && isWord(n.expression)) for (const c of n.caseBlock.clauses) if (ts.isCaseClause(c)) add(c.expression);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return words;
}

/** The relative modules a file imports directly: static imports, re-exports, `require("./x")` and `import("./x")`. */
function directImports(sf: ts.SourceFile, from: string): string[] {
  const out: string[] = [];
  const add = (spec: ts.Node | undefined) => {
    if (isText(spec) && spec.text.startsWith(".")) out.push(resolve(dirname(from), spec.text));
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) add(n.moduleSpecifier);
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) add(n.arguments[0]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The scripts the hooks files register: every `hooks/<file>` named in a hook's command, and a dispatcher's script. */
function hookScripts(all: readonly string[]): Set<string> {
  const scripts = new Set<string>();
  for (const path of all) {
    if (basename(dirname(path)) !== "hooks" || !/^(copilot-)?hooks\.json$/.test(basename(path))) continue;
    const pluginRoot = dirname(dirname(path));
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        // Every hooks/<file> a command names, and the script a dispatcher runs (`run-hook.cmd session-start`).
        for (const m of value.matchAll(/hooks[\\/]+([A-Za-z0-9._-]+)"?(?:\s+([a-z][a-z0-9-]*))?/g)) {
          scripts.add(join(pluginRoot, "hooks", m[1]!));
          if (m[1]!.endsWith(".cmd") && m[2]) scripts.add(join(pluginRoot, "hooks", m[2]));
        }
      } else if (value && typeof value === "object") for (const v of Object.values(value)) visit(v);
    };
    visit(JSON.parse(readFileSync(path, "utf8")));
  }
  return scripts;
}

function readCards(root: string, path: string | undefined, errors: string[]): DoorCard[] {
  if (!path) return [];
  let parsed: { doors?: unknown };
  try {
    parsed = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    errors.push(`${path}: can't read the cards: ${(error as Error).message.split("\n")[0]}`);
    return [];
  }
  const doors = Array.isArray(parsed.doors) ? parsed.doors : [];
  if (!Array.isArray(parsed.doors) || doors.some((d) => typeof (d as DoorCard)?.id !== "string")) errors.push(`${path}: doors must be a list of cards, each with an id`);
  return doors.filter((d) => typeof (d as DoorCard)?.id === "string") as DoorCard[];
}

/** Every string literal in a file outside error cards. */
function literals(sf: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set(node.properties.map((p) => keyText(p.name)));
      if (keys.has("code") && keys.has("means") && keys.has("fix")) return;
    }
    if (isText(node)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const kindOfScript = (file: string): ts.ScriptKind => (/\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);

export async function walk(opts: WalkerOptions): Promise<WalkResult> {
  const dir = resolve(opts.root, opts.source);
  const all = statSync(dir).isDirectory() ? files(dir) : [dir];
  const errors: string[] = [];
  const parsed = new Map<string, ts.SourceFile>();
  const sourceOf = (path: string): ts.SourceFile => {
    let sf = parsed.get(path);
    if (!sf) {
      sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kindOfScript(path));
      parsed.set(path, sf);
    }
    return sf;
  };
  const found: Found[] = [];
  const unwalked: Gap[] = [];
  const door = (name: string, file: string, line: number, readOnly: boolean): Found => ({
    door: { id: `cli:${name}`, kind: "cli", product: opts.product, name, description: "", file: relative(opts.root, file), line, card: null, evidence: {} },
    readOnly,
  });
  const claimedByHooks = hookScripts(all);
  const kitFiles = new Set<string>();
  const entries: { path: string; node: ts.Node }[] = [];
  for (const path of all) {
    if (path.endsWith(".py")) {
      const line = pythonEntry(path);
      if (line !== null && !claimedByHooks.has(path)) found.push(door(`python3 ${relative(opts.root, path)}`, path, line, false));
      continue;
    }
    if (!SCRIPT.test(path) || NOT_SCRIPT.test(path)) {
      if (isShellScript(path) && !claimedByHooks.has(path)) found.push(door(relative(opts.root, path), path, 1, false));
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (!text.startsWith("#!") && !text.includes("argv") && !text.includes("defineCli") && !text.includes("require.main")) continue;
    const sf = sourceOf(path);
    if (text.includes("defineCli")) {
      const kit = kitDoors(facts(sf));
      if (kit.clis > 0) kitFiles.add(path);
      for (const d of kit.doors) found.push(door(d.name, path, d.line, d.readOnly));
      for (const g of kit.gaps) {
        unwalked.push({ id: `cli:${relative(opts.root, path)}:${g.line}`, kind: "cli", file: relative(opts.root, path), line: g.line, reasons: [`unwalked: ${g.what}`] });
      }
    }
    const node = entryNode(sf);
    if (node) entries.push({ path, node });
  }
  for (const { path, node } of entries) {
    if (kitFiles.has(path) || claimedByHooks.has(path)) continue;
    const imports = directImports(sourceOf(path), path);
    if (imports.some((i) => kitFiles.has(i))) continue;
    const sf = sourceOf(path);
    const name = `node ${relative(opts.root, path)}`;
    found.push(door(name, path, lineOf(sf, node), false));
    for (const [word, line] of firstWords(sf)) found.push(door(`${name} ${word}`, path, line, false));
  }

  if (found.length === 0 && unwalked.length === 0) errors.push(`${opts.source}: no commands or scripts under it, so the walker finds nothing. Fix: point the source at a folder of code.`);
  const cards = readCards(opts.root, opts.cards, errors);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const handlerLiterals = new Set<string>();
  for (const h of opts.handlers ?? []) {
    const p = resolve(opts.root, h);
    for (const f of statSync(p).isDirectory() ? files(p).filter((x) => SCRIPT.test(x)) : [p]) for (const l of literals(sourceOf(f))) handlerLiterals.add(l);
  }
  const doors: Door[] = [];
  const seen = new Set<string>();
  for (const { door: d, readOnly } of found) {
    if (seen.has(d.id)) {
      errors.push(`${d.id}: found twice (again at ${d.file}:${d.line})`);
      continue;
    }
    seen.add(d.id);
    const card = byId.get(d.id) ?? null;
    let raises: string[] | undefined;
    if (card && Array.isArray(card.errors) && SCRIPT.test(d.file)) {
      const own = literals(sourceOf(resolve(opts.root, d.file)));
      const has = (code: string) => own.has(code) || own.has(code.replaceAll("-", "_")) || handlerLiterals.has(code) || handlerLiterals.has(code.replaceAll("-", "_"));
      raises = card.errors.map((e) => e?.code).filter((code): code is string => typeof code === "string" && has(code));
    }
    doors.push({ ...d, card, evidence: { ...(readOnly ? { readOnly: true } : {}), ...(raises ? { raises } : {}) } });
  }
  for (const id of byId.keys()) if (!seen.has(id)) errors.push(`${id}: a card in ${opts.cards} for a command the walker doesn't find under ${opts.source}. Fix: remove the card, or fix its id.`);
  return { doors, errors, unwalked };
}
