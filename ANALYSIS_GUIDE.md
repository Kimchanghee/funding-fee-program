# 분석 가이드

> 이 문서는 사용자가 "분석해줘" 라고 말할 때 Claude(또는 다른 분석가)가 어떤 데이터를 어디서 읽어, 어떤 키로 조인해, 어떤 컷으로 답하는지 명문화한다.
> 마지막 갱신: 2026-05-03 KST

---

## 1. 질문 받으면 먼저 확인할 4 차원

새 분석 요청이 들어왔을 때 아래 4 가지가 *전부* 있어야 답을 할 수 있다. 빠진 게 있으면 사용자에게 한 번에 물어본다.

| # | 차원 | 예시 |
| - | --- | --- |
| 1 | **시간 범위** | "최근 24시간", "2026-04-29 ~ 2026-05-03 (KST)" |
| 2 | **심볼/거래소 필터** | "PRL 만", "binance/bybit 페어만", "전체" |
| 3 | **분석 종류** | "시간대별 진입 시도/성공", "차단 사유 분포", "예상 vs 실현 PnL", "텔레그램 알림 누락 검증" |
| 4 | **결과 형식** | 표 / 차트 / 보고서 마크다운 / 짧은 요약 |

타임존은 항상 **KST 명시**. 데이터 timestamp 는 ms 단위 UTC 이지만 파일명/일자 cutoff 는 KST 기준임을 잊지 말 것.

---

## 2. 데이터 소스 인벤토리

| 디렉토리 / 파일 | 포맷 | 일자 키 | 무엇이 들어있나 | 핵심 join key |
| --- | --- | --- | --- | --- |
| `data/trades/<KST>.jsonl` | JSONL | KST 일자 | 모든 schedule_probe (analysis_balance, analysis_candidate, analysis_summary, scheduled, pre_30m/10m/5m/3m/1m, execute, execute_failed, execute_success, post_funding_*, deferred_to_next_cycle, guard_block) | `pairId`, `opportunityId`, `timestamp`, `baseAsset`, `shortExchange`, `longExchange` |
| `data/logs/<KST>.jsonl` | JSONL | KST 일자 | warning/info/error 레벨 시스템 로그. trades 와 거의 1:1 대응이지만 사람이 읽기 좋은 형태 | `timestamp`, `message`, `level` |
| `data/trades-executed/sim/<KST>.jsonl` | JSONL | KST 일자 | **실체결 이벤트만** — `snipe_entry`, `snipe_exit`, `funding`, `snipe_complete`. 가장 깨끗한 P&L 소스 | `pairId`, `timestamp`, `type` |
| `data/trades-executed/real/<KST>.jsonl` | JSONL | KST 일자 | REAL 모드 실체결. SIM 과 동일 스키마 | 동일 |
| `data/funding-receipts/{sim,real}/<KST>.jsonl` | JSONL | KST 일자 | 거래소가 정산한 funding 수령액 | `pairId`, `exchange`, `side`, `timestamp` |
| `data/telegram/<KST>.jsonl` | JSONL | KST 일자 | **모든 봇 발신 메시지 영속화** (2026-05-03 KST 신규). 발신 실패도 기록 | `tsUnix`, `pairId`, `kind`, `messageId`, `text`, `structured.*` |
| `data/telegram/index.json` | JSON | (전체) | 텔레그램 아카이브 롤업 — totalMessages, byKind, byDate, bySymbol(top30), byDeliverySuccess | — |
| `data/sim-state.json` | JSON | 현재 | 스냅샷: 각 거래소 잔고, 누적 펀딩/수수료/PnL, 최근 펀딩 리시트 | `updatedAt` |
| `data/sim-scheduler-state.json` | JSON | 현재 | 활성 여부, 스케줄 큐, probe 상태, 다음 펀딩 시간 | `lastRatesUpdate` |
| `data/snipe-state.json` | JSON | 현재 | 사용자 토글 (sim/real active flag) | — |
| `data/analysis/opportunities-hourly/<source>/<KST hour>.json` | JSON | KST 시간 | 시간대별 후보 스냅샷 (api_funding_rates / server_sim_scheduler) | `hourKeyKST`, `topOpportunity` |
| `data/snapshots/<KST timestamp>.json` | JSON | KST 시각 | 풀 dashboard state snapshot (수동 트리거) | — |
| `.git/logs/HEAD` | git | — | 최근 커밋 SHA·메시지 → 어떤 코드가 언제 배포됐는지 추적 | commit SHA |

### 2.1 텔레그램 아카이브 스키마

`data/telegram/<KST>.jsonl` 의 한 줄:

