// Desk's HTTP walker: the routes of an Express app Hosted Desk serves, read from the syntax tree (never served).
//
// The source is the file that builds the app. Every call `<app>.<method>(<path>, ...)` on a variable assigned
// `express()` in that file is a door `http:<label> <METHOD> <path>`, where `<label>` is the source's `module` (which
// app it is, as Desk deploys it: `gateway`, `hooks`) and `<method>` is get, post, put, patch, delete, all or use. A
// path list is one door per path. `use` with a function or express's own middleware (`express.json()`) first is
// middleware, not a door. `use` with a router a known factory builds (`app.use(mcpAuthRouter(options))`) is a door for
// each route that factory mounts, from ROUTERS; any other router, an `express.Router()` or an `app.route()` is an
// unwalked gap, since its routes aren't in this file. A route whose path isn't a literal is an unwalked gap too, and a
// source with no express app, or with an app but no routes, is a census error: the walker would otherwise go blind
// and the census would ask for the doors to come off the baseline.
//
// `cards` is the sidecar of cards, `{ "doors": [DoorCard] }`; a card whose door isn't found is a census error. The
// literals outside error cards, in the file and in the local modules it imports (followed through their imports), are
// the codes it may raise, as written or with hyphens as underscores. A route's handler may live in an imported file.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { importClosure } from "./imports.mts";
import type { Door, DoorCard, Gap, WalkerOptions, WalkResult } from "../scripts/ouro-census/types.mts";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use", "route"]);

// The routes a router factory mounts, as the library builds them. mcpAuthRouter is @modelcontextprotocol/sdk 1.x's
// (dist/esm/server/auth/router.js): the authorization and token endpoints, the metadata routes, and dynamic client
// registration and revocation, which it mounts when the provider supports them (counted here either way).
const ROUTERS: Readonly<Record<string, readonly string[]>> = {
  mcpAuthRouter: ["/authorize", "/token", "/register", "/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"],
};
const isText = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
/** `express.json()` and the other middleware express itself builds. */
const isExpressMiddleware = (n: ts.Node): boolean => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "express";
const keyText = (name: ts.PropertyName | undefined): string | null => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null);

export async function walk(opts: WalkerOptions): Promise<WalkResult> {
  const path = resolve(opts.root, opts.source);
  const file = relative(opts.root, path);
  const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const apps = new Set<string>();
  const literals = new Set<string>();
  const collect = (into: Set<string>) => (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const keys = new Set(n.properties.map((p) => keyText(p.name)));
      if (keys.has("code") && keys.has("means") && keys.has("fix")) return;
    }
    if (isText(n)) into.add(n.text);
    ts.forEachChild(n, collect(into));
  };
  const findApps = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text === "express") apps.add(n.name.text);
    ts.forEachChild(n, findApps);
  };
  findApps(sf);
  const parse = (p: string): ts.SourceFile => (p === path ? sf : ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true, /\.[cm]?ts$/.test(p) ? ts.ScriptKind.TS : ts.ScriptKind.JS));
  for (const p of importClosure(path, parse)) collect(literals)(parse(p));

  const errors: string[] = [];
  const doors: Door[] = [];
  const unwalked: Gap[] = [];
  const label = opts.module;
  const add = (method: string, route: string, node: ts.Node) => {
    const name = `${label} ${method} ${route}`;
    if (doors.some((d) => d.name === name)) return;
    doors.push({ id: `http:${name}`, kind: "http", product: opts.product, name, description: "", file, line: lineOf(node), card: null, evidence: {} });
  };
  const gap = (what: string, n: ts.Node, why: string) => unwalked.push({ id: `http:${label} ${what}`, kind: "http", file, line: lineOf(n), reasons: [`unwalked: ${why}`] });
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "express" && n.expression.name.text === "Router") {
      gap(`ROUTER ${file}:${lineOf(n)}`, n, "an express.Router(), whose routes the walker doesn't follow");
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && apps.has(n.expression.expression.text) && METHODS.has(n.expression.name.text)) {
      const method = n.expression.name.text.toUpperCase();
      const first = n.arguments[0];
      if (method === "ROUTE") gap(`ROUTE ${file}:${lineOf(n)}`, n, "an app.route() chain");
      else if (isText(first)) add(method, first.text, first);
      else if (first && ts.isArrayLiteralExpression(first) && first.elements.length > 0 && first.elements.every(isText)) for (const el of first.elements) add(method, (el as ts.StringLiteral).text, el);
      else if (method === "USE" && first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first) || isExpressMiddleware(first))) {
        // Middleware: it runs on every request and adds no route.
      } else if (method === "USE" && first && ts.isCallExpression(first) && ts.isIdentifier(first.expression) && Object.hasOwn(ROUTERS, first.expression.text)) {
        for (const route of ROUTERS[first.expression.text]!) add(method, route, first);
      } else if (method === "USE" && first && ts.isCallExpression(first)) gap(`USE ${first.expression.getText(sf)}()`, n, "a router whose routes aren't in this file");
      else gap(`${method} ${file}:${lineOf(n)}`, n, "a route whose path isn't a literal");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (apps.size === 0) errors.push(`${file}: no express() app, so the walker finds no routes. Fix: point the source at the file that builds the app.`);
  else if (doors.length === 0 && unwalked.length === 0) errors.push(`${file}: an express app with no routes the walker can read.`);

  let cards: DoorCard[] = [];
  if (opts.cards) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(opts.root, opts.cards), "utf8")) as { doors?: unknown };
      const list = Array.isArray(parsed.doors) ? parsed.doors : [];
      if (!Array.isArray(parsed.doors) || list.some((d) => typeof (d as DoorCard)?.id !== "string")) errors.push(`${opts.cards}: doors must be a list of cards, each with an id`);
      cards = list.filter((d) => typeof (d as DoorCard)?.id === "string") as DoorCard[];
    } catch (error) {
      errors.push(`${opts.cards}: can't read the cards: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  const ids = new Set(doors.map((d) => d.id));
  for (const card of cards) if (!ids.has(card.id)) errors.push(`${card.id}: a card in ${opts.cards} for a route the walker doesn't find in ${file}. Fix: remove the card, or fix its id.`);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const raised = (code: unknown) => typeof code === "string" && (literals.has(code) || literals.has(code.replaceAll("-", "_")));
  return {
    doors: doors.map((d) => {
      const card = byId.get(d.id) ?? null;
      return { ...d, card, evidence: card && Array.isArray(card.errors) ? { raises: card.errors.map((e) => e?.code).filter(raised) as string[] } : {} };
    }),
    errors,
    unwalked,
  };
}
