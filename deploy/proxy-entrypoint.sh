#!/bin/sh
# Adapter for a separately supplied official CLIProxyAPI image; never modifies its binary.
set -eu
set -a
. /run/crap/service.env
set +a
. /run/crap/proxy-storage-guard.sh
cp /run/crap/config.example.yaml /data/config.example.yaml
exec "$@"
