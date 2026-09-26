#!/usr/bin/env bash
# Shared primitives for install and rollback. This file has no side effects.
qqqsp_release_lock() {
  exec 9>"$1/.install.lock"
  flock -n 9 || { echo '另一个安装或回滚任务正在运行' >&2; return 1; }
}
qqqsp_valid_release() {
  local owned candidate version
  owned=$(readlink -f -- "$1/releases") || return 1
  candidate=$(readlink -f -- "$2") || return 1
  [[ "$candidate" == "$owned/"* && -f "$candidate/server.js" && -f "$candidate/VERSION" ]] || return 1
  version=$(cat "$candidate/VERSION")
  version=${version%$'\r'}
  [[ "$version" =~ ^[0-9]+$ ]]
}
qqqsp_switch_release() {
  local root=$1 target=$2 anchor=${3:-current} temporary
  [[ "$anchor" == current || "$anchor" == previous ]] || return 1
  qqqsp_valid_release "$root" "$target" || { echo '拒绝切换到安装目录之外或不完整的版本' >&2; return 1; }
  temporary="$root/.$anchor-$$"
  ln -sfn -- "$target" "$temporary" && mv -Tf -- "$temporary" "$root/$anchor"
}
qqqsp_wait_ready() {
  local node_bin=$1 port=$2 expected=$3 service=$4 attempt
  expected=${expected%$'\r'}
  for attempt in {1..20}; do
    if systemctl is-active --quiet "$service" && "$node_bin" -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(async r=>{const p=await r.json();process.exit(r.ok&&p.ready===true&&String(p.version)===process.argv[2]?0:1)}).catch(()=>process.exit(1))' "http://127.0.0.1:$port/readyz" "$expected"; then return 0; fi
    sleep 1
  done
  return 1
}
