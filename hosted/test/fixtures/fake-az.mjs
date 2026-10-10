#!/usr/bin/env node
// A fake `az` for provision.sh's tests. It records every call's argv (one JSON
// line each in $FAKE_AZ_DIR/argv.log), answers the reads provision.sh makes from
// $FAKE_AZ_DIR/app.json (absent: the app doesn't exist), and copies each
// `containerapp update --yaml` or `create --yaml` file to updates/<n>.json.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
} else if (joined.includes("containerapp update") || joined.includes("containerapp create")) {
  saveDocument();
} else if (joined.includes("identity show")) {
  if (joined.includes("--query id")) console.log("/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi");
  else console.log("00000000-0000-0000-0000-000000000000");
} else if (joined.includes("acr show")) {
  console.log("ouroworkprodk2aumligevt3e.azurecr.io");
}
