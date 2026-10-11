The factory store playbook accepts bounded managed-user logins in maintainer
permission lookups. It rejects malformed whole values, including newlines,
while retaining permission-based authority and fail-closed API handling.
