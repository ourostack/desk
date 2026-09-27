// Git's parse-options accepts unambiguous long-option prefixes, clusters short flags and
// lets an operand-taking option consume its value even when the value looks like a flag.
// A spec is a space-separated list of "[s|]long[=|=?|=^][!]" or "-S[=]" entries: "=" takes a
// value, "=?" takes only an attached value, "=^" takes the next argument unless it starts
// with "-" (Git's last-argument default), and "!" marks an option without a --no- form.
// The lists match `git <command> --git-completion-helper-all` for Git 2.54, hidden options
// included, so a prefix Desk resolves is a prefix Git resolves.
const ENTRY = /^(?:-(?<only>[A-Za-z0-9])|(?:(?<short>[A-Za-z0-9])\|)?(?<long>[a-z][a-z0-9-]*))(?<value>=[?^]?)?(?<fixed>!)?$/u

function spec(text) {
  const long = [], short = new Map()
  for (const entry of text.trim().split(/\s+/u)) {
    const { only, short: letter, long: name, value = "", fixed } = ENTRY.exec(entry).groups
    const option = { name: only ? `-${only}` : name, value: { "": "none", "=": "required", "=?": "optional", "=^": "following" }[value] }
    if (only) short.set(only, option)
    else {
      long.push({ spelling: name, option, negated: false })
      if (!fixed) long.push({ spelling: `no-${name}`, option, negated: true })
      if (letter) short.set(letter, option)
    }
  }
  return { long, short }
}

export const SPECS = {
  checkout: spec("-b= -B= -l guess overlay auto-advance q|quiet recurse-submodules=? progress m|merge conflict= d|detach t|track=? f|force orphan= overwrite-ignore ignore-other-worktrees 2|ours! 3|theirs! p|patch U|unified=! inter-hunk-context=! ignore-skip-worktree-bits pathspec-from-file= pathspec-file-nul"),
  switch: spec("c|create= C|force-create= guess discard-changes q|quiet recurse-submodules=? progress m|merge conflict= d|detach t|track=? f|force orphan= overwrite-ignore ignore-other-worktrees"),
  reset: spec("q|quiet refresh mixed! soft! hard! merge! keep! recurse-submodules=? p|patch auto-advance U|unified=! inter-hunk-context=! N|intent-to-add pathspec-from-file= pathspec-file-nul"),
  restore: spec("s|source= S|staged W|worktree ignore-unmerged overlay q|quiet recurse-submodules=? progress m|merge conflict= 2|ours! 3|theirs! p|patch U|unified=! inter-hunk-context=! ignore-skip-worktree-bits pathspec-from-file= pathspec-file-nul"),
  branch: spec("v|verbose q|quiet t|track=? set-upstream u|set-upstream-to= unset-upstream color=? r|remotes! contains=^! no-contains=^! with=^! without=^! abbrev=? a|all! d|delete -D m|move -M omit-empty c|copy -C l|list show-current create-reflog edit-description f|force merged=^! no-merged=^! column=? sort= points-at= i|ignore-case recurse-submodules format="),
  rebase: spec("onto= keep-base verify q|quiet v|verbose -n stat trailer= signoff committer-date-is-author-date reset-author-date ignore-date ignore-whitespace whitespace= f|force-rebase ff continue! skip! abort! quit! edit-todo! show-current-patch! apply! m|merge! i|interactive! preserve-merges rerere-autoupdate empty=! k|keep-empty autosquash update-refs S|gpg-sign=? autostash x|exec= allow-empty-message r|rebase-merges=? fork-point s|strategy= X|strategy-option= root reschedule-failed-exec reapply-cherry-picks -C="),
  pull: spec("v|verbose q|quiet progress recurse-submodules=? r|rebase=? -n stat summary compact-summary log=? signoff=? squash commit edit cleanup= ff ff-only! verify verify-signatures autostash s|strategy= X|strategy-option= S|gpg-sign=? allow-unrelated-histories all a|append upload-pack= f|force t|tags p|prune j|jobs=? dry-run k|keep depth= shallow-since= shallow-exclude= deepen= unshallow! update-shallow refmap=! o|server-option= 4|ipv4 6|ipv6 negotiation-tip= show-forced-updates set-upstream"),
  merge: spec("-n stat summary compact-summary log=? squash commit e|edit cleanup= ff ff-only! rerere-autoupdate verify-signatures s|strategy= X|strategy-option= m|message= F|file=! into-name= v|verbose q|quiet abort quit continue allow-unrelated-histories progress S|gpg-sign=? autostash overwrite-ignore signoff verify"),
  push: spec("v|verbose q|quiet repo= all branches mirror d|delete tags n|dry-run porcelain f|force force-with-lease=? force-if-includes recurse-submodules= thin receive-pack= exec= u|set-upstream progress prune verify follow-tags signed=? atomic o|push-option= 4|ipv4! 6|ipv6!"),
  commit: spec("q|quiet v|verbose F|file= author= date= m|message= c|reedit-message= C|reuse-message= fixup= squash= reset-author trailer= s|signoff t|template= e|edit cleanup= status S|gpg-sign=? a|all i|include interactive p|patch U|unified=! inter-hunk-context=! o|only -n verify dry-run short branch ahead-behind porcelain long z|null amend post-rewrite u|untracked-files=? pathspec-from-file= pathspec-file-nul allow-empty allow-empty-message"),
  fetch: spec("v|verbose q|quiet all set-upstream a|append atomic upload-pack= f|force m|multiple t|tags j|jobs= prefetch p|prune P|prune-tags recurse-submodules=? dry-run porcelain write-fetch-head k|keep u|update-head-ok progress depth= shallow-since= shallow-exclude= deepen= unshallow! refetch! submodule-prefix= recurse-submodules-default= update-shallow refmap=! o|server-option= 4|ipv4! 6|ipv6! negotiation-tip= negotiate-only filter= auto-maintenance auto-gc show-forced-updates write-commit-graph stdin"),
  tag: spec("l|list! d|delete! v|verify! a|annotate m|message=! F|file= trailer= e|edit s|sign cleanup= u|local-user= f|force create-reflog column=? contains=^! no-contains=^! with=^! without=^! merged=^! no-merged=^! omit-empty sort= points-at=^ format= color=? i|ignore-case -n=?"),
  "worktree add": spec("f|force -b= -B= orphan d|detach checkout lock reason= q|quiet track guess-remote relative-paths"),
  "worktree remove": spec("f|force"),
  "worktree prune": spec("n|dry-run v|verbose expire="),
}

