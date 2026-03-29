# Funding Fee Arbitrage Strategy v2

> 최종 업데이트: 2026-03-30
> 상태: 기능 구현 완료, SIM/소액 REAL 검증 단계 — 기본 OFF opt-in 운영

---

## 1. 개요

크립토 선물 거래소 간 **펀딩비 스프레드**를 이용한 델타 중립형 차익거래 프로그램.
6개 거래소(Binance, Bybit, OKX, Bitget, Gate, BingX)의 펀딩레이트를 비교하여,
스프레드가 **예상 총비용과 운영 리스크를 초과하는 경우에만** 자동 진입/청산한다.

### 핵심 운영 원칙

- 방향성 노출은 낮추되, **체결 리스크 / 정산 리스크 / 거래소별 담보 리스크는 남는다.**
- 진입 의사결정은 **Decision EV 기준**으로 수행하며, **레퍼럴/리베이트는 포함하지 않는다.**
- 거래소 기본 프로파일보다 **심볼별 live funding metadata**를 우선 사용한다.
- v2 기능은 전부 **기본 OFF**이며, 검증 완료 전까지 opt-in 방식으로만 활성화한다.

### v1 → v2 핵심 변경

| 항목 | v1 (기존) | v2 (개정) |
|------|-----------|-----------|
| 진입 타이밍 | 고정 T-3.5s | 거래소 프로파일 + live metadata 기반 |
| 청산 | 고정 T+1s | 펀딩 정산 확인 후 청산 |
| 노셔널 | 고정 (투자금 × 레버리지) | 오더북 impact budget 기반 동적 사이징 |
| 유동성 가드 | 슬리피지 % | impact bps 기준 (entry soft / round-trip hard cap) |
| 주문 방식 | Post-Only → IOC → Market | IOC-limit only opt-in, 시장가 금지 가능 |
| 헷지 기준 | mismatch 2% | ratio pre-check + mismatch 0.20% |
| 거래소 취급 | 동등 취급 | Tier A/B/C + capability flags |
| 비용 계산 | 표시 funding/정적 수수료 중심 | conservative EV + live fee 우선 |
| 기본 상태 | — | **모든 v2 기능 OFF** |

**설계 원칙**: `ConfirmedSnipeConfig`가 없거나 미설정이면 v1 로직 100% 유지.
각 기능은 독립 토글로 개별 ON/OFF 가능.

---

## 2. 거래소 프로파일

### 2.1 Tier 시스템

| Tier | 의미 | 거래소 |
|------|------|--------|
| **A** | 기본 REAL 허용, 확인형 청산 적합 | Binance, Bybit, Bitget, Gate |
| **B** | REAL 허용, settlement wait를 더 길게 둬야 함 | OKX |
| **C** | 기본 Observe Only | BingX |

### 2.2 프로파일 상세

> 아래 표의 기본값은 **스케줄링 힌트**이며, 실제 실행 시에는 **심볼별 live funding metadata**가 우선한다.

| 거래소 | Tier | 진입 리드(초) | 표시 Funding 갱신 특성 | 정산 주기 취급 | Settlement Check | 컷오프 / 지연 주의 | IOC |
|--------|------|---------------|-------------------------|----------------|------------------|--------------------|-----|
| Binance | A | 7 | live funding info 기준 | 기본 8h, 심볼별 조정 가능 → live metadata 우선 | O | 경미한 정산 시각 편차 가능 | O |
| Bybit | A | 5 | 표시값 매분 갱신 | N-hour interval 계약 기준 → live metadata 우선 | O | 표시값과 확정값 분리 필요 | O |
| OKX | B | 7 | 직전 1분 값 / 즉시 rate 특성 반영 | 기본 8h, 1/2/4h 자동 조정 가능 | O | settlement wait 보수적 운영 | O |
| Bitget | A | 7 | live funding page 기준 | 보통 8h, 일부 심볼 예외 가능 | O | 심볼별 주기 재확인 | O |
| Gate | A | 5 | funding 계산/표시값 수시 갱신 | 보통 8h, 일부 4h/2h 가능 | O | contract detail 우선 확인 | O |
| BingX | C | 35 | live page 기준 | 기본 주기 외 예외 가능 | X | 정산 최대 1분 지연, 정산 직전 30초 주문 미반영 가능 | O |

