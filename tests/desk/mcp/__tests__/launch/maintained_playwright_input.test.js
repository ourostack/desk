import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkTempRoot } from "../_temp_roots.js";
import { removeTree } from "../_remove_tree.js";

const require = createRequire(import.meta.url);
const fixtureFile = fileURLToPath(new URL("./fixtures/playwright-native-error-transport.cjs", import.meta.url));
const fixture = require(fixtureFile);

test("maintained component input defaults to the locked pristine public package", () => {
  const input = fixture.read({});
  const cli = fixture.cliDirectory({});
  const pkg = JSON.parse(fs.readFileSync(path.resolve(cli, "../../../package.json"), "utf8"));
  assert.equal(pkg.version, "1.64.0-alpha-1790635538000");
  assert.equal(input.coreSha256, "cd6730be1bbcff00771a0fc1390f200306d28428ce68e305420ca623cb39cdeb");
  assert.equal(input.sessionFile, path.join(cli, "session.js"));
  assert.equal(typeof input.backend, "string");
  assert.equal(typeof input.configLoader, "string");
});

test("an explicit maintained input stays explicit, including invalid inputs", () => {
  assert.equal(fixture.cliDirectory({ DESK_TEST_MAINTAINED_CLI_DIR: "/explicit/source" }), "/explicit/source");
  for (const value of ["", null, false]) {
    assert.throws(() => fixture.cliDirectory({ DESK_TEST_MAINTAINED_CLI_DIR: value }), /maintained CLI input/);
  }
  assert.throws(() => fixture.read({ DESK_TEST_MAINTAINED_CLI_DIR: "/definitely-absent-owned-test-input" }), { code: "ENOENT" });
});

test("a missing locked input names the setup command instead of borrowing a user cache", () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(fixtureFile, "utf8"), {
    module, __dirname: path.dirname(fixtureFile), process,
    require: name => name === "node:fs" ? { existsSync: () => false } : require(name),
  });
  assert.throws(() => module.exports.cliDirectory({}), /npm ci --ignore-scripts --prefix/);
});

test("maintained input refuses full-source drift before composing bounded regions", async t => {
  const root = await mkTempRoot("desk-maintained-input-drift-");
  t.after(() => removeTree(root));
  const sourceCli = fixture.cliDirectory({});
  const cli = path.join(root, "lib/tools/cli-client");
  fs.mkdirSync(cli, { recursive: true });
  const core = fs.readFileSync(path.resolve(sourceCli, "../../coreBundle.js"), "utf8");
  fs.writeFileSync(path.resolve(cli, "../../coreBundle.js"), core + "\n// owned drift\n");
  fs.copyFileSync(path.join(sourceCli, "session.js"), path.join(cli, "session.js"));
  assert.throws(() => fixture.read({ DESK_TEST_MAINTAINED_CLI_DIR: cli }), /exact admitted full maintained source/);
});
