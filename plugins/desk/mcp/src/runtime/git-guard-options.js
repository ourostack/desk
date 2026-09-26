// Git's parse-options accepts unambiguous long-option prefixes. Operand-taking
// options consume their value even when it looks like another flag.
const SPECS = {
  restore: {
    flags: ["staged", "worktree", "ignore-unmerged", "overlay", "quiet", "progress", "merge", "ours", "theirs", "patch", "ignore-skip-worktree-bits", "pathspec-file-nul"],
    values: ["source", "conflict", "unified", "inter-hunk-context", "pathspec-from-file"],
    optional: ["recurse-submodules"],
    short: { s: "source", U: "unified" },
    watched: "source",
  },
  branch: {
    flags: ["verbose", "quiet", "unset-upstream", "remotes", "all", "delete", "move", "omit-empty", "copy", "list", "show-current", "create-reflog", "edit-description", "force", "ignore-case", "recurse-submodules"],
    values: ["set-upstream-to", "sort", "points-at", "format"],
    optional: ["track", "color", "abbrev", "column"],
    following: ["contains", "no-contains", "merged", "no-merged"],
    short: { u: "set-upstream-to", f: "force" },
    watched: "force",
  },
  remove: { flags: ["force"], values: [], optional: [], short: { f: "force" }, watched: "force" },
}

export function inspectGitOptions(operation, args) {
  const spec = SPECS[operation]
  const names = [...spec.flags, ...spec.values, ...spec.optional, ...(spec.following ?? [])]
  let enabled = false, options = true
  const operands = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (options && arg === "--") { options = false; continue }
    if (!options || !arg.startsWith("-") || arg === "-") { operands.push(arg); continue }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=")
      const raw = arg.slice(2, equal < 0 ? undefined : equal)
      const negated = raw.startsWith("no-") && !names.includes(raw)
      const candidate = negated ? raw.slice(3) : raw
      const matches = names.includes(candidate) ? [candidate] : names.filter((name) => name.startsWith(candidate))
      // An ambiguous or unknown option is rejected by Git before mutation.
      if (matches.length !== 1) return { enabled: false, operands: [] }
      const [name] = matches
      if (name === spec.watched) enabled = !negated
      if (!negated && spec.values.includes(name) && equal < 0) {
        if (++i >= args.length) return { enabled: false, operands: [] }
      } else if (spec.following?.includes(name) && equal < 0 && args[i + 1] && !args[i + 1].startsWith("-")) i++
      continue
    }
    for (let at = 1; at < arg.length; at++) {
      const name = spec.short[arg[at]]
      if (name === spec.watched) enabled = true
      if (spec.values.includes(name)) {
        if (at === arg.length - 1 && ++i >= args.length) return { enabled: false, operands: [] }
        break
      }
    }
  }
  return { enabled, operands }
}
