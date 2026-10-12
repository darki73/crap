# Accounts and providers

[Documentation index](README.md)

**Accounts & Providers** separates subscription sign-ins from API credential
configuration. Strict CRAP routing currently uses Claude subscription OAuth
accounts only; it never falls back to paid API credentials. The broader management
UI reflects engine capabilities, not a promise of strict support for every provider.

## Add a subscription account

Start the Claude sign-in flow, complete the provider's authorization page, then
return to CRAP. The UI waits for credential persistence. If the browser ends at a
refused localhost callback, copy the complete callback URL into the pending CRAP
flow. Its code and state are sensitive. If the flow expired, start a new one rather
than repeatedly submitting an old callback.

Open account details to inspect available plan information, models and actions.
Use a recognizable account label; masked email is the fallback identity. Labels
are CRAP metadata and do not rename the upstream provider account. Masking is a
presentation feature, not encryption or removal of the underlying email.

Disabling an account makes it ineligible for subsequent selection. Deleting or
exporting credentials is an administrative action; exports contain secrets.
Do not share accounts or hand provider credentials to client computers.

## Plan and quota information

Plan/profile fields and usage windows come from observations available to CRAP.
They may be missing, delayed or stale after a subscription change. A model-specific
window appearing is not sufficient evidence of a particular paid tier. Check the
collection status and observation time; do not infer zero usage or unlimited access
from an unknown field. See [quota collection](routing.md).

The main quota view is **Quota & Limits**. Account details focus on identity,
plan and management actions; **Token Ledger** describes requests observed by CRAP.

## Where credentials live

In the packaged stack, CLIProxyAPI uses its supported PostgreSQL store for runtime
configuration and authentication material, and keeps a local working cache in its
data volume. CLIProxyAPI remains responsible for OAuth refresh. CRAP stores labels,
routing, accounting and encrypted integration settings in its own schema.

The database contains sensitive credential material; not every field is encrypted
by CRAP. Treat database access, local caches, exports and backups as privileged.
The dashboard does not make browser storage the authoritative credential store.

A supported full migration preserves credentials and matching keys, so moving does
not intentionally require fresh OAuth. Provider expiration, revocation or policy
can still require reauthentication. Never run both restored and original OAuth
owners at once. See [storage and recovery](storage.md).
