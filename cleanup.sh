#!/usr/bin/env bash
# Retired: never truncate live files or touch the sibling monitor's data.
# panel.log uses log.mjs bounded rotation; systemd output uses journald retention.
set -euo pipefail
echo 'cleanup.sh is retired. No files changed. See ops/RUNBOOK.md for log retention.' >&2
