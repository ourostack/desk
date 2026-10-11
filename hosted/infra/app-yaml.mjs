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
//     [--forbid-identity <name>]...    refuse an app that holds this identity (staging: production's pull identity)
// It prints only the written file's path; notes go to stderr.
//   node hosted/infra/app-yaml.mjs --shown <show.json> --get-env NAME    prints that env var's plain value
//   node hosted/infra/app-yaml.mjs --mask <file>                         prints a document with every secret value as ***
//   node hosted/infra/app-yaml.mjs --verify --before <show.json> --after <show.json> --secret-list <list.json>
//     [--identity-record <file>] [--forbid-identity <name>]... [--registry-identity <id>]   the check after a write
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { cutoffWarning, identitySettings, loadRecordFile } from "./identity-record.mjs";

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

// az 2.77's YAML update fills each value-less secret from listSecrets and catches only a missing name: a Key Vault
// reference that listSecrets returns without a value makes it fail with KeyError before it sends anything (re-review
// N-m1). The message says only what is true: this update was not sent, but an earlier write in the same run (an
// identity attach, or the app's creation) was, and stays (Task 2 re-review Minor). provision.sh builds the same text
// from the same parts.
export const KEY_VAULT_FILL_FAILURE = "az could not send the update: listSecrets returned a Key Vault reference without a value, which az 2.77's YAML update can't handle (KeyError: 'value').";
export const KEY_VAULT_FILL_NOT_SENT = "az stops there before sending the update, so none of this update's changes reached the app.";
export const KEY_VAULT_FILL_NOTHING_BEFORE = "Nothing else was sent to the app before it in this step.";
export const KEY_VAULT_FILL_SENT_BEFORE = "Already sent to the app before it, and still in effect:";
export const KEY_VAULT_FILL_NEXT = "Record this for the rehearsal; the update path needs a fix before this app can be updated again.";
export function keyVaultFillFailure({ sentBefore = [] } = {}) {
  const before = sentBefore.length ? `${KEY_VAULT_FILL_SENT_BEFORE} ${sentBefore.join("; ")}.` : KEY_VAULT_FILL_NOTHING_BEFORE;
  return `${KEY_VAULT_FILL_FAILURE} ${KEY_VAULT_FILL_NOT_SENT} ${before} ${KEY_VAULT_FILL_NEXT}`;
}
export const isKeyVaultFillFailure = (stderr) => String(stderr ?? "").includes("KeyError: 'value'");

// The one container the gateway runs in: the one named `gateway`, or the only one.
function gatewayContainer(app) {
  const containers = app.properties?.template?.containers ?? [];
  const container = containers.find((candidate) => candidate.name === "gateway") ?? (containers.length === 1 ? containers[0] : undefined);
  if (!container) throw new Error("The shown app has no gateway container.");
  return container;
}

