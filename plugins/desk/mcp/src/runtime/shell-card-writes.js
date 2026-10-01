// Best-effort reading of a shell command for a WRITE to a task card, for the task-status guard's `Bash` check (boot acceptance round E, run 8:
// an agent rewrote a live card with a node script run through Bash and committed it by hand, skipping `task_update`).
//
// What it does. It finds every word of the command that ends in `task.md` and asks the caller (`resolve`) whether that word is a live card of the
// bound desk. For each such card it then looks for a write form:
//   - shell forms, judged on the words around the path inside the same pipeline segment (the text between `;`, `&`, `|` and line breaks):
//     a redirect onto it (`> path`, `>> path`, `>| path`, `2> path`), `tee` / `sponge` / `truncate` / `dd of=` naming it, an in-place editor (`sed -i`,
//     `perl -i`, `ruby -i`, `yq -i`, `--in-place`) naming it, `mv` / `cp` / `install` / `rsync` / `ln` whose LAST operand it is, and `git checkout` or `git restore`
//     naming it;
//   - script forms, judged on the call: a script that writes a file by API (`writeFile`, `writeFileSync`, `appendFile`, `createWriteStream`,
//     `copyFile`, `renameSync`, Python `open(..., 'w'|'a'|'x'|'r+')`, `write_text`, `write_bytes`, `shutil.move|copy*`, `os.replace|rename`, Ruby
//     `File.write` / `IO.write`, PowerShell `Set-Content` / `Add-Content` / `Out-File`), because the path is often held in a variable the script
//     writes through, as in the round E command.
// A script form counts only when the card is the WRITE TARGET of the call: the destination argument of `writeFileSync`, `copyFile`, `rename`, `open(.., 'w')`,
// `Path(..).write_text`, `[IO.File]::WriteAllText` and the like, either written inline or held in a variable the script assigns from a string that names the
// card. A script that only reads the card (`open('task.md').read()`, `readFileSync`) or writes somewhere else does not trip it. PowerShell cmdlets
// (`Set-Content`, `Out-File`, `Move-Item`, ...) are judged on the operand: the card must be the `-Path`, `-LiteralPath`, `-FilePath` or `-Destination` operand (or
// the positional target) outside any parenthesised sub-expression, so `Set-Content other.md (Get-Content task.md)` passes.
// A path built in pieces (`path.join(desk, 'track', 'slug', 'task.md')`) names no card by itself; a write target that has a bare `task.md` and a command that has
// the slug of a live card as a whole word is read as writing that card (`slugCards`).
// While a card is conflicted (`conflicted(card)`, from `git ls-files -u`), `git checkout --ours|--theirs <card>` and `git checkout <ref> -- <card>` pass: resolving a
// merge is a git operation.
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

