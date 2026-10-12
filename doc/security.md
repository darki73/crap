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

The publication gate covers what CRAP ships: its control, gateway and panel
images, native plugin, Tailscale helpers and npm dependencies. High/critical
findings in these images or the npm lockfile, and reachable advisories in CRAP's
Go code, block packaging even when no fix is available. Dependencies embedded in
a CRAP artifact remain in scope, regardless of who maintains them.

The separately installed official CLIProxyAPI and PostgreSQL are external
services. Their image/binary findings remain in the candidate's external report
for deployment decisions; they do not block CRAP artifact publication. A passing
CRAP gate does not mean those services are free of vulnerabilities. CRAP does not
patch, build or republish them.

All five image scans, CRAP Go source scans (including three OS targets for the
Tailscale helper), the official proxy binary scan and the full npm audit must
complete. A failed or missing scan is not a pass. Compatibility tests against the
official proxy remain mandatory, as do offline source/history secret scanning
and Docker build-context checks.

Packaging checks the explicit CRAP publication scope, exact image identities, a
security-input fingerprint, scan age under 24 hours and unexpired applicability
reviews. Old evidence must be regenerated after a policy change. Findings cannot
be reclassified as external simply by labelling an owned artifact that way.

An applicability exception names an exact advisory, package/version, Debian
release, image role and expiry, backed by inspection proving the affected
component is absent. It does not suppress other findings or remove the raw
inventory. Functional tests do not substitute for artifact vulnerability scans.
Review both ownership reports for the exact candidate revision. No penetration
test or guarantee of zero vulnerabilities is claimed.

## Provider and reporting boundaries

Personal account ownership does not establish permission to proxy subscriptions or
rotate accounts. Read [the personal-use guide](../CRAP.md); CRAP does not promise
account safety or exemption from provider rules.

GitHub private vulnerability reporting is enabled. Use
[Report a vulnerability](https://github.com/darki73/crap/security/advisories/new)
and follow the [security policy](../SECURITY.md). Do not publish secrets or unpatched
exploit details in public issues.
