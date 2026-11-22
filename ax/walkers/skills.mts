// Desk's skills walker: every skill and agent file Desk ships, each a door an agent loads by name. Read from the files,
// never loaded.
//
// Under the source folder (one folder per plugin), each `<plugin>/skills/<skill>/SKILL.md` is a door
// `skill:<plugin>:<skill>`, and each agent file is a door `agent:<plugin>:<name> <host>`: `<plugin>/agents/<name>.md`
// is Claude Code's (`claude`) and `<plugin>/agents/<name>.agent.md` is Copilot's (`copilot`). A door's description is
// its frontmatter `description`, and its line is that of the frontmatter's `name` (else 1). A skill folder without a
// SKILL.md is an unwalked gap, and a source with no skills or agent files at all is a census error: the walker would
// otherwise go blind and the census would ask for the doors to come off the baseline.
//
// `cards` is the sidecar of cards, `{ "doors": [DoorCard & { uses: string[] }] }`. A skill or agent file declares the
// doors it tells the agent to use, as `uses`: ids such as `mcp:task_update`, `cli:drains poll` or
// `skill:desk:start-task`, or `host:<tool>` for a tool the host provides. A card without `uses`, a `uses` entry that
// isn't an id, one that names a skill or agent file this walker doesn't find, and a card whose door isn't found, are
// census errors. Loading a skill's text changes nothing, so a skill door's read-only evidence is true; an agent file
// starts an agent, so it has none.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Door, DoorCard, Gap, WalkerOptions, WalkResult } from "../scripts/ouro-census/types.mts";

const ID = /^[a-z][a-z0-9-]*:\S.*$/;

/** The frontmatter's top-level `key: value` pairs, folded block values joined by spaces, and each key's line. */
export function frontmatter(text: string): { fields: Record<string, string>; lines: Record<string, number> } {
  const fields: Record<string, string> = {};
  const lines: Record<string, number> = {};
  const all = text.split(/\r?\n/);
  if (all[0]?.trim() !== "---") return { fields, lines };
  let key: string | null = null;
  let block: string[] | null = null;
  const close = () => {
    if (key && block) fields[key] = block.join(" ").trim();
    block = null;
  };
  for (let i = 1; i < all.length; i++) {
    const line = all[i]!;
    if (line.trim() === "---") break;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      close();
      key = m[1]!;
      lines[key] = i + 1;
      const value = m[2]!.trim();
      if (/^[>|][-+]?$/.test(value)) block = [];
      else fields[key] = value.replace(/^(["'])(.*)\1$/, "$2");
    } else if (block && /^\s/.test(line)) {
      (block as string[]).push(line.trim());
    }
  }
  close();
  return { fields, lines };
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function markdown(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export async function walk(opts: WalkerOptions): Promise<WalkResult> {
  const base = resolve(opts.root, opts.source);
  const doors: Door[] = [];
  const unwalked: Gap[] = [];
  const add = (kind: "skill" | "agent", name: string, path: string) => {
    const { fields, lines } = frontmatter(readFileSync(path, "utf8"));
    doors.push({
      id: `${kind}:${name}`,
      kind,
      product: opts.product,
      name,
      description: fields.description ?? "",
      file: relative(opts.root, path),
      line: lines.name ?? 1,
      card: null,
      evidence: kind === "skill" ? { readOnly: true } : {},
    });
  };
  for (const plugin of dirs(base)) {
    for (const skill of dirs(join(base, plugin, "skills"))) {
      const path = join(base, plugin, "skills", skill, "SKILL.md");
      if (isFile(path)) add("skill", `${plugin}:${skill}`, path);
      else unwalked.push({ id: `skill:${plugin}:${skill}`, kind: "skill", file: relative(opts.root, join(base, plugin, "skills", skill)), line: null, reasons: ["unwalked: a skill folder without a SKILL.md"] });
    }
    for (const file of markdown(join(base, plugin, "agents"))) {
      const copilot = file.endsWith(".agent.md");
      add("agent", `${plugin}:${file.slice(0, copilot ? -9 : -3)} ${copilot ? "copilot" : "claude"}`, join(base, plugin, "agents", file));
    }
  }

  const errors: string[] = [];
  if (doors.length === 0 && unwalked.length === 0) errors.push(`${opts.source}: no skills or agent files under it, so the walker finds nothing. Fix: point the source at the folder of plugins.`);
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
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const card of cards) {
    if (!ids.has(card.id)) {
      errors.push(`${card.id}: a card in ${opts.cards} for a skill or agent file the walker doesn't find under ${opts.source}. Fix: remove the card, or fix its id.`);
      continue;
    }
    if (!Array.isArray(card.uses)) {
      errors.push(`${card.id}: the card names no uses. Fix: list the doors it tells the agent to use, such as "mcp:task_update" or "host:Bash", or [] when it uses none.`);
      continue;
    }
    for (const use of card.uses) {
      if (typeof use !== "string" || !ID.test(use)) errors.push(`${card.id}: uses ${JSON.stringify(use)}, which isn't a door id such as "mcp:task_update".`);
      else if ((use.startsWith("skill:") || use.startsWith("agent:")) && !ids.has(use)) errors.push(`${card.id}: uses ${use}, which the walker doesn't find. Fix: name a skill or agent file that exists.`);
    }
  }
  return { doors: doors.map((d) => ({ ...d, card: byId.get(d.id) ?? null })), errors, unwalked };
}
