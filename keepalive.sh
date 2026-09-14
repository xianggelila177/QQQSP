#!/usr/bin/env bash
# Legacy compatibility entry point. Independent systemd units own recovery.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "keepalive.sh is retired; use qqqsp-panel.service, qqqsp-relay-tunnel.service, and qqqsp-cloudflared.service" >&2
exec "$DIR/ops/keepall.sh" "$@"
