#!/bin/sh
set -eu
# Copy host-provided secret files into service-specific volumes, owned by the
# normal runtime UID. This one-shot initializer never contacts PostgreSQL.
test -f /input/READY
for service in control migrate proxy panel; do
  mkdir -p "/output/$service"
  for source in "/input/$service/"*; do
    target="/output/$service/$(basename "$source")"
    if [ -e "$target" ]; then
      cmp -s "$source" "$target" || { echo 'Existing external secrets differ; refusing replacement.' >&2; exit 1; }
    else
      cp "$source" "$target"
    fi
    chmod 600 "$target"
    chown 1000:1000 "$target"
  done
  chmod 700 "/output/$service"
  chown 1000:1000 "/output/$service"
done

node --input-type=module -e 'import {installProxyAdapter} from "/app/deploy/bootstrap.mjs"; await installProxyAdapter("/output/proxy");'

chown 1000:1000 /output/proxy-data
chmod 700 /output/proxy-data
