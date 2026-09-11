#!/usr/bin/env bash
# Operational regression: old tunnel health wrapper is retired; systemd owns tunnel recovery.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok(){ echo "PASS: $1"; pass=$((pass+1)); }
no(){ echo "FAIL: $1"; fail=$((fail+1)); }
grep -q 'qqqsp-relay-tunnel.service' "$ROOT/relay_tunnel.sh" && ok 'legacy relay wrapper points to independent unit' || no 'legacy relay wrapper is ambiguous'
grep -q 'qqqsp-cloudflared.service' "$ROOT/tunnel_watchdog.sh" && ok 'legacy cloudflared wrapper points to independent unit' || no 'legacy cloudflared wrapper is ambiguous'
grep -q 'systemctl start qqqsp-panel.service' "$ROOT/ops/keepall.sh" && ok 'keepall delegates panel to systemd' || no 'keepall panel delegation missing'
! grep -Eq 'https://|digital-reality\.shop|pgrep|pkill' "$ROOT/ops/keepall.sh" && ok 'keepall has no public probe or process scan' || no 'keepall still embeds legacy probes'

echo "---- _test_tunnel_health: pass=$pass fail=$fail ----"
[ "$fail" -eq 0 ]