// The script write forms, tested on the whole command (the boot-acceptance harness keeps an identical list; a test compares them).
export const SCRIPT_WRITE_PATTERNS = [
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|renameSync|truncateSync)\s*\(/u,
  /\bfs\s*\.\s*(?:promises\s*\.\s*)?(?:rename|writeFile|appendFile|copyFile|truncate)\s*\(/u,
  /\b(?:open|openSync)\s*\([^)]*,\s*(?:mode\s*=\s*)?["'][^"']*[wax+][^"']*["']/u,
  /\.\s*(?:write_text|write_bytes)\s*\(/u,
  /\b(?:shutil\s*\.\s*(?:move|copy|copy2|copyfile)|os\s*\.\s*(?:replace|rename))\s*\(/u,
  /\b(?:File|IO)\s*\.\s*(?:write|binwrite)\s*\(/u,
  /\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Move-Item|Copy-Item)\b/iu,
  /\bFile\s*\]\s*::\s*(?:WriteAll\w+|AppendAll\w+|Copy|Move|Replace)\s*\(/iu,
]

// What each script write call writes to: the arguments (0-based) that name the file it changes. `modeArg` marks `open(path, mode)`, which writes only
// when the mode string has a write flag.
const CALLS = [
  { re: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync)\s*\(/gu, args: [0] },
  { re: /\b(?:copyFile|copyFileSync)\s*\(/gu, args: [1] },
  { re: /\b(?:renameSync|os\s*\.\s*(?:replace|rename)|fs\s*\.\s*(?:promises\s*\.\s*)?rename)\s*\(/gu, args: [0, 1] },
  { re: /\bshutil\s*\.\s*(?:copy|copy2|copyfile)\s*\(/gu, args: [1] },
  { re: /\bshutil\s*\.\s*move\s*\(/gu, args: [0, 1] },
  { re: /\b(?:File|IO)\s*\.\s*(?:write|binwrite)\s*\(/gu, args: [0] },
  { re: /\bFile\s*\]\s*::\s*(?:WriteAll\w+|AppendAll\w+)\s*\(/giu, args: [0] },
  { re: /\bFile\s*\]\s*::\s*Copy\s*\(/giu, args: [1] },
  { re: /\bFile\s*\]\s*::\s*(?:Move|Replace)\s*\(/giu, args: [0, 1] },
  { re: /\b(?:open|openSync)\s*\(/gu, args: [0], modeArg: 1 },
  // `Path(<card>).write_text(...)`: the receiver is the target, checked after the call's arguments.
  { re: /\bPath\s*\(/gu, args: [0], suffix: /^\s*\.\s*(?:write_text|write_bytes)\s*\(|^\s*\.\s*open\s*\(\s*["'][^"']*[wax+]/u },
]
const WRITE_MODE = /^\s*(?:mode\s*=\s*)?["'][^"']*[wax+][^"']*["']/u

// PowerShell cmdlets that change the file they are given, and which operand that is.
const PS_CMDLET = /\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Clear-Content|Move-Item|Copy-Item|Rename-Item|New-Item)\b/iu
const PS_TARGET_PARAM = /-(?:Path|LiteralPath|FilePath|Destination|PSPath)(?::|\s+)["']?$/iu
const PS_FIRST_POSITIONAL = /\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Clear-Content|Move-Item|Rename-Item|New-Item)(?:\s+-(?:Force|Append|NoNewline|NoClobber|Confirm|WhatIf))*\s+["']?$/iu
const PS_SECOND_POSITIONAL = /\b(?:Move-Item|Copy-Item)(?:\s+-(?:Force|Confirm|WhatIf))*\s+(?:"[^"]*"|'[^']*'|[^\s"'(-][^\s"']*)\s+["']?$/iu

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
  if (powershellTarget(before)) return "a PowerShell write cmdlet"
  return null
}

/** Whether the card word that ends `before` is the file operand of a PowerShell write cmdlet, outside any parenthesised sub-expression. */
function powershellTarget(before) {
  if (!PS_CMDLET.test(before)) return false
  let depth = 0
  for (const char of before) {
    if (char === "(") depth += 1
    else if (char === ")") depth -= 1
  }
  if (depth > 0) return false
  return PS_TARGET_PARAM.test(before) || PS_FIRST_POSITIONAL.test(before) || PS_SECOND_POSITIONAL.test(before)
}

/** The arguments of the call whose `(` is at `open`, as source text, and the index after its `)`. Quotes and nested brackets are respected. */
function callArguments(text, open) {
  const args = []
  let depth = 0
  let quote = null
  let start = open + 1
  const limit = Math.min(text.length, open + 4000)
  for (let index = open; index < limit; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === "\\") index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "(" || char === "[" || char === "{") depth += 1
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1
      if (depth === 0) {
        args.push(text.slice(start, index))
        return { args, end: index + 1 }
      }
    } else if (char === "," && depth === 1) {
      args.push(text.slice(start, index))
      start = index + 1
    }
  }
  args.push(text.slice(start, limit))
  return { args, end: limit }
}

/** Variables a script assigns from a string that names a card: `{ name -> right-hand side }`. */
function aliases(text) {
  const found = new Map()
  for (const match of text.matchAll(/(?<![\w.$])\$?([A-Za-z_][\w]*)\s*=\s*([^;\n=][^;\n]*task\.md[^;\n]*)/giu)) found.set(match[1], match[2])
  return found
}

/** The `[{ word, bare }]` card words a write target names: inline, or through a variable assigned from a string that names the card. */
function targetWords(argument, table, seen = new Set()) {
  const out = []
  for (const match of argument.matchAll(CARD_WORD)) out.push({ word: match[0] })
  for (const identifier of argument.matchAll(/(?<![\w.$"'])\$?([A-Za-z_]\w*)(?![\w"'(])/gu)) {
    const rhs = table.get(identifier[1])
    if (rhs === undefined || seen.has(identifier[1])) continue
    seen.add(identifier[1])
    out.push(...targetWords(rhs, table, seen))
  }
  return out
}

/** The write targets of a script, as `[{ word }]`: every card word (or `task.md` built in pieces) in the destination argument of a write call. */
function scriptTargets(text) {
  const table = aliases(text)
  const out = []
  for (const call of CALLS) {
    for (const match of text.matchAll(call.re)) {
      const { args, end } = callArguments(text, match.index + match[0].length - 1)
      if (call.modeArg !== undefined && !WRITE_MODE.test(args[call.modeArg] ?? "")) continue
      if (call.suffix !== undefined && !call.suffix.test(text.slice(end))) continue
      for (const index of call.args) out.push(...targetWords(args[index] ?? "", table))
    }
  }
  for (const [name] of table) {
    // `target.write_text(...)` / `target.open('w')` on a variable that holds the card.
    if (new RegExp(`(?<![\\w.$])${name}(?=\\s*\\.\\s*(?:write_text|write_bytes|open\\s*\\(\\s*["'][^"']*[wax+]))`, "u").test(text)) out.push(...targetWords(table.get(name), table))
  }
  return out
}

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
export function shellCardWrites(command, { resolve, slugCards, vars = {}, conflicted = () => false }) {
  let text = String(command ?? "")
  if (!/task\.md/iu.test(text)) return []
  for (const [name, value] of Object.entries(vars)) text = text.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, "gu"), () => value)
  const dirs = directories(text)
  const found = new Map()
  const note = (card, via) => {
    if (!found.has(card.absolute)) found.set(card.absolute, { card, via })
  }
  for (const match of text.matchAll(CARD_WORD)) {
    const card = resolve(match[0], dirs)
    if (card === null) continue
    const via = shellForm(text, match.index, match[0].length)
    if (via === "git checkout or restore" && conflicted(card)) continue
    if (via !== null) note(card, via)
  }
  let bare = false
  for (const { word } of scriptTargets(text)) {
    const card = resolve(word, dirs)
    if (card === null) bare ||= /^(?:\.[\\/])?task\.md$/iu.test(word)
    else note(card, "a script that writes files")
  }
  if (bare) {
    for (const { card, slug } of slugCards()) {
      if (slug.length >= 4 && new RegExp(`(?<![\\w-])${slug.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`, "u").test(text)) note(card, "a script that writes files")
    }
  }
  return [...found.values()]
}
