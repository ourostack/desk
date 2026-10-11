#!/usr/bin/env node
// A fake `az` for provision.sh's tests. It records every call's argv (one JSON
// line each in $FAKE_AZ_DIR/argv.log), answers the reads provision.sh makes from
// $FAKE_AZ_DIR/app.json (absent: the app doesn't exist), and copies each
// `containerapp update --yaml` or `create --yaml` file to updates/<n>.json.
// An update then goes through a model of az's own pipeline and ARM's PATCH (az-update-model.mjs), so app.json
// shows what the app would really hold: az drops the identity map, and with FAKE_RESOLVE_REFS=1 listSecrets
// returns a value for a Key Vault reference, which turns it into a plain secret (the review's worst case), and with
// FAKE_REFS_WITHOUT_VALUE=1 it returns the reference without a value, on which az fails before sending.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armPatch, azUpdateModel, LISTED_WITHOUT_VALUE } from "./az-update-model.mjs";

const dir = process.env.FAKE_AZ_DIR;
const args = process.argv.slice(2);
appendFileSync(join(dir, "argv.log"), `${JSON.stringify(args)}\n`);
const joined = args.join(" ");
const appFile = join(dir, "app.json");
const value = (flag) => args[args.indexOf(flag) + 1];
const readyFile = join(dir, "ready-after");

