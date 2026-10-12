# Isolated routing-boundary fixture

Run from the repository root:

```sh
node deploy/strict-proof/run.mjs
```

This disposable fixture uses an official CLIProxyAPI image, a test plugin, a
synthetic HTTPS provider and a CRAP-owned outbound gate. It checks exact-account
execution, plugin bypass rejection, streaming, cancellation and process failure.
It uses synthetic credentials and does not contact real model providers.

The fixture is a focused contract test, not an application deployment. Its test
policy and credentials must not be used with personal accounts. The runner removes
its fixture containers and volumes when finished.

For the integrated application test, run `node deploy/strict-integration/run.mjs`.
See [the integration contract](../UPSTREAM-CONTRACT.md) and
[the supported deployment](../README.md).
