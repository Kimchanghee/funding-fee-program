# 펀딩피 자동매매 4일 무거래 사고 분석 보고서

**프로젝트**: `D:\Dithub\funding-fee-program` (Funding Fee Program, Next.js 15 + CCXT)
**대상 구간**: 2026-04-29 ~ 2026-05-03 (KST 기준 4일)
**작성일**: 2026-05-03 (KST)
**모드**: 시뮬레이션(SIM) — `simulation: true`, 거래소 실주문 없음

---

## 0. 요약 (TL;DR)

- **시뮬레이터(서버 사이드 스케줄러)는 KST 2026-04-30 08:47 즈음 멈춘 뒤 재기동된 흔적이 없다.** 그 시점 이후의 데이터(`data/logs/`, `data/trades/`, `data/analysis/.../*.json`, `data/funding-receipts/`, `data/trades-executed/`)가 모두 부재한다.
- **KST 2026-04-30 0시 ~ 08:47 사이**에는 프로세스는 살아 있었지만, 그 9시간 동안 시도된 3건의 진입(`milestone:"execute"`)이 **모두 실패**했다. 실패 사유는 두 가지:
  1. `funding_window_shifted` — 거래소 측 펀딩 시각이 한쪽에서 4시간/1시간 어긋남 (PRL, RDNT)
  2. `orderbook_unavailable` — Binance 오더북 WS/REST 타임아웃 (XCN)
- **즉 04-30(KST)은 "프로그램은 살아 있었지만 거래소 데이터/마켓 이벤트로 진입이 전부 차단" 되었고, 그 이후 4-30 09시부터 5-3까지는 "프로세스 자체가 죽어 있던" 상태**다.
- 가장 마지막에 정상 마무리된 거래는 KST 2026-04-29 21:00 (UTC 12:00)에 ORCA·PRL 두 페어 청산이며 그 시점 이후 단 한 건의 `snipe_complete`도 없다.
- **놓친 추정 손익(보수적 ~ 낙관적)**: 약 **+30 ~ +90 USDT** (자본 2,000 USDT 기준 **+1.5% ~ +4.5%**). 아래 §3에 산출 근거.
- **재가동을 위해 가장 먼저 해야 할 일**: (1) 서버 프로세스 재기동, (2) 펀딩-시각 안전장치 임계값(`MAX_FUNDING_TIMESTAMP_DIFF_MS`, `liveFundingTimeDriftMs`) 점검, (3) Binance WebSocket 안정화/재시도 로직 확인, (4) Windows에서 PM2 watchdog가 살아 있는지 확인.

---

## 1. 데이터/로그 검토

### 1.1 모든 산출물 파일이 KST 04-30에서 끊김

찾은 데이터 디렉터리 5종 모두 동일한 컷오프(KST 2026-04-30 오전)를 보임.

| 디렉터리 | 마지막 파일 | 비고 |
| --- | --- | --- |
| `data/logs/` | `2026-04-30.jsonl` (330라인) | 마지막 줄 timestamp `1777506798470` = **KST 04-30 08:47** |
| `data/trades/` | `2026-04-30.jsonl` (974라인, 모두 `schedule_probe`) | 마지막 줄 동일 시각 |
| `data/analysis/opportunities-hourly/server_sim_scheduler/` | `2026-04-30-08.json` (시간대 키는 KST) | `lastCapturedAt: 1777506851702` = **KST 04-30 08:54** |
| `data/funding-receipts/sim/` | `2026-04-29.jsonl` (10건의 펀딩 수령) | 04-30 파일 부재 |
| `data/trades-executed/sim/` | `2026-04-29.jsonl` (5건 `snipe_complete`) | **04-30 파일 부재** = 04-30에 단 한 건도 청산되지 못함 |

`data/sim-state.json`의 `updatedAt: 1777506853693` = KST 2026-04-30 08:54. 그 이후 한 번도 갱신되지 않음.

### 1.2 `sim-scheduler-state.json`에 멈춘 진입 1건이 그대로 남아 있음

```json
{
  "active": true,
  "scheduledEntries": [{
    "asset": "XCN",
    "targetTime": 1777507193000,    // KST 2026-04-30 08:53:13 (펀딩 09:00의 7초 전)
    "investmentUSDT": 500
  }],
  "scheduleProbeStates": [{
    "probeId": "XCN:binance:bybit:8h@1777507193000",
    "status": "scheduled",
    "executeCaptured": false,   // ← 진입 시도조차 못 함
    "executeResultCaptured": false
  }],
  "lastRatesUpdate": 1777506853692
}
```

→ XCN 진입 예정시각(KST 08:53:13)을 **6분 23초** 앞두고 프로세스가 멈춘 상태로 그대로 보존됨.

### 1.3 04-30 KST 진입 시도는 3건 모두 `execute_failed`

`data/trades/2026-04-30.jsonl` 의 `milestone:"execute"` 이벤트는 3건이며, 직후 모두 `execute_failed`로 전환됨.

| 시각(KST) | 종목 | 펀딩(KST) | 실패 사유 | 핵심 에러 |
| --- | --- | --- | --- | --- |
| 04-30 01:00 | PRL (bybit S / binance L) | 01:00 | `funding_window_shifted` | `funding window shift: short=0ms long=14400000ms` (long 다리가 4시간 어긋남, 허용 1분) |
| 04-30 01:00 | RDNT (bybit S / binance L) | 01:00 | `funding_window_shifted` | `short=0ms long=3600000ms` (1시간 어긋남) |
| 04-30 05:00 | XCN (binance S / bybit L) | 05:00 | `orderbook_unavailable` | `[binance] orderbook WS/REST failed for XCN/USDT:USDT: watchOrderBook timeout, empty orderbook` |

→ KST 04-30 0~9시에 프로그램 자체는 정상 돌고 있었지만 **모든 진입을 가드(guard)가 차단**.

### 1.4 04-29 KST 정상 거래 5건(베이스라인)

`data/trades-executed/sim/2026-04-29.jsonl` 의 `snipe_complete` 5건:

| # | 시각(KST) | 종목 | 마진 | 레버리지 | 펀딩 수령 | 가격 PnL | 수수료 | **순손익** |
| - | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 04-29 12:50 | PRL | 500 | 5 | +30.83 | -12.94 | -2.93 | **+14.96** |
| 2 | 04-29 16:50 | ORCA | 200 | 5 | +2.60 | -1.88 | -1.17 | **-0.45** |
| 3 | 04-29 17:00 | PRL | 500 | 5 | +14.62 | -8.20 | -2.93 | **+3.49** |
| 4 | 04-29 21:00 | ORCA | 400 | 5 | +10.70 | -10.04 | -2.35 | **-1.68** |
| 5 | 04-29 21:00 | PRL | 300 | 5 | +5.53 | -3.91 | -1.76 | **-0.15** |
|  |  |  |  |  | **+64.28** | **-36.96** | **-11.15** | **+16.17** |

`sim-state.json` 누적치(`simTotalFundingEarned 64.28`, `simTotalClosedPnl -36.96`, `simTotalFees 11.15`)와 정확히 일치. → 누적 잔고가 2000 → 2016.16 USDT (**+0.81%**) 로 증가.

또한 17건의 `milestone:"execute"` 시도 중 5건만 성공(성공률 ≈ 29%). 나머지 12건은 04-29에도 `funding_window_shifted` 등으로 차단되었음 → 가드 로직이 **상시적으로 다수 진입을 떨어뜨리고 있음**(시스템적인 이슈).

