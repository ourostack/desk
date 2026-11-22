// The doors a Desk skill or hook card says it uses must exist. Each card's `uses` lists door ids ("mcp:task_update",
// "cli:drains poll", "skill:desk:start-task"), or "host:<tool>" for a tool the host provides. A walker sees only its
// own doors, so this check runs every Desk walker in the census config and fails on a `uses` entry that names no
// door any of them finds. Run after the census, from the repository root:
//   node ax/check-uses.mts ax/census.config.json
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Door, WalkerOptions, WalkResult } from "./scripts/ouro-census/types.mts";

interface Config {
  product: string;
  walkers: Record<string, { module: string }>;
  sources: (Omit<WalkerOptions, "root" | "product"> & { walker: string })[];
}

/** Each `uses` entry that names no door the config's Desk walkers find, as "<card id>: uses <id>". */
export async function unresolvedUses(configPath: string, root: string): Promise<string[]> {
  const config = JSON.parse(readFileSync(resolve(root, configPath), "utf8")) as Config;
  const doors: Door[] = [];
  for (const { walker, ...source } of config.sources) {
    const def = config.walkers[walker];
    if (!def) continue;
    const mod = (await import(pathToFileURL(resolve(root, def.module)).href)) as { walk: (o: WalkerOptions) => Promise<WalkResult> };
    doors.push(...(await mod.walk({ ...source, root, product: config.product } as WalkerOptions)).doors);
  }
  const ids = new Set(doors.map((d) => d.id));
  const problems: string[] = [];
  for (const door of doors) {
    const uses = (door.card as { uses?: unknown } | null)?.uses;
    if (!Array.isArray(uses)) continue;
    for (const use of uses) if (typeof use === "string" && !use.startsWith("host:") && !ids.has(use)) problems.push(`${door.id}: uses ${use}, which no walker finds. Fix: name a door that exists, or "host:<tool>" for a host tool.`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = await unresolvedUses(process.argv[2] ?? "ax/census.config.json", process.cwd());
  for (const p of problems) process.stderr.write(`${p}\n`);
  process.stdout.write(`check-uses: ${problems.length} unresolved\n`);
  process.exitCode = problems.length ? 1 : 0;
}
