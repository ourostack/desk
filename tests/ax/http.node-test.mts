// Desk's HTTP walker (ax/walkers/http.mts), over an Express app shaped like Hosted Desk's.
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { walk } from "../../ax/walkers/http.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "http"));
const at = (file: string) => `${FIX}/${file}`;
const options = (more: Record<string, unknown> = {}) => ({ product: "desk", module: "gw", source: at("app.js"), root: ROOT, ...more });

test("each route on the express app is a door; middleware and other objects are not", async () => {
  const { doors, unwalked, errors } = await walk(options());
  assert.deepEqual(errors, []);
  assert.deepEqual(
    doors.map((d) => [d.id, d.line]),
    [
      ["http:gw GET /healthz", 6],
      ["http:gw ALL /a", 7],
      ["http:gw ALL /b", 7],
      ["http:gw USE authRouter()", 8],
      ["http:gw POST /hooks/:id", 9],
    ],
  );
  assert.deepEqual(unwalked.map((g) => [g.id, g.reasons]), [[`http:gw GET ${at("app.js")}:10`, ["unwalked: a route whose path isn't a literal"]]]);
});

test("a card's codes count as raised when the file holds them outside error cards; a card with no route is an error", async () => {
  const { doors, errors } = await walk(options({ cards: at("cards.json") }));
  assert.deepEqual(doors.find((d) => d.id === "http:gw POST /hooks/:id")!.evidence, { raises: ["hook-not-found"] });
  assert.deepEqual(errors, [`http:gw GET /gone: a card in ${at("cards.json")} for a route the walker doesn't find in ${at("app.js")}. Fix: remove the card, or fix its id.`]);
});
