#!/usr/bin/env node
// Builds the whole Container App document for `az containerapp update --yaml`
// from what `az containerapp show -o json` printed, changing only the named
// secrets, env vars, Key Vault references and identities.
//
// az 2.77's YAML update replaces the app's secret and container lists with the
// file's, so a partial file would drop every secret, env var and volume it
// leaves out (plan ruling N4/N5). Starting from the shown app keeps everything:
// each secret the app holds stays by name (az keeps its value), a Key Vault
// reference keeps its keyVaultUrl and identity and never gains a value, and
// every env var, volume, probe, identity, registry and custom domain is passed
// through unchanged.
//
// The document is written as JSON, which is YAML, because hosted/ has no YAML
// library and az prints the same document either way. The file holds secret
// values, so it is mode 0600 in a fresh 0700 directory; the caller deletes it.
//
// Command line (used by provision.sh; no secret value is ever an argument):
//   node hosted/infra/app-yaml.mjs --shown <show.json> --out <dir>
//     [--ensure-secret <name>]...      a random 32-byte hex value, only if the app lacks it
//     [--ensure-placeholder <name>]... the value `unset`, only if the app lacks it
//     [--set-env NAME=value]... [--remove-env NAME]...
//     [--identity-record <identity-env.json>]   the Ouro tenant settings (identity-record.mjs)
// It prints only the written file's path.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { identitySettings, loadRecordFile } from "./identity-record.mjs";

// `az containerapp show -o json`'s output, as text or already parsed.
export function parseShown(shown) {
  if (shown && typeof shown === "object") return structuredClone(shown);
  try {
    return JSON.parse(shown);
  } catch {
    throw new Error("The shown app must be `az containerapp show -o json` output.");
  }
}

const isKeyVaultReference = (secret) => Boolean(secret.keyVaultUrl);

// The one container the gateway runs in: the one named `gateway`, or the only one.
function gatewayContainer(app) {
  const containers = app.properties?.template?.containers ?? [];
  const container = containers.find((candidate) => candidate.name === "gateway") ?? (containers.length === 1 ? containers[0] : undefined);
  if (!container) throw new Error("The shown app has no gateway container.");
  return container;
}

export function buildAppYaml({ shownYaml, setSecrets = {}, setEnv = {}, secretRefs = {}, keyVaultSecrets = {}, removeEnv = [], addIdentities = [] }) {
  const app = parseShown(shownYaml);
  app.properties.configuration ??= {};
  const shownSecrets = app.properties.configuration.secrets ?? [];

  // Secrets: every shown one by name (a reference with its keyVaultUrl and identity), then the new ones.
  const secrets = shownSecrets.map((secret) => {
    if (isKeyVaultReference(secret)) {
      if (Object.hasOwn(setSecrets, secret.name)) {
        throw new Error(`${secret.name} is a Key Vault reference; write its value to Key Vault, not to the app.`);
      }
      const reference = Object.hasOwn(keyVaultSecrets, secret.name) ? keyVaultSecrets[secret.name] : secret;
      return { name: secret.name, keyVaultUrl: reference.keyVaultUrl, identity: reference.identity };
    }
    if (Object.hasOwn(keyVaultSecrets, secret.name)) {
      throw new Error(`${secret.name} holds a value in the app; refusing to turn it into a Key Vault reference in place.`);
    }
    return Object.hasOwn(setSecrets, secret.name) ? { name: secret.name, value: String(setSecrets[secret.name]) } : { name: secret.name };
  });
  const held = new Set(secrets.map((secret) => secret.name));
  for (const [name, value] of Object.entries(setSecrets)) {
    if (!held.has(name)) secrets.push({ name, value: String(value) }), held.add(name);
  }
  for (const [name, { keyVaultUrl, identity }] of Object.entries(keyVaultSecrets)) {
    if (!keyVaultUrl || !identity) throw new Error(`The Key Vault reference ${name} needs a keyVaultUrl and an identity.`);
    if (!held.has(name)) secrets.push({ name, keyVaultUrl, identity }), held.add(name);
  }
  app.properties.configuration.secrets = secrets;

  // Env: shown order, replaced in place, removed by name, new ones appended.
  const container = gatewayContainer(app);
  const changes = new Map();
  for (const [name, value] of Object.entries(setEnv)) changes.set(name, { name, value: String(value) });
  for (const [name, secretRef] of Object.entries(secretRefs)) {
    if (!held.has(secretRef)) throw new Error(`${name} would read secret ${secretRef}, which the app doesn't hold.`);
    changes.set(name, { name, secretRef });
  }
  const removed = new Set(removeEnv);
  const env = [];
  for (const entry of container.env ?? []) {
    if (removed.has(entry.name)) continue;
    if (changes.has(entry.name)) env.push(changes.get(entry.name)), changes.delete(entry.name);
    else env.push(entry);
  }
  env.push(...changes.values());
  container.env = env;

  // Identities: the shown ones, plus any new user-assigned identity.
  if (addIdentities.length) {
    app.identity ??= { type: "UserAssigned", userAssignedIdentities: {} };
    app.identity.userAssignedIdentities ??= {};
    for (const id of addIdentities) app.identity.userAssignedIdentities[id] ??= {};
    if (app.identity.type === "SystemAssigned") app.identity.type = "SystemAssigned,UserAssigned";
    else if (!app.identity.type || app.identity.type === "None") app.identity.type = "UserAssigned";
  }

  // Every secret an env var or volume names must still be there.
  for (const entry of env) if (entry.secretRef && !held.has(entry.secretRef)) throw new Error(`${entry.name} reads secret ${entry.secretRef}, which the app doesn't hold.`);
  for (const volume of app.properties.template?.volumes ?? []) {
    for (const { secretRef } of volume.secrets ?? []) if (!held.has(secretRef)) throw new Error(`Volume ${volume.name} mounts secret ${secretRef}, which the app doesn't hold.`);
  }
  return `${JSON.stringify(app, null, 2)}\n`;
}

