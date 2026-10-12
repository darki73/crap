# Workspace backup, recovery and upgrades

These commands operate on the packaged Compose deployment only. They do not
convert the original development installation or provision a CNPG cluster.
The operator host needs Node 24 and Docker Compose v2. Use the same source
checkout and application images as the workspace being backed up. The supported
entrypoint is always `deploy/compose.yaml`, which enables strict routing. New
archives record that mode; the backup command verifies the source gateway/control
settings and private proxy network before stopping services. Legacy archives
require a separate reviewed migration and are rejected before target creation.

For downloaded release candidates, add `--images /path/to/compose.images.json`
to both backup and restore commands. This selects the matching retained helper
and service images. Use that same override with Compose when activating the
restored project. Source-built local rehearsals use their local image tags.

## Full encrypted backup

Create a private passphrase file containing at least 16 characters. Keep it
separately from the backup, outside Git; do not put the passphrase in command
arguments or shell history. From the repository root:

```sh
node deploy/workspace-backup.mjs backup crap ./backups/workspace.crap /private/path/passphrase.txt
```

The command stops the checked gateway first, allowing existing HTTP streams to
finish without a forced shutdown timeout. It then stops the panel, proxy and
control service, takes a PostgreSQL custom-format dump and snapshots all eight
secret/data volumes. It encrypts the complete archive with AES-256-GCM and a
scrypt-derived key, removes its private plaintext staging directory, and
restarts the services that were running before the backup. PostgreSQL remains
running for the dump; it must not have other writers outside these services.

Long-lived upgraded connections can keep draining indefinitely. Cancel only
with an understanding that service state needs inspection; after a power loss
or forced termination, inspect and remove any owner-only `.crap-backup-*`
staging directory once recovery is complete. Free space must accommodate the
logical dump, volume snapshots, packed plaintext and encrypted output. Existing
backup files are never overwritten. The passphrase is required to recover;
there is no backdoor or reset.

For migration or an upgrade, add `--keep-stopped`. This deliberately leaves the
source stopped even if backup fails. Inspect the error and preserve existing
volumes before deciding whether to restart.

## Restore into a fresh project

```sh
node deploy/workspace-backup.mjs restore crap-recovered ./backups/workspace.crap /private/path/passphrase.txt
```

Restore authenticates the entire encrypted payload and validates every file
checksum before creating target volumes. It refuses an existing target project
or any volume with that project's prefix. It restores matching roles/secrets,
both database schemas, the proxy's spool, control maintenance state and the
panel's Tailscale identity. It leaves the target stopped. A partial restore is
retained for inspection and must not be started blindly.

**Stop the original owner before activating the restored workspace.** Duplicate
OAuth refresh owners, Telegram workers and Tailscale node identities are not a
supported migration mode. Choose unused host ports if needed, then:

```sh
docker compose -p crap-recovered -f deploy/compose.yaml up -d --wait --wait-timeout 180
docker compose -p crap-recovered -f deploy/compose.yaml exec -T panel node deploy/health.mjs
```

Inspect account registrations, integration status, journal/queue warnings and
the ledger before directing clients to the new endpoint. The same credentials
are restored, but provider-side revocation or expiration can still require
reauthentication. Verify privately; do not print credential rows into logs.

## Upgrade and rollback

1. Run the compatibility CI and mock-only release rehearsals for the exact new
   source/plugin pair. Record both old and new commit/image identities.
2. Take a full backup with `--keep-stopped`; preserve the old images and checkout.
3. Build the new images and run Compose `up` with the existing project. Its
   migration job must finish successfully before control/proxy startup.
4. Check readiness and perform an explicitly chosen client smoke test. Watch for
   rejected queue events and unresolved journal entries.
5. To roll back after a schema change, stop the new owner and restore the
   pre-upgrade backup into a fresh project using the old checkout/images. Do not
   point old code at a database containing unknown newer migrations. Those are
   deliberately rejected by the migration runner.

Data written after the backup is not in the rollback snapshot. Preserve a
post-failure backup for reconciliation. There is no automatic destructive
rollback. Argo CD rolling updates, concurrent replicas and automatic upgrades
remain unsupported until refresh ownership and rollout tests are implemented.

## Accounting recovery limits

Delivery is idempotent; conflicting usage and terminal records are quarantined
instead of silently overwritten. Recovered valid temporary spool files replay
after restart. A completed journal record cannot be reopened by late admission.
Operational retention defaults to a dry run; financial/token history stays.

Upstream lifecycle and usage hooks have different execution identifiers but share
the full inbound trace UUID. New records are correlated through an opaque keyed
reference to that UUID; retries remain separate usage events under one trace.
Legacy short/absent trace IDs remain unlinked. The ledger reports exact observed
matches and successful completions without usage after a 30-second delivery grace
period. It does not infer missing token counts. An unresolved lifecycle entry can
represent ongoing work or a lost callback. A host crash before callback delivery
can still lose observations, even when another usage record matches the trace.
