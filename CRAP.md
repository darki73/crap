# CRAP — Control Room for Agentic Proxy

A self-hosted workspace for accounts, quota-aware affinity routing and durable
token accounting, built around the CLIProxyAPI engine.

CRAP adds a React dashboard, OAuth/account management, provider configuration,
masked account identities, quota windows, routing decisions, a token ledger and
versioned pricing. PostgreSQL stores control state and accounting. Tailscale
provides private access; Telegram delivers opt-in notifications. Small shell
scripts connect supported coding clients without relocating their chat history.

This is a **pre-release, single-owner deployment candidate**. Supported scope is
one active proxy, one workspace owner, and primarily Claude accounting/routing.
Subscription quota, observed token counts and API-equivalent estimates are
separate concepts. An estimate is not a subscription invoice.

CRAP is intended for **personal use with accounts personally owned and used by
the person running the workspace**. Its purpose is to reduce manual switching
between your own accounts and make their usage visible. The project does not
condone selling or renting accounts, subscription access, proxy keys or quota;
sharing subscription access with others; or operating a resale service or
shared subscription pool. **Personal use can still breach provider terms:**
subscription proxying and account rotation may violate a provider's terms or
authentication rules even when you own and pay for every account. Working
authentication does not establish permission, and providers may restrict or
suspend access. CRAP cannot guarantee continued account access. The project's
personal-use position does not create an exception to provider rules, change
the software license or imply provider endorsement.

You use CRAP's subscription integrations at your own risk. To the extent permitted
by applicable law, **CRAP and its developers accept no responsibility for account
bans, suspensions, restrictions or loss of access** imposed by a provider as a
result of using CRAP. Account enforcement is the provider's decision; CRAP and its
developers cannot guarantee prevention or reversal of those decisions.

The dashboard opens a four-part Personal Use Guide before first use in a browser.
It covers these boundaries, the setup and routing workflow, usage interpretation
and private access. Both ownership and personal-use acknowledgements are required
before the dashboard loads account data. A versioned acknowledgement is stored
locally in that browser; clearing storage or changing the guide version shows it
again. If storage is unavailable, acknowledgement lasts for the current visit.
Reopen it using **Personal Use Guide** in the dashboard footer. This is an
educational UI gate, not authentication, identity verification or API enforcement.

- [Install a local Compose workspace](deploy/README.md)
- [Back up, migrate and recover](deploy/OPERATIONS.md)
- [External PostgreSQL / CNPG storage rehearsal (strict networking pending)](deploy/EXTERNAL-DATABASE.md)
- [Release status and remaining gates](doc/release-status.md)
- [Routing architecture](doc/architecture.md)
- [Dashboard development](control-panel/README.md)
- [Contributor guidance](deploy/CONTRIBUTING.md)
- [Security scope](deploy/SECURITY.md)

CLIProxyAPI remains the upstream engine. CRAP components live in `control-panel`,
`affinity-router` and `deploy`; this project does not claim authorship of the
upstream engine. Preserve the repository's MIT license and upstream attribution.
The project repository is [darki73/crap](https://github.com/darki73/crap), with all
CRAP components maintained together. The private reporting channel and published
artifact registry still need to be finalized before an external alpha release.
