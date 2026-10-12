# Storage, backup and migration

[Documentation index](README.md)

## Both services use PostgreSQL

| Data                                           | Owner / recovery requirement                          |
| ---------------------------------------------- | ----------------------------------------------------- |
| Account credentials and proxy configuration    | CLIProxyAPI PostgreSQL store plus local working cache |
| Bindings, quota, ledger, price history, labels | CRAP schema                                           |
| Encrypted integration/enrollment settings      | CRAP schema **and matching identity key**             |
| Pending usage delivery                         | Proxy data volume                                     |
| Tailscale node identity and local panel state  | Panel data volume                                     |
| Database/service/bootstrap credentials         | Matching secret volumes                               |

The packaged installation provisions separate roles and schemas on first start.
It does not require the local development “Configure Both Services” wizard.
That wizard imports the original file-backed local installation into its existing
PostgreSQL instance; it is not a generic production database replacement button.

Separate roles do not imply DML-only runtime privileges everywhere. The bundled
runtime roles own their schemas and have CREATE privileges required by existing
initialization. See [deployment details](../deploy/README.md).

## Full workspace backup: packaged deployment

Install Node 24 on the operator host in addition to Docker. Create a private file
with a passphrase of at least 16 characters, outside Git. Keep it separately from
the backup. Run from the matching source checkout:

```sh
node deploy/workspace-backup.mjs backup crap ./backups/workspace.crap /private/path/passphrase.txt
```

This drains the checked gateway, stops writers, dumps PostgreSQL, snapshots all
secret/data volumes and encrypts the archive. It normally restarts prior services.
Add `--keep-stopped` for cutover; that leaves the source stopped even on failure.
The passphrase is not recoverable by CRAP. Have enough disk space for staging and
both plaintext/encrypted archives; inspect private staging after an interrupted run.

## Restore and cut over

Restore into a fresh project; existing target volumes are refused:

```sh
node deploy/workspace-backup.mjs restore crap-recovered ./backups/workspace.crap /private/path/passphrase.txt
```

The command authenticates the archive, verifies checksums, restores matching state
and leaves the target stopped. **Stop the original owner before activation.**
Then use the matching checkout/images and unused host ports if necessary:

```sh
docker compose -p crap-recovered -f deploy/compose.yaml up -d --wait --wait-timeout 180
docker compose -p crap-recovered -f deploy/compose.yaml exec -T panel node deploy/health.mjs
```

Inspect accounts, ledger, delivery warnings and integrations before redirecting
clients. Migration preserves credentials but cannot prevent provider revocation or
expiration. Downloaded candidates require their matching image override for backup,
restore and startup. Follow [the exact runbook](../deploy/OPERATIONS.md).

## Direct database transfer and portable export

The database migration flow supports direct copying to a reachable destination
and encrypted portable `.crapdb` exports for restoration elsewhere. These are
**logical database transfers**, different from the full `.crap` workspace archive.
They include a reviewed handoff of matching encryption identity; they do not
snapshot every spool or Tailscale file. Pause the source for a real cutover and
keep backups. Destination schemas must be fresh; do not overwrite occupied state.

Portable restore is implemented by
[restore-database.mjs](../control-panel/scripts/restore-database.mjs), including a
native PostgreSQL-tool mode for a cluster Job. Supply credentials through its
structured input rather than command arguments. See the
[external database runbook](../deploy/EXTERNAL-DATABASE.md) for TLS, role provisioning,
import handoff and restart behavior.

## Kubernetes recipes and remaining cluster validation

External PostgreSQL provisioning/import is a tested **storage rehearsal**, not a
supported strict production topology. Its private database network boundary still
needs integration. Do not deploy compose.external.yaml with live accounts or
attach the proxy to an internet-enabled network to make the database reachable.

The [Kubernetes recipes](../k8s/README.md) now provide a separate strict topology with
CNPG selectors, verified TLS, retained PVCs and single-replica Recreate deployments.
They have passed offline checks, not a live-cluster rehearsal.

CNPG failover, zero-downtime upgrades and multiple active proxies remain future
work. Shared SQL state alone does not coordinate native OAuth refresh ownership.
A migration must have one owner; duplicate restored Telegram workers and Tailscale
identities are also unsafe. Do not auto-update arbitrary upstream tags.

For rollback after schema changes, restore the pre-upgrade backup with matching
old images into a fresh project. New writes since that backup require separate
reconciliation. Do not run old code against unknown newer migrations or delete
volumes as a repair strategy.
