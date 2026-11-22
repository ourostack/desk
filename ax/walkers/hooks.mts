// Desk's hooks walker: every hook Desk registers with a host. A hook's output is text or a refusal the agent reads, so
// each registered command is a door. Read from the hooks files, never run.
//
// Under the source folder (one folder per plugin), `<plugin>/hooks/hooks.json` is Claude Code's format
// (`{ "hooks": { "<Event>": [{ "matcher"?, "hooks": [{ "command" }] }] } }`) and `<plugin>/hooks/copilot-hooks.json`
// is Copilot's (`{ "hooks": { "<event>": [{ "matcher"?, "bash", "powershell" }] } }`). Each command is a door
// `hook:<plugin> <host> <event> <script>`, where the script is the `hooks/<file>` the command runs (with the word after
// it for a dispatcher such as `run-hook.cmd session-start`), at the line of its command in the file. A command that
// names no script under hooks/ is an unwalked gap.
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
  text: string;
  line: number;
}

/** Each command string under `hooks.<event>` with its line: Claude's `command`, or Copilot's `bash`. */
function commands(path: string): Command[] {
  const sf = ts.parseJsonText(path, readFileSync(path, "utf8"));
  const out: Command[] = [];
  const root = sf.statements[0]?.expression;
  const prop = (obj: ts.Node, key: string): ts.Expression | undefined =>
    ts.isObjectLiteralExpression(obj) ? (obj.properties.find((p) => ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name) && p.name.text === key) as ts.PropertyAssignment | undefined)?.initializer : undefined;
  const hooks = root && prop(root, "hooks");
  if (!hooks || !ts.isObjectLiteralExpression(hooks)) return out;
  for (const p of hooks.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.name) || !ts.isArrayLiteralExpression(p.initializer)) continue;
    const event = p.name.text;
    const visit = (node: ts.Node): void => {
      for (const key of ["command", "bash"]) {
        const value = prop(node, key);
        if (value && ts.isStringLiteral(value)) out.push({ event, text: value.text, line: sf.getLineAndCharacterOfPosition(value.getStart(sf)).line + 1 });
      }
      ts.forEachChild(node, visit);
    };
    visit(p.initializer);
  }
  return out;
}

/** The `hooks/<file>` a command runs, with the word after a dispatcher (`run-hook.cmd session-start`). */
function scriptOf(text: string): string | null {
  const m = /hooks[\\/]+([A-Za-z0-9._-]+)"?(?:\s+([a-z][a-z0-9-]*))?/.exec(text);
  if (!m) return null;
  return m[1]!.endsWith(".cmd") && m[2] ? `${m[1]} ${m[2]}` : m[1]!;
}

export async function walk(opts: WalkerOptions): Promise<WalkResult> {
  const base = resolve(opts.root, opts.source);
  const doors: Door[] = [];
  const unwalked: Gap[] = [];
  const errors: string[] = [];
  const plugins = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const plugin of plugins) {
    for (const [file, host] of HOSTS) {
      const path = join(base, plugin, "hooks", file);
      if (!existsSync(path)) continue;
      for (const c of commands(path)) {
        const script = scriptOf(c.text);
        const rel = relative(opts.root, path);
        if (!script) {
          unwalked.push({ id: `hook:${plugin} ${host} ${c.event}`, kind: "hook", file: rel, line: c.line, reasons: ["unwalked: a command that names no script under hooks/"] });
          continue;
        }
        const name = `${plugin} ${host} ${c.event} ${script}`;
        if (doors.some((d) => d.name === name)) {
          errors.push(`hook:${name}: registered twice in ${rel}`);
          continue;
        }
        doors.push({ id: `hook:${name}`, kind: "hook", product: opts.product, name, description: "", file: rel, line: c.line, card: null, evidence: {} });
      }
    }
  }

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