```json
{
  "ts":              "2026-05-03T18:00:53.123+09:00",
  "tsUnix":          1777798853123,
  "messageId":       482915,
  "chatId":          "...",
  "kind":            "entry|exit|snipe_complete|funding|transfer|balance_warning|error|daily_summary|watchdog|manual|other",
  "tradeId":         "(있을 때)",
  "pairId":          "sim-pair-1777798853000-abc123",
  "symbol":          "PRL",
  "exchanges":       "binance/bybit",
  "side":            "long|short (있을 때)",
  "fundingTime":     "2026-05-03T18:00:00.000Z (있을 때)",
  "text":            "...원문 메시지 그대로...",
  "structured": {
    "expNet": 11.79, "perFunding": 14.73, "totalRoundTripFees": 2.94,
    "totalReservesUSD": 0.00, "realPnl": 14.96, "totalFunding": 30.83,
    "totalPricePnl": -12.94, "totalFees": 2.93,
    "margin": 500, "notional": 2500, "leverage": 5, "spreadPercent": 0.589,
    "expectedRoiPercent": 1.18, "realizedRoiPercent": 1.50
  },
  "deliverySuccess": true,
  "deliveryError":   null,
  "synthetic":       false,
  "buildSha":        "8145aab77dfa"
}
```

`synthetic: true` 는 백필 스크립트(`scripts/backfill-telegram-archive.ts`)가 옛 trade 데이터에서 재구성한 레코드. 실제 봇 발송 안 됐음을 의미.

### 2.2 trade 이벤트 스키마 (가장 자주 쓰는 필드)

```jsonc
// snipe_entry / entry
{
  "timestamp": 1777798853000, "type": "snipe_entry", "simulation": true,
  "baseAsset": "PRL", "shortExchange": "bybit", "longExchange": "binance",
  "spreadPercent": 0.589, "margin": 500, "leverage": 5, "notional": 2500,
  "entryFee": 1.47,
  "netProfit": 11.79,                 // = conservative EV (현행)
  "perFunding": 14.73,                // raw funding income, no buffers
  "totalRoundTripFees": 2.94,
  "totalReservesUSD": 0.00,           // 신규: EV reserves 합계
  "pairId": "sim-pair-...",
  "analysis": { "conservativeEvDecision": { ... }, "totalReservesUSD": 0.00 }
}

// snipe_exit (per-leg)
{
  "type": "snipe_exit", "exchange": "bybit", "side": "short",
  "pairId": "...", "pnl": 3.56, "fundingAmount": 0.03,
  "exitFee": 0.77, "entryFee": 0.77,
  "pricePnl": 5.07, "exitPrice": 0.342
}

// snipe_complete (pair 완료)
{
  "type": "snipe_complete", "pairId": "...", "margin": 500, "notional": 2500,
  "fundingCollected": 30.83, "pnl": 14.96, "pricePnl": -12.94,
  "entryFee": 1.47, "exitFee": 1.46
}
```

### 2.3 schedule_probe 의 milestone 가짓수

