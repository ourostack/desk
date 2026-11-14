import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function parsePost(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/u.exec(text);
  const fields = Object.fromEntries((match ? match[1] : "").split("\n").filter(Boolean).map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
  return { title: fields.title ?? "Untitled", date: fields.date ?? "", body: text.slice(match ? match[0].length : 0).trim() };
}

export function renderIndex(posts) {
  const items = posts.map((post) => `    <li><a href="${post.slug}.html">${post.title}</a> <time>${post.date}</time></li>`).join("\n");
  return `<!doctype html>\n<html>\n  <body>\n    <ul>\n${items}\n    </ul>\n  </body>\n</html>\n`;
}

export function buildSite({ postsDir, outDir }) {
  const posts = readdirSync(postsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ slug: name.slice(0, -".md".length), ...parsePost(readFileSync(path.join(postsDir, name), "utf8")) }));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "index.html"), renderIndex(posts));
  return posts.length;
}
