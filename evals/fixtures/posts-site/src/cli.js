import { buildSite } from "./site.js";

console.log(`Built ${buildSite({ postsDir: "posts", outDir: "site" })} posts into site/`);
