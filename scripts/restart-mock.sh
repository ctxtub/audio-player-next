#!/bin/bash
# E2E mock 重启脚本（仓库跟踪资产，缺陷 #5 修复）。
#
# 职责：在明确范围内安全替换本脚本管理的 mock 实例，并以
# 非流 200 + 流式 `[DONE]` + TTS 200 三探针确证注入模式已恢复默认。
# 对非本脚本管理/不可信 PID 绝不击杀，直接失败并给出可操作错误。
#
# 作用域覆盖（环境变量覆盖，便于隔离测试；缺省保持线上行为）：
# - MOCK_PORT：mock 监听端口（缺省 9301）
# - MOCK_PID_FILE：pid 文件（缺省 <repo>/.e2e-runtime/mock.pid）
# - MOCK_LOG_FILE：mock 日志（缺省 <repo>/.e2e-runtime/mock.log）
# - MOCK_SCRIPT：mock 服务脚本（缺省 <repo>/.e2e-runtime/mock-openai.mjs，
#   缺失时直接失败并指引经 MOCK_SCRIPT 显式传入；测试一律显式传入）。
#
# 说明：本脚本不读取任何 .env 文件（避免与密钥载体耦合），全部配置经环境变量传入。
# 旧位置 `.e2e-runtime/restart-mock.sh`（git 忽略）已废弃，行为以本文件为准。
set -u

# 中文注释：仓库根目录由脚本位置推导，不依赖调用方 cwd 与绝对路径。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 中文注释：作用域解析（环境覆盖优先，缺省为线上 :9301 资产）。
MOCK_PORT="${MOCK_PORT:-9301}"
MOCK_PID_FILE="${MOCK_PID_FILE:-.e2e-runtime/mock.pid}"
MOCK_LOG_FILE="${MOCK_LOG_FILE:-.e2e-runtime/mock.log}"
MOCK_SCRIPT="${MOCK_SCRIPT:-.e2e-runtime/mock-openai.mjs}"
MOCK_BASENAME="$(basename "$MOCK_SCRIPT")"
BASE_URL="http://127.0.0.1:${MOCK_PORT}"

# 中文注释：mock 服务脚本必须存在，否则本次启动无意义，直接给出可操作错误。
if [ ! -f "$MOCK_SCRIPT" ]; then
  echo "ERROR: mock 服务脚本不存在：${MOCK_SCRIPT}。" >&2
  echo "ERROR: 请经 MOCK_SCRIPT 传入可用脚本路径，或准备默认 .e2e-runtime/mock-openai.mjs，本次启动已中止。" >&2
  exit 1
fi

# 中文注释：判断 PID 是否存活（ESRCH 即死亡）。
is_alive() {
  kill -0 "$1" 2>/dev/null
}

# 中文注释：判定 pid 文件中的 PID 是否为本脚本管理的 mock。
# 规则：进程存活且其命令行包含 mock 服务文件名（缺省 mock-openai.mjs）
# 或完整 MOCK_SCRIPT 路径。目录名不作为判据（避免 /tmp/d5-restart-mock- 误判）。
is_managed_pid() {
  local pid="$1"
  local cmd=""
  if ! is_alive "$pid"; then
    return 1
  fi
  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if [ -z "$cmd" ]; then
    return 1
  fi
  case "$cmd" in
    *"$MOCK_SCRIPT"*|*"mock-openai.mjs"*|*"healthy-mock.mjs"*|*"broken-stream-mock.mjs"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# 中文注释：端口是否被占用（任意 HTTP 应答即视为占用；000/连接失败即空闲）。
is_port_occupied() {
  local code="000"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${BASE_URL}/v1/models" 2>/dev/null || true)"
  if [ "$code" = "000" ]; then
    return 1
  fi
  return 0
}

# 中文注释：终止受管旧实例（TERM → 等待 → KILL），并等待端口释放。
stop_managed() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 10); do
    if ! is_alive "$pid"; then
      break
    fi
    sleep 0.5
  done
  if is_alive "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.5
  fi
  for i in $(seq 1 10); do
    if ! is_port_occupied; then
      break
    fi
    sleep 0.5
  done
}

# 中文注释：清理本轮自己拉起但探活失败的实例（避免残留故障进程）。
cleanup_started() {
  local pid="$1"
  if is_alive "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  if [ -f "$MOCK_PID_FILE" ]; then
    local filed=""
    filed="$(cat "$MOCK_PID_FILE" 2>/dev/null | tr -d ' \n\r\t' || true)"
    if [ "$filed" = "$pid" ]; then
      rm -f "$MOCK_PID_FILE"
    fi
  fi
}

