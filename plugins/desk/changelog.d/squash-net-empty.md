### A checkout whose commits net to nothing takes content-home writes again

The squash-merge reconcile did nothing when the held commits and their merges changed no file overall, so the checkout stayed refused with `content_home_unpublished_base`. Desk now moves it onto the base in that case too.