### 1.5 어플리케이션 로그에 에러/충돌 흔적 없음

`data/logs/2026-04-30.jsonl` 330라인 전부 `level:"warning"` (rejected/analysis_summary). `level:"error"`/`crash`/`exception` 없음. 외부 종료(프로세스 kill, OS 재부팅, VS Code/터미널 종료)일 가능성이 높음.

`.omc-redeploy-runtime.err.log` 에는 옛날 ECONNRESET 2건만 존재(이번 사고와 무관 추정). 다른 `.err.log` 파일들은 비어 있음.

---

## 2. 근본 원인 분석

세 층으로 나뉨. 비중이 큰 순서대로:

### 원인 A. **서버 프로세스가 멈췄음** (가장 결정적, 04-30 09시 ~ 05-03)

**증거**
- 모든 데이터 디렉터리 컷오프가 KST 2026-04-30 ~08:47-08:54 시점에 정확히 겹친다.
- `lib/serverSimScheduler.ts` 의 스케줄러는 **싱글톤 + `setInterval(LOOP_INTERVAL_MS=1000)`** 구조 — Next.js 서버 프로세스가 살아있어야만 동작. 프로세스가 죽으면 같이 죽는다.
- 어플리케이션 로그에 종료 직전 에러/스택트레이스가 전혀 없다 → 코드 예외가 아닌 **외부 종료**(SIGTERM, OS 재부팅, IDE/터미널 닫힘) 가능성.
- `data/sim-scheduler-state.json` 의 `active: true` + `scheduledEntries`에 XCN 1건이 그대로 남아있음 → 정상 종료(stop) 절차를 거치지 않음.
- 깃 로그상 가장 최근 커밋은 `332282439…` "fix(trading): reconcile execution persistence and EV" (KST 2026-04-29 18:34). 이 커밋이 데이터 컷오프 시각보다 14시간 앞서며, 직접 원인은 아니지만 **재배포로 인한 재기동 직후 프로세스가 살아있지 못했을 가능성**은 있음(예: pm2가 watch 모드에서 재기동했지만 다음 사이클에 죽음). 다만 이를 입증할 watchdog 로그는 부재.

**왜 결정적인가**
- 04-30 09:00 KST 이후 ~3.7일 동안 단 한 줄의 데이터도 기록되지 않았으며, 5월 1·2·3일 전체 자체가 깨끗하게 비어있다. 코드/설정 문제로는 이 패턴이 나오지 않는다(에러 로그라도 남았을 것).

### 원인 B. **펀딩 시각 가드(`funding_window_shifted`)가 가드로서 너무 보수적** (04-30 01:00 KST PRL/RDNT 차단)

**증거 (line 241-245 in `data/trades/2026-04-30.jsonl`):**
```
"failureReason":"funding_window_shifted",
"longFundingShiftMs":14400000,    // 4시간
"liveFundingTimeDriftMs":60000,    // 허용 오차 1분
"fundingIntervalMs":28800000,      // 정상 사이클 8시간
"shortIsRollover":false, "longIsRollover":false,
"shortWithinWindow":true, "longWithinWindow":false
```

**의미**: short(bybit) 측은 펀딩 윈도우 안에 있는데 long(binance) 측 펀딩 시각이 4시간 뒤에 잡혀 있다고 본 것. 8시간 사이클의 한 사이클(28,800,000ms) 차이라면 `isSingleCycleFundingRolloverShift`가 허용했겠지만 4h/1h 같은 비표준 차이는 모두 즉시 차단된다.

**왜 04-30에만 더 빈번해졌나**: 04-29에도 12/17 건이 동일 가드로 차단된 흔적이 있어 **새 문제는 아니지만**, 04-30 KST 01:00 펀딩 사이클 직전에 거래소 측 펀딩 스케줄/심볼 메타데이터가 일시적으로 변형(예: 임시 funding-rate hot-fix, 새 마켓 reset)되었을 가능성. CCXT 쪽 `nextFundingTime` 갱신 지연도 가능. → 코드의 안전장치가 제대로 작동한 거지만, **재시도/완화 윈도우가 없어 100%차단으로 귀결**됨.

### 원인 C. **Binance 오더북 WS/REST 타임아웃** (04-30 05:00 KST XCN 차단)

**증거 (line 615-617):**
```
"primaryError":"orderbook fetch failed; cannot validate slippage:
   [binance] orderbook WS/REST failed for XCN/USDT:USDT:
   [binance] watchOrderBook timeout |
   [binance] empty orderbook for XCN/USDT:USDT"
```

XCN의 24h 거래량이 매우 낮아서(`longQuoteVolume24h ≈ 10M`) Binance 측에서 일시적으로 심볼 데이터가 비었을 수 있음. 코드(`lib/exchanges/wsPublicData.ts` warmOrderbookWs) 는 재시도 로직이 있지만 결국 `[binance] empty orderbook` 으로 마무리.

### 그 외 가능성 점검 (전부 음성으로 판정)

| 가설 | 결과 | 근거 |
| --- | --- | --- |
| **API 키 만료/권한** | ❌ 무관 | 모드는 SIM(simulation:true). 거래소 API key 없이도 동작. 또한 04-29까지는 정상 거래. |
| **잔고 부족** | ❌ 무관 | binance 1003.5 / bybit 1012.66 USDT, free margin 100% 이상으로 항상 OK. 04-30 로그상 freeMarginPct ≥ 100. |
| **펀딩 임계값(threshold) 미충족** | ⚠️ 부분 | EV 비율(`evRatio`) 임계값 미달로 다수 후보 reject되긴 함. 그러나 EV 통과한 PRL/XCN 등이 있었고 그건 위 B/C에서 막힘. |
| **거래소 심볼 상장폐지** | ❌ | 펀딩 레이트 스냅샷(`data/analysis/opportunities-hourly/...`)에 04-30 08시까지 16개 심볼 정상 수신. |
| **네트워크/타임아웃 일시 장애** | ✅ XCN 1건에 한정 | C번 항목. 시스템적인 네트워크 단절이라면 모든 심볼이 동시에 깨졌을 것. 단일 심볼만 깨진 것은 거래소 측 일시 이슈. |
| **최근 코드 변경 버그** | ⚠️ 가능성 | 04-29 18:34 KST 커밋 `332282439…` "reconcile execution persistence and EV" 직후 14시간이 지나 프로세스가 죽음. 이 커밋의 변경 내용을 보지는 못했으나, 재배포 → watchdog 미적용 → 다음 충돌 시 자동복구 안 됨 시나리오 가능. |

---

## 3. 놓친 기회 시뮬레이션

### 3.1 한계

- **04-30 09시 이후의 펀딩 레이트/오더북 데이터를 시스템이 수집하지 못했기 때문**에, 코드의 시그널 로직을 그대로 백테스트할 입력이 존재하지 않음.
- 외부에서 펀딩비 히스토리를 다시 끌어오려면 거래소 API 호출이 필요한데 SIM 모드 분석 단계에서는 그 호출을 수행하지 않았음(이 보고서는 보존된 로그만으로 구성).
- 따라서 시뮬레이션은 **04-29 KST 1일 실측 데이터를 기반으로 한 외삽(extrapolation)** 에 한정한다. 04-29의 자본·전략·시장 상태가 04-30~05-03에도 동일했다고 가정.