# ---- 1) 受管旧实例替换 / 不受管占用拒绝 ----
if [ -f "$MOCK_PID_FILE" ]; then
  OLD_PID="$(tr -d ' \n\r\t' < "$MOCK_PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" -eq "$OLD_PID" ] 2>/dev/null; then
    if is_alive "$OLD_PID"; then
      if is_managed_pid "$OLD_PID"; then
        echo "INFO: 停止受管旧 mock PID=${OLD_PID}（${MOCK_PID_FILE}）"
        stop_managed "$OLD_PID"
        rm -f "$MOCK_PID_FILE"
      else
        echo "ERROR: 拒绝击杀非受管进程 PID=${OLD_PID}（命令行与 ${MOCK_BASENAME} 不符，多为不受管占用）。" >&2
        echo "ERROR: 端口 ${MOCK_PORT} 的归属不可信，请手动确认后处理（kill ${OLD_PID} 或更换 MOCK_PORT），本次拒绝启动以避免误杀。" >&2
        exit 1
      fi
    else
      # 中文注释：pid 文件残留死进程，先清理再按无 pid 流程做占用检查。
      rm -f "$MOCK_PID_FILE"
    fi
  else
    # 中文注释：pid 文件内容非法，视为不可信，不直接删除端口占用者，仅清理文件后检查端口。
    echo "WARN: pid 文件内容非法，已清理并重新检查端口占用：${MOCK_PID_FILE}" >&2
    rm -f "$MOCK_PID_FILE"
  fi
fi

if is_port_occupied; then
  echo "ERROR: 端口 ${MOCK_PORT} 已被非受管进程占用（无受管 pid 归属），拒绝击杀。" >&2
  echo "ERROR: 请手动确认占用者（lsof -iTCP:${MOCK_PORT} -sTCP:LISTEN）后处理，或更换 MOCK_PORT；本次启动已中止。" >&2
  exit 1
fi

# ---- 2) 启动本作用域 mock（MOCK_PORT 显式导出给 mock 进程） ----
export MOCK_PORT
mkdir -p "$(dirname "$MOCK_PID_FILE")" "$(dirname "$MOCK_LOG_FILE")"
nohup node "$MOCK_SCRIPT" > "$MOCK_LOG_FILE" 2>&1 & echo $! > "$MOCK_PID_FILE"
NEW_PID="$(cat "$MOCK_PID_FILE" 2>/dev/null | tr -d ' \n\r\t')"

# ---- 3) 三探针健康检查：非流 200 + 流式 [DONE] + TTS 200 ----
HEALTH_TMP="$(mktemp -t d5-health-XXXXXX)"
trap 'rm -f "$HEALTH_TMP" "$HEALTH_TMP.hdr" "$HEALTH_TMP.body"' EXIT
NONSTREAM=000
STREAM_OK=0
TTS_OK=0
for i in $(seq 1 20); do
  if ! is_alive "$NEW_PID"; then
    echo "ERROR: mock 进程 ${NEW_PID} 已退出（多为 EADDRINUSE 或启动崩溃），详见 ${MOCK_LOG_FILE}。" >&2
    break
  fi
  NONSTREAM="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST "${BASE_URL}/v1/chat/completions" -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"ping"}],"stream":false}' 2>/dev/null || true)"
  if [ "$NONSTREAM" = "200" ]; then
    if curl -s --max-time 5 -X POST "${BASE_URL}/v1/chat/completions" -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"ping"}],"stream":true}' 2>/dev/null | grep -q 'data: \[DONE\]'; then
      STREAM_OK=1
    fi
    TTS_CODE="$(curl -s -D "$HEALTH_TMP.hdr" -o "$HEALTH_TMP.body" -w '%{http_code}' --max-time 5 -X POST "${BASE_URL}/v1/audio/speech" -H 'content-type: application/json' -d '{"input":"ping"}' 2>/dev/null || true)"
    if [ "$TTS_CODE" = "200" ] && grep -qi 'audio' "$HEALTH_TMP.hdr" 2>/dev/null && [ -s "$HEALTH_TMP.body" ]; then
      TTS_OK=1
    else
      TTS_OK=0
    fi
    if [ "$STREAM_OK" = "1" ] && [ "$TTS_OK" = "1" ]; then
      break
    fi
  fi
  sleep 0.5
done

if [ "$NONSTREAM" = "200" ] && [ "$STREAM_OK" = "1" ] && [ "$TTS_OK" = "1" ] && is_alive "$NEW_PID"; then
  echo "MOCK_PID=${NEW_PID} HEALTH=200 STREAM=DONE TTS=200"
  exit 0
fi

echo "ERROR: mock 健康检查未通过（非流=${NONSTREAM} 流式_DONE=${STREAM_OK} TTS=${TTS_OK}），已清理本轮实例 PID=${NEW_PID}。" >&2
if [ "$STREAM_OK" != "1" ] && [ "$NONSTREAM" = "200" ]; then
  echo "ERROR: 非流 200 但流式探针缺 [DONE]，疑为注入/断流态 mock，拒绝视为健康。" >&2
fi
if [ "$TTS_OK" != "1" ]; then
  echo "ERROR: TTS 探针未通过（期待 audio/speech 200 + 音频负载），拒绝视为健康。" >&2
fi
cleanup_started "$NEW_PID"
exit 1