### 2.3 Capability Flags

각 거래소 프로파일에 아래 플래그가 포함되며, 런타임에서 기능 분기에 사용된다.

- `supportsFundingSettlementCheck` — 펀딩 정산 이력 조회 가능 여부
- `supportsRawOrderbook` — 원시 오더북 depth 품질
- `supportsIocLimit` — IOC limit 주문 안정성
- `realEnabledByDefault` — REAL 모드 기본 활성화 여부
- `requiresLiveFundingMeta` — funding interval / next funding time을 live metadata 우선으로 해석해야 하는지 여부

**BingX는 `supportsFundingSettlementCheck: false`** 이므로 confirmed close를 기본 사용하지 않고 legacy fallback 또는 Observe Only로 취급한다.

### 2.4 구현 위치

```
lib/exchangeProfiles.ts
```

헬퍼 함수:
- `getPairEntryLeadMs(short, long)` — 두 거래소 중 더 긴 entry lead 반환
- `getPairMaxSettlementWaitMs(short, long)` — 두 거래소 중 더 긴 settlement wait 반환
- `hasTierCExchange(short, long)` — Tier C 포함 여부
- `pairSupportsConfirmedClose(short, long)` — 양쪽 모두 settlement check 가능 여부
- `pairSupportsIocLimit(short, long)` — 양쪽 모두 IOC 지원 여부

---

## 3. v2 기능 토글 (`ConfirmedSnipeConfig`)

### 3.1 토글 목록

| 토글 | 기본 | 설명 |
|------|------|------|
| `useConfirmedClose` | OFF | 펀딩 정산 확인 후 청산 |
| `useIocLimitOnly` | OFF | IOC-limit only 진입 (시장가 금지) |
| `useDynamicNotional` | OFF | 오더북 impact budget 기반 동적 노셔널 |
| `useImpactGuards` | OFF | impact bps 기반 유동성 가드 |
| `useStrictHedge` | OFF | hedge ratio 0.998~1.002, mismatch 0.20% |
| `useDriftBuffer` | OFF | displayed funding 보수적 보정 |

### 3.2 추가 파라미터

| 파라미터 | 기본값 | 설명 |
|----------|--------|------|
| `targetImpactBps` | 4 | **entry total soft target** (`shortImpact + longImpact`) |
| `maxRoundTripImpactBps` | 12 | **round-trip hard cap** (`2 x entryImpactBps`) |
| `dynamicNotionalCap` | $2,200 | 동적 노셔널 상한 |

### 3.3 구현 위치

```
lib/types.ts — ConfirmedSnipeConfig interface, DEFAULT_CONFIRMED_SNIPE_CONFIG
```

**`DEFAULT_CONFIRMED_SNIPE_CONFIG`의 모든 토글은 `false`**.
`StrategyConfig.confirmedSnipeConfig`가 `undefined`이면 기본값이 적용되므로 v1 동작 유지.

---

## 4. Confirmed Close (확인형 청산)

### 4.1 기존 방식 (v1)

```
펀딩 시간 + closeDelayMs (1초) → 즉시 양쪽 청산
```

문제:
- 거래소마다 실제 정산 반영 시점이 다를 수 있다.
- 표시 funding timestamp와 실제 settlement history 반영 시점이 일치하지 않을 수 있다.
- 일부 거래소는 정산 지연 또는 직전 주문 미반영 조건이 존재한다.

### 4.2 새 방식 (v2)

```
펀딩 시간 도달
  → checkFundingSettled() polling
  → 양쪽 모두 confirmed → 즉시 청산
  → maxSettlementWaitSec 초과 → 강제 청산
```

### 4.3 동작 조건

- `useConfirmedClose: true`
- `pairSupportsConfirmedClose(short, long) === true`
- 첫 번째 close 시도일 때만 (`closeAttempts === 0`)

조건 미충족 시 자동으로 v1 방식(고정 지연 후 청산) 사용.

### 4.4 Settlement Check 구현

```typescript
checkFundingSettled(exchange, config, symbol, expectedFundingTime, toleranceMs = 60_000)
→ { settled: boolean; payment?: { amount, rate, timestamp } }
```

