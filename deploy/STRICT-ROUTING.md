# Strict Claude routing

CRAP owns admission, permanent conversation-family selection and outbound grants.
CLIProxyAPI is installed independently from its official distribution. Its supported native executor owns
OAuth refresh, provider headers, payload translation and actual HTTP execution.

## Request path

Claude Code → CRAP gateway → private CLIProxyAPI plugin → exact-account native
executor → CRAP CONNECT gate → Anthropic.

The gateway retains the original payload in memory and sends a private model to
the proxy. The registered plugin must claim an opaque, single-use grant before
it can invoke the native executor with the selected OAuth account. The private
proxy network has no direct route to the provider. The CONNECT gate admits the
inference origin only for a live grant and closes its tunnels when that request
ends. Missing/skipped/disabled plugins cannot silently fall back to native routing.

TLS is not decrypted. This is a boundary around the trusted, pinned proxy and
CRAP plugin, not a sandbox for hostile native plugins or a hostile administrator.
Zero global retries and disabled host cooldown are mandatory; accounts with
positive retry overrides are excluded. Upgrade compatibility must rerun the
synthetic production integration suite. Claude Code may independently retry an
error; CRAP does not replay the request itself.

Only Claude Messages and token counting are admitted. Other inference protocols
return an explicit unsupported-protocol error. Subscription OAuth accounts only;
API-key accounts do not participate. Quota/profile reads use separate short-lived
grants; OAuth refresh uses the provider's separate token origin. No prompt/body
is stored in PostgreSQL or the delivery spool.

## Policy and accounting

The supported rules are described in [Routing and quota](../doc/routing.md).
Migration 007 adds permanent family/session bindings, a current filling account,
and credential/model rejection observations. Existing ledger, credentials and
legacy routing tables remain intact. On the first resumed request, exact explicit
session variants can recover the previous live assignment from decision history.
There is no prompt-similarity matching.

Every real request gets one admission record; the native usage hook supplies one
upstream usage event. Shared trace identity links them. Response IDs link cache
writes to their reported five-minute or one-hour duration. Missing callbacks or
missing duration remain unknown, not invented. Streams require an actual Claude
`message_stop` event before being marked successful.

Disabling a plugin does not invoke quiescence in every upstream path. CRAP also
checks the local plugin status once per second while a request is active and
revokes its grant if readiness is lost. This is local management polling, not
provider quota polling. New admission is checked on every request. Normal
gateway shutdown drains active requests; it does not move/replay them.

## Run and test

Fresh isolated Compose deployment with bundled PostgreSQL:

```sh
docker compose -f deploy/compose.yaml up -d --build
node deploy/strict-integration/run.mjs
```

The test runner uses its own project, database, generated CA, synthetic OAuth
credentials and HTTPS provider. It verifies sticky streaming, accounting/cache
durations, no overload replay, response-driven exhaustion, whole-family moves,
token counting, bypass denial, plugin disable/re-enable and active cancellation.
It removes its disposable volumes on exit. No real provider requests are made.

`compose.yaml` is the supported strict deployment. `compose.strict.yaml` remains
a redundant compatibility overlay for existing scripts. `compose.legacy-test.yaml`
and `compose.external.yaml` are regression/storage fixtures, not strict release
configurations. CNPG/external PostgreSQL needs a restricted database network path
and the same end-to-end rehearsal before deployment. Do not attach the proxy to
an internet-enabled network to work around database connectivity.

The full-workspace backup records strict deployment mode, validates the source's
private proxy network before stopping services, and restores into a fresh strict
project. Older non-strict archives require a separate explicit migration; this
release will not silently activate them. See [operations](OPERATIONS.md).
