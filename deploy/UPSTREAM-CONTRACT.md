# Proxy integration contract

CRAP requires an independently installed official CLIProxyAPI release with the
plugin interface recorded in [the compatibility manifest](cliproxy-release.json).
CRAP does not patch or publish the engine.

## Admission requirements

Only supported Claude Messages and token-counting requests are admitted. The
native CRAP plugin must be enabled and connected to a ready control service.
Missing, disabled or failed plugins cause admission to fail explicitly.

The gateway selects an eligible subscription account and issues a short-lived,
single-use grant. The plugin must claim the grant before invoking the native
executor. The isolated proxy reaches provider inference only through the CRAP
outbound gate. TLS is not decrypted; trusted engine and plugin code are part of
this boundary. It is not a sandbox for hostile plugins or administrators.

Automatic engine retries and account fallback must be disabled. CRAP cannot
identify separate HTTP requests inside an encrypted CONNECT tunnel; changing
those settings invalidates per-request admission assumptions.

## Accounting and compatibility

Lifecycle and usage observations share a full trace identity. Missing upstream
callbacks remain unknown; durable CRAP ingestion cannot reconstruct events that
were never delivered. Prompt bodies are not stored by the accounting system.

Run `node deploy/strict-integration/run.mjs` before accepting a different proxy
release. The disposable fixture exercises streaming, account selection, quota,
plugin failure, network isolation and recovery with a synthetic provider.

See [strict routing](STRICT-ROUTING.md), [architecture](../doc/architecture.md)
and [independent proxy updates](../doc/connecting-cliproxy.md).