export function buildAppYaml({ shownYaml, setSecrets = {}, setEnv = {}, secretRefs = {}, keyVaultSecrets = {}, removeEnv = [], addIdentities = [], forbidIdentities = [] }) {
  const app = parseShown(shownYaml);
  refuseForbidden(app, forbidIdentities, "");
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

const identityIds = (app) => Object.keys(app?.identity?.userAssignedIdentities ?? {});
const lower = (ids) => new Set(ids.map((id) => id.toLowerCase()));
const identityName = (id) => String(id).split("/").at(-1);

// Staging must never hold production's pull identity, which can write production storage and change email settings
// (re-review N-I1): neither attached nor as the identity a registry pulls with.
function refuseForbidden(app, forbidIdentities, when) {
  const held = [...identityIds(app), ...(app.properties?.configuration?.registries ?? []).map((registry) => registry.identity ?? "")];
  for (const id of held) {
    const name = forbidIdentities.find((candidate) => candidate.toLowerCase() === identityName(id).toLowerCase());
    if (name) {
      throw new Error(`${app.name ?? "The app"} must not hold identity ${name}${when}: it carries production roles. Point the registry at the stage's own identity (az containerapp registry set --server <registry> --identity <its id>), remove it (az containerapp identity remove --user-assigned ${name}), and run this again.`);
    }
  }
}

// The user-assigned identities in `ids` that the app doesn't have. az's YAML update drops the identity map before
// it sends the PATCH (process_loaded_yaml, then clean_null_values), so an identity is attached with
// `az containerapp identity assign` before any update that needs it, never through the document.
export function missingIdentities(shown, ids) {
  const held = lower(identityIds(parseShown(shown)));
  return ids.filter((id) => !held.has(id.toLowerCase()));
}

// After a write: az fills every value-less secret from listSecrets before sending (Key Vault references
// included), and may drop identities, so the app as read back must still hold every secret the document held,
// every Key Vault reference as a reference, and every identity. `secretList` is `az containerapp secret list -o
// json` (names, and keyVaultUrl for a reference; no values).
export function checkWritten({ before, after, secretList, keyVaultSecrets = {}, expectIdentities = [], forbidIdentities = [], registryIdentity = null }) {
  const shown = parseShown(before);
  const listed = new Map(secretList.map((secret) => [secret.name, secret]));
  for (const { name } of shown.properties?.configuration?.secrets ?? []) {
    if (!listed.has(name)) throw new Error(`Secret ${name} is gone from the app after the write.`);
  }
  const references = [...(shown.properties?.configuration?.secrets ?? []).filter((secret) => secret.keyVaultUrl).map(({ name }) => name), ...Object.keys(keyVaultSecrets)];
  for (const name of references) {
    if (!listed.get(name)?.keyVaultUrl) throw new Error(`${name} is no longer a Key Vault reference after the write; it must be fixed before the app restarts.`);
  }
  const held = lower(identityIds(parseShown(after)));
  for (const id of [...identityIds(shown), ...expectIdentities]) {
    if (!held.has(id.toLowerCase())) throw new Error(`Identity ${id.split("/").at(-1)} is no longer attached to the app after the write.`);
  }
  const app = parseShown(after);
  refuseForbidden(app, forbidIdentities, " after the write");
  if (registryIdentity) {
    const registries = app.properties?.configuration?.registries ?? [];
    if (!registries.length) throw new Error(`The app has no registry after the write; it must pull with ${identityName(registryIdentity)}.`);
    for (const registry of registries) {
      if ((registry.identity ?? "").toLowerCase() !== registryIdentity.toLowerCase()) {
        throw new Error(`The app pulls from ${registry.server} with ${identityName(registry.identity ?? "no identity")}, not ${identityName(registryIdentity)}, after the write.`);
      }
    }
  }
}

// The document with every secret's value shown as ***, for a dry run.
export function maskSecrets(text) {
  const app = parseShown(text);
  for (const secret of app.properties?.configuration?.secrets ?? []) if ("value" in secret) secret.value = "***";
  return JSON.stringify(app, null, 2);
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

export function cli(argv = process.argv.slice(2), { print = (line) => process.stdout.write(`${line}\n`), note = (line) => process.stderr.write(`${line}\n`), now = Date.now() } = {}) {
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
      "get-env": { type: "string" },
      mask: { type: "string" },
      "missing-identities": { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      before: { type: "string" },
      after: { type: "string" },
      "secret-list": { type: "string" },
      "forbid-identity": { type: "string", multiple: true, default: [] },
      "registry-identity": { type: "string" },
    },
  });
  const record = values["identity-record"] ? loadRecordFile(values["identity-record"]) : null;
  const wanted = record ? identitySettings(record) : { addIdentities: [], keyVaultSecrets: {} };
  if (values["missing-identities"]) {
    for (const id of missingIdentities(readFileSync(values.shown, "utf8"), wanted.addIdentities)) print(id);
    return null;
  }
  if (values.verify) {
    checkWritten({
      before: readFileSync(values.before, "utf8"),
      after: readFileSync(values.after, "utf8"),
      secretList: JSON.parse(readFileSync(values["secret-list"], "utf8")),
      keyVaultSecrets: wanted.keyVaultSecrets,
      expectIdentities: wanted.addIdentities,
      forbidIdentities: values["forbid-identity"],
      registryIdentity: values["registry-identity"] ?? null,
    });
    return print("Checked: every secret, Key Vault reference and identity is still on the app.");
  }
  if (values.mask) return print(maskSecrets(readFileSync(values.mask, "utf8")));
  if (values.shown && values["get-env"]) {
    const entry = gatewayContainer(parseShown(readFileSync(values.shown, "utf8"))).env?.find((candidate) => candidate.name === values["get-env"]);
    return print(entry?.value ?? "");
  }
  if (!values.shown || !values.out) throw new Error("Usage: app-yaml.mjs --shown <show.json> --out <dir> [options]");
  const shown = parseShown(readFileSync(values.shown, "utf8"));
  const held = new Set((shown.properties?.configuration?.secrets ?? []).map((secret) => secret.name));
  const setSecrets = {};
  for (const name of values["ensure-secret"]) if (!held.has(name)) setSecrets[name] = randomBytes(32).toString("hex");
  for (const name of values["ensure-placeholder"]) if (!held.has(name)) setSecrets[name] = "unset";
  const setEnv = Object.fromEntries(values["set-env"].map((text) => splitAssignment(text, "--set-env")));
  let identity = { setEnv: {}, secretRefs: {}, keyVaultSecrets: {}, addIdentities: [] };
  if (record) {
    identity = identitySettings(record);
    if (identity.missing.length) {
      note(`identity-${record.env}.json is incomplete (missing ${identity.missing.join(", ")}); the app's Ouro sign-in settings stay as they are.`);
    } else {
      note(`Ouro sign-in settings from identity-${record.env}.json: tenant ${record.tenant.id}, mapped account ${record.ari.accountId}, legacy cutoff ${record.legacyCutoff ?? "none"}.`);
    }
    const warning = cutoffWarning(record, now);
    if (warning) note(warning);
  }
  const text = buildAppYaml({
    shownYaml: shown,
    setSecrets,
    setEnv: { ...setEnv, ...identity.setEnv },
    secretRefs: identity.secretRefs,
    keyVaultSecrets: identity.keyVaultSecrets,
    addIdentities: identity.addIdentities,
    removeEnv: values["remove-env"],
    forbidIdentities: values["forbid-identity"],
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