| milestone | 의미 |
| --- | --- |
| `analysis_balance` | 거래소별 잔고/스케줄 마진 스냅샷 |
| `analysis_candidate` | 후보 평가 (selected/rejected + reason) |
| `analysis_summary` | 한 라운드 분석 마감 (counts) |
| `scheduled` | 큐에 잡힘 |
| `pre_30m`, `pre_10m`, `pre_5m`, `pre_3m`, `pre_1m` | 펀딩 직전 진척도 체크포인트 |
| `execute` | 진입 시도 직전 |
| `execute_failed` | 실패 (reason 필드 참조) |
| `execute_success` | 성공 (실체결은 별도 trades-executed/* 에) |
| `post_funding_1s/5s/7s/10s/15s/20s/25s/30s` | 정산 직후 시장 상태 측정 |
| `deferred_to_next_cycle` | 신규: 오더북 폴백으로 다음 사이클 이월 |

### 2.4 차단 사유(`reason`/`failureReason`) 가짓수

| reason | 의미 | 시나리오 D 에서 회복? |
| --- | --- | :---: |
| `funding_window_shifted` | 양 거래소 펀딩 시각 어긋남 | ✅ B |
| `orderbook_unavailable` | WS/REST 오더북 빈/타임아웃 | ✅ C |
| `live_spread_reverted` | 진입 직전 라이브 스프레드 음수 | ❌ |
| `profitability_insufficient` | 보수 EV 음수/임계 미달 | ❌ |
| `funding_timestamp_mismatch` | 두 다리 펀딩 timestamp 불일치 | (별도 가드) |
| `slippage_exceeded` | maxSlippagePct 초과 | ❌ |
| `impact_exceeded` | 라운드트립 impact bps 초과 | ❌ |
| `entry_gap_exceeded` | 진입 가격 갭 초과 | ❌ |
| `insufficient_balance` | 시뮬 잔고 부족 | ❌ |
| `free_margin_low` | 자유 마진 % 낮음 | ❌ |
| `route_failure_blocked` | 최근 실패 경로 차단 | ❌ |
| `profitability_scan_failed` | 분석 단계 음수 EV 거절 | ❌ |

---

## 3. 표준 분석 컷 10 가지

대부분의 "분석해줘" 요청은 아래 10 가지 컷의 조합으로 답할 수 있다. 각 컷마다 입력 디렉토리 + join key + 1차 grep 패턴을 명시.

### 3.1 시간대별 진입 시도/성공
- 입력: `data/trades/<KST>.jsonl`
- grep `"milestone":"execute"` (시도) / `"milestone":"execute_success"` (성공)
- 또는 `data/trades-executed/{sim,real}/<KST>.jsonl` 의 `type:"snipe_complete"` 카운트
- group by KST hour

### 3.2 차단 사유 분포
- 입력: `data/trades/<KST>.jsonl`
- grep `"milestone":"execute_failed"` 후 `analysis.failureReason` 카운트
- (또는 type:`guard_block`)

### 3.3 심볼별 / 거래소별 P&L
- 입력: `data/trades-executed/{sim,real}/<KST>.jsonl`
- group by `baseAsset` 혹은 `shortExchange + "/" + longExchange`
- aggregate: `Σ pnl`, `Σ fundingCollected`, `Σ pricePnl`, `Σ entryFee+exitFee`, count

### 3.4 예상 vs 실현 비교
- 입력: 동일 디렉토리
- pair: `snipe_entry.netProfit` ↔ `snipe_complete.pnl` (공통 `pairId`)
- decompose: `Δ = realPnl − expNet`, 이를 다시 `funΔ = realFund − perFunding` + `pxPnl − totalReservesUSD` 로 분해

### 3.5 텔레그램 알림 vs trade 이벤트 매칭 (★ 신규)
- 입력: `data/telegram/<KST>.jsonl` ∩ `data/trades-executed/{sim,real}/<KST>.jsonl`
- **join key 1순위**: `telegram.pairId === trade.pairId`
- **join key 2순위 (fallback)**: `telegram.kind == 'entry' AND trade.type == 'snipe_entry' AND |telegram.tsUnix − trade.timestamp| < 5000ms AND telegram.symbol === trade.baseAsset`
- 검증 컷:
  - 누락 알림: `snipe_entry` 있는데 `entry` 텔레그램 0건 → archive 에 없으면 진짜 누락 / 있는데 deliverySuccess=false 면 발신 실패
  - 잘못된 expNet: `telegram.structured.expNet` ≠ `snipe_entry.netProfit` → 코드 동기화 문제
  - 백필 vs 실 발송 구분: `synthetic: true` 분리

### 3.6 펀딩 사이클별 회수율
- 입력: `data/trades-executed/{sim,real}/<KST>.jsonl` + `data/funding-receipts/`
- group by funding timestamp (정확히 정시 boundaries)
- 각 사이클마다: 후보 수, 진입 수, 평균 expNet, 실현 sum, 회수율 = 진입/후보

### 3.7 가드 완화 효과 측정 (시나리오 D 가동 후)
- 입력: `data/trades/<KST>.jsonl`
- 비교 컷: 가드 완화 ON 시점 (env flip after 2026-05-03 17:48 KST) 전후로
  - `funding_window_shifted` 발생 빈도 ↓ ?
  - `deferred_to_next_cycle` milestone 등장 빈도 ?
  - 진입 성공률 (execute_success / execute) ↑ ?

### 3.8 거래소 안정성 / 데이터 헬스
- 입력: `data/logs/<KST>.jsonl`, `data/analysis/opportunities-hourly/`
- grep: `"WS soft timeout"`, `"orderbook"`, `"REST fallback"` 등
- group by hour × exchange

### 3.9 잔고 추이 / 자본 효율
- 입력: `data/sim-state.json` (snapshot) + `data/snapshots/*.json`
- 시계열 회수: 각 snapshot 의 `simBalances` 합 + `simTotalFundingEarned`/`simTotalClosedPnl`/`simTotalFees` 누적치

### 3.10 EV 리저브 분해 (예상 vs 실현 갭의 미시 분석)
- 입력: `data/trades-executed/{sim,real}/<KST>.jsonl` 의 `snipe_entry.analysis.conservativeEvDecision`
- 컴포넌트 별로 누적: `Σ entryImpactUSD`, `Σ exitImpactUSD`, `Σ timingReserveUSD`, `Σ basisConvergenceReserveUSD`, `Σ volumeLiquidityReserveUSD`, `Σ dataHealthPenaltyUSD`
- 비교 대상: 실제 `Σ pricePnl` (음수)
- 갭 = (실현 `pricePnl` 절대값) − (모델 reserves 합) → 모델이 미반영한 시장 위험 크기

---

## 4. Claude 가 따라야 할 절차

1. 사용자 요청을 받으면 §1 의 4 차원 중 빠진 게 있는지 확인. 없으면 한 번에 물어보고 멈춤.
2. §3 의 10 가지 컷 중 어떤 것에 해당하는지 매칭. 새 컷이면 §3 에 추가 후 진행.
3. 입력 파일 size/last-write-time 부터 확인 (= 데이터 신선도). 끊긴 구간이 있으면 보고서에 명시.
4. 시간 변환 유틸:
   ```
   KST = UTC + 9h
   파일 일자(KST) = UTC ms + 9*3600*1000 의 YYYY-MM-DD
   ```
5. CLI/PowerShell 에서 jsonl 을 ConvertFrom-Json 으로 파싱할 때는 **반드시 UTF-8 명시** (`[System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8)`). 한국어 `executionLabel` 이 깨져서 JSON 파싱 실패하는 케이스가 흔함.
6. 결과는 §1.4 형식대로. 마크다운 보고서면 `outputs/` 또는 사용자 지정 디렉토리에. 짧은 답변이면 표 1 ~ 2 개만.
7. **숫자 인용 시 반드시 해당 파일의 line number 또는 timestamp 를 함께 인용** — 사용자가 검증할 수 있게.

---

## 5. 알려진 이슈 / 함정

- **timestamp 가 ms 인지 sec 인지** — `data/*` 의 모든 timestamp 는 **ms (Date.now() 기준)**. funding rate API 의 `nextFundingTime` 도 ms. 단 일부 외부 sec timestamp 와 섞일 수 있으므로 `> 1e12` 면 ms, `< 1e12` 면 sec 로 판정.
- **현행 vs 옛 standalone bundle**: 코드는 git HEAD 가 새것이어도 deployed standalone bundle 이 옛 것이면 옛 동작 (대표 사례: 2026-04-29 의 `analysis` 필드 부재 = 옛 bundle 운용). 분석 시 `buildSha` 또는 `analysis` 필드 유무로 판단할 것.
- **시뮬 vs 실거래 혼동**: 모든 trade 이벤트에 `simulation: true|false`. 절대 두 모드를 합산하지 말 것.
- **funding rate 해석**: `rate > 0` → 롱이 숏에게 지급. 거래 한쪽 다리 입장에서 `signed amount = ±rate × notional`. `(shortRate − longRate)` 이 페어 net funding income.
- **노티오널 양다리 합산**: `pair.totalMargin = pair.margin × 2` (한쪽 마진 × 2). ROI 분모는 totalMargin. 한쪽만 쓰면 2 배 오류.
- **백필 데이터 구분**: telegram 아카이브의 `synthetic: true` 는 실제 발신 안 된 재구성. 통계 낼 때 분리할지 합칠지 명시할 것.

---

## 6. 자주 나오는 분석 요청 → 즉시 적용 가능 컷 매핑

| 사용자 표현 | §3 컷 |
| --- | --- |
| "어제 거래 어땠어?" | 3.3 + 3.4 |
| "왜 거래가 안 돼?" | 3.2 + 3.8 |
| "예상이랑 실현 차이가 너무 커" | 3.4 + 3.10 |
| "텔레그램 알림 누락된 거 있어?" | 3.5 |
| "PRL 만 따로 보여줘" | 3.3 with `baseAsset == 'PRL'` filter |
| "가드 완화 효과 봐줘" | 3.7 |
| "주말 vs 평일 비교" | 3.1 + 3.6 with weekday/weekend partition |

---

## 7. 핵심 보고서 인덱스

| 보고서 | 위치 | 내용 |
| --- | --- | --- |
| 2026-04-30 무거래 사고 분석 | `outputs/funding-fee-program-downtime-report-20260503.md` | §1~6: 사고 분석, 가드 완화 백테스트, 예상 vs 실현 PnL 수식 분석 |
| 분석 가이드 (이 문서) | `ANALYSIS_GUIDE.md` | 데이터 인벤토리 + 표준 컷 + Claude 절차 |

새 분석 보고서를 만들 때는 위 두 문서를 먼저 읽고 일관된 용어·필드명 사용.
