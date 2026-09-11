#!/usr/bin/env bash
set -euo pipefail
ROOT=${1:-/opt/qqqsp-v2}
[[ $(id -u) -eq 0 ]] || { echo '请使用 sudo'; exit 1; }
[[ "$ROOT" =~ ^/[a-zA-Z0-9_./-]+$ && "$ROOT" != / && "$ROOT" != *..* ]] || exit 1
PREVIOUS=$(readlink -f "$ROOT/previous" 2>/dev/null || true)
[[ -n "$PREVIOUS" && -f "$PREVIOUS/server.js" ]] || { echo '没有上一部署版本。首次切换请将隧道重新指向旧版端口。'; exit 1; }
CURRENT=$(readlink -f "$ROOT/current")
ln -s "$PREVIOUS" "$ROOT/.rollback-$$"; mv -Tf "$ROOT/.rollback-$$" "$ROOT/current"
ln -sfn "$CURRENT" "$ROOT/previous"
systemctl restart qqqsp-v2.service
echo "已切回 $PREVIOUS；配置与状态保留。"
