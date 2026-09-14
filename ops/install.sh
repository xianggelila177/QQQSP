#!/usr/bin/env bash
# 单用户安装：一个进程、一个 service。旧版服务不停止，默认新端口 8568。
set -euo pipefail
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=${1:-/opt/qqqsp-v2}
NEW_PORT=${2:-8568}
SERVICE=qqqsp-v2.service
KEEP_OLD=${QQQSP_KEEP_OLD_RELEASES:-3}
RELEASE_BUDGET=${QQQSP_RELEASE_BUDGET_BYTES:-536870912}
MEMORY_HIGH=${QQQSP_MEMORY_HIGH:-512M}
MEMORY_MAX=${QQQSP_MEMORY_MAX:-768M}
[[ "$KEEP_OLD" =~ ^[0-9]+$ && "$RELEASE_BUDGET" =~ ^[0-9]+$ ]] || { echo '版本保留参数无效'; exit 1; }
((KEEP_OLD<=20 && RELEASE_BUDGET>=1)) || { echo '版本保留数量必须为0～20，预算必须大于0'; exit 1; }
[[ "$MEMORY_HIGH" =~ ^[0-9]+[MG]$ && "$MEMORY_MAX" =~ ^[0-9]+[MG]$ ]] || { echo '内存限制必须是整数 M/G'; exit 1; }
[[ $(id -u) -eq 0 ]] || { echo '请使用 sudo bash ops/install.sh'; exit 1; }
[[ "$ROOT" =~ ^/[a-zA-Z0-9_./-]+$ && "$ROOT" != / && "$ROOT" != *..* ]] || { echo '安装目录必须是独立的绝对路径，不含空格或 ..'; exit 1; }
[[ "$NEW_PORT" =~ ^[0-9]+$ ]] && ((NEW_PORT>=1 && NEW_PORT<=65535)) || { echo '端口无效'; exit 1; }
command -v systemctl >/dev/null || { echo '此脚本需要 systemd；其他环境使用 bash start.sh 或 Docker。'; exit 1; }
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[[ -n "$NODE_BIN" ]] || { echo '请先安装 Node.js 22.16 或更新版本（推荐 24）。'; exit 1; }
NODE_BIN=$(readlink -f -- "$NODE_BIN")
[[ "$NODE_BIN" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Node 路径不能包含空格。'; exit 1; }
"$NODE_BIN" -e 'const [m,n]=process.versions.node.split(".").map(Number);if(m<22 || m===22 && n<16)process.exit(1)' || { echo '需要 Node.js 22.16 或更新版本（推荐 24）。'; exit 1; }
id qqqsp >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin qqqsp
runuser -u qqqsp -- "$NODE_BIN" --version >/dev/null || { echo 'qqqsp 用户不能执行该 Node；请使用所有用户可执行的系统 Node 路径。'; exit 1; }
install -d -m 755 "$ROOT" "$ROOT/releases" "$ROOT/shared"
exec 9>"$ROOT/.install.lock"
flock -n 9 || { echo '另一个安装任务正在运行'; exit 1; }
install -d -o qqqsp -g qqqsp -m 750 "$ROOT/shared/state" "$ROOT/shared/logs"
if [[ ! -f "$ROOT/shared/.env" ]]; then
  # .env 仅作为数据交给 Node/systemd 读取，绝不 source 为 shell 脚本。
  ENV_SOURCE="$SOURCE/.env.example"; [[ ! -f "$SOURCE/.env" ]] || ENV_SOURCE="$SOURCE/.env"
  install -o root -g qqqsp -m 640 "$ENV_SOURCE" "$ROOT/shared/.env"
  # 首次安装的端口由参数指定；升级保留现有 .env。
  sed -i "s/^PORT=.*/PORT=$NEW_PORT/" "$ROOT/shared/.env"
fi
ACTIVE_PORT=$("$NODE_BIN" -e 'console.log(require("node:util").parseEnv(require("node:fs").readFileSync(process.argv[1],"utf8")).PORT || "8568")' "$ROOT/shared/.env")
[[ "$ACTIVE_PORT" =~ ^[0-9]+$ ]] || { echo 'shared/.env 的 PORT 无效'; exit 1; }
PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)
RELEASE=$(mktemp -d "$ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
chmod 755 "$RELEASE"
COMMITTED=0
cleanup_failed(){
  local code=$?
  if [[ "$COMMITTED" != 1 ]]; then
    if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
      ln -sfn "$PREVIOUS" "$ROOT/.rollback-$$"; mv -Tf "$ROOT/.rollback-$$" "$ROOT/current"
      systemctl restart "$SERVICE" || true
    else
      systemctl stop "$SERVICE" || true
      [[ $(readlink -f "$ROOT/current" 2>/dev/null || true) != "$RELEASE" ]] || rm -f -- "$ROOT/current"
    fi
    rm -rf -- "$RELEASE"
    rm -f -- "$ROOT/.current-$$" "$ROOT/.rollback-$$"
  fi
  return "$code"
}
trap cleanup_failed EXIT
for item in app.js server.js config.js log.mjs mkt.mjs sent.mjs VERSION package.json package-lock.json lib public data; do
  cp -a -- "$SOURCE/$item" "$RELEASE/$item"
done
chmod -R a+rX "$RELEASE"
ln -s "$ROOT/shared/state" "$RELEASE/state"
ln -s "$ROOT/shared/logs" "$RELEASE/logs"
PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -s "$RELEASE" "$ROOT/.current-$$"
mv -Tf "$ROOT/.current-$$" "$ROOT/current"
cat > "/etc/systemd/system/$SERVICE" <<EOF
[Unit]
Description=QQQSP v2 single-user market panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=qqqsp
Group=qqqsp
WorkingDirectory=$ROOT/current
EnvironmentFile=$ROOT/shared/.env
ExecStart=$NODE_BIN server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=12
NoNewPrivileges=true
UMask=0027
MemoryAccounting=true
MemoryHigh=$MEMORY_HIGH
MemoryMax=$MEMORY_MAX
TasksMax=128
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE"
if systemctl restart "$SERVICE"; then
 for attempt in {1..20}; do
  if systemctl is-active --quiet "$SERVICE" && "$NODE_BIN" -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "http://127.0.0.1:$ACTIVE_PORT/readyz"; then
   if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$RELEASE" ]]; then ln -sfn "$PREVIOUS" "$ROOT/previous"; fi
   COMMITTED=1
   "$NODE_BIN" "$SOURCE/ops/prune-releases.mjs" "$ROOT" "$KEEP_OLD" "$RELEASE_BUDGET" || echo '版本清理未完成，请检查目录权限；当前/回滚版本未主动删除。' >&2
   printf '\n安装成功：%s\n本地地址：http://127.0.0.1:%s\n配置：%s/shared/.env\n日志：journalctl -u %s -f\n' "$SERVICE" "$ACTIVE_PORT" "$ROOT" "$SERVICE"
   echo '已更新 qqqsp-v2 服务，其他名称的旧版服务未改动。确认页面与来源状态后核对现有隧道目标端口。'
   exit 0
  fi
  sleep 1
 done
fi
echo '新版本未通过服务就绪检查，开始恢复上一版本。' >&2
journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
exit 1