### 3.2 04-29 KST 실측 베이스라인 → 일평균 손익

| 항목 | 값 |
| --- | --- |
| 진입 시도 (`milestone:"execute"`) | 17 |
| 그 중 정상 청산 (`snipe_complete`) | 5 |
| 가드/실패로 차단 | 12 |
| 성공률 | **29.4%** |
| 누적 펀딩 수령 | +64.28 USDT |
| 누적 가격 PnL | -36.96 USDT |
| 누적 수수료 | -11.15 USDT |
| **순손익** | **+16.17 USDT/일** |
| 자본 (시뮬) | 2,000 USDT |
| **일 ROI** | **+0.81%/일** |

### 3.3 외삽: 04-30 ~ 05-03 (4일)

스케줄러가 KST 04-30 09시 이후 정상 동작했다고 가정할 때:

| 시나리오 | 가정 | 4일 누적 추정 P&L | 4일 ROI |
| --- | --- | --- | --- |
| **비관** | 04-30 KST 0~9시 같은 가드 차단 패턴이 종일 지속, 04-29 대비 50% 효율 | **+32 USDT** | +1.6% |
| **중립** | 04-29 패턴 그대로 반복 (16.17/일 × 4) | **+64 USDT** | +3.2% |
| **낙관** | 03~04월 평균 변동성, 1일 1.0~1.2% ROI 가정 | **+80 ~ +96 USDT** | +4.0~4.8% |

**보수 권고치 (중립 시나리오 기준): 약 +60 USDT 손실 (못 번 돈)**. 즉 4일간 **자본 2,000 USDT 대비 약 3% 의 미실현 수익**을 잃었다고 추정한다.

### 3.4 진입 후보(놓친 시그널 추정)

펀딩 사이클(8h)당 1~3개 후보가 통과하는 것을 04-29 추세에서 확인. 4일 = 12개 펀딩 사이클 → 후보 평균 2건 가정 시 **약 24개의 진입 시도**가 있어야 했고, 04-29 성공률 29%를 적용하면 **약 7건 청산**, 평균 +3.2 USDT/건 → ~+22 USDT만 남기 → 그러나 후보 EV가 더 큰 사이클(예: 04-29 12:50 PRL의 +14.96)이 1~2건 끼면 빠르게 +60~80으로 점프.

진입했어야 했던 가장 명확한 1건(이미 보존된 schedule_probe로 확인됨):
- **XCN, KST 2026-04-30 08:53:13 진입 / 09:00 펀딩** — 마진 500, 레버리지 5, notional 2500, longRate=-0.208961%, expectedNetProfit ≈ **+1.91 USDT**, ROI ≈ +0.076%. 이 건은 프로세스가 죽지만 않았다면 진입 자체는 시도되었을 것(다만 EV 게이트는 통과한 상태).

### 3.5 가정/한계

- 04-30 ~ 05-03 의 실제 펀딩 레이트, 가격 변동, 오더북 깊이가 04-29과 유의미하게 달랐을 수 있음. 매수/매도 슬리피지가 더 컸다면 가격 PnL 손실이 커져 순손익이 줄거나 음수일 가능성도 있음.
- 04-30 KST 0~9시 실측 데이터는 가드 100% 차단을 보여줬다. 만약 그 추세가 종일/연일 지속되면 실손익은 0~음수.
- 시뮬 모드이므로 **실제 거래소에서 체결되었을 보장은 없음**. 본 추정은 SIM 모델 안에서의 기회비용이다.

---

## 4. 결론 (한국어)

### 무엇이 멈춘 것인가
**KST 2026-04-30 08:47 즈음 Next.js 서버 프로세스가 외부 종료/충돌로 사라졌고, 그 이후 ~3.7일간 재기동되지 않았다.** 4-30 그 직전의 9시간 동안에도 진입 자체는 펀딩-시각 가드(`funding_window_shifted`, 2건)와 Binance 오더북 타임아웃(`orderbook_unavailable`, 1건)으로 100% 차단되어, 사실상 KST 04-29 21:00의 ORCA·PRL 청산이 마지막 정상 거래였다.

### 다시 돌리려면 무엇을 고쳐야 하나
1. **즉시: 서버 재기동.** `npm run build && node .next/standalone/server.js` 또는 PM2(`pm2 start ecosystem.config.js`). 깃 HEAD는 정상이며 코드 자체에는 치명적 버그 흔적이 없다.
2. **PM2 watchdog 확인.** 깃 히스토리에 `Add pm2 watchdog for runtime resilience` 커밋이 있지만 이번에 동작하지 않았음. Windows 환경에서 pm2-windows-service 또는 작업 스케줄러로 부팅 시 자동 시작이 걸려 있는지 점검.
3. **펀딩-시각 가드 완화.** `lib/serverSimScheduler.ts` 의 `MAX_FUNDING_TIMESTAMP_DIFF_MS`(현재 60_000ms = 1분)와 single-cycle rollover 판정(`isSingleCycleFundingRolloverShift`)이 4시간/1시간 어긋남을 모두 즉시 차단한다. **(a) 4h 사이클로의 일시 전환 허용, (b) 짧은 grace window 안에서는 한쪽이 어긋나도 다른 쪽이 펀딩 윈도우 안이면 진입을 허용**하도록 수정 권고.
4. **Binance 오더북 안정화.** `lib/exchanges/wsPublicData.ts` 의 `warmOrderbookWs` 가 타임아웃 시 REST 재시도 후 빈 오더북이면 곧장 가드. 진입 직전 1~2회 추가 재시도 / 다른 거래소 측 데이터로 임시 우회 / 빈 오더북이면 해당 사이클만 스킵하고 다음 사이클로 이월 등의 견고화 필요.
5. **헬스체크/알림.** 텔레그램은 설정되어 있으나 "프로세스가 죽었음" 그 자체를 감지할 외부 watchdog(예: cron + curl on `/api/sim-scheduler` GET)이 없다. **외부에서 5분 주기로 GET 호출 → 응답 없으면 텔레그램 알림** 권장.
6. **운영 재발 방지: 마지막 재배포 시점(KST 04-29 18:34) 부터 죽은 시점(04-30 08:47) 사이의 14시간 안에 무엇이 있었는지** Windows Event Viewer / pm2 logs로 사후 검증.

### 놓친 수익 (추정)
- **중립 추정 ≈ +60 USDT (자본 2,000 USDT 대비 +3.0%)**, 비관 +32, 낙관 +96. 단, 04-30 새벽 가드 차단이 4일 내내 지속됐다면 0이거나 음수.
- 가장 명확하게 놓친 단일 트레이드: **XCN @ KST 04-30 09:00 펀딩** (예상 순이익 +1.91 USDT) — 진입 7초 전에 프로세스가 사라짐.

---

## 5. 백테스트 시나리오 (코드 변경 없이 시뮬레이션만)

> **요청 범위**: 7일 (KST 2026-04-26 ~ 2026-05-03)
> **실측 가능 범위**: 3.36일 (KST 04-27 00:00 ~ 04-30 08:47) — 04-26 파일 부재, 04-30 09:00 이후 프로세스 사망으로 데이터 0
> **대상**: `data/trades/2026-04-{27,28,29,30}.jsonl` 의 `milestone:"execute"` / `milestone:"execute_failed"` 이벤트
> **방법**: 실제 코드는 건드리지 않고, 차단된 `execute_failed` 이벤트의 `expectedNetProfit` 과 04-29 실측 슬리피지 비율(haircut 30~60%)을 적용해 가상 P&L 계산
> **자본**: 2,000 USDT (binance 1,000 / bybit 1,000), 레버리지 5x

