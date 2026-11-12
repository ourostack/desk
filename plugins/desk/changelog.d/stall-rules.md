### Agents keep working through red checks and correction rounds

Two skill sentences told agents to stop instead of finishing. `fast-honest-ci` said to find a red run's cause before any re-run and never re-queue. `work-orchestration` allowed one bounded correction wave. Now a known or likely flake may be re-run once, with its run link stated, and the cause is still fixed. Correction continues until the candidate is green or a concrete blocker is named, with no fixed round limit. Finished work is never closed or discarded because a check failed or a round count ran out.
