import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let admittedUrls = new Set();

export function initialize({ urls }) {
  admittedUrls = new Set(urls);
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  // These source-pinned ESM TypeScript leaves otherwise reach the maintained hook with a format it skips, so they resolve as "module" and its TypeScript preset removes their types while it instruments them.
  return admittedUrls.has(result.url) ? { ...result, format: "module" } : result;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  // A leaf the change under test does not require is not instrumented and comes back as raw TypeScript. As plain "module" it fails to parse, so a Node that strips types loads it as "module-typescript".
  if (!admittedUrls.has(url) || result.format !== "module" || !process.features.typescript) return result;
  const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
  return source === await readFile(fileURLToPath(url), "utf8") ? { ...result, format: "module-typescript", source } : result;
}