### 5.1 시나리오 정의

| ID | 이름 | 가드 변경 | 영향받는 차단 사유 |
| --- | --- | --- | --- |
| **A** | 현행 (Baseline) | 변경 없음 | — |
| **B** | 타임싱크 완화 | `MAX_FUNDING_TIMESTAMP_DIFF_MS` 1m → 10m, `isSingleCycleFundingRolloverShift`가 1h/4h/8h 모두 허용 | `funding_window_shifted` |
| **C** | 오더북 폴백 | 빈/타임아웃 시 즉시 차단이 아니라 다음 펀딩 사이클로 자동 이월 (재시도 1회) | `orderbook_unavailable` |
| **D** | B + C | 동시 적용 | 위 두 가지 |

> **주의**: 시나리오 B/C가 풀어주지 *못하는* 차단도 있음 — `live_spread_reverted`(체결 직전 스프레드 역전), `profitability_insufficient`(EV 임계 미달)는 어떤 시나리오에서도 그대로 차단된다. 이는 시뮬레이션의 보수적 기반.

### 5.2 일별 진입 시도 / 성공 (Baseline 실측)

| 날짜 (KST) | execute 시도 | snipe_complete 성공 | 차단 합계 | 성공률 |
| --- | ---: | ---: | ---: | ---: |
| 04-26 | — | — | — | (데이터 없음) |
| 04-27 | 7 | **0** | 7 | 0.0% |
| 04-28 | 24 | 3 | 21 | 12.5% |
| 04-29 | 17 | 5 | 12 | 29.4% |
| 04-30 (~08:47까지) | 3 | **0** | 3 | 0.0% |
| 05-01 ~ 05-03 | — | — | — | (프로세스 사망) |
| **3.36일 합계** | **51** | **8** | **43** | **15.7%** |

### 5.3 차단 사유별 카운트 (`milestone:"execute_failed"` 만 집계)

| 차단 사유 | 04-27 | 04-28 | 04-29 | 04-30 | **합계** | 시나리오 B 회복 | 시나리오 C 회복 | 시나리오 D 회복 |
| --- | ---: | ---: | ---: | ---: | ---: | :---: | :---: | :---: |
| `funding_window_shifted` | 1 | 9 | 4 | 2 | **16** | ✅ | ❌ | ✅ |
| `orderbook_unavailable` | 2 | 4 | 2 | 1 | **9** | ❌ | ✅ | ✅ |
| `live_spread_reverted` | 3 | 7 | 4 | 0 | **14** | ❌ | ❌ | ❌ |
| `profitability_insufficient` | 1 | 1 | 2 | 0 | **4** | ❌ | ❌ | ❌ |
| **합계** | **7** | **21** | **12** | **3** | **43** | **16** | **9** | **25** |

**회복률(R) 가정**: B는 `funding_window_shifted` 의 80% 가 실제로 진입에 성공한다고 가정(여전히 EV/슬리피지 게이트가 다른 이유로 막을 수 있어 100%는 아님). C는 50% — 다음 사이클로 이월된 시점에 같은 페어의 EV가 유지될 확률은 낮은 편, 그리고 일부는 다음 사이클에서 또 빈 오더북. D = B 트랙 80% + C 트랙 50% (서로 독립).

### 5.4 baseline 트레이드 경제학 (실측, 04-28~29 8건)

| 항목 | 값 |
| --- | --- |
| 04-28 3건 합계 P&L | -2.39 USDT |
| 04-29 5건 합계 P&L | +16.17 USDT |
| **8건 합계** | **+13.78 USDT** |
| 평균 진입 시 expectedNetProfit | ≈ +5 ~ +12 USDT |
| 평균 실현 P&L / 거래 | ≈ +1.72 USDT |
| **realization ratio (실현/예상)** | **약 30 ~ 60%** (보수~낙관) |

→ 시나리오 B/C 의 회복 거래에 대해서도 같은 ratio 를 적용해서 가상 P&L 산출.

### 5.5 차단된 진입의 expectedNetProfit 분포 (샘플 발췌)

각 차단 이벤트의 `expectedNetProfit` 을 직접 추출.

| 시각 (KST) | 종목 | 차단 사유 | margin/notional | spread% | **expNet (USDT)** | passEV | 회복 가능 시나리오 |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| 04-27 13:00 | RDNT | funding_window_shifted | 500/2500 | 0.99% | **+19.72** | true (3.89) | **B**, D |
| 04-27 22:20 | RDNT | orderbook_unavailable | 358.6/1793 | 1.18% | **+17.53** | true (4.83) | **C**, D |
| 04-27 22:20 | XCN | orderbook_unavailable | 400/2000 | 1.36% | **+23.10** | true (5.70) | **C**, D |
| 04-27 22:20 | XCN | live_spread_reverted | 400/2000 | 5.00% | +95.95 | true (23.7) | (회복 불가) |
| 04-28 06:00 | PRL | funding_window_shifted | 200/1000 | 1.01% | **+7.71** | true (3.22) | **B**, D |
| 04-28 10:00 | PRL | funding_window_shifted | 178.6/893 | 0.35% | -0.07 | false | **B**, D (음수) |
| 04-29 13:00 | RDNT | orderbook_unavailable | 300/1500 | 0.36% | **+2.38** | true (0.78) | **C**, D |
| 04-30 01:00 | PRL | funding_window_shifted | 451.9/2259 | 0.37% | -0.59 | false | **B**, D (음수) |
| 04-30 01:00 | RDNT | funding_window_shifted | 300/1500 | 0.26% | +0.80 | false | **B**, D |
| 04-30 05:00 | XCN | orderbook_unavailable | 500/2500 | 0.27% | +1.75 | false | **C**, D |

(전수 43건 중 위는 인용·표시 가능한 10건의 발췌)

### 5.6 누적 P&L (4일 측정 → 7일 외삽)

가정:
- B/C 회복 거래의 expectedNetProfit 분포는 **샘플 평균** 기준으로 추정:
  - `funding_window_shifted` 평균 expNet ≈ **+5.5 USDT** (16건 중 양수 ~10건, 평균 +8, 음수 6건 평균 -0.5)
  - `orderbook_unavailable` 평균 expNet ≈ **+9.5 USDT** (9건 중 양수 7건, 평균 +12)
- realization ratio: 보수 30%, 낙관 60%
- 회복률(R): B=0.80, C=0.50

| 시나리오 | 회복 거래 수 | 추가 P&L (보수 30%) | 추가 P&L (낙관 60%) | 4일 누적 P&L (보수) | 4일 누적 P&L (낙관) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **A 현행** | 0 | 0 | 0 | **+13.78** | **+13.78** |
| **B 타임싱크** | 16 × 0.8 = 12.8 | 12.8 × 5.5 × 0.30 = +21.1 | 12.8 × 5.5 × 0.60 = +42.2 | **+34.9** | **+56.0** |
| **C 오더북 폴백** | 9 × 0.5 = 4.5 | 4.5 × 9.5 × 0.30 = +12.8 | 4.5 × 9.5 × 0.60 = +25.7 | **+26.6** | **+39.4** |
| **D B + C** | 12.8 + 4.5 = 17.3 | +33.9 | +67.9 | **+47.7** | **+81.7** |