- `fetchFundingHistory` 기반으로 예상 펀딩 시간 +/- tolerance 내 정산 기록 확인
- 네트워크 실패 / 응답 지연 시 `{ settled: false }` 반환
- `expectedFundingTime`은 profile 고정값이 아니라 **live funding metadata 우선**으로 계산

### 4.5 운영 원칙

- confirmed close는 **"양쪽 모두 확인되면 청산"** 이 기본이다.
- 다만 `maxSettlementWaitSec` 초과 시에는 **펀딩 미확인 상태라도 flatten** 한다.
- Tier C 거래소 포함 페어는 confirmed close의 기본 대상이 아니다.

---

## 5. IOC-Limit Only 진입

### 5.1 기존 방식 (v1)

```
Post-Only maker → 미체결 시 IOC taker fallback → 미달 시 Market fallback
```

### 5.2 새 방식 (v2)

```
IOC-limit 한 번만 발사 → 90% 미만 체결 시 실패 처리 → 필요 시 즉시 rollback / flatten
```

- **시장가 진입 금지 가능**
- 진입 가격 상한이 명확해짐
- 장시간 maker 대기로 인한 funding miss / orphan leg 리스크 감소

### 5.3 운영 규칙

- `useIocLimitOnly: true`일 때만 활성화
- 체결률 `< 90%`이면 `OrderExecutionError`
- **한쪽 leg만 남는 시간은 `MAX_ORPHAN_LEG_MS` 이내**로 제한
- orphan leg가 허용시간 초과 시 즉시 flatten

---

## 6. 동적 노셔널

### 6.1 기존 방식 (v1)

```
targetNotional = investmentUSDT x leverage  (고정)
```

### 6.2 새 방식 (v2)

```
targetNotional = min(
  baseNotional,
  shortDepthCapNotional,
  longDepthCapNotional,
  dynamicNotionalCap,
)
```

### 6.3 핵심 원칙: floor 없음

- depth가 얕으면 진입 자체를 **skip**
- `targetNotional < $100`이면 `depth_insufficient`로 기록하고 진입 거부
- 경제성 판단은 `Decision EV`, `minProfitUSD`, `minEVRatio`, impact cap으로 수행

### 6.4 depth cap 계산

```typescript
calcOrderbookImpactBps(bids, asks, notionalUSDT, side)
→ { impactBps, fillPrice, worstPrice, midPrice, depthCapNotional }
```

- `impactBps`는 **각 거래소 자체 mid price 기준**으로 산출
- `depthCapNotional`은 보수적으로 **per-leg hard cap 3bps** 기준으로 계산
- 위 3bps는 `maxRoundTripImpactBps = 12`일 때,
  - `entry hard budget = 6bps`
  - 대칭 가정 시 leg당 `3bps`
  로 배분한 값이다.

---

## 7. Impact 기반 유동성 가드

### 7.1 기존 방식 (v1)

```
maxSlippagePercent = 1.5% (leg별)
```

### 7.2 새 방식 (v2)

```
shortImpactBps = |shortFillPrice - shortMid| / shortMid x 10000
longImpactBps  = |longFillPrice  - longMid|  / longMid  x 10000

entryImpactBps = shortImpactBps + longImpactBps
roundTripImpactBps = 2 x entryImpactBps
```

### 7.3 판정 기준

- **Soft target**: `entryImpactBps <= targetImpactBps` 권장
- **Hard reject**: `roundTripImpactBps > maxRoundTripImpactBps` 이면 진입 거부

즉,
- `targetImpactBps = 4`는 **entry total soft target**
- `maxRoundTripImpactBps = 12`는 **round-trip hard cap**
으로 사용한다.

### 7.4 Signal / Execution 연동

`useImpactGuards: true`이면 진입 신호 판단은 아래처럼 수행한다.

```
Decision EV = expectedFundingUSD
            - roundTripFeeUSD
            - estimatedRoundTripImpactUSD
            - timingReserveUSD
```

- 더 이상 `maxRoundTripImpactBps / 100` 같은 % 환산값을 entry gap threshold로 직접 사용하지 않는다.
- 비용 커버 여부는 **bps budget**이 아니라 **달러 EV 기준**으로 최종 판단한다.