// Writes the document to a 0600 file in a new 0700 directory under `parent`.
export function writeAppYaml(text, { parent = tmpdir() } = {}) {
  const dir = mkdtempSync(join(parent, "app-yaml-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "app.yaml");
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, dir };
}

function splitAssignment(text, flag) {
  const index = text.indexOf("=");
  if (index <= 0) throw new Error(`${flag} takes NAME=value.`);
  return [text.slice(0, index), text.slice(index + 1)];
}

export function cli(argv = process.argv.slice(2), { print = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      shown: { type: "string" },
      out: { type: "string" },
      "ensure-secret": { type: "string", multiple: true, default: [] },
      "ensure-placeholder": { type: "string", multiple: true, default: [] },
      "set-env": { type: "string", multiple: true, default: [] },
      "remove-env": { type: "string", multiple: true, default: [] },
      "identity-record": { type: "string" },
    },
  });
  if (!values.shown || !values.out) throw new Error("Usage: app-yaml.mjs --shown <show.json> --out <dir> [options]");
  const shown = parseShown(readFileSync(values.shown, "utf8"));
  const held = new Set((shown.properties?.configuration?.secrets ?? []).map((secret) => secret.name));
  const setSecrets = {};
  for (const name of values["ensure-secret"]) if (!held.has(name)) setSecrets[name] = randomBytes(32).toString("hex");
  for (const name of values["ensure-placeholder"]) if (!held.has(name)) setSecrets[name] = "unset";
  const setEnv = Object.fromEntries(values["set-env"].map((text) => splitAssignment(text, "--set-env")));
  let identity = { setEnv: {}, secretRefs: {}, keyVaultSecrets: {}, addIdentities: [] };
  if (values["identity-record"]) identity = identitySettings(loadRecordFile(values["identity-record"]));
  const text = buildAppYaml({
    shownYaml: shown,
    setSecrets,
    setEnv: { ...setEnv, ...identity.setEnv },
    secretRefs: identity.secretRefs,
    keyVaultSecrets: identity.keyVaultSecrets,
    addIdentities: identity.addIdentities,
    removeEnv: values["remove-env"],
  });
  const { file } = writeAppYaml(text, { parent: values.out });
  print(file);
  return file;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`app-yaml: ${error.message}\n`);
    process.exit(1);
  }
}
