// Best-effort reading of a shell command for a WRITE to a task card, for the task-status guard's `Bash` check (boot acceptance round E, run 8:
// an agent rewrote a live card with a node script run through Bash and committed it by hand, skipping `task_update`).
//
// What it does. It finds every word of the command that ends in `task.md` and asks the caller (`resolve`) whether that word is a live card of the
// bound desk. For each such card it then looks for a write form:
//   - shell forms, judged on the words around the path inside the same pipeline segment (the text between `;`, `&`, `|` and line breaks):
//     a redirect onto it (`> path`, `>> path`, `>| path`, `2> path`), `tee` / `sponge` / `truncate` / `dd of=` naming it, an in-place editor (`sed -i`,
//     `perl -i`, `ruby -i`, `yq -i`, `--in-place`) naming it, `mv` / `cp` / `install` / `rsync` / `ln` whose LAST operand it is, and `git checkout` or `git restore`
//     naming it;
//   - script forms, judged on the whole command: a script that writes a file by API (`writeFile`, `writeFileSync`, `appendFile`, `createWriteStream`,
//     `copyFile`, `renameSync`, Python `open(..., 'w'|'a'|'x'|'r+')`, `write_text`, `write_bytes`, `shutil.move|copy*`, `os.replace|rename`, Ruby
//     `File.write` / `IO.write`, PowerShell `Set-Content` / `Add-Content` / `Out-File`), because the path is often held in a variable the script
//     writes through, as in the round E command.
// A path built in pieces (`path.join(desk, 'track', 'slug', 'task.md')`) names no card by itself; a command that has a bare `task.md`, a script write form
// and the slug of a live card as a whole word is read as writing that card (`slugCards`).
// Reads pass: `cat`, `grep`, `head`, `tail`, `less`, `git diff`, `git log`, `git show`, `sed -n`, `cp <card> elsewhere`, `mv <card> elsewhere` and a
// redirect that has the card on its left (`cat task.md > /tmp/x`) are not write forms.
//
// What it cannot see, by design: a variable that holds the path, a glob (`*/*/task.md`), a path assembled from several strings, a `cd` through a
// variable, a script file run by name. The desk's pre-commit hook (`desk/card-commit-guard.js`) is the layer under this one: whatever wrote the file,
// the commit has to come from Desk.

