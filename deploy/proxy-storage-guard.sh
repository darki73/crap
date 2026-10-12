#!/bin/sh
# Sourced after the generated service environment. Never print credential values.
crap_storage_error() {
  echo "CRAP: release proxy requires PostgreSQL storage and the standard server command. $1" >&2
  exit 78
}
case "${PGSTORE_DSN:-}" in
  *[![:space:]]*) ;;
  *) crap_storage_error 'PGSTORE_DSN is missing.' ;;
esac
# Upstream loads .env from its working directory after this entrypoint.
if [ -e .env ] || [ -L .env ]; then
  crap_storage_error 'Remove the working-directory .env; use the generated service environment.'
fi
# Only the canonical PG selector is accepted; aliases and alternate stores fail closed.
if env | cut -d= -f1 | grep -Ev '^PGSTORE_DSN$' | LC_ALL=C grep -Eiq '^(gitstore_|objectstore_|home_jwt$|pgstore_dsn$)' ; then
  crap_storage_error 'An unsupported storage or control-plane environment selector is set.'
fi
# The supported image runs the server, not the upstream login/TUI/Home CLI.
for crap_arg do
  case "$crap_arg" in
    CLIProxyAPI|/usr/local/bin/CLIProxyAPI|/CLIProxyAPI/CLIProxyAPI|--local-model) ;;
    *) crap_storage_error 'Unsupported server argument.' ;;
  esac
done
