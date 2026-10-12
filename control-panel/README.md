# CRAP dashboard

The dashboard combines a React/TypeScript frontend with a Node bridge for account
management, configuration, integrations and client enrollment. It connects to
CRAP's control service and an independently installed CLIProxyAPI.

For a fresh installation, follow [Getting started](../doc/getting-started.md).
Do not copy another user's local configuration or credentials.

## Development

Use Node 24 and the Go version required by the helper modules. For a configured
local workspace with private settings in `.local-panel/.env`:

```sh
npm ci
npm run proxy:start
npm run dev
```

Vite serves the frontend on port 5173 and the Node development bridge on 3001.
The predev command builds the database helper. See the
[development guide](../doc/development.md) for prerequisites and test fixtures.

## Checks

```sh
npm test
npm run test:ui
npm run build
```

The optional OAuth and integration tests require an explicitly configured
disposable workspace; they are not part of the isolated unit tests above.

## Guides

- [Accounts and credentials](../doc/accounts.md)
- [Configuration](../doc/configuration.md)
- [Tailscale and Telegram](../doc/integrations.md)
- [Storage and migration](../doc/storage.md)
- [Client shell integration](client-shell/guide.md)
- [Security boundaries](../doc/security.md)