---

## 8. Strict Hedge 강화

### 8.1 기존 방식 (v1)

```
mismatch > 2% → 초과분 트림
```

### 8.2 새 방식 (v2)

**진입 전 hedge ratio 검증:**
```
hedgeRatio = |longNotional / shortNotional|
허용 범위: 0.998 ~ 1.002
범위 밖 → 진입 거부 (hedge_ratio_exceeded)
```

**진입 후 mismatch 트림:**
```
diffPercent > 0.20% → 초과분 즉시 부분 청산
```

### 8.3 v2 상수

```typescript
HEDGE_RATIO_MIN = 0.998
HEDGE_RATIO_MAX = 1.002
MAX_HEDGE_MISMATCH_PCT = 0.20
MAX_ORPHAN_LEG_MS = 300
```

---

## 9. 펀딩 Drift Buffer

### 9.1 목적

표시된 funding rate를 그대로 쓰지 않고 보수적으로 조정한다.
거래소마다 displayed rate와 실제 settled rate 사이에 차이가 날 수 있다.

### 9.2 계산식

```typescript
calcDriftBuffer(displayedRate, recentRateHistory?, exchangeUsesInstantRate?)

// recentRateHistory 없는 경우:
//   일반 거래소: 1bp (0.0001)
//   즉시 rate 성격 거래소: max(1bp, |rate| x 5%)

// recentRateHistory 있는 경우:
//   buffer = max(|last1mChange|, |last5mChange| x 0.5, 1bp)
//   즉시 rate 성격 거래소: buffer x 1.5
```

### 9.3 EV 계산 적용

```
shortFR_eff = displayedShortFR - shortDriftBuffer
longFR_eff  = displayedLongFR  + longDriftBuffer
expectedFundingUSD = notional x (shortFR_eff - longFR_eff)
```

---

## 10. Conservative EV 계산

### 10.1 공식

```
DecisionEVUSD = expectedFundingUSD
              - roundTripFeeUSD
              - estimatedRoundTripImpactUSD
              - timingReserveUSD
```

```
RealizedNetUSD = realizedFundingUSD
               - realizedTradingFeeUSD
               - realizedImpactUSD
               + realizedRebateUSD
```

### 10.2 진입 기준

```
DecisionEVUSD >= MIN_PROFIT_USD ($1.25)
DecisionEVUSD / worstCaseExitUSD >= MIN_EV_RATIO (1.8)
```

여기서 `worstCaseExitUSD = roundTripFee + estimatedRoundTripImpact + timingReserve`

### 10.3 운영 원칙

- **레퍼럴/리베이트는 진입 의사결정에 넣지 않는다.**
- 레퍼럴/리베이트는 **사후 손익(`RealizedNetUSD`)에만 반영**한다.
- 승인 기준은 `DecisionEVUSD`와 `RealizedNetUSD`의 괴리를 함께 본다.

### 10.4 시간 정규화 점수

```
score = DecisionEVUSD x fillProb x fundingCaptureProb / capitalLockSec
```

---

## 11. 거래소별 진입 타이밍

### 11.1 기존 방식 (v1)

```
entryLeadMs = 3,500ms (모든 거래소 동일)
```

### 11.2 새 방식 (v2)

```
entryLeadMs = max(
  getPairEntryLeadMs(short, long),
  legacyTimingConfig.entryLeadMs,
)
```

| 페어 | 적용 리드 |
|------|-----------|
| Binance <-> Bybit | 7s |
| Bybit <-> Gate | 5s |
| OKX <-> 아무거나 | 7s |
| BingX <-> 아무거나 | 35s (Tier C, 기본 비활성) |

### 11.3 Funding Timestamp 정렬

`useConfirmedClose: true`이면:
```
|shortFundingTime - longFundingTime| > 3초 → 진입 거부
```

discovery 단계의 120초 tolerance는 유지하되, **실행 단계에서만 3초 제한**을 적용한다.

### 11.4 Timestamp Source 우선순위

```
1) exchange live funding metadata
2) symbol/contract funding info endpoint
3) exchangeProfiles.ts 기본값
```

