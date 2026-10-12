# Security policy

Report CRAP vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/darki73/crap/security/advisories/new).

Include the affected CRAP revision, deployment method, sanitized reproduction
steps and expected/actual behavior. Do not include real OAuth tokens, client keys,
bot credentials, database dumps, private conversation content or unredacted logs.
Use synthetic accounts where possible. Do not open a public issue with an
unpatched exploit or credential material.

CRAP is currently a pre-release, single-owner project. No stable supported release
or response-time SLA is promised. Keep using the matching source and image set;
see [release status](doc/release-status.md) for the current scope.

The supported boundary is loopback or explicitly allowlisted Tailscale access.
Every allowed dashboard user is an administrator. The upstream engine and native
plugins must be trusted. See [deployment security](deploy/SECURITY.md),
[the user security guide and release scanning policy](doc/security.md).

Upstream CLIProxyAPI vulnerabilities remain identified as upstream findings.
Acceptance of upstream risk does not mean the vulnerabilities are fixed. Current
release evidence must match the exact source, images and policy being published.
