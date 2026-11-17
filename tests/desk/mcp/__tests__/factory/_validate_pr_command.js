import { runValidatePrCommand } from "../../../../../plugins/desk/mcp/scripts/factory.js"

/** `runValidatePrCommand` for a test that holds the `--flag value` list a workflow passes: the pairs become the flags object the command takes. */
export function validatePrCommand({ argv, ...seams }) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 2) flags[argv[index].slice(2)] = argv[index + 1]
  return runValidatePrCommand(flags, seams)
}
