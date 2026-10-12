# Security and release clearance

[Documentation index](README.md)

## Supported trust boundary

CRAP is a single-owner workspace. The dashboard has no independent public login
or per-user permissions. Local machine users and members of its Docker network
are trusted administrators. Host/Origin validation protects browser requests; it
does not authenticate a direct network client.

Only the dashboard and checked API gateway are published, on loopback. Remote
access uses the Tailscale identity allowlist. Every allowed dashboard identity
has full administrative access; inference additionally needs a client API key.
Keep the raw proxy, database, management and control ports private.

Strict admission requires the enabled native plugin, control/database readiness
and healthy durable delivery. The private proxy has no direct internet path;
outbound inference needs a request-scoped grant. This assumes trusted engine and
plugin code. An operator changing topology, entrypoint or plugins can invalidate
that boundary. See [architecture](architecture.md).

## Secrets and privacy

- Treat database dumps, auth exports, local caches, logs and callback URLs as
  sensitive. Masked emails in the UI do not anonymize stored credentials.
- Integration encryption needs its identity key; protect it and back it up with
  the workspace. A lost key is not repaired by generating another one.
- Keep backup passphrases separately and never put credentials in shell arguments,
  issue reports or screenshots. Use synthetic accounts for reproducible bugs.
- Client enrollment sends a short-lived, single-use ticket, not provider or
  management secrets. Revoke lost/unused devices from Client API Keys.
- Accounting does not retain prompt bodies, but proxy logs can contain request
  material depending on configuration. Review log settings and exports privately.

## What clearance means here

The release gate scans five runtime images, three Go modules (including three OS
targets for the Tailscale helper) and the full npm lockfile. Offline source/history
secret scanning and Docker build-context checks are separate gates.

Unresolved high/critical image findings and reachable Go advisories block packaging,
including findings with no available fix. Scan failure or missing evidence is not
a pass. Packaging also checks exact image identities, a security-input fingerprint,
scan age under 24 hours and unexpired applicability reviews.

An applicability exception names an exact advisory, package/version, Debian release,
image role and expiry, backed by inspection of that image. It does not suppress
other findings from the package or remove the raw inventory. The affected component
must be absent. Low exposure or “upstream dependency” alone is not clearance.

Functional tests do not substitute for dependency clearance. Review the scan
artifacts for the exact candidate revision, including separate CRAP and external
dependency reports. Failed scans continue to block candidate packaging. No
penetration test or guarantee of zero vulnerabilities is claimed.

## Provider and reporting boundaries

Personal account ownership does not establish permission to proxy subscriptions or
rotate accounts. Read [the personal-use guide](../CRAP.md); CRAP does not promise
account safety or exemption from provider rules.

GitHub private vulnerability reporting is enabled. Use
[Report a vulnerability](https://github.com/darki73/crap/security/advisories/new)
and follow the [security policy](../SECURITY.md). Do not publish secrets or unpatched
exploit details in public issues.
