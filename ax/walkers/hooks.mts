// Desk's hooks walker: every hook Desk registers with a host. A hook's output is text or a refusal the agent reads, so
// each registered command is a door. Read from the hooks files, never run.
//
// Under the source folder (one folder per plugin), `<plugin>/hooks/hooks.json` is Claude Code's format
// (`{ "hooks": { "<Event>": [{ "matcher"?, "hooks": [{ "command" }] }] } }`) and `<plugin>/hooks/copilot-hooks.json`
// is Copilot's (`{ "hooks": { "<event>": [{ "matcher"?, "bash", "powershell" }] } }`). Each command is a door
// `hook:<plugin> <host> <event> <script>`, where the script is the `hooks/<file>` the command runs (with the word after
// it for a dispatcher such as `run-hook.cmd session-start`), at the line of its command in the file. A command that
// names no script under hooks/ is an unwalked gap. The same script on one event under a second matcher is a door of its
// own, `... <script> [<matcher>]`. A hooks file with no `hooks` object is a census error, and so is a source with no
// hooks at all: the walker would otherwise go blind and the census would ask for the doors to come off the baseline.
//
// A Copilot SDK extension under `<plugin>/optional/<name>/extension.mjs` registers hooks in code, as the keys of the
// `hooks` object it passes to `joinSession`. Each key is a door `hook:<plugin> copilot-extension <key> <name>`; an
// extension whose hooks the walker can't read is an unwalked gap.
//
// `cards` is the sidecar of cards, `{ "doors": [DoorCard & { uses: string[] }] }`; like a skill, a hook declares the
// doors its text tells the agent to use. A card without `uses`, and a card whose door isn't found, are census errors.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, DoorCard, Gap, WalkerOptions, WalkResult } from "../scripts/ouro-census/types.mts";

const HOSTS: readonly [file: string, host: string][] = [
  ["hooks.json", "claude"],
  ["copilot-hooks.json", "copilot"],
];

interface Command {
  event: string;
  /** The entry's matcher; Claude's sits on the group above the command, so it's inherited. */
  matcher: string | null;
  text: string;
  line: number;
}

/** Each command string under `hooks.<event>` with its line: Claude's `command`, or Copilot's `bash`. */
function commands(path: string): Command[] | null {
  const sf = ts.parseJsonText(path, readFileSync(path, "utf8"));
  const out: Command[] = [];
  const root = sf.statements[0]?.expression;
  const prop = (obj: ts.Node, key: string): ts.Expression | undefined =>
    ts.isObjectLiteralExpression(obj) ? (obj.properties.find((p) => ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name) && p.name.text === key) as ts.PropertyAssignment | undefined)?.initializer : undefined;
  const hooks = root && prop(root, "hooks");
  if (!hooks || !ts.isObjectLiteralExpression(hooks)) return null;
  for (const p of hooks.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.name) || !ts.isArrayLiteralExpression(p.initializer)) continue;
    const event = p.name.text;
    const visit = (node: ts.Node, inherited: string | null): void => {
      const own = prop(node, "matcher");
      const matcher = own && ts.isStringLiteral(own) ? own.text : inherited;
      for (const key of ["command", "bash"]) {
        const value = prop(node, key);
        if (value && ts.isStringLiteral(value)) out.push({ event, matcher, text: value.text, line: sf.getLineAndCharacterOfPosition(value.getStart(sf)).line + 1 });
      }
      ts.forEachChild(node, (child) => visit(child, matcher));
    };
    visit(p.initializer, null);
  }
  return out;
}

/** The `hooks/<file>` a command runs, with the word after a dispatcher (`run-hook.cmd session-start`). */
function scriptOf(text: string): string | null {
  const m = /hooks[\\/]+([A-Za-z0-9._-]+)"?(?:\s+([a-z][a-z0-9-]*))?/.exec(text);
  if (!m) return null;
  return m[1]!.endsWith(".cmd") && m[2] ? `${m[1]} ${m[2]}` : m[1]!;
}

