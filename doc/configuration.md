# Configuration and dashboard map

[Documentation index](README.md)

## Where to change things

| Page                 | Use it for                                                   |
| -------------------- | ------------------------------------------------------------ |
| Overview             | Workspace health, current routing and connection information |
| Setup & Integrations | Setup sequence, storage flow, Tailscale and Telegram         |
| Accounts & Providers | Subscription OAuth and API provider configuration            |
| Models               | Registered models and catalog inspection                     |
| Client API Keys      | Client access, enrollment and connected-computer revocation  |
| Routing & Affinity   | CRAP selection, quota reserve, bindings and decisions        |
| Quota & Limits       | Provider allowance windows, plans and observation status     |
| Token Ledger         | Recorded usage, delivery coverage and price catalog          |
| Logs                 | Runtime/request diagnostics and log controls                 |
| Diagnostics          | Health and explicitly submitted diagnostic requests          |
| Proxy Configuration  | Typed upstream configuration tabs, fields and defaults       |
| Plugins              | Native plugin registration and management                    |

The startup personal-use guide can be reopened from the interface. Acknowledging
it is not a login and does not establish a security boundary.

## CRAP policy versus engine configuration

Use **Routing & Affinity** for CRAP's strict policy. The engine's round-robin,
fill-first and legacy selector controls do not replace the CRAP admission path.
Strict mode requires zero host retries, disabled host cooldown and the mandatory
CRAP plugin. Positive per-account retry overrides make accounts ineligible.
Changing required values can make readiness fail deliberately.

**Proxy Configuration** exposes upstream settings through typed controls, including
default values and nested collections. Advanced JSON/YAML editing remains available.
A setting being editable does not mean every topology or provider is supported by
this alpha. Review changes before saving, especially payload, logging, retry and
network options. Enabling detailed request logs can capture sensitive content.

## Persistence and deployment settings

The packaged CLIProxy configuration is persisted through the supported PostgreSQL
store. Do not edit only its local mirror and expect PostgreSQL state to change.
CRAP owns separate database records for routing/accounting and encrypted integration
settings. Deployment secrets and local identity/spool files remain in volumes.

Host ports use CRAP_PANEL_PORT and CRAP_API_PORT. Compose supplies internal service
addresses and generated credentials. Most operators do not need to edit secret
files. The panel receives neither database password in the packaged stack.

Bootstrap refuses incompatible saved configuration rather than silently overwriting
it. Do not remove secret volumes to force startup. For migration, upgrades and
rollback follow [storage](storage.md) and [operations](../deploy/OPERATIONS.md).

The release wrapper only admits the supported PostgreSQL startup mode. Alternate
Git/object storage, Home selectors, dotenv overrides and ad-hoc upstream CLI modes
are outside this composition. This guard belongs to CRAP, not a core proxy patch.
