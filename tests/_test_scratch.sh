#!/usr/bin/env bash
# Deterministic source checkout check: no temporary files in the panel root.
# Historical archives are optional release artifacts and are never downloaded by tests.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok(){ echo "PASS: $1"; pass=$((pass+1)); }
no(){ echo "FAIL: $1"; fail=$((fail+1)); }

SCRATCH="_acc.json _cv.mjs _final_check.js _mc.json _n1.json _push40.sh _t28.cjs _t30.cjs _t40.mjs"
BAKS="server.out.last.bak supervisor.out.last.bak tunnel.out.last.bak"

bad=""
for f in $SCRATCH $BAKS; do
  [ -e "$ROOT/$f" ] && bad="$bad $f"
done
[ -z "$bad" ] && ok "panel 根目录无 scratch/*.last.bak 残留" || no "根目录仍残留:$bad"

# 通用守则: 根目录不得累积 _ 开头的非测试文件。90 分钟内新生的文件视为并行任务在用, 只告警宽限。
n=0; young=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ -n "$(find "$f" -mmin -90)" ]; then
    young="$young $(basename "$f")"
  else
    n=$((n+1)); echo "  违规文件: $f"
  fi
done < <(find "$ROOT" -maxdepth 1 -type f -name '_*' ! -name '_test_*')
[ "$n" -eq 0 ] && ok "根目录无 _ 开头的非测试文件(存量)" || no "根目录有 $n 个 _ 开头非测试文件(存量)"
[ -z "$young" ] && true || echo "WARN: 90 分钟内新出现的 _ 文件(疑似并行任务在用, 不判失败):$young"

[ -d "$ROOT/archive" ] && ok "archive/ optional artifact present" || echo "NOT RUN: historical archive checks (optional release artifact absent)"

echo "---- _test_scratch: pass=$pass fail=$fail ----"
[ "$fail" -eq 0 ]
