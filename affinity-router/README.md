# CRAP routing and accounting

This independent Go module provides CRAP's gateway, control service and native
plugin. It uses CLIProxyAPI's supported plugin interface; it does not import,
modify or redistribute the upstream engine.

## Components

- `cmd/affinity-gateway`: client admission and request-scoped outbound access.
- `cmd/affinity-control`: routing policy, quota observations and durable accounting.
- `cmd/affinity-plugin`: native plugin connecting CRAP decisions to the proxy.
- `cmd/affinity-db`: database migrations and maintenance commands.
- `storage/migrations`: versioned PostgreSQL schema.

For installation, use the [packaged deployment](../deploy/README.md).
The supported topology requires the gateway, control service and plugin together.
Running the plugin alone does not provide the complete admission boundary.

## Build and test

Use the Go version in `go.mod`:

```sh
go test ./...
go build ./cmd/affinity-gateway ./cmd/affinity-control ./cmd/affinity-db
```

Database integration tests require `AFFINITY_TEST_DATABASE_URL` pointing to a
disposable database named `affinity_test`. Without it, database tests are skipped.
Build the native plugin on Linux through the release Dockerfile.

See [architecture](../doc/architecture.md), [routing policy](../doc/routing.md),
[token accounting](../doc/accounting.md) and [development](../doc/development.md).