function longOption(spec, raw) {
  const exact = spec.long.find((entry) => entry.spelling === raw)
  // Git rejects an ambiguous or unknown option before it changes anything.
  const matches = exact ? [exact] : spec.long.filter((entry) => entry.spelling.startsWith(raw))
  return matches.length === 1 ? matches[0] : null
}

/** Parse Git arguments without executing them: the options set (last occurrence wins, in `sequence` order), the operands, and where `--` fell among them. */
export function parseGitOptions(spec, args) {
  const set = new Map(), sequence = [], operands = []
  let dashdash = -1, options = true
  const record = (name, value, negated = false) => { set.set(name, { value, negated }); sequence.push({ name, negated }) }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (options && arg === "--") { options = false; dashdash = operands.length; continue }
    if (options && arg === "--end-of-options") { options = false; continue }
    if (!options || !arg.startsWith("-") || arg === "-") { operands.push(arg); continue }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=")
      const found = longOption(spec, arg.slice(2, equal < 0 ? undefined : equal))
      if (!found) continue
      const { option, negated } = found
      const attached = equal < 0 ? undefined : arg.slice(equal + 1)
      if (negated || option.value === "none") {
        if (attached === undefined) record(option.name, !negated, negated)
      } else if (option.value === "required") {
        const value = attached ?? args[++i]
        if (value === undefined) break
        record(option.name, value)
      } else if (option.value === "following" && attached === undefined && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) {
        record(option.name, args[++i])
      } else record(option.name, attached ?? true)
      continue
    }
    for (let at = 1; at < arg.length; at++) {
      const option = spec.short.get(arg[at])
      if (!option) continue
      if (option.value === "none") { record(option.name, true); continue }
      const rest = arg.slice(at + 1)
      const value = rest || (option.value === "required" ? args[++i] : true)
      if (value === undefined) return { set, sequence, operands, dashdash }
      record(option.name, value)
      break
    }
  }
  return { set, sequence, operands, dashdash }
}

/** Whether `name` is set and not negated by a later --no- form. */
export function hasOption(parsed, name) {
  return parsed.set.get(name)?.negated === false
}
