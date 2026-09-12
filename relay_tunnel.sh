#!/usr/bin/env bash
# Legacy compatibility entry point. The relay tunnel is qqqsp-relay-tunnel.service.
set -euo pipefail
echo "relay_tunnel.sh is retired; enable qqqsp-relay-tunnel.service" >&2
exit 0
