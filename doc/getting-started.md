# Getting started

[Documentation index](README.md)

## Before installing

This is a pre-release evaluation stack. Use a published, validated alpha revision.
Use one trusted owner and personally owned Claude subscriptions. Read the
[personal-use guide](../CRAP.md) and [security boundary](security.md).

Install Docker with Compose v2 and obtain a reviewed source checkout. Builds
need internet access. Windows/macOS use Linux containers; the release image
validation currently covers Linux amd64. Other architectures are not certified.
A fresh install needs no existing account, host database, Go or Node runtime.

CLIProxyAPI is installed from its official image, independently of CRAP. For an
existing installation or independent upgrades, see [Connect CLIProxyAPI](connecting-cliproxy.md).

## Install published images

The [v0.1.0-alpha.1 prerelease](https://github.com/darki73/crap/releases/tag/v0.1.0-alpha.1)
provides Linux amd64 images, a digest-pinned Compose override and checksums. Use
the source at that same tag; do not combine an old override with arbitrary source.
With Git and the GitHub CLI installed:

```sh
git clone --branch v0.1.0-alpha.1 --depth 1 https://github.com/darki73/crap.git
cd crap
gh release download v0.1.0-alpha.1 --repo darki73/crap --pattern compose.ghcr.json --pattern published-images.json --pattern GHCR-SHA256SUMS
sha256sum -c GHCR-SHA256SUMS
docker compose -f deploy/compose.yaml -f compose.ghcr.json up -d --no-build --wait --wait-timeout 180
```

You can also download the source and these files from the release page without
GitHub CLI. On macOS, use `shasum -a 256 -c GHCR-SHA256SUMS`. On Windows, compare
`Get-FileHash -Algorithm SHA256` for each deployment file with `GHCR-SHA256SUMS`.
The images are public; GHCR login is unnecessary. Keep the override beside the
matching source and use both `-f` arguments for later Compose operations.

## Build the guided stack from source

Alternatively, run from a reviewed repository checkout:

```sh
docker compose -f deploy/compose.yaml up -d --build --wait --wait-timeout 180
docker compose -f deploy/compose.yaml ps
```

Open [http://localhost:13000](http://localhost:13000). The checked client API is
on `http://localhost:18317`. These differ from development ports 5173/8317.

Bootstrap creates persistent, independent client, management, control, database
and identity secrets. It configures both services to use PostgreSQL and runs
migrations before startup. No model traffic or sample accounts are created.
It refuses inconsistent bootstrap state instead of regenerating missing secrets.

The default project name is `crap`. If you use `-p` to change it, use that same
project name for every operation. To choose different host ports, set
`CRAP_PANEL_PORT` and `CRAP_API_PORT` before running Compose. Keep loopback binding.

## Connect and use

1. Read the startup guide. Its acknowledgement is educational, not authentication.
2. In **Accounts & Providers**, choose the subscription account flow and complete
   Claude OAuth. A refused local callback can be pasted into the waiting flow.
   Treat that URL as a secret, not material for a public issue.
3. Check the account under **Quota & Limits**. Unknown data is not zero quota;
   check observation time and collection status before drawing conclusions.
4. In **Routing & Affinity**, review the reserve. All applicable limits constrain
   every request. See [the routing rules](routing.md).
5. In **Client API Keys**, set up the `crap` command on your computer. Local URLs
   work only on the server computer; configure Tailscale for another machine.
6. Run `crap doctor`, then choose proxy mode and launch `claude`. Doctor checks
   connectivity without inference. Your own test message can consume allowance.
7. Inspect **Token Ledger** for usage and **Routing & Affinity** for selection.

## Check, stop and restart

```sh
docker compose -f deploy/compose.yaml exec -T panel node deploy/health.mjs
docker compose -f deploy/compose.yaml stop
docker compose -f deploy/compose.yaml start
```

Health checks include required plugin/control readiness. Stopping preserves
volumes. Do not delete volumes to recover from a failed start. See
[troubleshooting](troubleshooting.md) and take a [full backup](storage.md) before
migration or upgrades. Ordinary stop commands have finite grace periods; use the
backup/upgrade runbook when active streams must drain.

Remote access uses [Tailscale](integrations.md), not a publicly exposed dashboard.
The alpha has no standalone dashboard login or multi-user roles.
