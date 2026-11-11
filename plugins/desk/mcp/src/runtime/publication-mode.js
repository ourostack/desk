// A server launched with `--publication deferred` commits but never schedules a push: the caller that launched it
// publishes the commit through its own route (`local-recovery.js --publication deferred`). Every entry point that can
// schedule a push sets the mode from its own arguments, so a variable inherited from a shell can never silently stop an
// ordinary session's pushes; a deferred server hands the mode to the children it starts as an argument.
export const PUBLICATION_ENV = "DESK_PUBLICATION"
const PUBLICATION_DEFERRED = "deferred"

export function applyPublicationMode(args, env) {
  if (args.publication === PUBLICATION_DEFERRED) env[PUBLICATION_ENV] = PUBLICATION_DEFERRED
  else delete env[PUBLICATION_ENV]
}

export function publicationDeferred(env) {
  return env[PUBLICATION_ENV] === PUBLICATION_DEFERRED
}

export function publicationArgs(env) {
  return publicationDeferred(env) ? ["--publication", PUBLICATION_DEFERRED] : []
}
