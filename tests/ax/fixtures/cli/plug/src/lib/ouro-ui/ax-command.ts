// Vendored: its own CLI is Ouro's door, not Desk's.
export const defineCli = (def: unknown) => def
export const defineCommand = (def: unknown) => def
defineCli({ name: "xray", command: defineCommand({ name: "xray" }) })
console.log(process.argv)
