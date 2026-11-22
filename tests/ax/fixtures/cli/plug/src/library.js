// Reads argv only inside a function: a library, not an entry point.
export const entry = (argv = process.argv) => argv[1]
