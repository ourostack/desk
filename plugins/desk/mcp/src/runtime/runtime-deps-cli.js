// The `build-runtime-deps-pack` and `verify-runtime-deps-pack` command lines, defined with Ouro AX. They live apart from
// runtime-deps.js, which the dependency-free bootstrap imports and so must not import the kit.
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { AxError } from "../lib/ouro-ui/registry/ouro/ax/problem.ts"
import { defineCli, defineCommand } from "../lib/ouro-ui/registry/ouro/ax/command.ts"
import { runCli } from "../lib/ouro-ui/registry/ouro/ax/cli.ts"
import { buildRuntimeDependencyPack, deriveRuntimeDependencyPackPaths, verifyRuntimeDependencyPack } from "./runtime-deps.js"

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))

const PLATFORM = { type: "string", placeholder: "<OS>", description: "The platform to target (this machine's)." }
const ARCH = { type: "string", placeholder: "<ARCH>", description: "The CPU architecture to target (this machine's)." }
const NODE_ABI = { type: "string", placeholder: "<ABI>", description: "The Node ABI to target (this machine's)." }
const text = (result) => result.text

// A failure thrown with its own `<tool>:` line would otherwise carry the tool name twice.

export function runRuntimeDependencyPackBuildCli({ argv = process.argv.slice(2), io = process } = {}) {
  const cli = defineCli({
    name: "build-runtime-deps-pack",
    about: ["Builds the pack of production dependencies the desk MCP server runs from."],
    command: defineCommand({
      name: "build-runtime-deps-pack",
      effect: "private",
      summary: "Build a runtime dependency pack for the desk MCP server, for one platform, architecture and Node ABI.",
      output: "{ text }: where the pack was built",
      flags: { "output-root": { type: "string", placeholder: "<DIR>", description: "The folder to build the pack in." }, platform: PLATFORM, arch: ARCH, "node-abi": NODE_ABI },
      text,
      run: (input) => {
        const result = buildRuntimeDependencyPack({ outputRoot: input["output-root"], platform: input.platform, arch: input.arch, nodeAbi: input["node-abi"] })
        return { text: `runtime dependency pack built: ${result.packDir}\n` }
      },
    }),
  })
  return runCli(cli, argv, { stdout: io.stdout, stderr: io.stderr })
}

export function runRuntimeDependencyPackVerifyCli({ argv = process.argv.slice(2), io = process } = {}) {
  const cli = defineCli({
    name: "verify-runtime-deps-pack",
    about: ["Checks that a built pack matches the package lock and the target it was built for."],
    command: defineCommand({
      name: "verify-runtime-deps-pack",
      effect: "private",
      readOnly: true,
      summary: "Verify a runtime dependency pack for the desk MCP server against the package lock, for one platform, architecture and Node ABI.",
      output: "{ text }: that the pack verified",
      flags: { "pack-dir": { type: "string", placeholder: "<DIR>", description: "The pack to check (the one built for this target)." }, platform: PLATFORM, arch: ARCH, "node-abi": NODE_ABI },
      text,
      run: (input) => {
        const platform = input.platform ?? process.platform
        const arch = input.arch ?? process.arch
        const nodeAbi = input["node-abi"] ?? process.versions.modules
        const paths = deriveRuntimeDependencyPackPaths({ mcpRoot, packageJson: readJson(path.join(mcpRoot, "package.json")), packageLock: readJson(path.join(mcpRoot, "package-lock.json")), platform, arch, nodeAbi })
        const result = verifyRuntimeDependencyPack({ packDir: input["pack-dir"] ?? paths.packDir, platform, arch, nodeAbi })
        if (!result.ok) throw new AxError({ code: "pack-invalid", exit: 1, thing: "pack", problem: result.errors.join("; "), fix: "rebuild it with npm run runtime:deps-pack:build" })
        return { text: "runtime dependency pack verified\n" }
      },
    }),
  })
  return runCli(cli, argv, { stdout: io.stdout, stderr: io.stderr })
}
