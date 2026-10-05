#!/usr/bin/env bash
# Existing units are deployment configuration, not a release template.
qqqsp_write_service_unit() {
  local target=$1 root=$2 node_bin=$3 memory_high=$4 memory_max=$5
  [[ ! -e "$target" && ! -L "$target" ]] || return 0
  local temporary="${target}.new-$$"
  (umask 077; cat > "$temporary" <<EOF
[Unit]
Description=QQQSP v2 single-user market panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=qqqsp
Group=qqqsp
WorkingDirectory=$root/current
EnvironmentFile=$root/shared/.env
ExecStart=$node_bin server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=12
NoNewPrivileges=true
UMask=0077
MemoryAccounting=true
MemoryHigh=$memory_high
MemoryMax=$memory_max
TasksMax=128
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF
  ) || return 1
  chmod 644 "$temporary" && mv -T -- "$temporary" "$target"
}