// A word that ends in task.md: a path chunk without whitespace, quotes, redirection, pipe or separator characters; `task.md.bak` and `task.mdx` do not end there.
const CARD_WORD = /[^\s"'`=:<>|;&(),{}]*task\.md(?![\w.-])/giu

// The shell write forms, each tested on the text BEFORE the path (inside its segment) unless noted.
const REDIRECT_BEFORE = /(?<![=\-<>])>{1,2}\|?\s*["']?$/u
const TEE_BEFORE = /\b(?:tee|sponge|truncate)\b[^]*$/u
const DD_BEFORE = /\bof=["']?$/u
const IN_PLACE_BEFORE = /\b(?:sed|gsed|perl|ruby|yq|awk)\b[^]*\s(?:-[A-Za-z]*i\S*|--in-place\S*)/u
const COPY_BEFORE = /\b(?:mv|cp|install|rsync|ln)\b[^]*$/u
const GIT_RESTORE_BEFORE = /\bgit\b[^]*\b(?:checkout|restore)\b/u
// `git restore --staged <path>` only unstages it (the hook's own message tells an agent to do that); with `--worktree` it rewrites the file too.
const UNSTAGE_ONLY = /\s(?:--staged|-S)(?=\s)/u
const ALSO_WORKTREE = /\s(?:--worktree|-W)(?=\s)/u
// A card word that is the argument of a read call is a read of the card, whatever else the script writes.
const READ_CALL_BEFORE = /\b(?:readFileSync|readFile|createReadStream|statSync|existsSync|read_text|read_bytes)\s*\(\s*["']?$/u

// The script write forms, tested on the whole command (the boot-acceptance harness keeps an identical list; a test compares them).
export const SCRIPT_WRITE_PATTERNS = [
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|renameSync|truncateSync)\s*\(/u,
  /\bfs\s*\.\s*(?:promises\s*\.\s*)?(?:rename|writeFile|appendFile|copyFile|truncate)\s*\(/u,
  /\b(?:open|openSync)\s*\([^)]*,\s*(?:mode\s*=\s*)?["'][^"']*[wax+][^"']*["']/u,
  /\.\s*(?:write_text|write_bytes)\s*\(/u,
  /\b(?:shutil\s*\.\s*(?:move|copy|copy2|copyfile)|os\s*\.\s*(?:replace|rename))\s*\(/u,
  /\b(?:File|IO)\s*\.\s*(?:write|binwrite)\s*\(/u,
  /\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Move-Item|Copy-Item)\b/iu,
]

function segmentBefore(command, index) {
  let start = index
  // A `|` right after `>` is the forced redirect `>|`, not a pipe.
  while (start > 0 && !(";&|\n".includes(command[start - 1]) && !(command[start - 1] === "|" && command[start - 2] === ">"))) start -= 1
  return command.slice(start, index)
}

function segmentAfter(command, index) {
  let end = index
  while (end < command.length && !";&|\n".includes(command[end])) end += 1
  return command.slice(index, end)
}

/** Which shell write form precedes the card word at `index` in `command`, as a short label, or null. */
function shellForm(command, index, length) {
  const before = segmentBefore(command, index)
  const after = segmentAfter(command, index + length)
  if (REDIRECT_BEFORE.test(before)) return "a redirect"
  if (DD_BEFORE.test(before)) return "dd of="
  if (TEE_BEFORE.test(before)) return "tee"
  if (IN_PLACE_BEFORE.test(before)) return "an in-place edit"
  if (GIT_RESTORE_BEFORE.test(before) && (!UNSTAGE_ONLY.test(before) || ALSO_WORKTREE.test(before))) return "git checkout or restore"
  if (COPY_BEFORE.test(before) && /^["']?\s*$/u.test(after)) return "a move or copy onto it"
  return null
}

const scriptForm = (command) => SCRIPT_WRITE_PATTERNS.some((pattern) => pattern.test(command))

/** The folders a command moves into before it runs the rest (`cd dir`, `pushd dir`, `git -C dir`), as written. */
function directories(command) {
  const found = []
  for (const match of command.matchAll(/(?:\b(?:cd|pushd)\s+(?:--\s+)?|\bgit\s+-C\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))/gu)) found.push(match[1] ?? match[2] ?? match[3])
  return found
}

/**
 * The live cards `command` writes, as `[{ card, via }]` (empty when it writes none). `resolve(word, directories)` returns the live, readable card
 * a word names (resolved against each of `directories`, the session folder, the desk and any folder the command moves into) or null; `slugCards` is
 * a function returning the `{ card, slug }` of the desk's live cards, used for a path built in pieces. `vars` are the strings `$DESK` and `${DESK}` expand to.
 */
export function shellCardWrites(command, { resolve, slugCards, vars = {} }) {
  let text = String(command ?? "")
  if (!/task\.md/iu.test(text)) return []
  for (const [name, value] of Object.entries(vars)) text = text.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, "gu"), () => value)
  const dirs = directories(text)
  const script = scriptForm(text)
  const found = new Map()
  const note = (card, via) => {
    if (!found.has(card.absolute)) found.set(card.absolute, { card, via })
  }
  let bare = false
  for (const match of text.matchAll(CARD_WORD)) {
    const card = resolve(match[0], dirs)
    if (card === null) {
      bare ||= /^(?:\.[\\/])?task\.md$/iu.test(match[0])
      continue
    }
    const readOnly = READ_CALL_BEFORE.test(text.slice(Math.max(0, match.index - 40), match.index))
    const via = shellForm(text, match.index, match[0].length) ?? (script && !readOnly ? "a script that writes files" : null)
    if (via !== null) note(card, via)
  }
  if (bare && script) {
    for (const { card, slug } of slugCards()) {
      if (slug.length >= 4 && new RegExp(`(?<![\\w-])${slug.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`, "u").test(text)) note(card, "a script that writes files")
    }
  }
  return [...found.values()]
}
