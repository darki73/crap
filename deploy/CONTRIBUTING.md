# Contributing to CRAP

Read [release status](../doc/release-status.md) and [architecture](../doc/architecture.md)
before expanding scope. CLIProxyAPI is installed independently;
use its supported plugin contracts.

Use synthetic accounts and mock providers for tests. Never commit `.local-panel`,
database dumps, backup passphrases, OAuth credentials, real client keys or private
screenshots. Preserve masked account labels and keep prompts out of accounting.

Run `npm ci`, `npm test`, `npm run test:ui` and `npm run build` in `control-panel`.
Run `go test ./...` and `gofmt` in `affinity-router`. Set
`AFFINITY_TEST_DATABASE_URL` to a dedicated database named `affinity_test` for
PostgreSQL integration tests. Never use a real workspace database for tests.
Do not vendor or compile the upstream engine. Routing/storage changes
require `node deploy/strict-integration/run.mjs`, which covers the standard strict
stack and full-workspace recovery. Historical storage regressions use the
explicit `compose.legacy-test.yaml` fixture; never connect live accounts to it.
Packaging changes require `node deploy/check-build-context.mjs` and
`node deploy/scan-secrets.mjs`. Review every new secret-scanner finding privately;
never regenerate the baseline automatically or exclude whole source directories.
Test UI changes in a browser at desktop and phone width.

Describe observable before/after behavior, validation and limitations in changes.
Do not turn unknown tokens into zero, infer missing cache durations, relabel
estimates as bills or mark callback loss as successful accounting. Do not claim
multi-replica safety based only on shared PostgreSQL storage.
