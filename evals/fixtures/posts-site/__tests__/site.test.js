import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePost, renderIndex } from "../src/site.js";

test("parsePost reads front matter and keeps the body", () => {
  const post = parsePost("---\ntitle: Hello\ndate: 2026-10-01\n---\n\nFirst post.\n");
  assert.deepEqual(post, { title: "Hello", date: "2026-10-01", body: "First post." });
});

test("renderIndex lists posts in the order it is given", () => {
  const html = renderIndex([{ slug: "a", title: "A", date: "2026-10-01" }, { slug: "b", title: "B", date: "2026-10-02" }]);
  assert.ok(html.indexOf('href="a.html"') < html.indexOf('href="b.html"'));
});
