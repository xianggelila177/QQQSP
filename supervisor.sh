#!/usr/bin/env bash
# Legacy compatibility entry point. Recovery is PID-scoped by ops/keepall.sh.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "supervisor.sh is retired; use qqqsp-panel.service, qqqsp-relay-tunnel.service, and qqqsp-cloudflared.service" >&2
exec "$DIR/ops/keepall.sh" "$@"
