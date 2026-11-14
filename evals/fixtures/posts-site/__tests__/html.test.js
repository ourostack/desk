import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml } from "../src/html.js";

test("escapeHtml escapes the characters that break markup", () => {
  assert.equal(escapeHtml(`a & b <c> "d"`), "a &amp; b &lt;c&gt; &quot;d&quot;");
});
