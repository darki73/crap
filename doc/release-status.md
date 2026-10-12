# Release status

[Documentation index](README.md)

CRAP is pre-release software for one owner and one active proxy. Published source
and passing functional checks do not by themselves establish a supported release.
The [v0.1.0-alpha.3 prerelease](https://github.com/darki73/crap/releases/tag/v0.1.0-alpha.3)
moves the upstream version check into the panel, so it works with strict proxy
egress restrictions. The check reads only public GitHub release metadata, caches
successful responses for five minutes, and never forwards workspace credentials.
It requires no database migration and leaves inference routing unchanged. The [release workflow](https://github.com/darki73/crap/actions/workflows/crap-publish.yml)
publishes images and a release only after all checks, scans and packaging pass.
Exact image digests and retained scan evidence are attached to each release;
external proxy/database findings remain informational.

## Supported scope

- Claude Code with personally owned Claude subscription accounts.
- Mandatory CRAP gateway, control service and native plugin.
- Loopback access or private Tailscale access with an identity allowlist.
- Conversation-family affinity, quota reserves and durable token accounting.
- Client enrollment, integrations and encrypted workspace backup/restore.

CLIProxyAPI is installed separately from its official distribution. See
[connection and independent updates](connecting-cliproxy.md).

## Release validation

A release requires the full checks workflow, a successful candidate build and
its dependency scans, reviewed artifacts, and installation/recovery validation.
The [candidate workflow](../deploy/CANDIDATES.md) enforces the packaging gates;
the [publisher](publishing.md) runs automatically when a reviewed version tag is pushed.

A failed or missing check is not a pass. Current scan results are attached to the
relevant candidate run. No published image is implied by a local image tag.

## Limitations

[Kubernetes recipes](../k8s/README.md) cover Helm, Argo CD and plain manifests with
an existing PostgreSQL/CNPG database. Validate network enforcement and recovery
in the target cluster before relying on them. Active-active replicas, rolling HA,
public multi-user access and additional client/provider adapters are unsupported.

Same-version restore does not prove a cross-version upgrade. Affinity cannot
guarantee cache reuse, uninterrupted generation or account safety. The ledger
cannot reconstruct upstream usage observations that were never delivered.
