// The single-desk gateway runs as node, and the Desk children it starts inherit
// its HOME. The native job proves Desk reaches ready with that environment in the
// production image (fixtures/legacy-native.js); these guards keep it wired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the entrypoint gives the gateway node's HOME and USER before it drops to uid 1000", () => {
  const entrypoint = read("../bin/entrypoint.sh");
  const exported = entrypoint.indexOf("export HOME=/home/node USER=node");
  assert.ok(exported > 0, "HOME and USER are node's");
  assert.ok(exported < entrypoint.indexOf("case "), "both modes get them");
});

test("the native job runs the single-desk gateway case from the production image", () => {
  const workflow = read("../../.github/workflows/hosted-tests.yml");
  assert.match(workflow, /for mode in [^;]*\blegacy\b/);
  assert.match(workflow, /legacy\) flags=\(\); multi=0; script=legacy-native\.js/);
  assert.match(workflow, /-e DESK_MULTI_USER="\$multi"/);
  assert.match(workflow, /cp [^\n]*hosted\/test\/fixtures\/legacy-native\.js/);
  assert.match(read("./fixtures/runtime-native.Dockerfile"), /COPY [^\n]*legacy-native\.js/);
  const fixture = read("./fixtures/legacy-native.js");
  assert.match(fixture, /deskChildEnv\(/, "the fixture uses the legacy relay's own environment");
  assert.match(fixture, /deskStatus\.state, "ready"/);
});
