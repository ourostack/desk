// An entry point whose argv read sits inside main(), which the module calls at the top level.
async function main() {
  const [first] = process.argv.slice(2)
  return first
}
main().catch(() => process.exit(1))
