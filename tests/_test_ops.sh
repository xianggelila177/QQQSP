#!/usr/bin/env bash
# Hermetic material checks: no credentials or live service execution.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for unit in qqqsp-panel.service qqqsp-relay-tunnel.service qqqsp-cloudflared.service; do
  test -f "$ROOT/$unit"
  grep -q '^User=qqqsp' "$ROOT/$unit"
  grep -q '^ProtectSystem=strict' "$ROOT/$unit"
  grep -q 'Restart=' "$ROOT/$unit"
done
test "$(sed -n 's/^User=//p' "$ROOT/qqqsp-panel.service" "$ROOT/qqqsp-relay-tunnel.service" "$ROOT/qqqsp-cloudflared.service" | sort -u | wc -l | tr -d ' ')" = 3
python3 - "$ROOT/ops/relay.py" <<'PY'
import ast,pathlib,sys
ast.parse(pathlib.Path(sys.argv[1]).read_text())
PY
bash -n "$ROOT/ops/keepall.sh"
node "$ROOT/scripts/secret-scan.mjs" "$ROOT"
echo 'PASS: service material, syntax and safe credential scanner'