---

## 12. UI 토글

### 12.1 위치

전략 설정 패널(`components/dashboard/StrategyPanel.tsx`) 내
텔레그램 설정 위에 **"v2.1 Confirmed Snipe"** 섹션으로 배치.

### 12.2 구성

- 6개 독립 토글 스위치
- `useDynamicNotional` ON 시 **노셔널 상한** 입력 필드 표시 ($500~$10,000, 기본 $2,200)
- 안내 문구: **"모든 토글 기본 OFF. 기존 전략 동작에 영향 없음."**

### 12.3 Config 전달 경로

```
StrategyPanel UI
  → setStrategyConfig({ confirmedSnipeConfig: { ... } })
  → buildSchedulerConfig() / buildServerSimSchedulerConfig()
  → API /api/scheduler (REAL) / /api/sim-scheduler (SIM)
  → ServerScheduler / ServerSimScheduler
```

---

## 13. 수수료 및 리베이트 정책

### 13.1 수수료 소스 우선순위

```
effectiveFee = liveAccountFee ?? feeOverride ?? localPresetEstimate
```

운영 원칙:
- **실계정 effective maker/taker fee 조회값을 최우선 사용**
- `feeOverrides`는 명시적 override 용도
- `localPresetEstimate`는 **SIM/예비 계산용 fallback**이며 승인 기준의 근거로 사용하지 않음
- 세션 시작 시 1회, 이후 주기적으로 수수료 재동기화

### 13.2 IOC-limit only 수수료 처리

- `useIocLimitOnly: true`이면 진입 leg는 **taker fee 기준**으로 계산한다.
- 청산은 실제 체결 방식에 따라 maker/taker를 구분해 사후 회계 반영한다.

### 13.3 레퍼럴/리베이트 처리

- 레퍼럴 할인, 커미션 공유, 리베이트는 **Decision EV 계산에서 제외**
- 실제 정산 확인 후 `realizedRebateUSD`로만 집계
- 월간 리포트에서는 **전략 PnL**과 **운영 보조수익(rebate)** 을 분리 표기

---

## 14. 리스크 관리 및 운영 통제

### 14.1 리스크 매트릭스

| 리스크 | v1 대응 | v2 추가 대응 |
|--------|---------|-------------|
| 펀딩 미수령 | 고정 지연 청산 | settlement 확인 polling + max wait 강제 청산 |
| 표시값 드리프트 | 표시 funding 그대로 사용 | drift buffer 반영 |
| 한쪽만 체결 | rollback + flatten | IOC-limit only + orphan leg 300ms 제한 |
| 헷지 mismatch | 2% 트림 | ratio pre-check + 0.20% 트림 |
| 유동성 부족 | 24h volume 필터 | depth 기반 동적 노셔널 + impact hard cap |
| 거래소별 담보 부족 | 명시 약함 | free collateral / liquidation buffer 기준 신규 진입 금지 |
| 정산 주기 불일치 | 고정 타이밍 | live metadata 우선 + timestamp 3초 정렬 검사 |
| 거래소별 API/제한 | 재시도 위주 | tier/capability 분기 + observe-only 운영 |
| 거래소 장애 | API 실패 시 중단 | confirmed close fallback + kill-switch |

### 14.2 실행 상태 머신

```
idle
  → discover
  → precheck
  → arm
  → submit_both
  → one_leg_filled
  → hedge_or_abort
  → pending_funding
  → wait_settlement_confirm
  → confirmed_close
  → flatten
  → reconcile
  → cooldown
```

### 14.3 핵심 운영 규칙

- `orphan leg > MAX_ORPHAN_LEG_MS` → 즉시 flatten
- `freeCollateralRatio`가 기준 미만이면 신규 진입 금지
- `distanceToLiquidation`이 임계값 미만이면 포지션 축소 또는 flatten
- settlement check 실패가 누적되면 해당 거래소/페어를 cooldown 처리
- public/private 데이터 불일치 시 자동 매매 중지

### 14.4 Kill-Switch 조건

아래 중 하나라도 충족하면 자동 진입을 중지한다.