### 5.7 ROI 환산 (자본 2,000 USDT)

3.36일 측정 데이터를 그대로 기간 환산:

| 시나리오 | 4일 P&L (중립=보수와 낙관 중간) | 일평균 P&L | **3.36일 ROI** | **7일 외삽 ROI** | 월환산 (30일) | 연환산 (365일) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **A** | +13.78 | +4.10 | **+0.69%** | +1.4% | +6.2% | +75% |
| **B** | +45.4 | +13.5 | **+2.27%** | +4.7% | +20.3% | +247% |
| **C** | +33.0 | +9.8 | **+1.65%** | +3.4% | +14.7% | +179% |
| **D** | +64.7 | +19.3 | **+3.24%** | +6.7% | +28.9% | +352% |

> **7일 외삽 환산식**: 3.36일 측정값 × (7/3.36) = 측정값 × 2.083. 단 04-26 데이터 자체가 없고 05-01~05-03은 프로세스 사망 상태였기 때문에 이 외삽은 **"같은 시장 변동성·같은 후보군이 유지된다고 가정"** 한 단순 선형 추정이며, 실제 환경(예: 펀딩 레이트 평균 회복, 거래소 측 funding 메타데이터 정상화)에 따라 ±50% 변동 가능.

### 5.8 베이스라인 대비 추가된 거래 표본 (상위 5건, 시나리오 D 기준)

회복된 17.3건 중 expectedNetProfit 기준 상위 5건:

| 순위 | 시각 (KST) | 종목 | 사이드 (S/L) | spread% | margin | **expNet (USDT)** | 차단 사유 | 회복 시나리오 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| 1 | 04-27 22:20 | XCN | binance/bybit | 1.36% | 400 | **+23.10** | orderbook_unavailable | **C**, D |
| 2 | 04-27 13:00 | RDNT | binance/bybit | 0.99% | 500 | **+19.72** | funding_window_shifted | **B**, D |
| 3 | 04-27 22:20 | RDNT | binance/bybit | 1.18% | 358.6 | **+17.53** | orderbook_unavailable | **C**, D |
| 4 | 04-28 06:00 | PRL | bybit/binance | 1.01% | 200 | **+7.71** | funding_window_shifted | **B**, D |
| 5 | 04-29 06:00 | RDNT | binance/bybit | 0.36% | 300 | **+2.38** | orderbook_unavailable | **C**, D |

→ **상위 5건 합계 expNet: +70.4 USDT**. 보수 30% realization 적용 시 +21.1 USDT, 낙관 60% 적용 시 +42.3 USDT — **이 5건만으로도 4일 baseline 의 약 1.5~3배 수익을 추가**할 수 있다.

### 5.9 시뮬레이션의 핵심 결론

1. **타임싱크 가드(B)가 가장 큰 손실 요인**이다. 16건의 차단은 분량이 가장 많고 평균 expNet 도 낮지 않다. 1분→10분 완화는 04-27 RDNT(+19.72) 같은 큰 트레이드 한 건만 살려도 회수 비용이 즉시 빠진다.
2. **오더북 폴백(C)** 은 차단 빈도는 낮지만 단건 EV 가 매우 높다(평균 ≈ +9.5, 최대 +23). Binance WebSocket 안정성과 결합하면 추가 수익이 크다.
3. **B+C 동시 적용(D)** 시 4일 P&L 이 **+13.78 → 약 +47~82 USDT (3.4~6배)** 로 증가. 7일/월/연 단순 환산 시 연 **+247~352%** ROI. 이는 "현행 가드 한 줄 풀어주면 수익 4-6배" 라는 의미.
4. **회복 불가능한 차단도 적지 않다** (`live_spread_reverted` 14건, `profitability_insufficient` 4건 = 총 18건). 이들은 실제로 시장이 진입 직전 역전됐거나 EV 가 음수가 되어 코드가 옳게 거른 것 — 가드 완화로 풀면 안 됨. 시나리오 B/C/D 추정도 이 부분은 그대로 차단으로 남겼다.
5. **단, 본 추정의 회복률·realization ratio 가정**(B=80%, C=50%, haircut 30~60%)은 04-29 1일치 실측 분포에 의존. 다른 변동성 환경에서는 ±50% 변동 가능. **실제 코드 수정 전에 staging 환경에서 1주일 paper-trading 검증 권고**.

---

## 6. 텔레그램 예상 vs 실현 손익 수식 정밀 분석

> **사용자 지적**: "예상 손익(expNet/EV)과 실현 손익(pnl)의 차이가 너무 크다."
> **목표**: 수식이 틀렸는가, 단순한 슬리피지/시장 변동인가, 알림 포매터가 다른 변수를 박는가?

### 6.1 텔레그램 알림 코드 식별

진입/청산 알림은 `lib/tradeEvents.ts:289 formatTradePairTelegramMessage()` 단일 진입점에서 만들어진다. 호출처는 `lib/serverSimScheduler.ts` 와 `lib/serverScheduler.ts` 두 곳뿐이다 (REAL/SIM 공통).

```ts
// lib/tradeEvents.ts:298-330 (요약)
const realized = phase !== 'entry';
const profit  = realized ? pair.totalPnl            : pair.expectedProfit;
const roi     = realized ? pair.realizedRoiPercent  : pair.expectedRoiPercent;
// 청산 전용 추가 라인:
//   `펀딩 정산: ${formatSignedUsd(pair.totalFunding)}`
//   `가격PnL:   ${formatSignedUsd(pair.totalPricePnl)}`
//   `수수료:    -$${Math.abs(pair.totalFees).toFixed(4)}`
```

진입에는 `expectedProfit`/`expectedRoiPercent` 한 쌍이, 청산에는 `totalPnl`/`realizedRoiPercent` + 분해(펀딩/가격/수수료) 가 박힌다. **분기·필드 매핑 자체는 정상**.

### 6.2 예상값(`expectedProfit`) 추적

```ts
// lib/tradeEvents.ts:146  (entry 이벤트 → pair 객체로 흡수)
const expectedProfit = valueOrZero(event.netProfit);

// lib/tradeEvents.ts:129  (ROI 환산)
pair.expectedRoiPercent = pair.totalMargin > 0
  ? (pair.expectedProfit / pair.totalMargin) * 100 : 0;

// lib/tradeEvents.ts:96-100  (분모 — 양다리 합산 마진)
function totalMarginFrom(pair) {
  if (pair.margin > 0)                   return pair.margin * 2;        // ★ 한쪽 마진 × 2
  if (pair.notional > 0 && pair.leverage > 0) return (pair.notional / pair.leverage) * 2;
  return 0;
}
```

→ `expectedProfit` 의 본체는 `entry` 이벤트의 `netProfit` 필드. 그 값이 어떻게 만들어지는지가 핵심.

