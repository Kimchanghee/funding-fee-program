#!/bin/bash
# funding-fee-program 진입 상태 확인 스크립트
# 더블클릭하면 현재 스케줄/진입/포지션 상태와 마지막 분석 결과를 한 번에 보여줌
set -e
cd "$(dirname "$0")"

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
TOKEN="${INTERNAL_API_TOKEN:-${SITE_PASSWORD:-9788}}"

echo "========================================"
echo "  funding-fee-program  status @ $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "========================================"

echo ""
echo "▶ 서버 응답:"
if curl -fsS -o /dev/null "http://${HOST}:${PORT}/login"; then
  echo "  OK  (http://${HOST}:${PORT})"
else
  echo "  ❌ NO RESPONSE — start-local.command 다시 실행 필요"
  read -p "Press enter to close..." _
  exit 1
fi

echo ""
echo "▶ Sim 스케줄러 상태:"
curl -fsS -H "x-internal-api-token: ${TOKEN}" "http://${HOST}:${PORT}/api/sim-scheduler" \
  | python3 -c "
import json, sys, datetime
j = json.load(sys.stdin)
UTC = datetime.timezone.utc
KST = datetime.timezone(datetime.timedelta(hours=9))
print(f'  active            : {j.get(\"active\")}')
print(f'  enabledExchanges  : {j[\"config\"][\"enabledExchanges\"]}')
print(f'  investmentUSDT    : \${j[\"config\"][\"investmentUSDT\"]}  (compoundInvesting={j[\"config\"][\"compoundInvesting\"]})')
print(f'  minSpreadPercent  : {j[\"config\"][\"minSpreadPercent\"]}%')
sched = j.get('scheduledEntries',[])
print(f'  scheduled entries : {len(sched)}')
for e in sched:
    t_utc = datetime.datetime.fromtimestamp(e['targetTime']/1000, UTC)
    t_kst = t_utc.astimezone(KST)
    delta = (t_utc - datetime.datetime.now(UTC)).total_seconds()
    h = int(abs(delta)//3600); m = int((abs(delta)%3600)//60)
    sign = '-' if delta < 0 else '+'
    short = (e.get('opportunity') or {}).get('shortExchange','?')
    long_ = (e.get('opportunity') or {}).get('longExchange','?')
    spread = (e.get('opportunity') or {}).get('spreadPercent', 0)
    print(f'    • {e[\"asset\"]:>10}  {short}->{long_:<8}  spread={spread:.3f}%  margin=\${e[\"investmentUSDT\"]}  target={t_kst:%H:%M:%S} KST  ({sign}{h}h{m}m)')
probes = j.get('scheduleProbeStates',[])
active_probes = [p for p in probes if not p.get('finalizedAt') and p.get('status') != 'canceled']
print(f'  active probes     : {len(active_probes)}')
for p in active_probes[:10]:
    print(f'    • {p[\"asset\"]:>10}  status={p.get(\"status\")}  reason={p.get(\"lastReason\",\"\")}')
"

echo ""
echo "▶ Sim 포지션 / 누적 PnL:"
python3 -c "
import json, datetime
with open('data/sim-state.json') as f: s = json.load(f)
pos = s.get('simPositions',[])
print(f'  active positions  : {len(pos)}')
for p in pos:
    print(f'    • {p}')
print(f'  funding earned    : \${s.get(\"simTotalFundingEarned\",0):.2f}')
print(f'  closed PnL        : \${s.get(\"simTotalClosedPnl\",0):.2f}')
print(f'  fees              : \${s.get(\"simTotalFees\",0):.2f}')
print(f'  net               : \${s.get(\"simTotalFundingEarned\",0) + s.get(\"simTotalClosedPnl\",0) - s.get(\"simTotalFees\",0):.2f}')
print(f'  balances          :')
for k,v in s.get('simBalances',{}).items():
    if v > 0: print(f'      {k:<10} \${v:.2f}')
"

echo ""
echo "▶ 최근 milestone 이벤트 (10개):"
TODAY=$(TZ=Asia/Seoul date +"%Y-%m-%d")
TFILE="data/trades/${TODAY}.jsonl"
if [ -f "$TFILE" ]; then
  python3 -c "
import json, datetime
UTC = datetime.timezone.utc
KST = datetime.timezone(datetime.timedelta(hours=9))
events = []
with open('$TFILE') as f:
    for line in f:
        try: o = json.loads(line)
        except: continue
        m = o.get('milestone'); t = o.get('type')
        if m in ('execute','execute_failed','snipe_entry','snipe_complete','deferred_to_next_cycle','pre_5m','pre_3m','pre_1m','canceled_before_execute','scheduled') or t == 'guard_block':
            ts = o.get('timestamp',0)
            kst = datetime.datetime.fromtimestamp(ts/1000, UTC).astimezone(KST)
            asset = o.get('asset') or o.get('baseAsset') or '?'
            print(f'  {kst:%H:%M:%S} KST  {(m or t):28s}  {asset:>10}  {o.get(\"reason\",\"\")}')
            events.append(1)
print(f'(총 {sum(events)}건)') if events else print('  (없음)')
" | tail -n 12
else
  echo "  (오늘 trades 파일 없음)"
fi

echo ""
echo "========================================"
read -p "Press enter to close..." _
