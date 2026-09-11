#!/usr/bin/env bash
# Legacy compatibility entry point. Cloudflared is qqqsp-cloudflared.service.
set -euo pipefail
echo "tunnel_watchdog.sh is retired; enable qqqsp-cloudflared.service" >&2
exit 0
