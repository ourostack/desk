### The Windows ACL helper waits longer for its first answer

On Windows, Desk's ACL helper now waits up to 45 s instead of 20 s for its first answer, so a slow cold PowerShell start no longer fails a protected write ([`mcp/src/factory/windows-acl.js`](mcp/src/factory/windows-acl.js)).