/** Each `<plugin>/optional/<name>/extension.mjs`, with the keys of the `hooks` it passes to joinSession (null when unreadable). */
function extensions(pluginDir: string): { name: string; path: string; line: number; keys: { key: string; line: number }[] | null }[] {
  const dir = join(pluginDir, "optional");
  if (!existsSync(dir)) return [];
  const out: { name: string; path: string; line: number; keys: { key: string; line: number }[] | null }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
    const path = join(dir, e, "extension.mjs");
    if (!existsSync(path)) continue;
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    let call: ts.CallExpression | null = null;
    const find = (n: ts.Node): void => {
      if (!call && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "joinSession") call = n;
      ts.forEachChild(n, find);
    };
    find(sf);
    const found = call as ts.CallExpression | null;
    const arg = found?.arguments[0];
    const hooks = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "hooks") : undefined;
    const value = hooks && ts.isPropertyAssignment(hooks) ? hooks.initializer : undefined;
    if (!found || !value || !ts.isObjectLiteralExpression(value)) {
      out.push({ name: e, path, line: found ? lineOf(found) : 1, keys: null });
      continue;
    }
    const keys = value.properties.flatMap((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [{ key: p.name.text, line: lineOf(p) }] : []));
    out.push({ name: e, path, line: lineOf(found), keys });
  }
  return out;
}

export async function walk(opts: WalkerOptions): Promise<WalkResult> {
  const base = resolve(opts.root, opts.source);
  const doors: Door[] = [];
  const unwalked: Gap[] = [];
  const errors: string[] = [];
  const plugins = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const registered = new Map<string, (string | null)[]>();
  for (const plugin of plugins) {
    for (const ext of extensions(join(base, plugin))) {
      const rel = relative(opts.root, ext.path);
      if (!ext.keys) unwalked.push({ id: `hook:${plugin} copilot-extension ${ext.name}`, kind: "hook", file: rel, line: ext.line, reasons: ["unwalked: an extension whose joinSession hooks the walker can't read"] });
      for (const k of ext.keys ?? []) {
        const name = `${plugin} copilot-extension ${k.key} ${ext.name}`;
        doors.push({ id: `hook:${name}`, kind: "hook", product: opts.product, name, description: "", file: rel, line: k.line, card: null, evidence: {} });
      }
    }
    for (const [file, host] of HOSTS) {
      const path = join(base, plugin, "hooks", file);
      if (!existsSync(path)) continue;
      const rel = relative(opts.root, path);
      const found = commands(path);
      if (!found) {
        errors.push(`${rel}: no hooks object, so the walker finds no hooks in it.`);
        continue;
      }
      for (const c of found) {
        const script = scriptOf(c.text);
        if (!script) {
          unwalked.push({ id: `hook:${plugin} ${host} ${c.event}`, kind: "hook", file: rel, line: c.line, reasons: ["unwalked: a command that names no script under hooks/"] });
          continue;
        }
        const plain = `${plugin} ${host} ${c.event} ${script}`;
        const same = registered.get(plain) ?? [];
        if (same.includes(c.matcher)) {
          errors.push(`hook:${plain}: registered twice in ${rel}`);
          continue;
        }
        const name = same.length === 0 ? plain : `${plain} [${c.matcher ?? ""}]`;
        same.push(c.matcher);
        registered.set(plain, same);
        doors.push({ id: `hook:${name}`, kind: "hook", product: opts.product, name, description: "", file: rel, line: c.line, card: null, evidence: {} });
      }
    }
  }

  if (doors.length === 0 && unwalked.length === 0 && errors.length === 0) errors.push(`${opts.source}: no hooks registered under it, so the walker finds nothing. Fix: point the source at the folder of plugins.`);

  let cards: (DoorCard & { uses?: unknown })[] = [];
  if (opts.cards) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(opts.root, opts.cards), "utf8")) as { doors?: unknown };
      const list = Array.isArray(parsed.doors) ? parsed.doors : [];
      if (!Array.isArray(parsed.doors) || list.some((d) => typeof (d as DoorCard)?.id !== "string")) errors.push(`${opts.cards}: doors must be a list of cards, each with an id`);
      cards = list.filter((d) => typeof (d as DoorCard)?.id === "string") as typeof cards;
    } catch (error) {
      errors.push(`${opts.cards}: can't read the cards: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  const ids = new Set(doors.map((d) => d.id));
  for (const card of cards) {
    if (!ids.has(card.id)) errors.push(`${card.id}: a card in ${opts.cards} for a hook the walker doesn't find under ${opts.source}. Fix: remove the card, or fix its id.`);
    else if (!Array.isArray(card.uses) || card.uses.some((u) => typeof u !== "string" || !/^[a-z][a-z0-9-]*:\S/.test(u))) {
      errors.push(`${card.id}: the card's uses must list the door ids its text tells the agent to use, such as "mcp:desk_status", or [] when it names none.`);
    }
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  return { doors: doors.map((d) => ({ ...d, card: byId.get(d.id) ?? null })), errors, unwalked };
}
