### Merge-when-green relays judge the newest attempt of each check

A `merge-when-green` relay now counts only the newest attempt of each required check. GitHub keeps a rerun's earlier attempts on the same head, so a check that failed and then passed on rerun used to hold a labelled pull request back for good. The main-branch gate already judged only the latest completed run of its workflow, and still does; the relay's status and `why` now name that run, by id and link, both while it waits and when it merges. A cached check read from before this change is read again on the next poll.
