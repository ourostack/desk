// Desk's MCP walker: the tools a Desk MCP server lists, from the registry it serves them from. Desk's servers don't
// export the census's getToolSchemas(), so the built-in mcp-schemas walker can't read them.
//
// A source's `module` is the registry: either a JavaScript module exporting `TOOL_NAMES` (the names tools/list serves,
// in order), `TOOL_DESCRIPTIONS` and `TOOL_ANNOTATIONS` (name to served annotations), as the desk server's
// src/tool-names.js does; or a JSON catalog served whole, `{ "tools": [{ "name", "description", "annotations" }] }`, as
// desk-web's web-catalog.json is. `source` is the file whose syntax tree holds each name as a literal (the TOOL_NAMES
// array's elements, or a catalog tool's "name"), which gives each door its line; a name with no literal there is a door
// with line null.
//
// `cards` is the sidecar holding the server's cards: `{ "errors": [ErrorCard], "doors": [DoorCard] }`, where `errors`
// are the server's own (an `unknown-door` card, the answer to a tool name it doesn't serve). A card whose door the
// server doesn't list is a census error, so a card can't outlive its tool. `handlers` are the files or folders that
// raise the tools' error codes: a card's code counts as raised when one of them holds it as a string literal, as written,
// with its hyphens as underscores (Desk's codes are snake_case on the wire, a card's are kebab-case), or in upper snake
// case (desk-web writes its codes as AUTH_TIMEOUT and serves them lowercased in structuredContent.code).
//
// Read-only evidence is the served `readOnlyHint`. Nothing here calls a tool.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { Door, DoorCard, ErrorCard, WalkerOptions, WalkResult } from "../scripts/ouro-census/types.mts";

interface Tool {
  name: string;
  description: string;
  readOnly: boolean;
}

const SCRIPT = /\.[cm]?[jt]s$/;
const SKIP = new Set(["node_modules", "__tests__", "fixtures"]);
// Vendored kits (lib/ouro-ui, lib/ouro-actions) raise their own codes, not the server's.
const VENDORED = new Set(["ouro-ui", "ouro-actions"]);

const kindOf = (file: string): ts.ScriptKind => (/\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : file.endsWith(".json") ? ts.ScriptKind.JSON : ts.ScriptKind.JS);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kindOf(file));
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const keyText = (name: ts.PropertyName): string | null => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null);

/** The line of each tool name's literal: the elements of a `TOOL_NAMES` array, or the `"name"` of a catalog's tools. */
function nameLines(sf: ts.SourceFile): Map<string, number> {
  const lines = new Map<string, number>();
  const add = (node: ts.Node) => {
    if (isText(node) && !lines.has(node.text)) lines.set(node.text, lineOf(sf, node));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "TOOL_NAMES" && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      node.initializer.elements.forEach(add);
    }
    if (ts.isPropertyAssignment(node) && keyText(node.name) === "tools" && ts.isArrayLiteralExpression(node.initializer)) {
      for (const tool of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(tool)) continue;
        for (const p of tool.properties) if (ts.isPropertyAssignment(p) && keyText(p.name) === "name") add(p.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

async function readTools(path: string, label: string): Promise<{ tools: Tool[]; errors: string[] }> {
  const errors: string[] = [];
  let names: unknown;
  let describe: (name: string, i: number) => unknown;
  let readOnly: (name: string, i: number) => unknown;
  if (path.endsWith(".json")) {
    const catalog = JSON.parse(readFileSync(path, "utf8")) as { tools?: { name?: unknown; description?: unknown; annotations?: { readOnlyHint?: unknown } }[] };
    const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
    if (!Array.isArray(catalog.tools)) errors.push(`${label}: a catalog with no tools list`);
    names = tools.map((t) => t?.name);
    describe = (_, i) => tools[i]?.description;
    readOnly = (_, i) => tools[i]?.annotations?.readOnlyHint;
  } else {
    const loaded = (await import(pathToFileURL(path).href)) as { TOOL_NAMES?: unknown; TOOL_DESCRIPTIONS?: Record<string, unknown>; TOOL_ANNOTATIONS?: Record<string, { readOnlyHint?: unknown } | undefined> };
    names = loaded.TOOL_NAMES;
    if (!Array.isArray(names)) errors.push(`${label}: exports no TOOL_NAMES list`);
    describe = (name) => loaded.TOOL_DESCRIPTIONS?.[name];
    readOnly = (name) => loaded.TOOL_ANNOTATIONS?.[name]?.readOnlyHint;
  }
  const tools: Tool[] = [];
  (Array.isArray(names) ? names : []).forEach((name, i) => {
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`${label}: a tool without a name`);
      return;
    }
    const description = describe(name, i);
    tools.push({ name, description: typeof description === "string" ? description : "", readOnly: readOnly(name, i) === true });
  });
  return { tools, errors };
}

interface Sidecar {
  errors: ErrorCard[];
  doors: DoorCard[];
}

function readSidecar(root: string, path: string | undefined, errors: string[]): Sidecar {
  if (!path) return { errors: [], doors: [] };
  let parsed: { errors?: unknown; doors?: unknown };
  try {
    parsed = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    errors.push(`${path}: can't read the cards: ${(error as Error).message.split("\n")[0]}`);
    return { errors: [], doors: [] };
  }
  const doors = Array.isArray(parsed.doors) ? parsed.doors : [];
  if (!Array.isArray(parsed.doors) || doors.some((d) => typeof (d as DoorCard)?.id !== "string")) errors.push(`${path}: doors must be a list of cards, each with an id`);
  return { errors: Array.isArray(parsed.errors) ? (parsed.errors as ErrorCard[]) : [], doors: doors.filter((d) => typeof (d as DoorCard)?.id === "string") as DoorCard[] };
}

function scriptFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? (SKIP.has(e.name) || (VENDORED.has(e.name) && basename(path) === "lib") ? [] : scriptFiles(join(path, e.name))) : SCRIPT.test(e.name) ? [join(path, e.name)] : []));
}

