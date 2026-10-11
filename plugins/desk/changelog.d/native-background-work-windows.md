Native browser work uses independently recorded, unfocused popup windows so
successful local-page navigation does not activate Edge's normal-window surface.
The owner control and bounded peer API identify each task's exact browser window
without changing website titles. Page creation waits for bootstrap and ownership
readiness before handing a page to callers; pending targets remain authoritative
during failure reconciliation and exact cleanup.
