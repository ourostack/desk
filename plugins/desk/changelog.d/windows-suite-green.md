Desk now behaves the same on Windows as on macOS and Linux in the places the new Windows test run found. The index, the vector packs and snapshots, and the paths that task, track, lesson, friction and move tools report now spell every desk path with `/` instead of a Windows backslash, so a Windows desk matches the vector packs and snapshots Desk ships and a Windows agent sees the same paths as everyone else. The Windows ACL step finds `SystemRoot` whatever its capitalization, as Git Bash spells it.

Protecting the same private folder many times in one run is faster on Windows. Desk starts Windows PowerShell for every protected write, which takes several hundred milliseconds, and a factory flush repeats that dozens of times. A folder this process already protected and verified is now skipped while its identity and change time are unchanged, and any change to it, including to its access rules, protects it again.

Workspace tidy now removes merged worktrees on Windows. Git reports paths with forward slashes, which the tidy and claim checks compared against native paths, so every worktree was retained. The desk report resolves 8.3 short folder names the way Git does, the coverage runner passes its reporter as a file URL, and the test-state guard recognises the long spelling of a short temp folder.

The index links planning, doing and feedback docs to their task and honors pinned iterations on Windows. A failed move or archive no longer leaves an empty folder. Archiving a task with a symlinked card works with short temp paths. The workspace watcher no longer crashes the controller when the desk path uses an 8.3 short name.

The card pre-commit refusal keeps its first sentence within the length limit, and guard denials name the checkout in one spelling.

Desk no longer starts a separate PowerShell for each of several identical folder-protection requests made at the same moment on Windows. They share one run, which is faster and avoids concurrent rewrites of one folder's permissions.

Desk now watches the long spelling of the desk folder on Windows so a path with 8.3 short names no longer aborts the index process, closes an unreadable index database before moving it aside so the rebuild works, and no longer preloads its native database modules on a worker thread on Windows, which could end the server with an access violation.

The Windows test suite now runs on pull requests that touch the Desk server, its tests or its workflow, as a standard user, and its job fails whenever any test file fails or times out. Before, it reported the results and always passed.

On Windows, a crew desk can open and claim improvement cards and file friction improvement cards, the headless evaluator finds the Claude CLI as `claude.exe`, and shell commands that redirect to `/dev/null` are no longer recorded as file writes. The desk save tool checks a card path in its forward-slash spelling so a backslash path cannot slip past the card guard.
