// Quoting for the commands Desk's messages tell an agent to run, so a path or URL with a space or a shell
// metacharacter in it cannot become a second command.

const PLAIN = /^[\w@%+=:,./-]+$/u

/** `value` as one POSIX shell word; plain words stay bare. */
export function shellQuote(value) {
  const text = String(value)
  if (text !== "" && PLAIN.test(text)) return text
  return `'${text.replace(/'/gu, "'\\''")}'`
}

/** A path as one shell word, keeping a leading `~/` unquoted so the shell still expands it. */
export function shellQuotePath(value) {
  const text = String(value)
  if (text.startsWith("~/")) return `~/${shellQuote(text.slice(2))}`
  return shellQuote(text)
}
