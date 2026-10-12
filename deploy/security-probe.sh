#!/bin/sh
set -eu
# Inventory-only checks in a read-only, networkless container. Fail on scan errors.
scan_absent() {
  hits=$(find /usr /lib -name "$2" -print)
  if [ -z "$hits" ]; then printf '%s=absent\n' "$1"; else printf '%s=present\n' "$1"; fi
}
scan_absent systemdHomed systemd-homed
scan_absent archiveTar Tar.pm
scan_absent minizip '*minizip*'

scan_absent infocmp infocmp
