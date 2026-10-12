# Security scope before public release

The supported boundary is one trusted owner on loopback or the Tailscale identity
allowlist. Every allowed dashboard user has full administrative access. There
are no viewer roles, separate tenants or public-internet login sessions.

The raw proxy, control API and PostgreSQL must remain private. Keep the dashboard
and checked inference gateway loopback-bound for local access. Host/Origin checks
address browser-origin attacks, not authentication of direct network clients.
Use the Tailscale gateway's identity checks for remote access. The owner still
supplies a client API key for inference. Do not expose management ports through a
generic ingress or Docker port mapping.

The management API can use provider credentials for authenticated HTTP calls.
Treat it, database backups, encrypted settings plus their identity key, and the
Tailscale state directory as sensitive administrative material. Never include
them in public bug reports. Backup passphrases must be stored separately.

The project repository is [darki73/crap](https://github.com/darki73/crap).
GitHub private vulnerability reporting was enabled and verified on 2026-10-12.
Use [Report a vulnerability](https://github.com/darki73/crap/security/advisories/new)
for sensitive reports. See the root [security policy](../SECURITY.md) for report
contents and supported-version scope. Do not post credentials or unpatched exploit
details in public issues. No response-time SLA or security-audit certification is implied.

Release checks run Gitleaks in an offline container over Git-visible source and
locally reachable history. `deploy/secret-baseline.json` records reviewed upstream
OAuth client constants and fixture/protocol matches. Source exceptions include a
line-content hash; history exceptions include the exact commit fingerprint.
Do not add broad path exclusions or automatically accept new findings. The scan
does not establish absence of vulnerabilities or safety of provider account use.