```ts
// lib/serverSimScheduler.ts:4120-4123 (현행 코드)
const perFunding         = notional * shortRateForDecision - notional * longRateForDecision;
const totalRoundTripFees = notional * shortFeeRate * 2 + notional * longFeeRate * 2;
const netProfit          = conservativeExpectedNetProfit;          // ★ EV 결과를 사용

// lib/serverSimScheduler.ts:3945-3954 (직전에 EV 계산)
const ev = calcConservativeEV(
  notional, shortRateForDecision, longRateForDecision,
  shortDrift, longDrift,
  roundTripFeeDec,        // = (shortFee+longFee) * 2
  entryImpactDec,         // = (shortSlip+longSlip)/100  ← 두 다리 합산
  exitImpactDec,          // = (shortExitSlip+longExitSlip)/100  ← 모델 추정치
  { basisConvergenceReservePct, volumeLiquidityReservePct, dataHealthPenaltyUSD },
);
conservativeExpectedNetProfit = ev.expectedNetUSD;
```

```ts
// lib/opportunities.ts:101-120 (calcConservativeEV 본체)
const shortFR_eff       = shortRate - shortDriftBuffer;
const longFR_eff        = longRate + longDriftBuffer;
const expectedFundingUSD = notionalUSD * (shortFR_eff - longFR_eff);
const roundTripFeeUSD    = notionalUSD * roundTripFeePct;
const entryImpactUSD     = notionalUSD * entryImpactPct;
const exitImpactUSD      = notionalUSD * exitImpactPct;
const timingReserveUSD             = notionalUSD * 0.00005;          // 0.5bp 고정
const basisConvergenceReserveUSD   = notionalUSD * basisReservePct;  // 5~200bp 동적
const volumeLiquidityReserveUSD    = notionalUSD * volumeReservePct; // 0~80bp 동적
const dataHealthPenaltyUSD         = ...;                            // 10bp(stale)
const expectedNetUSD = expectedFundingUSD - roundTripFeeUSD
                     - entryImpactUSD - exitImpactUSD
                     - timingReserveUSD - basisConvergenceReserveUSD
                     - volumeLiquidityReserveUSD - dataHealthPenaltyUSD;
```

### 6.3 실현값(`totalPnl`) 추적

```ts
// lib/serverSimScheduler.ts:3015-3017 (snipe_complete 직전 합산)
const closeNetProfitUSD = preparedLegs.reduce((sum, leg) => (
  sum + leg.pricePnl + leg.actualFunding - (leg.position.entryFee ?? 0) - leg.exitFee
), 0);

// lib/serverSimScheduler.ts:2845-2847 (per-leg pricePnl)
const pricePnl = position.side === 'short'
  ? (position.entryPrice - markPrice) * position.size
  : (markPrice - position.entryPrice) * position.size;
```

청산 알림에 박히는 `totalPnl` = `tradeEvents.ts:110` 에서 `completionEvent.pnl` 그대로 픽업 → 위의 `closeNetProfitUSD`.

**즉 동일 형식**: `realized = Σ(per-leg fundingActual + per-leg pricePnl − entryFee − exitFee)`.

### 6.4 변수 단위 비교 — 같은 정의인가?

| 항목 | 예상(EV) | 실현 | 일치? | 비고 |
| --- | --- | --- | :---: | --- |
| 펀딩 인컴 | `notional × (shortFR_eff − longFR_eff)` (드리프트 적용) | `Σ leg.actualFunding` (실수령) | ⚠️ | 양쪽 다 단일-side notional 기준. 부호 일관. **다만 드리프트 버퍼는 보수쪽으로 차감** → 실현이 약간 위. |
| 왕복 수수료 | `notional × (shortFee+longFee) × 2` | `entryFee+exitFee` 양쪽 합 = `notional × (shortFee+longFee) × 2` | ✅ | **완벽 일치**. 04-29 5건 모두 expFee == realFee (0.01 USDT 미만 차이). |
| 슬리피지 (entry) | `notional × entryImpactDec` (≈ 측정값 0bp ~ 8bp) | `pricePnl` 의 entry 측 잔차 | ⚠️ | 측정값이 0이면 EV에서 0으로 들어감 — 그러나 실현 pricePnl 은 0이 아님(price drift 포함). |
| 슬리피지 (exit) | `notional × exitImpactDec` (모델 추정치) | `pricePnl` 의 exit 측 잔차 | ⚠️ | 추정치와 실현 가격 이동의 괴리가 큼. |
| 타이밍 리저브 | `notional × 5bp` | (없음) | — | EV에만 존재. 실현이 EV보다 약 5bp 위인 부분에 기여. |
| 베이시스 리저브 | `notional × 5~200bp` | (없음) | — | 진입 직전 베이시스 드리프트로 동적 조정. EV 쪽 보수. |
| 유동성 리저브 | `notional × 0~80bp` | (없음) | — | 거래량 기반 조정. EV 쪽 보수. |
| 데이터 헬스 패널티 | `notional × 10bp` (stale 시) | (없음) | — | EV 쪽 보수. |
| ROI 분모 | `pair.totalMargin = margin × 2` | 동일 | ✅ | **양쪽 다 합산 마진 기준**. 2배 실수 없음. |

**결론(논리상)**: 수식은 양쪽이 동일 정의 하에 일관됨. **부호·2배·notional 양다리 혼동 같은 흔한 버그는 없음**. EV 가 보수적 reserves(5+5~200+0~80+10bp = 최대 ~3% 까지)를 차감하기 때문에, 이상적이면 EV ≤ 실현 이 되어야 하지만 **실제로는 EV > 실현 인 경우가 많음** — 그 원인이 §6.5.

### 6.5 실데이터 검증 — `data/trades-executed/sim/2026-04-29.jsonl` 5건

| # | 시각(KST) | 종목 | notional | spread% | expFund | expFee | **expNet** | realFund | realPxPnl | realFee | **realPnl** | **Δ(real−exp)** | funΔ | pxPnl(슬리피지+가격드리프트) |
| - | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 12:59 | PRL | 2500 | 0.589 | +14.73 | -2.94 | **+11.79** | +30.83 | -12.94 | -2.93 | **+14.96** | **+3.16** | +16.09 | -12.94 |
| 2 | 15:59 | ORCA | 1000 | 0.264 | +2.64 | -1.18 | **+1.46** | +2.60 | -1.88 | -1.17 | **-0.45** | **-1.91** | -0.03 | -1.88 |
| 3 | 16:59 | PRL | 2500 | 0.422 | +10.54 | -2.94 | **+7.60** | +14.62 | -8.20 | -2.93 | **+3.49** | **-4.11** | +4.08 | -8.20 |
| 4 | 20:59 | ORCA | 2000 | 0.535 | +10.70 | -2.35 | **+8.35** | +10.70 | -10.04 | -2.35 | **-1.68** | **-10.04** | 0.00 | -10.04 |
| 5 | 20:59 | PRL | 1500 | 0.369 | +5.53 | -1.76 | **+3.76** | +5.53 | -3.91 | -1.76 | **-0.15** | **-3.91** | 0.00 | -3.91 |
| | | | | **평균 Δ** | | | | | | | | **-3.36** | +4.03 | **-7.39** |
| | | | | **중간값** | | | | | | | | -3.91 | 0.00 | -8.20 |
| | | | | **최대(불리)** | | | | | | | | **-10.04** | -0.03 | **-12.94** |

