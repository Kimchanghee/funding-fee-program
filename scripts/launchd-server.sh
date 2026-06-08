#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

export HOSTNAME="${HOSTNAME:-127.0.0.1}"
export PORT="${PORT:-3000}"
export NODE_ENV=production
export INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-${SITE_PASSWORD:-9788}}"

(
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://${HOSTNAME}:${PORT}/login" 2>/dev/null; then
      python3 <<'PY'
import json
import os
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
    "minSpreadPercent": 0.0,
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
        "dynamicNotionalCap": 1000,
        "useDriftBuffer": False,
        "useConfirmedClose": False,
        "useIocLimitOnly": True,
        "useStrictHedge": True,
    },
}

def request_json(method, path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        method=method,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))

status = request_json("GET", "/api/sim-scheduler")
current_config = status.get("config") if isinstance(status, dict) else {}
config = {**default_config, **(current_config or {})}
config["enabledExchanges"] = default_config["enabledExchanges"]
config["minSpreadPercent"] = 0.0
config["confirmedSnipeConfig"] = {
    **default_config["confirmedSnipeConfig"],
    **((current_config or {}).get("confirmedSnipeConfig") or {}),
    "useDynamicNotional": True,
    "dynamicNotionalCap": 1000,
    "useIocLimitOnly": True,
    "useStrictHedge": True,
}
action = "update" if status.get("active") else "start"
result = request_json("POST", "/api/sim-scheduler", {"action": action, "config": config})
next_status = result.get("status", {})
print(
    "[launchd-server] SIM scheduler "
    f"{action} ok active={next_status.get('active')} "
    f"scheduled={len(next_status.get('scheduledEntries') or [])}",
    flush=True,
)
PY
      exit 0
    fi
    sleep 1
  done
  echo "[launchd-server] WARN: server readiness timeout" >&2
) &

exec node scripts/start-standalone.js
