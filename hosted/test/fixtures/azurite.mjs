// Azurite, the local Azure Storage emulator, for the accounts store's tests. With DESK_AZURITE=1 the store suite also
// runs against a real Table endpoint (CI starts `azurite-table --inMemoryPersistence`); without it, that half is
// skipped. When DESK_AZURITE=1 and Azurite can't be reached, this throws, so the run fails instead of skipping quietly.
import { AzureNamedKeyCredential } from "@azure/data-tables";

export const AZURITE_ENDPOINT = "http://127.0.0.1:10002/devstoreaccount1";

// Azurite's published development account and key (the same for every Azurite install; not a secret).
const DEV_ACCOUNT = "devstoreaccount1";
const DEV_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

export async function azuriteFromEnv(env = process.env) {
  if (env.DESK_AZURITE !== "1") return null;
  const endpoint = env.DESK_AZURITE_ENDPOINT ?? AZURITE_ENDPOINT;
  try {
    // Any HTTP answer, even an error status, means Azurite is listening.
    await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
  } catch (error) {
    throw new Error(`DESK_AZURITE=1 but Azurite isn't reachable at ${endpoint} (${error.cause?.code ?? error.name}); start it with \`npx azurite-table --inMemoryPersistence\``);
  }
  return { endpoint, credential: new AzureNamedKeyCredential(DEV_ACCOUNT, DEV_KEY) };
}
