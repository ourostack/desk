import { defineCli, defineCommand } from "./lib/ouro-ui/ax-command.ts"

const command = defineCommand({ name: "boot", summary: "Boot.", effect: "private", readOnly: true, run: () => "raised_here" })
export const oneCli = () => defineCli({ name: "session-boot", about: ["Boot."], command })
export const nameless = (name) => defineCli({ name, about: ["?"], command })
export const empty = () => defineCli({ name: "empty", about: ["?"] })
