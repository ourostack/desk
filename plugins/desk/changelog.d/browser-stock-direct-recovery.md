The real-profile browser runner now launches the stock Playwright connection directly, without inserting Desk's watchdog or custom relay. Existing profile and token loading, output token redaction, stock tools, and explicit close behavior are unchanged.

Automatic tab deletion on disconnect or process exit is deferred. Close only tabs you created and still own using ordinary browser tools; leave unknown or foreign tabs alone. A disconnect is not proof that every tab was cleaned up.
