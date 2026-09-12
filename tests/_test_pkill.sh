#!/usr/bin/env bash
# Operational safety regression: legacy wrappers must not terminate by broad patterns.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok(){ echo "PASS: $1"; pass=$((pass+1)); }
no(){ echo "FAIL: $1"; fail=$((fail+1)); }
for f in "$ROOT/keepalive.sh" "$ROOT/supervisor.sh" "$ROOT/relay_tunnel.sh" "$ROOT/tunnel_watchdog.sh"; do
  if grep -Eq '(^|[^[:alnum:]_])pkill([[:space:]]|$)' "$f"; then no "$(basename "$f") has broad pkill"; else ok "$(basename "$f") has no process-pattern kill"; fi
done
if grep -q 'systemctl start qqqsp-panel.service' "$ROOT/ops/keepall.sh" && ! grep -Eq 'pkill|pgrep|kill ' "$ROOT/ops/keepall.sh"; then ok 'keepall delegates exact panel unit without process kill'; else no 'keepall has process-pattern supervisor'; fi

echo "---- _test_pkill: pass=$pass fail=$fail ----"
[ "$fail" -eq 0 ]
