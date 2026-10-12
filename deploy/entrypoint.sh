#!/bin/sh
set -eu
if [ -f /run/crap/service.env ]; then
  set -a
  . /run/crap/service.env
  set +a
fi
if [ "$1" = CLIProxyAPI ] || [ "$1" = /usr/local/bin/CLIProxyAPI ]; then
  . /usr/local/lib/crap/proxy-storage-guard.sh
  cp /run/crap/config.example.yaml /CLIProxyAPI/config.example.yaml
fi
if [ -f /run/crap-connection.env ]; then
  set -a
  . /run/crap-connection.env
  set +a
fi
exec "$@"
