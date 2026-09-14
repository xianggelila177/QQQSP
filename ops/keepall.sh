#!/usr/bin/env bash
# Legacy compatibility wrapper. Recovery is owned by independent systemd units.
set -euo pipefail
case "${1:-}" in
  '')
    echo 'keepall.sh is retired; enable qqqsp-panel.service, qqqsp-relay-tunnel.service, and qqqsp-cloudflared.service' >&2
    exec systemctl start qqqsp-panel.service qqqsp-relay-tunnel.service qqqsp-cloudflared.service
    ;;
  --status)
    exec systemctl --no-pager --full status qqqsp-panel.service qqqsp-relay-tunnel.service qqqsp-cloudflared.service
    ;;
  *)
    echo "usage: $0 [--status]" >&2
    exit 2
    ;;
esac