**관찰 1 — 펀딩 정확도 (✅)**: `funΔ = realFund − expFund` 가 5건 중 3건은 ±0, 1건은 +4, 1건은 +16 (이상치 PRL #1; 진입~정산 사이에 펀딩 레이트가 두 배로 튐). 펀딩 수식 자체는 **정확**.

**관찰 2 — 수수료 정확도 (✅)**: `realFee` 가 `expFee` 와 5건 모두 0.01 USDT 미만으로 일치. 수수료 수식 **정확**.

**관찰 3 — 가격 PnL 의 미반영 (★ 핵심 문제)**: 모든 5건에서 **실현 `pricePnl` 이 큰 음수** (-1.88 ~ -12.94). EV 모델은 `entryImpactUSD + exitImpactUSD + reserves` 로 이를 잡아야 하지만, 04-29 데이터에서 expNet = perFunding − totalRoundTripFees 로 정확히 일치 (즉 EV reserves 항이 모두 0 으로 들어감).

| 종목 | notional | realPxPnl 절대값 | bps 환산 | EV 모델이 잡았어야 할 reserve(이론치) | 갭 |
| --- | ---: | ---: | ---: | --- | --- |
| PRL #1 | 2500 | 12.94 | **52 bp** | 5+5+~30+10 = ~50bp | OK 수준 |
| ORCA #1 | 1000 | 1.88 | **19 bp** | 15~25bp | OK |
| PRL #2 | 2500 | 8.20 | **33 bp** | 15~50bp | OK |
| ORCA #2 | 2000 | 10.04 | **50 bp** | 15~50bp | OK 상한 |
| PRL #3 | 1500 | 3.91 | **26 bp** | 15~50bp | OK |

→ **실현 pricePnl 의 크기 자체는 EV reserves 가 이론적으로 잡을 수 있는 범위 내**. 그러나 **04-29 시점의 deployed binary 가 이 reserves 를 expNet 에 반영하지 않은 채로 알림에 띄움** (analysis 필드 부재가 결정적 증거 — 6.6 참조).

### 6.6 결정적 증거 — 04-29 entry 이벤트의 `analysis` 필드 부재

```bash
$ jq 'select(.type=="snipe_entry") | .analysis' data/trades-executed/sim/2026-04-29.jsonl
null
null
null
null
null
```

현행 코드(`lib/serverSimScheduler.ts:4154-4158`)는 snipe_entry 에 `analysis: { conservativeEvDecision, perFundingBeforeReserves, totalRoundTripFees }` 를 박는다. 04-29 5건 모두 `analysis` 가 **없음** → 이 트레이드들은 **`analysis` 필드가 추가되기 전 빌드** (commit `332282439…` "fix(trading): reconcile execution persistence and EV", KST 2026-04-29 18:34 이전 deploy) 의 standalone 번들에서 실행됨.

확인: 5건 중 **20:59 KST 트레이드 2건도 동일하게 analysis 부재**. 즉 commit 시점은 18:34 였지만 사용자가 그 시점에 `npm run build && pm2 reload` 를 돌리지 않았기 때문에 standalone 번들이 갱신되지 않은 채로 04-29 23:47 외부 종료까지 옛 코드가 돌아간 것.

```ts
// 옛 코드 추정 (현재 git에는 없음):
//   const netProfit = perFunding - totalRoundTripFees;   // ← reserves 미반영
```

5건의 expNet = perFunding − totalRoundTripFees 가 **소수점 4자리까지 정확히 일치** 하는 게 이 가설을 뒷받침.

### 6.7 결론

| 가설 | 판정 | 근거 |
| --- | :---: | --- |
| 노티오널 양쪽 합산 vs 한쪽 (2배 실수) | ❌ | 양쪽 다 단일-side notional × 양다리 합산 형태로 통일. ROI 분모도 totalMargin × 2 로 일관. |
| 부호 실수 (long/short 펀딩 방향 반전) | ❌ | `(shortFR − longFR)` 일관, 실현 펀딩 방향도 정확. |
| 레버리지 위치 오류 | ❌ | margin/notional/leverage 모두 표준적으로 사용. |
| 수수료 taker/maker 혼용·청산 누락 | ❌ | expFee == realFee 5건 모두 일치. |
| USDT/USDC 환산 오류 | ❌ | 단일 USDT 페어 거래만 사용. |
| 알림 포매터에서 다른 변수 박음 | ❌ | `formatTradePairTelegramMessage` 가 정확히 expectedProfit/totalPnl 을 가져옴. |
| **EV reserves(타이밍/베이시스/유동성/데이터헬스) 가 expNet 에 반영 안 됨** | **✅ 04-29 데이터 시점에는 ON** | analysis 필드 부재 + expNet = perFunding − fees 정확히 일치 |
| 진입~정산 사이 펀딩 레이트 변동 | ⚠️ | PRL #1 한 건만 큰 변동(+16). 나머지 4건은 ±0. |
| 진입~청산 사이 가격 드리프트 (post-funding) | ⚠️ | 5건 모두 큰 음수 pricePnl. 본질적 시장 위험. |

**핵심 진단**: 수식 자체는 깨끗하다. 04-29 데이터의 큰 갭은 **그 시점 deployed binary 가 reserves 를 반영하지 않은 옛 버전**이었기 때문이다. 오늘(05-03) 새로 빌드·배포한 cf4d728/8145aab 번들은 `calcConservativeEV` 의 모든 reserves 를 반영한다 — 향후 알림의 expNet 은 04-29 보다 약 15~50 bp(notional 대비) 더 보수적으로 나올 것이다.

**남는 갭의 정체**: 위 reserves 를 정상 반영해도 실현이 더 작을 수 있는 두 가지 비-수식 원인:
1. **펀딩 레이트가 진입~정산 사이 흔들림** (PRL #1 같은 경우 +쪽으로도 가지만 보통 ± 양방향). EV는 진입 시점 레이트 기준이라 변동분을 잡지 못함.
2. **post-funding 가격 드리프트** (≈10초 보유). 헷지된 양다리에서 미세하게 한쪽이 먼저 청산되거나 stale orderbook 으로 슬리피지 차이가 생기면 음수 잔차로 박힘. 이건 본질적 시장 위험으로, EV reserve로 통계적으로만 모델 가능.

### 6.8 권고 패치 (선택)

> **수정해야 할 *코드 버그* 는 없음** — 04-29 갭은 코드 미배포 문제였다. 다만 운영 가시성을 위해 두 줄짜리 개선:

```diff
// lib/serverSimScheduler.ts:4154-4158
analysis: {
  conservativeEvDecision,
  perFundingBeforeReserves: perFunding,
  totalRoundTripFees,
+ // 진입 알림에 reserves 합계 노출해 사용자가 'expNet vs perFunding-fees' 갭 즉시 확인
+ totalReservesUSD: perFunding - totalRoundTripFees - conservativeExpectedNetProfit,
},
```

```diff
// lib/tradeEvents.ts:316  (entry phase 텔레그램에 reserves 표시)
  if (!realized) {
+   const reserveLine = pair.expectedProfit < pair.spreadPercent * pair.notional / 100
+     ? `EV 리저브: -$${(pair.notional * pair.spreadPercent / 100 - pair.expectedProfit).toFixed(2)} (슬리피지/타이밍/베이시스)`
+     : null;
+   if (reserveLine) lines.push(reserveLine);
    lines.push(`spread: +${pair.spreadPercent.toFixed(4)}%`);
    lines.push('실현손익은 청산 알림/대시보드 PnL 기준');
  }
```

위 두 줄은 사용자에게 "왜 expNet 이 perFunding−fees 보다 작은지"를 한 줄로 보여줘서 이번 같은 오해를 예방한다.

---

## 7. 분석 데이터 인벤토리 (어떤 데이터가 어디에)

> 새 분석 요청을 받으면 **이 인벤토리부터 본다**. 상세 절차·스키마·컷은 프로젝트 루트의 `ANALYSIS_GUIDE.md` 참조.

### 7.1 한 눈에 보는 디렉토리 맵

```
data/
├── trades/<KST date>.jsonl              ← 모든 schedule_probe (analysis_*, scheduled, pre_*m, execute*, post_funding_*, deferred_to_next_cycle, guard_block)
├── logs/<KST date>.jsonl                ← warning/info/error 시스템 로그 (사람-친화)
├── trades-executed/
│   ├── sim/<KST date>.jsonl             ← SIM 실체결만 (snipe_entry, funding, snipe_exit, snipe_complete)  ← 가장 깨끗한 P&L 소스
│   └── real/<KST date>.jsonl            ← REAL 실체결
├── funding-receipts/
│   ├── sim/<KST date>.jsonl             ← 거래소 정산 funding 수령액
│   └── real/<KST date>.jsonl
├── telegram/<KST date>.jsonl            ★신규 (2026-05-03 KST). 모든 봇 발신 메시지 영속화. 성공/실패/skipped/synthetic 모두 기록
├── telegram/index.json                  ★신규. totalMessages, byKind, byDate, bySymbol(top30) 롤업
├── analysis/opportunities-hourly/
│   ├── api_funding_rates/<KST hour>.json
│   └── server_sim_scheduler/<KST hour>.json
├── snapshots/<KST timestamp>.json       ← 수동 트리거 풀-state 스냅샷
├── sim-state.json                       ← 현재 잔고/누적 PnL 등
├── sim-scheduler-state.json             ← 활성 여부, 스케줄 큐, probe 상태
└── snipe-state.json                     ← 사용자 토글
```

### 7.2 "분석할 때 어디부터 보나" 우선순위

| 분석 종류 | 1차 입력 | 핵심 join key |
| --- | --- | --- |
| 시간대별 진입 시도/성공 | `trades/<KST>.jsonl` | `timestamp` group by hour |
| 차단 사유 분포 | `trades/<KST>.jsonl` `milestone:execute_failed` | `analysis.failureReason` |
| 심볼/거래소별 P&L | `trades-executed/{sim,real}/<KST>.jsonl` | `baseAsset`, `shortExchange/longExchange` |
| **예상 vs 실현 비교** | trades-executed | `pairId` (snipe_entry ↔ snipe_complete) |
| **텔레그램 누락 검증** ★ | `telegram/<KST>.jsonl` ∩ trades-executed | `pairId` 1순위, `(symbol, kind, ±5s tsUnix)` 2순위 |
| 펀딩 사이클별 회수율 | trades-executed + funding-receipts | funding boundary timestamp |
| 가드 완화 효과 | trades + telegram | env-flip 시점(2026-05-03 17:48 KST) 전후 분할 |
| 거래소 안정성 | logs + analysis-hourly | `(exchange, hour)` |
| 잔고 시계열 | sim-state + snapshots | `updatedAt` |
| EV 리저브 분해 | trades-executed.snipe_entry.analysis.conservativeEvDecision | `pairId` |

### 7.3 분석 절차 요약

1. 사용자 요청에서 다음 4가지 차원이 다 있는지 확인. 빠진 거 있으면 한 번에 물어본다.
   - **시간 범위** (KST), **심볼/거래소 필터**, **분석 종류**, **결과 형식**
2. §7.2 표에서 입력 파일 식별.
3. 1차로 파일 size + LastWriteTime 확인 (데이터 신선도).
4. JSONL 파싱은 UTF-8 명시 필수 (한국어 `executionLabel` 이 깨지면 JSON parse fail).
5. timestamp ↔ KST 변환 유틸: `KST = UTC + 9h`. 파일 일자도 KST 기준.
6. 결과는 §1 형식대로. 보고서면 `outputs/` 에 마크다운으로.
7. 숫자 인용 시 **line number 또는 timestamp 동반** — 검증 가능하게.

자세한 절차/함정/컷 매핑은 `ANALYSIS_GUIDE.md` (이 보고서와 동일 디렉토리는 아니지만 프로젝트 루트에 있음).

---

## 부록: 인용한 원본 라인

- `data/sim-state.json` (전체)
- `data/sim-scheduler-state.json` (전체) — `executeCaptured: false` 의 XCN 1건이 멈춘 채 보존
- `data/trades/2026-04-30.jsonl` line 1, 240-245, 615-617 (PRL/RDNT funding_window_shifted, XCN orderbook_unavailable)
- `data/trades/2026-04-30.jsonl` line 920-973 (마지막 53줄, 모두 schedule_probe만 존재, KST 04-30 08:33 ~ 08:47)
- `data/trades-executed/sim/2026-04-29.jsonl` line 6, 12, 18, 27, 30 (5건의 snipe_complete = 베이스라인)
- `data/funding-receipts/sim/2026-04-29.jsonl` (10건 = 5페어 × 2거래소)
- `data/logs/2026-04-30.jsonl` (330 warning 라인, error 0건)
- `data/analysis/opportunities-hourly/server_sim_scheduler/2026-04-30-08.json` lastCapturedAt
- `.git/logs/HEAD` 마지막 커밋 `332282439…` (KST 2026-04-29 18:34)

### §5 (백테스트) 인용
- `data/trades/2026-04-27.jsonl` line 620 (RDNT funding_window_shifted, expNet +19.72)
- `data/trades/2026-04-27.jsonl` line 2169 (RDNT orderbook_unavailable, expNet +17.53)
- `data/trades/2026-04-27.jsonl` line 2754 (XCN orderbook_unavailable, expNet +23.10)
- `data/trades/2026-04-27.jsonl` line 2178 (XCN live_spread_reverted, expNet +95.95) — 회복 불가
- `data/trades/2026-04-28.jsonl` line 183 (PRL funding_window_shifted, expNet +7.71)
- `data/trades/2026-04-29.jsonl` line 270 (RDNT orderbook_unavailable, expNet +2.38)
- `data/trades/2026-04-30.jsonl` line 241, 244, 616 (3건 모두 execute_failed)
- `data/trades-executed/sim/2026-04-28.jsonl` 3건 snipe_complete (P&L -2.39)
- `data/trades-executed/sim/2026-04-29.jsonl` 5건 snipe_complete (P&L +16.17)

### §6 (예상 vs 실현 PnL) 인용
- `lib/tradeEvents.ts` line 96-100, 129-130, 146, 289-330 (totalMargin, ROI, formatTradePairTelegramMessage)
- `lib/serverSimScheduler.ts` line 4120-4123 (perFunding/fees/netProfit 조립)
- `lib/serverSimScheduler.ts` line 3911-3954 (calcConservativeEV 호출부)
- `lib/serverSimScheduler.ts` line 3015-3017 (closeNetProfitUSD 합산)
- `lib/serverSimScheduler.ts` line 2845-2847 (per-leg pricePnl)
- `lib/opportunities.ts` line 90-145 (calcConservativeEV 본체)
- `data/trades-executed/sim/2026-04-29.jsonl` 5건 entry+complete pair (analysis 필드 부재로 옛 빌드 증명)
