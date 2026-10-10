#!/usr/bin/env node
// A fake `az` for provision.sh's tests. It records every call's argv (one JSON
// line each in $FAKE_AZ_DIR/argv.log), answers the reads provision.sh makes from
// $FAKE_AZ_DIR/app.json (absent: the app doesn't exist), and copies each
// `containerapp update --yaml` or `create --yaml` file to updates/<n>.json.
// An update then goes through a model of az's own pipeline and ARM's PATCH (az-update-model.mjs), so app.json
// shows what the app would really hold: az drops the identity map, and with FAKE_RESOLVE_REFS=1 listSecrets
// returns a value for a Key Vault reference, which turns it into a plain secret (the review's worst case).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armPatch, azUpdateModel } from "./az-update-model.mjs";

const dir = process.env.FAKE_AZ_DIR;
const args = process.argv.slice(2);
appendFileSync(join(dir, "argv.log"), `${JSON.stringify(args)}\n`);
const joined = args.join(" ");
const appFile = join(dir, "app.json");
const value = (flag) => args[args.indexOf(flag) + 1];

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
  else if (joined.includes("customDomains[?name")) console.log("");
  else if (args.includes("json") && !args.includes("--query")) console.log(JSON.stringify(app));
  else console.log("");
} else if (joined.includes("containerapp identity assign")) {
  const app = JSON.parse(readFileSync(appFile, "utf8"));
  app.identity ??= { type: "UserAssigned", userAssignedIdentities: {} };
  app.identity.userAssignedIdentities[value("--user-assigned")] = { clientId: "c", principalId: "p" };
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
  }
  const sent = azUpdateModel(JSON.parse(readFileSync(value("--yaml"), "utf8")), values);
  writeFileSync(appFile, JSON.stringify(armPatch(current, sent).app));
} else if (joined.includes("containerapp create")) {
  saveDocument();
  // The fake can't read the template's YAML; a test that needs the created app names it as JSON.
  if (process.env.FAKE_CREATED_APP) writeFileSync(appFile, readFileSync(process.env.FAKE_CREATED_APP, "utf8"));
} else if (joined.includes("identity show")) {
  if (joined.includes("--query id")) console.log("/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi");
  else console.log("00000000-0000-0000-0000-000000000000");
} else if (joined.includes("acr show")) {
  console.log("ouroworkprodk2aumligevt3e.azurecr.io");
}
