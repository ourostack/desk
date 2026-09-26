// Git's parse-options accepts unambiguous long-option prefixes. Operand-taking
// options consume their value even when it looks like another flag.
const SPECS = {
  restore: {
    flags: ["staged", "worktree", "ignore-unmerged", "overlay", "quiet", "progress", "merge", "ours", "theirs", "patch", "ignore-skip-worktree-bits", "pathspec-file-nul"],
    values: ["source", "conflict", "unified", "inter-hunk-context", "pathspec-from-file"],
    optional: ["recurse-submodules"],
    nonNegatable: ["ours", "theirs", "unified", "inter-hunk-context"],
    short: { s: "source", U: "unified" },
    watched: "source",
  },
  branch: {
    flags: ["verbose", "quiet", "unset-upstream", "remotes", "all", "delete", "move", "omit-empty", "copy", "list", "show-current", "create-reflog", "edit-description", "force", "ignore-case", "recurse-submodules"],
    values: ["set-upstream-to", "sort", "points-at", "format"],
    optional: ["track", "color", "abbrev", "column"],
    following: ["contains", "no-contains", "merged", "no-merged"],
    nonNegatable: ["remotes", "all", "contains", "no-contains", "merged", "no-merged"],
    short: { u: "set-upstream-to", f: "force" },
    watched: "force",
  },
  remove: { flags: ["force"], values: [], optional: [], nonNegatable: [], short: { f: "force" }, watched: "force" },
}

export function inspectGitOptions(operation, args) {
  const spec = SPECS[operation]
  const names = [...spec.flags, ...spec.values, ...spec.optional, ...(spec.following ?? [])]
  const spellings = names.flatMap((name) => [
    { spelling: name, name, negated: false },
    ...(spec.nonNegatable.includes(name) ? [] : [{ spelling: `no-${name}`, name, negated: true }]),
  ])
  let enabled = false, options = true
  const operands = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (options && arg === "--") { options = false; continue }
    if (!options || !arg.startsWith("-") || arg === "-") { operands.push(arg); continue }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=")
      const raw = arg.slice(2, equal < 0 ? undefined : equal)
      const exact = spellings.find((option) => option.spelling === raw)
      const matches = exact ? [exact] : spellings.filter((option) => option.spelling.startsWith(raw))
      // Incomplete metadata or ambiguity cannot prove a recognized mutation safe.
      if (matches.length !== 1) continue
      const [{ name, negated }] = matches
      if (!negated && spec.values.includes(name) && equal < 0) {
        if (++i >= args.length) return { enabled, operands }
      } else if (spec.following?.includes(name) && equal < 0 && args[i + 1] && !args[i + 1].startsWith("-")) i++
      if (name === spec.watched) enabled = !negated
      continue
    }
    for (let at = 1; at < arg.length; at++) {
      const name = spec.short[arg[at]]
      if (spec.values.includes(name)) {
        if (at === arg.length - 1 && ++i >= args.length) return { enabled, operands }
        if (name === spec.watched) enabled = true
        break
      }
      if (name === spec.watched) enabled = true
    }
  }
  return { enabled, operands }
}