// Identities and role assignments, kept in cloud.json across one run's calls. Production's pull identity exists;
// staging's exists with AcrPull on the registry unless FAKE_NO_STAGING_IDENTITY=1 or FAKE_NO_ACRPULL=1.
const SUB = "261e0bf1-934d-41ab-9295-229b0d254418";
const REGISTRY_ID = `/subscriptions/${SUB}/resourceGroups/rg-ouro-work-substrate/providers/Microsoft.ContainerRegistry/registries/ouroworkprodk2aumligevt3e`;
const identityId = (group, name) => `/subscriptions/${SUB}/resourceGroups/${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
const cloudFile = join(dir, "cloud.json");
function loadCloud() {
  if (existsSync(cloudFile)) return JSON.parse(readFileSync(cloudFile, "utf8"));
  const cloud = { identities: {}, roles: [] };
  cloud.identities["ouro-prod-services-mi"] = { id: identityId("rg-ouro-work-substrate", "ouro-prod-services-mi"), principalId: "22222222-2222-2222-2222-222222222222" };
  cloud.identities["id-ourowork-github-prod"] = { id: identityId("rg-ouro-work-substrate", "id-ourowork-github-prod"), principalId: "77777777-7777-4777-8777-777777777777" };
  cloud.roles.push({ principalId: "22222222-2222-2222-2222-222222222222", role: "AcrPull", scope: REGISTRY_ID });
  if (process.env.FAKE_NO_STAGING_IDENTITY !== "1") {
    cloud.identities["id-ouro-desk-hosted-staging"] = { id: identityId("rg-ouro-identity", "id-ouro-desk-hosted-staging"), principalId: "44444444-4444-4444-4444-444444444444" };
    if (process.env.FAKE_NO_ACRPULL !== "1") cloud.roles.push({ principalId: "44444444-4444-4444-4444-444444444444", role: "AcrPull", scope: REGISTRY_ID });
  }
  return cloud;
}
const saveCloud = (cloud) => writeFileSync(cloudFile, JSON.stringify(cloud));

function saveDocument() {
  const updates = join(dir, "updates");
  mkdirSync(updates, { recursive: true });
  writeFileSync(join(updates, `${readdirSync(updates).length + 1}.json`), readFileSync(value("--yaml"), "utf8"));
}

if (joined.includes("containerapp env show")) {
  if (joined.includes("--query id")) console.log("/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/env");
  else if (joined.includes("defaultDomain")) console.log("blueflower-44af4710.eastus2.azurecontainerapps.io");
  else console.log("verification-id");
} else if (joined.includes("containerapp show")) {
  if (!existsSync(appFile)) {
    console.error("ERROR: (ResourceNotFound) The Resource was not found.");
    process.exit(3);
  }
  const app = JSON.parse(readFileSync(appFile, "utf8"));
  if (joined.includes("--query name")) console.log(app.name);
  else if (value("--query") === "properties.latestReadyRevisionName") {
    // FAKE_READY_AFTER_POLLS: the new revision becomes the ready one only after this many reads.
    const left = existsSync(readyFile) ? Number(readFileSync(readyFile, "utf8")) : 0;
    if (left > 0) {
      writeFileSync(readyFile, String(left - 1));
      if (left === 1) {
        app.properties.latestReadyRevisionName = app.properties.latestRevisionName;
        writeFileSync(appFile, JSON.stringify(app));
      }
    }
    console.log(app.properties.latestReadyRevisionName ?? "");
  } else if (/^properties(\.[A-Za-z]+)+$/.test(value("--query") ?? "")) console.log(value("--query").split(".").reduce((node, key) => node?.[key], app) ?? "");
  else if (joined.includes("customDomains[?name")) console.log("");
  else if (args.includes("json") && !args.includes("--query")) console.log(JSON.stringify(app));
  else console.log("");
} else if (joined.includes("containerapp revision show")) {
  const app = JSON.parse(readFileSync(appFile, "utf8"));
  const pending = value("--revision") !== app.properties.latestReadyRevisionName;
  console.log(process.env.FAKE_REVISION_STATE ?? (pending ? "Activating" : "Running"));
} else if (joined.includes("containerapp identity assign")) {
  const app = JSON.parse(readFileSync(appFile, "utf8"));
  app.identity ??= { type: "UserAssigned", userAssignedIdentities: {} };
  app.identity.userAssignedIdentities[value("--user-assigned")] = { clientId: "c", principalId: "p" };
  // az's assign is a full PUT that rewrites the secrets from listSecrets (re-review N-m2); this drops one.
  const dropped = process.env.FAKE_ASSIGN_DROPS_SECRET;
  if (dropped) app.properties.configuration.secrets = app.properties.configuration.secrets.filter((secret) => secret.name !== dropped);
  writeFileSync(appFile, JSON.stringify(app));
} else if (joined.includes("containerapp secret list")) {
  const app = JSON.parse(readFileSync(appFile, "utf8"));
  console.log(JSON.stringify(app.properties.configuration.secrets));
} else if (joined.includes("containerapp update")) {
  saveDocument();
  const current = JSON.parse(readFileSync(appFile, "utf8"));
  const values = {};
  for (const secret of current.properties.configuration.secrets) {
    if (!secret.keyVaultUrl) values[secret.name] = "stored";
    else if (process.env.FAKE_RESOLVE_REFS === "1") values[secret.name] = "resolved-from-key-vault";
    else if (process.env.FAKE_REFS_WITHOUT_VALUE === "1") values[secret.name] = LISTED_WITHOUT_VALUE;
  }
  let sent;
  try {
    sent = azUpdateModel(JSON.parse(readFileSync(value("--yaml"), "utf8")), values);
  } catch (error) {
    console.error(error.stderr ?? error.message);
    process.exit(1);
  }
  const next = armPatch(current, sent).app;
  // Every update makes a new revision. It becomes the ready one at once, after FAKE_READY_AFTER_POLLS reads, or, with
  // FAKE_REVISION_STATE=Failed, never.
  const updateCount = existsSync(join(dir, "updates")) ? readdirSync(join(dir, "updates")).length : 1;
  next.properties.latestRevisionName = `${next.name}--u${updateCount}`;
  if (process.env.FAKE_READY_AFTER_POLLS) writeFileSync(readyFile, process.env.FAKE_READY_AFTER_POLLS);
  else if (process.env.FAKE_REVISION_STATE !== "Failed") next.properties.latestReadyRevisionName = next.properties.latestRevisionName;
  // A write that comes back pulling with another identity, for the check after the write.
  if (process.env.FAKE_UPDATE_REGISTRY_IDENTITY) for (const registry of next.properties.configuration.registries ?? []) registry.identity = process.env.FAKE_UPDATE_REGISTRY_IDENTITY;
  writeFileSync(appFile, JSON.stringify(next));
} else if (joined.includes("containerapp create")) {
  saveDocument();
  // The fake can't read the template's YAML; a test that needs the created app names it as JSON.
  if (process.env.FAKE_CREATED_APP) writeFileSync(appFile, readFileSync(process.env.FAKE_CREATED_APP, "utf8"));
} else if (joined.includes("identity show") && !joined.includes("federated-credential")) {
  const name = value("-n");
  const identity = loadCloud().identities[name];
  if (!identity) {
    console.error(`ERROR: (ResourceNotFound) The Resource 'Microsoft.ManagedIdentity/userAssignedIdentities/${name}' under resource group '${value("-g")}' was not found.`);
    process.exit(3);
  }
  if (joined.includes("--query id")) console.log(identity.id);
  else if (joined.includes("--query principalId")) console.log(identity.principalId);
  else console.log("00000000-0000-0000-0000-000000000000");
} else if (joined.includes("identity create")) {
  const cloud = loadCloud();
  cloud.identities[value("-n")] = { id: identityId(value("-g"), value("-n")), principalId: "99999999-0000-4000-8000-000000000099" };
  saveCloud(cloud);
} else if (joined.includes("acr show")) {
  if (joined.includes("--query id")) console.log(REGISTRY_ID);
  else console.log("ouroworkprodk2aumligevt3e.azurecr.io");
} else if (joined.includes("role assignment list")) {
  const roles = loadCloud().roles.filter((role) => role.scope === value("--scope") && role.role === value("--role"));
  console.log(roles.map((role) => role.principalId).join("\n"));
} else if (joined.includes("role assignment create")) {
  const cloud = loadCloud();
  cloud.roles.push({ principalId: value("--assignee-object-id"), role: value("--role"), scope: value("--scope") });
  saveCloud(cloud);
}