- funding timestamp skew > 3초
- orphan leg timeout 발생
- hedge mismatch가 허용치 초과 후 복구 실패
- free collateral / liquidation buffer 기준 이탈
- 연속 API 실패 또는 settlement check 실패 누적
- 거래소 상태 이상 또는 주문 상태 불일치

---

## 15. 설정값 및 승인 기준

### 15.1 Legacy 호환 기본값 (코드 호환용)

```
포지션당 마진: $100
거래소당 잔고: $200
레버리지: 17x
기본 노셔널/포지션: $1,700
최소 스프레드: 0.20%
기존 closeDelay: 펀딩 후 1초
```

> 위 값은 **레거시 호환용 기준**이며, 신규 REAL 기본값으로 간주하지 않는다.

### 15.2 v2 REAL-SMALL 권장 운영값

```
useConfirmedClose: true
useIocLimitOnly: true
useDynamicNotional: true
useImpactGuards: true
useStrictHedge: true
useDriftBuffer: true

dynamicNotionalCap: $1,000 ~ $2,200
leverage: 3x ~ 5x부터 시작
per-exchange free collateral ratio: 60% 이상 유지
active symbols: BTC, ETH 우선
```

### 15.3 권장 활성화 순서

1. `useIocLimitOnly`
2. `useStrictHedge`
3. `useImpactGuards`
4. `useConfirmedClose`
5. `useDynamicNotional`
6. `useDriftBuffer`

### 15.4 승격 KPI 기준

아래 기준을 일정 샘플 수 이상에서 만족할 때만 opt-in 기능을 다음 단계로 승격한다.

```
fundingCaptureSuccessRate >= 95%
forcedCloseRate <= 5%
fillFailureRate <= 10%
orphanLegP95Ms <= 150ms
realizedEV / decisionEV >= 0.70
settlementCheckFalseNegativeRate <= 2%
```

---

## 16. 시스템 아키텍처

```
┌─ Client (Next.js React) ───────────────────────────┐
│  5초 폴링: funding/opportunity 상태                 │
│  3초 폴링: 서버 SIM 스케줄러 상태 동기화             │
│  UI: 기회 목록, 잔고, 거래 내역, 설정                │
│  v2.1 토글: ConfirmedSnipeConfig 6개 스위치          │
└──────────────┬─────────────────────────────────────┘
               │ REST API
┌──────────────▼─────────────────────────────────────┐
│ Server (Next.js API Routes)                         │
│ - ServerSimScheduler: SIM 자동 거래                  │
│ - ServerScheduler: REAL 자동 거래                    │
│ - ExchangeProfiles: tier / capability 분기           │
│ - CCXT + native metadata: funding/settlement 확인    │
│ - Conservative EV + impact 계산                      │
│ - 상태 파일 기반 영속성 (data/*.json)                │
└────────────────────────────────────────────────────┘
```

---

## 17. 파일 구조

| 파일 | 역할 |
|------|------|
| `lib/exchangeProfiles.ts` | 거래소별 프로파일, tier, capability flags |
| `lib/types.ts` | 전략 타입, v2 상수, ConfirmedSnipeConfig |
| `lib/opportunities.ts` | 기회 탐색, drift buffer, conservative EV, funding metadata 해석 |
| `lib/exchanges/index.ts` | CCXT 래퍼, 오더북 분석, impact 계산, settlement check, IOC-limit 진입 |
| `lib/serverScheduler.ts` | REAL 모드 스케줄러 (entry lead, confirmed close, collateral guard) |
| `lib/serverSimScheduler.ts` | SIM 모드 스케줄러 |
| `app/api/strategy/execute/route.ts` | 수동 실행 API (impact guard, hedge ratio, IOC flag) |
| `components/dashboard/StrategyPanel.tsx` | 전략 설정 UI + v2 토글 섹션 |
| `store/fundingStore.ts` | Zustand 상태 (scheduler에 config 전달) |

---

## 18. 배포

- AWS EC2 t3.small (ap-southeast-1)
- PM2 프로세스 매니저
- Next.js standalone 빌드
- 1GB 스왑 파일 (OOM 방지)

배포 명령:
```bash
ssh funding-ec2 "cd /home/ec2-user/funding-fee-program && git pull origin main && npm run build && pm2 restart all"
```
