// A kit CLI built the way Desk's are: a local helper passes its first parameter to defineCommand as the name.
import { defineCli, defineCommand } from "./lib/ouro-ui/ax-command.ts"

const LIST = defineCommand({ name: "list", summary: "List tasks.", effect: "private", readOnly: true })
const more = [defineCommand({ name: "archive", summary: "Archive one.", effect: "private" })]

export function tasksCli(engine) {
  const command = (name, def, run) => defineCommand({ name, effect: "private", ...def, run })
  return defineCli({
    name: "tasks",
    about: ["Tasks."],
    commands: [
      command("add", { summary: "Add a task." }, (input) => engine.add(input)),
      command("show", { summary: "Show one.", readOnly: true }, (input) => engine.show(input)),
      LIST,
      ...more,
      engine.extra,
      command("count", { ...READ, summary: "Count tasks." }, (input) => engine.count(input)),
      command("purge", { ...READ, readOnly: false, summary: "Purge done tasks." }, (input) => engine.purge(input)),
      command("peek", { readOnly: false, ...READ, summary: "Peek." }, (input) => engine.peek(input)),
      command("sync", { readOnly: true, ...engine.defaults, summary: "Sync." }, (input) => engine.sync(input)),
    ],
  })
}

// A shared read-only def spread into commands, as drains-cli.js does; a later key overrides the spread.
const READ = { effect: "private", readOnly: true }

import "./slug"
import "./missing.js"
