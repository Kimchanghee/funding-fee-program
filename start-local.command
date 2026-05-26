#!/bin/bash
# 로컬 전용 기동 스크립트 — 외부 터널 없이 127.0.0.1:3000에서만 응답
set -e

cd "$(dirname "$0")"

# .env.local 자동 로드
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

# 로컬 바인딩 강제
export HOSTNAME=127.0.0.1
export PORT="${PORT:-3000}"
export NODE_ENV=production
export INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-${SITE_PASSWORD:-9788}}"

# 동일 포트의 기존 프로세스 정리
EXISTING_PID="$(lsof -ti tcp:"${PORT}" 2>/dev/null || true)"
if [ -n "$EXISTING_PID" ]; then
  echo "[start-local] killing previous server on :${PORT} (pid=${EXISTING_PID})"
  kill -9 $EXISTING_PID || true
  sleep 1
fi

echo "[start-local] starting funding-fee-program on http://${HOSTNAME}:${PORT}"
echo "[start-local] login password: ${SITE_PASSWORD:-9788}"
echo "[start-local] logs: $(pwd)/server.log"

# 백그라운드로 띄우고 Terminal 창은 즉시 반환
nohup node scripts/start-standalone.js > server.log 2>&1 &
NEW_PID=$!
echo "[start-local] pid=${NEW_PID}"
disown ${NEW_PID} || true

# 헬스 대기
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://${HOSTNAME}:${PORT}/login" 2>/dev/null; then
    echo "[start-local] ready -> http://${HOSTNAME}:${PORT}"
    echo "[start-local] ensuring SIM scheduler is active (SIM-only build)"
    python3 <<'PY'
import json
import os
import urllib.error
import urllib.request

host = os.environ.get("HOSTNAME", "127.0.0.1")
port = os.environ.get("PORT", "3000")
base_url = f"http://{host}:{port}"
token = os.environ.get("INTERNAL_API_TOKEN") or os.environ.get("SITE_PASSWORD") or "9788"

headers = {
    "content-type": "application/json",
    "x-internal-api-token": token,
}

default_config = {
    "investmentUSDT": 250,
    "leverage": 17,
    "minSpreadPercent": 0.01,
    "compoundInvesting": True,
    "enabledExchanges": ["binance", "bybit", "okx", "bitget", "gate", "bingx"],
    "timingConfig": {
        "entryLeadMs": 180000,
        "closeDelayMs": 1000,
        "fundingVerifyRetryMs": 5000,
        "fundingVerifyAttempts": 3,
    },
    "maxSlippagePercent": 4,
    "minVolume24hUSD": 0,
    "confirmedSnipeConfig": {
        "useImpactGuards": False,
        "targetImpactBps": 2,
        "maxRoundTripImpactBps": 12,
        "useDynamicNotional": True,
        "dynamicNotionalCap": 300000,
        "useDriftBuffer": False,
        "useConfirmedClose": False,
        "useIocLimitOnly": True,
        "useStrictHedge": True,
    },
}


def request_json(method, path, body=None, timeout=15):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        method=method,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


try:
    status = request_json("GET", "/api/sim-scheduler")
    current_config = status.get("config") if isinstance(status, dict) else {}
    config = {**default_config, **(current_config or {})}
    config["enabledExchanges"] = default_config["enabledExchanges"]
    config["minSpreadPercent"] = min(float(config.get("minSpreadPercent") or 0.01), 0.01)
    config["maxSlippagePercent"] = max(float(config.get("maxSlippagePercent") or 0), 4)
    current_timing = ((current_config or {}).get("timingConfig") or {})
    timing_config = {**default_config["timingConfig"], **current_timing}
    try:
        current_entry_lead = float(timing_config.get("entryLeadMs") or 0)
    except (TypeError, ValueError):
        current_entry_lead = 0
    timing_config["entryLeadMs"] = max(180000, min(300000, current_entry_lead))
    config["timingConfig"] = timing_config
    config["confirmedSnipeConfig"] = {
        **default_config["confirmedSnipeConfig"],
        **((current_config or {}).get("confirmedSnipeConfig") or {}),
        "targetImpactBps": min(
            2,
            float(((current_config or {}).get("confirmedSnipeConfig") or {}).get("targetImpactBps") or 2),
        ),
        "useDynamicNotional": True,
        "dynamicNotionalCap": max(
            300000,
            int(((current_config or {}).get("confirmedSnipeConfig") or {}).get("dynamicNotionalCap") or 0),
        ),
        "useIocLimitOnly": True,
        "useStrictHedge": True,
    }
    action = "update" if status.get("active") else "start"
    result = request_json("POST", "/api/sim-scheduler", {"action": action, "config": config}, timeout=60)
    next_status = result.get("status", {})
    applied_config = next_status.get("config") if isinstance(next_status, dict) else {}
    applied_timing = (applied_config or {}).get("timingConfig") or {}
    scheduled = len(next_status.get("scheduledEntries") or [])
    print(
        "[start-local] SIM scheduler "
        f"{action} ok | active={next_status.get('active')} | scheduled={scheduled} | "
        f"investment=${(applied_config or config).get('investmentUSDT')} | "
        f"leverage={(applied_config or config).get('leverage')}x | "
        f"minSpread={float((applied_config or config).get('minSpreadPercent', config['minSpreadPercent'])):.4f}% | "
        f"entryLeadMs={applied_timing.get('entryLeadMs', config['timingConfig']['entryLeadMs'])}"
    )
except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as exc:
    print(f"[start-local] WARN: SIM scheduler auto-start failed: {exc}")
PY
    exit 0
  fi
  sleep 1
done

echo "[start-local] WARN: server did not respond within 30s. tail of log:" >&2
tail -n 40 server.log >&2 || true
exit 1
