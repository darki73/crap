# CRAP documentation

Start with [Connect CLIProxyAPI](connecting-cliproxy.md) · [Getting started](getting-started.md). These guides describe the CRAP
single-owner alpha, not every capability of the upstream engine. Public release
remains blocked by the [release validation requirements](release-status.md).

## Use your workspace

| Guide                                         | Covers                                                               |
| --------------------------------------------- | -------------------------------------------------------------------- |
| [Getting started](getting-started.md)         | Docker installation, first account, first client, health checks      |
| [Accounts and providers](accounts.md)         | OAuth, callback recovery, account identity, credential storage       |
| [Client setup](clients.md)                    | PowerShell/Bash/Zsh, direct/proxy switching, shared chat history     |
| [Routing and quota](routing.md)               | Affinity, reserve, selection, stale observations and failures        |
| [Token accounting and pricing](accounting.md) | Token categories, cache duration, estimates and missing observations |
| [Tailscale and Telegram](integrations.md)     | Private access, pairing, alerts and working links                    |
| [Configuration](configuration.md)             | Page map, ownership and strict-mode constraints                      |

## Operate and develop

| Guide                                 | Covers                                                              |
| ------------------------------------- | ------------------------------------------------------------------- |
| [Kubernetes deployment](../k8s/README.md) | Helm, Argo CD, plain manifests and existing CNPG |
| [Storage and migration](storage.md)   | Database ownership, recovery, direct/portable transfer, CNPG limits |
| [Architecture](architecture.md)       | Request path, service boundaries, credentials and durable delivery  |
| [Publication privacy](publication-privacy.md) | Publication review, private-file exclusions and automated checks |
| [Security](security.md)               | Trust boundary, release clearance, private data and reporting       |
| [Troubleshooting](troubleshooting.md) | Readiness, quota, OAuth, client setup and accounting symptoms       |
| [Development](development.md)         | Source layout, local iteration, tests and documentation checks      |
| [Release status](release-status.md)   | Supported scope and work required before publication                |

For the selected registry and manual publisher, see [Publishing to GHCR](publishing.md).

The detailed deployment runbooks remain in [deploy/](../deploy/README.md), including
[operations](../deploy/OPERATIONS.md), [strict routing](../deploy/STRICT-ROUTING.md),
[the upstream contract](../deploy/UPSTREAM-CONTRACT.md) and
[candidate packaging](../deploy/CANDIDATES.md). They contain implementation and
recovery details that should not be replaced by improvised commands.