/** Every string literal in the handler files, outside error cards. */
function raisedLiterals(root: string, handlers: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const handler of handlers) {
    for (const file of scriptFiles(resolve(root, handler))) {
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const keys = new Set(node.properties.map((p) => (p.name ? keyText(p.name as ts.PropertyName) : null)));
          if (keys.has("code") && keys.has("means") && keys.has("fix")) return;
        }
        if (isText(node)) found.add(node.text);
        ts.forEachChild(node, visit);
      };
      visit(parse(file));
    }
  }
  return found;
}

const raised = (literals: ReadonlySet<string>, code: unknown): boolean =>
  typeof code === "string" && (literals.has(code) || literals.has(code.replaceAll("-", "_")) || literals.has(code.replaceAll("-", "_").toUpperCase()));

export async function walk(opts: WalkerOptions): Promise<WalkResult> {
  const registry = resolve(opts.root, opts.module);
  const sourcePath = resolve(opts.root, opts.source);
  const file = relative(opts.root, sourcePath);
  const { tools, errors } = await readTools(registry, relative(opts.root, registry));
  const lines = nameLines(parse(sourcePath));
  const sidecar = readSidecar(opts.root, opts.cards, errors);
  const literals = raisedLiterals(opts.root, opts.handlers ?? []);
  const cards = new Map(sidecar.doors.map((card) => [card.id, card]));
  const doors: Door[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const id = `mcp:${tool.name}`;
    if (seen.has(id)) {
      errors.push(`${id}: listed twice in ${relative(opts.root, registry)}`);
      continue;
    }
    seen.add(id);
    const card = cards.get(id) ?? null;
    doors.push({
      id,
      kind: "mcp",
      product: opts.product,
      name: tool.name,
      description: tool.description,
      file,
      line: lines.get(tool.name) ?? null,
      card,
      evidence: {
        ...(tool.readOnly ? { readOnly: true } : {}),
        ...(card && Array.isArray(card.errors) && opts.handlers ? { raises: card.errors.map((e) => e?.code).filter((code) => raised(literals, code)) } : {}),
      },
    });
  }
  for (const id of cards.keys()) if (!seen.has(id)) errors.push(`${id}: a card in ${opts.cards} for a tool ${relative(opts.root, registry)} doesn't list. Fix: remove the card, or serve the tool.`);
  if (cards.size > 0) {
    if (!sidecar.errors.some((e) => e?.code === "unknown-door")) errors.push(`${opts.cards}: declares tool cards but no server errors with an unknown-door card, the answer to an unknown tool name`);
    else if (opts.handlers && !raised(literals, "unknown-door")) errors.push(`${opts.cards}: the unknown-door code is never raised in ${opts.handlers.join(", ")}`);
  }
  return { doors, errors };
}
