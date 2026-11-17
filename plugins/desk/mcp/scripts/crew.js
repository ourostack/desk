// Crew workspace setup, one deterministic step at a time, defined once with Ouro AX: run `node crew.js --help` for the commands
// and their flags. Prints one JSON result.
//
// `start` works on a new or an existing repository. With --tooling-repo the workspace is dual-repo (the team's plugin
// lives in that separate repository); without it, a monorepo (the plugin, if any, in its own plugins/ folder).
// Without --apply, no member or shared files change; join may fetch missing Git history for its preview.
// `--repo` defaults to the current folder.
// `initiative` writes the working tree only; publish the result through the shared-path protocol.
// Exits 1 when the result is refused, failed, has layout problems or is not a Git clone, and 2 for a usage error (one line on stderr).

import process from "node:process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { crewStatus, joinWorkspace, startWorkspace } from "../src/crew/workspace.js"
import { adoptInitiative, checkTracks, newInitiative } from "../src/crew/initiative.js"

import { defineCli, defineCommand } from "../src/lib/ouro-ui/registry/ouro/ax/command.ts"
import { runCli } from "../src/lib/ouro-ui/registry/ouro/ax/cli.ts"

const str = (description, placeholder) => ({ type: "string", description, ...(placeholder ? { placeholder } : {}) })
const REPO = str("The clone to work in; the current folder by default.", "<clone>")
const APPLY = { type: "boolean", description: "Make the changes; without it nothing is written." }

function founderOf(text) {
  if (text === undefined) return undefined
  const at = text.indexOf("=")
  return at === -1 ? { alias: text, identity: "" } : { alias: text.slice(0, at), identity: text.slice(at + 1) }
}

const FAILED = new Set(["refused", "failed", "not_git", "problems"])

function crewCli({ cwd, engine, script }) {
  const command = (name, def, run) => defineCommand({ name, output: "one JSON value", text: (result) => JSON.stringify(result, null, 2), exit: (result) => (FAILED.has(result.state) ? "error" : "ok"), effect: "private", ...def, run })
  const repoOf = (input) => input.repo ?? cwd
  return defineCli({
    name: "crew",
    about: ["Crew workspace setup, one deterministic step at a time. Exits 1 when the result is refused, failed, has layout problems or is not a Git clone."],
    groups: { initiative: "A shared initiative, written to the working tree only; publish the result through the shared-path protocol." },
    commands: [
      // status also says what a Desk session started in the clone binds (`session`), the check a join runs before it delivers.
      command("status", { readOnly: true, summary: "Report the clone's Crew state, and what a Desk session started there binds.", flags: { repo: REPO, identity: str("The login to check.", "<login>") } }, (input) => engine.crewStatus({ repo: repoOf(input), identity: input.identity, session: true })),
      command("start", {
        summary: "Set up a Crew workspace in a new or existing repository; with --tooling-repo the workspace is dual-repo, otherwise a monorepo.",
        flags: {
          repo: REPO,
          team: str("The team's name."),
          founder: str("The founder, as alias=identity.", "<alias>=<identity>"),
          "tooling-repo": str("The separate repository holding the team's plugin.", "<owner/name>"),
          "tooling-path": str("The plugin's folder in it.", "<dir>"),
          "tooling-plugin": str("The plugin's name."),
          "tooling-ref": str("The branch to track.", "<branch>"),
          "tooling-marketplace": str("The marketplace's name."),
          apply: APPLY,
        },
      }, (input) => engine.startWorkspace({
        repo: repoOf(input),
        apply: input.apply === true,
        team: input.team,
        founder: founderOf(input.founder),
        tooling: { repo: input["tooling-repo"], path: input["tooling-path"], plugin: input["tooling-plugin"], ref: input["tooling-ref"], marketplace: input["tooling-marketplace"] },
      })),
      command("join", {
        summary: "Join a Crew workspace; without --apply no member or shared files change, though the preview may fetch missing Git history.",
        flags: { repo: REPO, identity: str("Your login.", "<login>"), alias: str("Your alias in the crew."), apply: APPLY, "adopt-existing": str("A reviewed commit to adopt.", "<reviewed-commit>") },
      }, (input) => engine.joinWorkspace({ repo: repoOf(input), identity: input.identity, alias: input.alias, apply: input.apply === true, ...(input["adopt-existing"] === undefined ? {} : { adoptExisting: input["adopt-existing"] }) })),
      command("initiative new", { summary: "Create a shared initiative: _shared/tracks/<slug>/README.md.", args: [{ name: "slug", required: true, description: "The initiative's slug." }], flags: { repo: REPO, title: str("The initiative's name.") } }, (input) => engine.newInitiative({ repo: repoOf(input), slug: input.slug, title: input.title })),
      command("initiative adopt", { summary: "Bring an existing file or folder in as a shared initiative.", args: [{ name: "source", required: true, description: "The file or folder to bring in." }], flags: { repo: REPO, slug: str("The slug to give it."), title: str("The initiative's name.") } }, (input) => engine.adoptInitiative({ repo: repoOf(input), source: input.source, slug: input.slug, title: input.title })),
      command("initiative check", { readOnly: true, summary: "Check that _shared/tracks/ is laid out right; exits 1 and names the fix when it is not.", flags: { repo: REPO } }, (input) => engine.checkTracks({ repo: repoOf(input), crewScript: script })),
    ],
  })
}

export async function main({ argv = process.argv.slice(2), cwd = process.cwd(), write = (text) => process.stdout.write(text), stderr = process.stderr, engine = { crewStatus, startWorkspace, joinWorkspace, newInitiative, adoptInitiative, checkTracks }, script = fileURLToPath(import.meta.url) } = {}) {
  return runCli(crewCli({ cwd, engine, script }), argv, { stdout: { write }, stderr })
}

/** Whether this file is the script node was started with (compared as real paths, since a temp folder may be a link). */
export function isEntrypoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  process.exitCode = await main()
}
