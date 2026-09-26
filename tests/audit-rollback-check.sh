#!/usr/bin/env bash
# Mock all service operations; never contacts the real systemd manager.
set -euo pipefail
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
BASE=$(realpath "${TMPDIR:-/tmp}")
TASK_DIR=$(mktemp -d "$BASE/qqqsp-rollback-test.XXXXXX")
cleanup(){ [[ "$(realpath "$TASK_DIR")" == "$BASE/qqqsp-rollback-test."* ]] && rm -rf -- "$TASK_DIR"; }
trap cleanup EXIT
export TASK_DIR
mkdir -p "$TASK_DIR/bin" "$TASK_DIR/app/releases/current" "$TASK_DIR/app/releases/previous" "$TASK_DIR/app/shared"
for item in current previous; do touch "$TASK_DIR/app/releases/$item/server.js"; done
echo 108 > "$TASK_DIR/app/releases/current/VERSION"
echo 107 > "$TASK_DIR/app/releases/previous/VERSION"
source "$SOURCE/ops/release-common.sh"
printf '107\r\n' > "$TASK_DIR/app/releases/previous/VERSION"
qqqsp_valid_release "$TASK_DIR/app" "$TASK_DIR/app/releases/previous"
echo 107 > "$TASK_DIR/app/releases/previous/VERSION"
echo PORT=8569 > "$TASK_DIR/app/shared/.env"
cat > "$TASK_DIR/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$TASK_DIR/calls"
if [[ "$1" == show ]]; then echo "{ path=$TASK_DIR/bin/node ; }"; fi
exit 0
MOCK
cat > "$TASK_DIR/bin/node" <<'MOCK'
#!/usr/bin/env bash
if [[ "$2" == *parseEnv* ]]; then echo 8569; exit 0; fi
if [[ "$2" == *fetch* ]]; then [[ "$(cat "$TASK_DIR/app/current/VERSION")" != "${FAIL_VERSION:-none}" ]]; exit $?; fi
exit 0
MOCK
cat > "$TASK_DIR/bin/flock" <<'MOCK'
#!/usr/bin/env bash
[[ ${LOCK_FAIL:-0} == 0 ]]
MOCK
printf '#!/usr/bin/env bash\necho 0\n' > "$TASK_DIR/bin/id"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TASK_DIR/bin/sleep"
chmod +x "$TASK_DIR/bin/"*
export PATH="$TASK_DIR/bin:$PATH"
export MSYS=winsymlinks:nativestrict
ln -s "$TASK_DIR/app/releases/current" "$TASK_DIR/app/current"
ln -s "$TASK_DIR/app/releases/previous" "$TASK_DIR/app/previous"
bash "$SOURCE/ops/rollback.sh" "$TASK_DIR/app"
[[ $(cat "$TASK_DIR/app/current/VERSION") == 107 && $(cat "$TASK_DIR/app/previous/VERSION") == 108 ]]
export FAIL_VERSION=108
if bash "$SOURCE/ops/rollback.sh" "$TASK_DIR/app"; then echo 'failed candidate unexpectedly succeeded'; exit 1; fi
[[ $(cat "$TASK_DIR/app/current/VERSION") == 107 && $(cat "$TASK_DIR/app/previous/VERSION") == 108 ]]
export LOCK_FAIL=1
BEFORE=$(wc -l < "$TASK_DIR/calls")
if bash "$SOURCE/ops/rollback.sh" "$TASK_DIR/app"; then echo 'lock failure unexpectedly succeeded'; exit 1; fi
[[ $(wc -l < "$TASK_DIR/calls") == "$BEFORE" ]]
echo 'PASS: rollback success, failed-target restoration, lock refusal (mock service)'
