---
schema_version: 1
title: "Free test-tenant claim"
status: in_progress
created: "2026-11-13T08:30:00Z"
updated: "2026-11-13T09:10:00Z"
track: tenants
repos: []
---

# Free test-tenant claim

Claim a free test tenant from Alex's own account, for the posts-site demo.

## State

- The claim form in Alex's account is filled in. Its fields are in `claim-form.json` in this folder.
- The form needs no password and has no free-text field.
- Address: https://portal.example.test/api/test-tenant-claims. It takes a POST with the JSON body from `claim-form.json`.
- It goes to an automated provisioning queue. Not submitted yet.
