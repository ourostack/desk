// Shared by the CLI and HTTP walkers: the local modules a script imports, followed transitively, so a door's raised
// codes are the literals in its own file and in what it imports, never in a folder it doesn't import.
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const SCRIPT = /\.[cm]?[jt]s$/;
const NOT_SCRIPT = /\.d\.[cm]?ts$|\.(test|spec)\.[cm]?[jt]s$/;
const isText = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/** The relative modules a file imports directly: static imports, re-exports, `require("./x")` and `import("./x")`. */
export function directImports(sf: ts.SourceFile, from: string): string[] {
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

const IMPORT_SUFFIXES = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", "/index.js", "/index.mjs", "/index.cjs", "/index.ts", "/index.mts"];

/** The script file a local import names, with the extension or index file it may leave out; null when none exists. */
export function resolveImport(spec: string): string | null {
  for (const suffix of IMPORT_SUFFIXES) {
    const candidate = spec + suffix;
    try {
      if (statSync(candidate).isFile() && SCRIPT.test(candidate) && !NOT_SCRIPT.test(candidate)) return candidate;
    } catch {
      // not there; try the next form
    }
  }
  return null;
}


/** A file and every local script it imports, followed through their imports; `parse` reads a path's syntax tree. */
export function importClosure(file: string, parse: (path: string) => ts.SourceFile): string[] {
  const visited = new Set<string>();
  const queue = [file];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (visited.has(path)) continue;
    visited.add(path);
    for (const spec of directImports(parse(path), path)) {
      const target = resolveImport(spec);
      if (target) queue.push(target);
    }
  }
  return [...visited];
}
