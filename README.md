# CRAP — Control Room for Agentic Proxy

A personal control room for your AI subscriptions: connect your own accounts,
keep conversations on the same account, see quota and token usage, and manage
access from one dashboard.

CRAP combines a React dashboard, a checked inference gateway, a native routing
plugin and PostgreSQL. It connects to an **independently installed official
CLIProxyAPI**. CRAP does not vendor, build or republish the upstream engine.
See [connecting CLIProxyAPI](doc/connecting-cliproxy.md) for guided installation
or an existing proxy.

> **[v0.1.0-alpha.3 is available](https://github.com/darki73/crap/releases/tag/v0.1.0-alpha.3).**
> This is a pre-release for evaluation. Release artifacts require passing CRAP checks and
> artifact vulnerability scans. External proxy/database findings are reported
> separately; they do not block CRAP publication. See the [security scope](doc/security.md).
> The supported deployment is one owner, one active proxy, Claude Code and
> personally owned Claude subscription accounts. [Kubernetes recipes](k8s/README.md)
> are available for cluster rehearsal; active-active replicas and public multi-user
> access are not supported yet.

Version tags automatically run release validation, publish the checked GHCR images
and attach digest-pinned deployment files to a GitHub release. Normal pushes run
checks only. See [publishing](doc/publishing.md).

[Documentation](doc/README.md) · [Getting started](doc/getting-started.md) ·
[Kubernetes deployment](k8s/README.md) · [Release status](doc/release-status.md) · [Security](doc/security.md)

## Personal use, provider rules and account risks

**CRAP is for your own personal use with accounts you personally own.** We do not
condone selling or renting accounts, OAuth sessions, proxy keys, subscription
quota or access to other people. Shared subscription pools, resale gateways and
paid access to your subscriptions are outside this project's intended use.

We would prefer providers to offer supported ways to switch between personally
owned accounts, preserve ongoing conversations and understand usage limits in
their own tools. CRAP reflects that unmet need; it is not an endorsement of
violating provider terms, bypassing restrictions or evading enforcement.

**Owning an account does not make every access method permitted.** Subscription
proxying or account rotation may breach provider terms even for personal use.
Where a provider prohibits an access method, CRAP does not grant an exception.
Technical support for an integration is not provider approval, and CRAP is not
affiliated with or endorsed by those providers.

**You use CRAP at your own risk.** Use may result in account bans, suspensions,
restrictions or loss of access. To the extent permitted by applicable law, CRAP
and its developers accept no responsibility for those consequences. We cannot
guarantee account safety or prevent or reverse provider enforcement decisions.

Read [the personal-use guide](CRAP.md) before connecting accounts. These statements
describe the project's intended use and position; they do not add restrictions
to the [MIT license](LICENSE) or grant permission from any provider.

## What you can do

- Connect subscription accounts through OAuth, label them and inspect account details.
  Emails are masked in the interface by default.
- Keep a conversation and its subagents on one eligible account. Routing considers
  five-hour, weekly and relevant model limits, with a configurable quota reserve.
- Inspect quota observations, reset times, routing decisions and failures.
- Track uncached input, output, cache reads and cache writes in a durable token
  ledger. A versioned price catalog estimates API-equivalent cost.
- Install a small PowerShell/Bash/Zsh shell integration. Use `crap` to switch how
  your existing `claude` command connects, keeping the same chat history.
- Reach the dashboard and API privately through Tailscale, with an identity allowlist.
- Pair a private Telegram chat for account alerts, quota notifications and a digest.
- Back up and restore the database, credentials, encryption keys and local state
  together using an encrypted workspace archive.

The dashboard exposes broader CLIProxyAPI configuration, but the checked CRAP
inference path currently accepts **Claude Messages and token counting only**.
Other providers and paid API keys do not participate in this strict subscription
router. Configuring a provider in the UI does not make its protocol supported.

## Quick start

Install Docker with Compose v2 using Linux containers on an amd64 machine. Use
[the alpha release](https://github.com/darki73/crap/releases/tag/v0.1.0-alpha.3)'s
matching source and download `compose.ghcr.json`, `published-images.json` and
`GHCR-SHA256SUMS`. Verify the deployment files against those checksums, then run
from the source directory:

```sh
docker compose -f deploy/compose.yaml -f compose.ghcr.json up -d --no-build --wait --wait-timeout 180
```

The override pins CRAP's three public GHCR images by digest. No host Node, Go or
PostgreSQL installation is needed. Compose pulls the official CLIProxyAPI and
PostgreSQL images separately; CRAP does not republish them. For source builds and
step-by-step download commands, see [getting started](doc/getting-started.md).

| Endpoint                             | Default address                                  |
| ------------------------------------ | ------------------------------------------------ |
| Dashboard                            | [http://localhost:13000](http://localhost:13000) |
| Claude API origin                    | `http://localhost:18317`                         |
| API base shown to compatible tooling | `http://localhost:18317/v1`                      |

Both published ports bind to loopback. The proxy, database and control service
stay private. Set `CRAP_PANEL_PORT` and `CRAP_API_PORT` before starting Compose if
those host ports are occupied. Keep the loopback boundary.

1. Open the dashboard and read the personal-use guide.
2. Open **Setup & Integrations**. The packaged stack already configures PostgreSQL
   for both CRAP and CLIProxyAPI; the local development database wizard is separate.
3. Connect your own Claude account under **Accounts & Providers**. If an OAuth
   callback cannot reach the container, submit its complete URL in the dashboard.
4. Review **Quota & Limits** and the reserve in **Routing & Affinity**.
5. Use **Client API Keys → Set Up the crap Command** to configure a computer.
6. Send a request when you are ready, then inspect **Token Ledger**.

Installation does not send a model request. Missing mandatory plugin/control
readiness causes an error rather than a fallback to unchecked proxy routing.
See [the full installation guide](doc/getting-started.md).

## Routing and accounting

```text
Claude Code → CRAP gateway → private CLIProxyAPI + CRAP plugin
            → selected account's native executor → CRAP outbound gate → provider
                                     ↕
                          CRAP control + PostgreSQL
```

A usable conversation binding wins over balancing. Otherwise CRAP keeps filling
one account, choosing the least remaining weekly allowance, then five-hour
allowance when a new choice is needed. Every applicable window must meet the
saved reserve, including for resumed conversations and subagents. A 5% reserve
admits exactly 5% and excludes 3%. It reduces risk; it cannot guarantee that a
long generation fits. CRAP does not automatically replay a failed request.

Quota percentages and token accounting answer different questions. Subscription
allowances are provider-reported windows; the ledger records observed requests.
Missing token counts or cache durations stay unknown. Price estimates are
**API equivalents, not subscription invoices or guarantees of provider charges**.
See [routing](doc/routing.md) and [accounting](doc/accounting.md).

## Data and recovery

Persistent Docker volumes hold the database, secrets, pending usage delivery and
integration state. A database dump alone is not a full workspace backup: encrypted
settings also need the matching identity key. Do not use `down --volumes` to fix a
startup problem or start two copies against the same OAuth credentials.

Use the [storage and migration guide](doc/storage.md) and the exact
[backup/restore runbook](deploy/OPERATIONS.md). External PostgreSQL/CNPG preparation
exists as a storage rehearsal; its strict deployment boundary is not ready for
live use. Shared PostgreSQL alone does not make replicas safe.

## Development and contributions

The dashboard uses React, TypeScript, Vite, Tailwind and shadcn/ui components.
The gateway, control service, native plugin and Tailscale helper use Go. PostgreSQL
stores durable workspace state. Start with [development](doc/development.md) and
[contribution guidance](deploy/CONTRIBUTING.md).

CRAP code lives in `control-panel/`, `affinity-router/` and `deploy/`. Keep upstream
core changes separate; this project uses the supported plugin interface. Use
synthetic accounts for tests and never commit credentials, dumps or local state.
The [release guide](doc/release-status.md) describes supported scope and validation gates.
Images are published to [GHCR under ghcr.io/darki73](doc/publishing.md). The
[release workflow](https://github.com/darki73/crap/actions/workflows/crap-publish.yml)
passed, and its release includes matching image digests, scan evidence and checksums.
Subsequent publication remains a separate manual workflow.

## License, attribution and security reports

The [MIT license](LICENSE), [upstream project](https://github.com/router-for-me/CLIProxyAPI) and
[attribution notice](deploy/NOTICE.md) are preserved. CRAP is not endorsed by
CLIProxyAPI maintainers, Anthropic, OpenAI, Tailscale or Telegram.

Report vulnerabilities through [GitHub private reporting](https://github.com/darki73/crap/security/advisories/new).
Read the [security policy](SECURITY.md) before submitting sensitive information.
