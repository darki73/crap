# CRAP release deployment

For the user-facing setup, accounts, routing and integration guides, see
[CRAP documentation](../doc/README.md).

This is the single-instance alpha deployment candidate. It runs independently of the original `.local-panel` development setup. It is not yet a production/HA release; the remaining gates are in [release status](../doc/release-status.md).

## Install from a checkout

Install Docker with Compose v2, then run from the repository root:

```sh
docker compose -f deploy/compose.yaml up -d --build --wait --wait-timeout 180
```

No host Go, Node, PostgreSQL, or existing configuration is needed. Docker builds the unchanged CLIProxy source, the affinity plugin, the control service, and the dashboard from this checkout. The build context explicitly excludes local runtime data. Base images are pinned by digest; application dependencies use their lockfiles.

Open **http://localhost:13000**. The client API is **http://localhost:18317/v1** (Claude uses the origin without `/v1`). Set `CRAP_PANEL_PORT` and `CRAP_API_PORT` before Compose to change the host ports. These defaults avoid the existing development services on 5173/3001/8317. The Compose project defaults to `crap`; use a consistent `-p` value if running another workspace.

Bootstrap generates independent management, control, identity/encryption, client and database credentials. It saves them in private Docker volumes and refuses to replace inconsistent or missing bootstrap state. PostgreSQL starts with separate `crap_app` and `cliproxy_app` roles and separate schemas. The panel receives neither database password. Runtime services run as UID 1000; only bootstrap and the standard PostgreSQL initializer need root. The application roles currently own their schemas and have database CREATE permission, required by their existing schema initialization. Splitting migration privileges from runtime privileges is still pending.

Both services use PostgreSQL from their first start. The affinity migration job completes before the control service and proxy start. The plugin is included in the proxy image, with its delivery spool on a persistent volume. Strict routing is enabled immediately: only Claude Messages and token counting with subscription OAuth accounts are admitted. Conversations keep their account until it becomes unusable; CRAP does not replay failed requests. Connect your accounts in the UI before sending requests. No model request is sent during installation.

OAuth callbacks that cannot reach the container can be pasted into the dashboard's callback flow. Tailscale and Telegram start disconnected and can be configured in Setup & Integrations. The development database migration UI remains scoped to the original local installation. The [external database provisioning and import flow](EXTERNAL-DATABASE.md) remains a storage rehearsal: its strict network boundary has not been implemented. Use bundled PostgreSQL for this alpha. Do not deploy the earlier external composition with live accounts.

## Access boundary

Only the panel and checked client API gateway are published, both on host loopback. The raw proxy, PostgreSQL and control API have no published ports. Packaged Tailscale inference also goes through the checked gateway. The dashboard has no standalone user login. Treat local machine users and members of the deployment Docker network as trusted administrators. Host/Origin checks protect against browser-origin attacks; they do not authenticate someone with direct network access.

For remote dashboard access use the existing Tailscale integration and its explicit identity allowlist. Do not change the panel binding to `0.0.0.0` or publish a generic ingress without an authenticated gateway and a way to prevent bypassing that gateway. This alpha is a single-owner workspace, not a multi-tenant service.

## Operations

```sh
# Check all components, including plugin registration and database connectivity
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml exec -T panel node deploy/health.mjs

# Stop while retaining configuration, accounts, history and keys
docker compose -f deploy/compose.yaml stop

# Start existing containers
docker compose -f deploy/compose.yaml start
```

The gateway checks enabled plugin registration and authenticated control readiness for every request, including current database access, maintenance state and a recent healthy delivery heartbeat. Missing dependencies return `503 crap_not_ready` before forwarding. Management routes are not exposed on this port. Docker health status alone is not admission enforcement.

Strict admission is enforced by the CRAP plugin and a request-scoped outbound
CONNECT grant. The proxy joins only an internal Docker network. A missing or
skipped plugin has neither a valid account execution grant nor a direct route to
the provider. Zero host retries and disabled host cooldown are mandatory. See
[the boundary and its limitations](STRICT-ROUTING.md).

