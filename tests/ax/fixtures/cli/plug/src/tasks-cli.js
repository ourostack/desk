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
    ],
  })
}
