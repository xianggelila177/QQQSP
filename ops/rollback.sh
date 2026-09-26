#!/usr/bin/env bash
set -euo pipefail
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$SOURCE/ops/release-common.sh"
ROOT=${1:-/opt/qqqsp-v2}
SERVICE=qqqsp-v2.service
[[ $(id -u) -eq 0 ]] || { echo '请使用 sudo'; exit 1; }
[[ "$ROOT" =~ ^/[a-zA-Z0-9_./-]+$ && "$ROOT" != / && "$ROOT" != *..* ]] || exit 1
[[ -d "$ROOT/releases" ]] || { echo '安装目录不存在'; exit 1; }
qqqsp_release_lock "$ROOT"
PREVIOUS=$(readlink -f "$ROOT/previous" 2>/dev/null || true)
qqqsp_valid_release "$ROOT" "$PREVIOUS" || { echo '没有有效的上一部署版本'; exit 1; }
CURRENT=$(readlink -f "$ROOT/current")
qqqsp_valid_release "$ROOT" "$CURRENT" || { echo '当前版本不完整，未执行切换'; exit 1; }
if [[ -z ${NODE_BIN:-} ]]; then
  EXEC_START=$(systemctl show "$SERVICE" --property=ExecStart --value)
  if [[ "$EXEC_START" =~ path=([^\;[:space:]]+) ]]; then NODE_BIN=${BASH_REMATCH[1]}; else NODE_BIN=$(command -v node || true); fi
fi
[[ -x "$NODE_BIN" ]] || { echo '无法找到服务使用的Node，请设置NODE_BIN'; exit 1; }
ACTIVE_PORT=$("$NODE_BIN" -e 'console.log(require("node:util").parseEnv(require("node:fs").readFileSync(process.argv[1],"utf8")).PORT || "8568")' "$ROOT/shared/.env")
[[ "$ACTIVE_PORT" =~ ^[0-9]+$ ]] && ((ACTIVE_PORT>=1 && ACTIVE_PORT<=65535)) || { echo '端口无效'; exit 1; }
COMMITTED=0
restore_failed() {
  local code=$?
  if [[ "$COMMITTED" != 1 ]]; then
    qqqsp_switch_release "$ROOT" "$CURRENT" || true
    qqqsp_switch_release "$ROOT" "$PREVIOUS" previous || true
    if systemctl restart "$SERVICE" && qqqsp_wait_ready "$NODE_BIN" "$ACTIVE_PORT" "$(cat "$CURRENT/VERSION")" "$SERVICE"; then
      echo '回滚目标未就绪，已恢复操作前版本' >&2
    else
      echo '已尝试恢复操作前版本，但服务仍未就绪，请检查服务日志' >&2
    fi
  fi
  return "$code"
}
trap restore_failed EXIT
qqqsp_switch_release "$ROOT" "$PREVIOUS"
systemctl restart "$SERVICE"
qqqsp_wait_ready "$NODE_BIN" "$ACTIVE_PORT" "$(cat "$PREVIOUS/VERSION")" "$SERVICE"
qqqsp_switch_release "$ROOT" "$CURRENT" previous
COMMITTED=1
echo "已切回 $PREVIOUS；配置与状态保留。"
