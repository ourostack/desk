import { fileURLToPath } from "node:url";
import v1Dataset from "./cases/v2-alpha-v1/dataset.json" with { type: "json" };
import v1Manifest from "./cases/v2-alpha-v1/fixture-manifest.json" with { type: "json" };
import v2Dataset from "./cases/v2-alpha-v2/dataset.json" with { type: "json" };
import v2Manifest from "./cases/v2-alpha-v2/fixture-manifest.json" with { type: "json" };

// The one place every consumer that needs the parsed, frozen dataset/fixture-manifest structure for a plan's own
// dataset id -- not its raw bytes, which `producer.mjs` reads and hash-verifies separately -- looks it up. Adding a
// dataset version means adding one entry here; every controller, comparison and scoring path then sees it by id
// instead of silently falling back to a different version's frozen case list.
export const alphaDatasets = {
  [v1Dataset.id]: { dataset: v1Dataset, manifest: v1Manifest, sourceRoot: fileURLToPath(new URL("./cases/v2-alpha-v1/", import.meta.url)) },
  [v2Dataset.id]: { dataset: v2Dataset, manifest: v2Manifest, sourceRoot: fileURLToPath(new URL("./cases/v2-alpha-v2/", import.meta.url)) },
};
