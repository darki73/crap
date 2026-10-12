# External PostgreSQL and restored workspaces

**Storage rehearsal only, not a supported live strict deployment.** The external
composition does not yet enforce the isolated execution boundary. Do not attach
live accounts or expose inference with it. Use bundled PostgreSQL through
`compose.yaml` for the alpha; CNPG networking and strict recovery remain pending.

The external deployment connects **both CRAP and CLIProxy** to PostgreSQL 17.
It uses certificate and hostname verification (`sslmode=verify-full`), three
separate database roles, and service-specific secret volumes. It does not run
its own PostgreSQL container. CNPG can provide the server and CA; running this
Compose deployment does not install Kubernetes resources or test CNPG failover.

The operator host needs Node 24, Docker Compose v2 and PostgreSQL 17 client tools
for provisioning/import. The database must be dedicated to this workspace.
Use a hostname reachable from the application containers and present in the
server certificate. A Kubernetes service DNS name is normally reachable only
inside the cluster; do not point a desktop deployment at it without connectivity.

## New workspace

Build the application images from the tested checkout:

```sh
docker compose -f deploy/compose.yaml build
```

Create `destination.json`, containing no password:

```json
{
  "host": "postgres-rw.database.svc.cluster.local",
  "port": 5432,
  "database": "crap",
  "caFile": "/private/path/postgres-ca.crt"
}
```

Prepare a **new** private directory outside the repository:

```sh
node deploy/external-database.mjs destination.json /private/path/crap-external
```

This creates random per-workspace roles/passwords, matching service credentials,
the trusted CA, an identity backup and `provision.sql`. It refuses an existing
directory and leaves incomplete output without `READY`. Nothing connects to a
database yet. Preserve the whole directory securely; it contains credentials.
Do not attach it to bug reports. Its generated `.gitignore` excludes its contents.

Create the empty database through your PostgreSQL/CNPG administration mechanism.
Review and apply `provision.sql` to that database using an administrator connection:

```sh
psql "service=crap-admin" --file=/private/path/crap-external/provision.sql
```

Configure that libpq service and its password file privately, with verified TLS.
Do not place administrator passwords in command arguments. The administrator
credential is never given to CRAP. Provisioning is transactional: an existing
workspace schema, wrong database or role collision aborts without replacing data.

Set `CRAP_EXTERNAL_FILES` to the prepared directory and start:

```sh
export CRAP_EXTERNAL_FILES=/private/path/crap-external
docker compose -p crap-external -f deploy/compose.external.yaml up -d --wait --wait-timeout 180
```

In PowerShell use `$env:CRAP_EXTERNAL_FILES = 'C:\private\crap-external'` instead
of `export`. Port defaults are 13000 (dashboard) and 18317 (checked API), both
loopback-only; set `CRAP_PANEL_PORT` / `CRAP_API_PORT` to avoid another workspace.
The one-shot initializer copies matching secrets into private service volumes
and refuses replacements. The migration role is mounted only into the migration
job. The panel receives no database password. Runtime startup verifies the exact
migration set without attempting DDL.

CRAP's runtime role cannot create objects or edit migration history. CLIProxy's
unchanged startup always executes `CREATE SCHEMA/TABLE IF NOT EXISTS`, so its
role needs database/schema CREATE even for existing objects. It has DML access
to proxy tables but does not own the pre-provisioned tables and cannot read the
CRAP schema. This exception is tested and is not equivalent to a DML-only role.

## Bring an existing workspace

1. Use Setup & Integrations → database migration to export a portable encrypted
   `.crapdb` backup. For actual cutover, keep the source paused. A rehearsal copy
   must not serve live traffic or refresh real OAuth credentials.
2. Use `control-panel/scripts/restore-database.mjs` with that backup, its
   passphrase, verified TLS destination and a fresh output directory. It accepts
   JSON on standard input, never credentials in command arguments. Use `--native`
   inside a Kubernetes Job with PostgreSQL 17 tools. It refuses existing schemas,
   verifies table counts and writes `handoff.json` plus `deployment.env` privately.
3. Add `"importDirectory": "/private/path/restored-handoff"` to `destination.json`,
   then run the preparation command above with another fresh output directory.
4. Review and apply its `provision.sql` to the **restored** database. This import
   variant checks the handoff's table counts, creates fresh restricted roles and
   transfers ownership of only the two workspace schemas and their objects.
   It does not drop or restore tables again.
5. Stop the original owner, then start the external deployment. Its migration
   job adapts version-8 proxy bind addresses and plugin paths once, preserving
   client/provider keys and the management secret. The original encryption key
   is retained, so encrypted settings and private account references still work.
6. Inspect accounts, ledger and quota status. Telegram and Tailscale are paused
   once on import; reconnect/re-enable them in Setup after reviewing destination
   addresses. Telegram credentials and queued notifications are preserved. A
   logical backup does not carry the old Tailscale node's local identity files.

The importer rejects unsupported configuration/key formats instead of guessing.
Provider-side revocation/expiration can still require authentication, but moving
the database itself does not deliberately discard account credentials.

## Recovery and rollback

Back up the external database through PostgreSQL/CNPG and preserve the complete
private preparation directory **plus** `proxy-data`, `control-data` and `panel-data`
volumes. Database-only recovery misses queued usage and local Tailscale identity.
The bundled `workspace-backup.mjs` operates on the bundled database Compose stack;
do not use it against `compose.external.yaml`. External volume snapshots must be
taken with the single owner stopped. Keep CA and credential rotations coordinated
with replacement secret volumes; this initializer deliberately refuses drift.

For rollback, restore the pre-upgrade database and matching secrets/state using
the previous checkout/images. Older runtimes refuse a newer/modified migration
set. Never start two restored owners against the same credentials. Automated
Kubernetes rolling updates and active-active operation remain unsupported.

The disposable `external-rehearsal.mjs` exercises TLS (including a wrong-hostname
failure), runtime privileges, a fresh deployment, mock inference/accounting and
restored handoff activation. It neither connects to your CNPG cluster nor uses
real account credentials.
