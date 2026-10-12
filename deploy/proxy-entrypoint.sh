#!/bin/sh
# Adapter for a separately supplied official CLIProxyAPI image; never modifies its binary.
set -eu
set -a
. /run/crap/service.env
set +a
. /run/crap/proxy-storage-guard.sh
# Kubernetes supplies a read-only template, and its first copy may persist as 0400.
# Replace it atomically in the writable data directory instead of overwriting it.
crap_template=$(mktemp /data/.config.example.XXXXXX)
trap 'rm -f "$crap_template"' 0
trap 'exit 1' 1 2 15
cat /run/crap/config.example.yaml > "$crap_template"
chmod 400 "$crap_template"
mv -f "$crap_template" /data/config.example.yaml
trap - 0 1 2 15
exec "$@"