Existing pre-strict deployments are not silently converted: bootstrap refuses
configuration that differs from the saved identity/configuration. Use their
matching checkout to back them up, then perform a reviewed configuration migration.
Never delete secret volumes to get past that refusal. Strict archives restore
through the same default composition; older archives are rejected by this
release's public restore command before creating target volumes.

Container logs are rotated to three 10 MB files per service. Plugin admission stops at 10,000 queue files or 64 MiB, on unreadable storage, or when rejected events need inspection. Already-admitted completion records are still written, so these are admission thresholds, not hard disk-size guarantees. Interrupted writes are recovered or quarantined at startup. Inspect rejected records privately; never delete them just to clear readiness.

Operational retention is an explicit operator command. It previews records older than 30 days and applies at most 10,000 deletions per table per run. Usage, pricing, credentials and request journals are never deleted by this command:

```sh
docker compose -f deploy/compose.yaml exec -T control crap-entrypoint affinity-db prune
# After reviewing the counts and taking a backup:
docker compose -f deploy/compose.yaml exec -T control crap-entrypoint affinity-db prune --apply
```

Before upgrading, stop incoming traffic and let active requests finish, then stop panel, proxy and control. Back up the database and deployment secrets. Rebuild and use `up` to run migrations before the new services. The configured stop grace periods are upper bounds before Docker kills a process, not proof that every streaming request drains safely. Never run two credential-owning proxies against this workspace. Do not blindly auto-update an upstream tag; validate the full source/plugin pair in CI first.

Keep the PostgreSQL `database` volume together with **all secret volumes**, especially `bootstrap-state`, and preserve `proxy-data` (pending usage spool) and `panel-data` (Tailscale node state). The database alone cannot recover encrypted integration settings without the identity key. Do not regenerate missing keys, run `down --volumes`, or activate a restored copy while the source still owns live OAuth credentials. See [OPERATIONS.md](OPERATIONS.md) for the encrypted full-workspace backup, restore and rollback workflow.

## Disposable release rehearsal

```sh
node deploy/strict-integration/run.mjs
```

The host needs Node 24 and Docker. This builds the standard release composition
with a synthetic HTTPS provider on isolated test networks. It verifies account
selection, response quota, accounting, streaming, denied bypass and plugin failure,
then backs up and restores that fixture into a second strict workspace and resumes
a conversation. Both fixtures use generated credentials and are removed afterward.
No real provider request or integration notification is sent.

`compose.legacy-test.yaml` exists solely for historical storage regression tests;
it is not a supported live deployment. `compose.strict.yaml` is a compatibility
overlay and is no longer needed by the standard command. Native macOS/Windows
client installer checks run in CI; GitHub results are still pending.

## Container security constraints

The release application images run without Linux capabilities and with
no-new-privileges enabled. Bootstrap and PostgreSQL retain the permissions
needed to initialize their own volumes; they are not claimed to be rootless.
No service receives the Docker socket or a host filesystem mount.

The CRAP image entrypoint requires the generated PostgreSQL configuration before
starting CLIProxyAPI. It rejects Git/object storage selectors, Home control-plane
selectors, lowercase PGSTORE_DSN aliases, working-directory .env files (including
symlinks), and alternate upstream CLI modes. Use the dashboard account connection
flow; do not repurpose this image as an upstream OAuth/TUI command-line utility.
This restriction is in CRAP's wrapper; the upstream server source is unchanged.
An operator who replaces the entrypoint or topology is outside this release's
validated boundary.

Application runtimes use Debian 13; bundled PostgreSQL remains on the pinned
Debian 12 image. Do not swap the database OS image against an existing data volume
without planning for locale/collation compatibility and a tested restore.

Run these checks after rebuilding the release images:

```sh
node --test deploy/security-runtime.test.mjs deploy/vulnerability-policy.test.mjs
node deploy/scan-vulnerabilities.mjs
```

See [the security guide](../doc/security.md) for release scan requirements.
Successful functionality tests are not vulnerability clearance.
