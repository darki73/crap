# Development

[Documentation index](README.md)

Read the [contribution guide](../deploy/CONTRIBUTING.md).
CRAP changes belong in its own components; do not patch upstream core to work
around plugin limitations. Use synthetic accounts and keep local state out of Git.

## Source layout

| Directory                     | Purpose                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| control-panel/src             | React/TypeScript dashboard                                         |
| control-panel/*.mjs           | Node bridge, database/integration/enrollment services              |
| control-panel/client-shell    | Maintained PowerShell/Bash/Zsh client adapter                      |
| control-panel/tailnet-gateway | Go Tailscale helper                                                |
| affinity-router               | Independent Go control service, gateway and native plugin          |
| deploy                        | Packaged topology, bootstrap, recovery, fixtures and release gates |
| doc                           | User/operator guides                                               |

## Fast dashboard iteration

The local development tooling uses Vite on 5173 and a Node bridge
on 3001, with the strict gateway on 8317. Its private configuration is under
.local-panel. For an already initialized strict local workspace:

```sh
cd control-panel
npm ci
npm run proxy:start
npm run dev
```

This requires Node 24 and the Go version specified by the modules (the release
builder pins Go 1.27.2). The predev step builds the database helper. UI edits use
Vite hot reload and do not require rebuilding Docker images. Keep the dev process
running. A new contributor without that private local workspace should begin with
the [packaged stack](getting-started.md) and use the synthetic tests below; do not
copy another developer's .local-panel directory.

The [panel reference](../control-panel/README.md) describes the frontend and bridge.
Use the [strict deployment](../deploy/STRICT-ROUTING.md) as the supported topology.
Preserve saved database overrides when restarting an initialized workspace.

## Checks

In control-panel:

```sh
npm test
npm run test:ui
npm run build
```

In affinity-router:

```sh
gofmt -w .
go test ./...
```

PostgreSQL tests require AFFINITY_TEST_DATABASE_URL pointing to a **disposable**
database named affinity_test. A run without it is not a database integration pass.
Do not compile or vendor CLIProxyAPI here. Compatibility fixtures pull the pinned
official distribution. See [connecting CLIProxyAPI](connecting-cliproxy.md).
The native plugin is built on Linux using the release Dockerfile.

From the repository root, for routing/deployment changes:

```sh
node deploy/strict-integration/run.mjs
node --test deploy/security-runtime.test.mjs deploy/vulnerability-policy.test.mjs
node doc/check-links.mjs
node deploy/check-build-context.mjs
node deploy/scan-privacy.mjs
node deploy/scan-secrets.mjs
node deploy/scan-vulnerabilities.mjs
```

The strict integration runner builds a disposable mock-provider stack, tests
routing/streaming/bypass rejection, then verifies encrypted restore and a resumed
request. It uses generated credentials, sends no real provider traffic and removes
its fixture volumes. It rebuilds local candidate image tags; it is not a live
upgrade command. Run the final vulnerability scan after builds finish.

Use the exact shell tests and cross-platform jobs in
[CRAP checks](../.github/workflows/crap-checks.yml). Local success does not prove
GitHub CI or untested platforms pass. Documentation links are checked locally and
in that workflow. Keep guides consistent with supported scope, not roadmap intent.

Before the first commit or push, also follow [Publication privacy](publication-privacy.md),
including a separate review of Git author identity and staged files.
