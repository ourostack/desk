// Where a test makes Desk's temporary-index commit (`commitIndexPaths` in util/git-stage.js) fail, time out or race. Since #632
// that commit is no `git commit`: Git runs the hooks (`git hook run`), makes the commit (`git commit-tree`) and moves the branch
// with one compare-and-swap (`git update-ref`). A test that cut off or refused the old `git commit` picks the step that is what it
// means:
// - `beforeLanding`: the pre-commit hook, before anything is committed (a commit that timed out before it landed, or was refused);
// - `afterLanding`: the post-commit hook, once the branch holds the commit (a commit that landed, then timed out);
// - `branchUpdate`: the one dispatch that moves the branch.
const hookRun = (args, name) => args[2] === "hook" && args[3] === "run" && args.at(-1) === name

export const beforeLanding = (args) => hookRun(args, "pre-commit")
export const afterLanding = (args) => hookRun(args, "post-commit")
export const branchUpdate = (args) => args[2] === "update-ref"
