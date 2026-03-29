# Funding Fee Arbitrage Strategy v2

> 최종 업데이트: 2026-03-30
> 상태: 구현 완료, 기본 OFF — opt-in 방식 운영

---

## 1. 개요

크립토 선물 거래소 간 **펀딩비 스프레드**를 이용한 델타 뉴트럴 차익거래 프로그램.
6개 거래소(Binance, Bybit, OKX, Bitget, Gate, BingX)의 펀딩레이트를 실시간 비교하여,
스프레드가 비용을 초과하는 기회를 포착하고 자동으로 진입/청산한다.

### v1 → v2 핵심 변경

| 항목 | v1 (기존) | v2 (신규, opt-in) |
|------|-----------|-------------------|
| 진입 타이밍 | 고정 T-3.5s | 거래소별 프로파일 기반 (5~35s) |
| 청산 | 고정 T+1s | 펀딩 정산 확인 후 청산 |
| 노셔널 | 고정 (투자금 × 레버리지) | 오더북 깊이 기반 동적 사이징 |
| 유동성 가드 | 슬리피지 % (기본 1.5%) | impact bps (round-trip 12bps cap) |
| 주문 방식 | Post-Only → IOC → Market | IOC-limit only (시장가 금지) |
| 헷지 기준 | mismatch 2% | mismatch 0.20%, ratio 0.998~1.002 |
| 거래소 등급 | 동등 취급 | Tier A/B/C + capability flags |
| 기본 상태 | — | **모든 v2 기능 OFF** |

**설계 원칙**: `ConfirmedSnipeConfig`가 없거나 미설정이면 v1 로직 100% 유지.
각 기능은 독립 토글로 개별 ON/OFF 가능.

---

## 2. 거래소 프로파일

### 2.1 Tier 시스템

| Tier | 의미 | 거래소 |
|------|------|--------|
| **A** | 기본 REAL 허용, settlement 빠름 | Binance, Bybit, Bitget, Gate |
| **B** | REAL 허용, 확인형 청산 필요 | OKX |
| **C** | 기본 Observe Only | BingX |

### 2.2 프로파일 상세

| 거래소 | Tier | 진입 리드(초) | 정산 대기(초) | Rate 갱신 | 즉시 Rate | Settlement Check | IOC |
|--------|------|-------------|-------------|-----------|-----------|-----------------|-----|
| Binance | A | 7 | 20 | 8h | X | O | O |
| Bybit | A | 5 | 12 | 매분 | X | O | O |
| OKX | B | 7 | 75 | 8h | O (직전 1분) | O | O |
| Bitget | A | 7 | 20 | 8h | X | O | O |
| Gate | A | 5 | 12 | 8h | X | O | O |
| BingX | C | 35 | 75 | 8h | X | **X** | O |

### 2.3 Capability Flags

각 거래소 프로파일에 아래 플래그가 포함되어 있으며, 런타임에서 기능 분기에 사용된다:

- `supportsFundingSettlementCheck` — 펀딩 정산 이력 조회 가능 여부
- `supportsRawOrderbook` — 원시 오더북 depth 품질
- `supportsIocLimit` — IOC limit 주문 안정성
- `realEnabledByDefault` — REAL 모드 기본 활성화 여부

**BingX는 `supportsFundingSettlementCheck: false`** → confirmed close 사용 불가, legacy fallback.

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
| `useConfirmedClose` | OFF | 펀딩 정산 확인 후 청산 (거래소 profile 기반) |
| `useIocLimitOnly` | OFF | IOC-limit only 진입 (Post-Only cascade 제거) |
| `useDynamicNotional` | OFF | 오더북 깊이 기반 동적 노셔널 (floor 없음) |
| `useImpactGuards` | OFF | impact bps 기반 가드 (슬리피지 % 대체) |
| `useStrictHedge` | OFF | 헷지 비율 0.998~1.002, mismatch 0.20% |
| `useDriftBuffer` | OFF | 펀딩레이트 drift 버퍼 적용 |

### 3.2 추가 파라미터

| 파라미터 | 기본값 | 설명 |
|----------|--------|------|
| `targetImpactBps` | 4 | leg당 목표 impact (bps) |
| `maxRoundTripImpactBps` | 12 | 왕복 impact hard cap (bps) |
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

문제: 거래소마다 실제 정산 시점이 다르다.
- Binance: 최대 15초 편차
- OKX: 최대 60초
- BingX: 최대 60초 + 30초 전 주문 미카운트

### 4.2 새 방식 (v2)

```
펀딩 시간 도달
  → checkFundingSettled() 2초 간격 polling
  → 양쪽 모두 confirmed → 즉시 동시 청산
  → maxSettlementWaitSec 초과 → 강제 동시 청산
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

거래소의 `fetchFundingHistory`를 호출하여 예상 펀딩 시간 ±60초 내 정산 기록이 있는지 확인.
5초 타임아웃, 실패 시 `{ settled: false }` 반환.

### 4.5 closeAt 계산

```typescript
// v2: 펀딩 시간에 바로 발화 (executeClose가 settlement wait 처리)
const closeAt = snipeConfig.useConfirmedClose
  ? Math.max(Date.now(), targetFundingTime)
  : Math.max(Date.now(), targetFundingTime + closeDelayMs);  // v1 legacy
```

---

## 5. IOC-Limit Only 진입

### 5.1 기존 방식 (v1)

```
Post-Only maker → 미체결 시 IOC taker fallback → 미달 시 Market fallback
```

### 5.2 새 방식 (v2)

```
IOC-limit 한 번만 발사 → 90% 미만 체결 시 OrderExecutionError
```

- **시장가 진입 완전 금지**
- 진입 가격 상한이 명확 (limitPrice = worstPrice ± 0.05% buffer)
- 한쪽만 잡히는 사고 감소

### 5.3 동작 조건

- `useIocLimitOnly: true`
- `openPositionExact()`의 마지막 파라미터로 전달

OFF 시 기존 Post-Only → IOC → Market cascade 유지.

---

## 6. 동적 노셔널

### 6.1 기존 방식 (v1)

```
targetNotional = investmentUSDT × leverage  (고정)
```

### 6.2 새 방식 (v2)

```
targetNotional = min(
  baseNotional,                    // 기존 고정값
  shortDepthCapNotional,           // 숏 오더북 6bps 이내 수용 가능 금액
  longDepthCapNotional,            // 롱 오더북 6bps 이내 수용 가능 금액
  dynamicNotionalCap,              // 설정 상한 (기본 $2,200)
)
```

### 6.3 핵심 원칙: floor 없음

- depth가 얕으면 진입 자체를 **skip** (강제 floor 미적용)
- `targetNotional < $100`이면 `depth_insufficient`로 기록하고 진입 거부
- 경제성 판단은 `minProfitUSD`, `minEVRatio`, impact cap으로 수행

### 6.4 depth cap 계산

```typescript
calcOrderbookImpactBps(bids, asks, notionalUSDT, side)
→ { impactBps, fillPrice, worstPrice, midPrice, depthCapNotional }
```

- `depthCapNotional`: 오더북 레벨을 순회하며 **per-side 6bps** (round-trip 12bps의 절반) 이내에서 수용 가능한 최대 금액
- impact는 **각 거래소의 자체 mid price 기준** (교차 거래소 평균 아님)

---

## 7. Impact 기반 유동성 가드

### 7.1 기존 방식 (v1)

```
maxSlippagePercent = 1.5%  (leg별)
```

### 7.2 새 방식 (v2)

```
roundTripImpactBps = (shortSlippage + longSlippage) × 2 × 100
→ maxRoundTripImpactBps (기본 12bps) 초과 시 진입 거부
```

### 7.3 impact 계산 기준

- **각 거래소 오더북 mid 기준**으로 impact 산출
  - `shortImpact = |shortFillPrice - shortMid| / shortMid × 10000`
  - `longImpact = |longFillPrice - longMid| / longMid × 10000`
- 교차 거래소 가격을 섞어서 mid를 만들지 **않음**

### 7.4 entry gap guard 연동

- `useImpactGuards: true` → entry gap threshold도 impact 기준으로 전환 (`maxRoundTripImpactBps / 100`%)
- `useImpactGuards: false` → legacy `maxSlippagePercent` 유지

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

### 8.3 v2.1 상수

```typescript
HEDGE_RATIO_MIN = 0.998
HEDGE_RATIO_MAX = 1.002
MAX_HEDGE_MISMATCH_PCT = 0.20
MAX_ORPHAN_LEG_MS = 300      // 단독 leg 허용 시간 (ms)
```

---

## 9. 펀딩 Drift Buffer

### 9.1 목적

화면에 표시된 funding rate를 그대로 쓰지 않고, 보수적으로 깎아서 사용.
Bybit는 매분 갱신, OKX는 직전 1분 값 사용 — 표시값과 실제 정산값 차이 가능.

### 9.2 계산식

```typescript
calcDriftBuffer(displayedRate, recentRateHistory?, exchangeUsesInstantRate?)

// recentRateHistory 없는 경우:
//   일반 거래소: 1bp (0.0001)
//   즉시 rate 거래소 (OKX): max(1bp, |rate| × 5%)

// recentRateHistory 있는 경우:
//   buffer = max(|last1mChange|, |last5mChange| × 0.5, 1bp)
//   즉시 rate 거래소: buffer × 1.5
```

### 9.3 EV 계산 적용

```
shortFR_eff = displayedShortFR - shortDriftBuffer
longFR_eff = displayedLongFR + longDriftBuffer
expectedFundingUSD = notional × (shortFR_eff - longFR_eff)
```

---

## 10. Conservative EV 계산

### 10.1 공식

```
expectedNetUSD = expectedFundingUSD
  - roundTripFeeUSD
  - entryImpactUSD
  - exitImpactUSD
  - timingReserveUSD (0.5bp)
```

### 10.2 진입 기준

```
expectedNetUSD >= MIN_PROFIT_USD ($1.25)
expectedNetUSD / worstCaseExitUSD >= MIN_EV_RATIO (1.8)
```

여기서 `worstCaseExitUSD = roundTripFee + entryImpact + exitImpact + timingReserve`

### 10.3 시간 정규화 점수

```
score = expectedNetUSD × fillProb × fundingCaptureProb / capitalLockSec
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
  getPairEntryLeadMs(short, long),    // 거래소 프로파일 기반
  legacyTimingConfig.entryLeadMs,     // fallback
)
```

| 페어 | 적용 리드 |
|------|-----------|
| Binance ↔ Bybit | 7s (Binance 기준) |
| Bybit ↔ Gate | 5s |
| OKX ↔ 아무거나 | 7s |
| BingX ↔ 아무거나 | 35s (Tier C, 기본 비활성) |

### 11.3 Funding Timestamp 정렬

v2에서 `useConfirmedClose: true`이면:
```
|shortFundingTime - longFundingTime| > 3초 → 진입 거부
```

기존 discovery 단계의 120초 tolerance는 유지 (목록 표시용).
실제 실행 단계에서만 3초 제한 적용.

---

## 12. UI 토글

### 12.1 위치

전략 설정 패널 (`components/dashboard/StrategyPanel.tsx`) 내
텔레그램 설정 위에 **"v2.1 Confirmed Snipe"** 섹션으로 배치.

### 12.2 구성

- 6개 독립 토글 스위치 (각각 ON/OFF)
- `useDynamicNotional` ON 시 **노셔널 상한** 입력 필드 표시 ($500~$10,000, 기본 $2,200)
- 안내 문구: "모든 토글 기본 OFF. 기존 전략 동작에 영향 없음."

### 12.3 Config 전달 경로

```
StrategyPanel UI
  → setStrategyConfig({ confirmedSnipeConfig: { ... } })
  → buildSchedulerConfig() / buildServerSimSchedulerConfig()
  → API /api/scheduler (REAL) / /api/sim-scheduler (SIM)
  → ServerScheduler / ServerSimScheduler
```

---

## 13. 수수료 체계 (v1 유지)

Referral Max 할인 프리셋 기본 적용 (사용자 feeOverrides로 override 가능):

| 거래소 | Taker | Maker |
|--------|-------|-------|
| Binance | 0.040% | 0.016% |
| Bybit | 0.044% | 0.016% |
| OKX | 0.040% | 0.016% |
| Bitget | 0.048% | 0.016% |
| Gate | 0.040% | 0.016% |
| BingX | 0.040% | 0.016% |

v2에서 IOC-limit only 사용 시 항상 taker fee 적용.

---

## 14. 리스크 관리 종합

| 리스크 | v1 대응 | v2 추가 대응 |
|--------|---------|-------------|
| 가격 리스크 | 10초 보유 | 거래소별 confirmed close |
| 슬리피지 | maxSlippage 1.5% | impact 12bps hard cap |
| 한쪽만 체결 | rollback + flatten | IOC-limit only + hedge ratio pre-check |
| 헷지 mismatch | 2% 트림 | 0.20% 트림 + ratio 0.998~1.002 |
| 유동성 부족 | 24h volume 필터 | depth 기반 동적 노셔널 (floor 없음, skip) |
| 펀딩 미수령 | 고정 지연 청산 | settlement 확인 polling |
| Rate 변동 | 표시값 그대로 | drift buffer 보수적 반영 |
| 거래소 장애 | API 30회 연속 실패 시 중단 | capability flags + Tier C observe-only |

---

## 15. 설정 값

### 15.1 기본 운영값 (v1, 변경 없음)

```
포지션당 마진: $100
거래소당 잔고: $200
레버리지: 17x
노셔널/포지션: $1,700
최소 스프레드: 0.20%
최대 슬리피지: 1.5%
최소 24h 거래량: $7,500,000
진입 타이밍: 펀딩 3.5초 전
청산 지연: 펀딩 후 1초
```

### 15.2 v2 권장 운영값 (토글 ON 시)

```
useConfirmedClose: true
useIocLimitOnly: true
useDynamicNotional: true
useImpactGuards: true
useStrictHedge: true
useDriftBuffer: true
dynamicNotionalCap: $2,200
```

### 15.3 권장 활성화 순서

1. `useIocLimitOnly` — 가장 안전, 시장가 진입 제거
2. `useStrictHedge` — 헷지 품질 향상
3. `useImpactGuards` — 유동성 가드 정밀화
4. `useConfirmedClose` — 펀딩 캡처 안정성
5. `useDynamicNotional` — 얕은 시장 리스크 감소
6. `useDriftBuffer` — 수익 추정 보수성

---

## 16. 시스템 아키텍처

```
┌─ Client (Next.js React) ──────────────────────┐
│  5초 폴링: 펀딩레이트, 오더북 스프레드          │
│  3초 폴링: 서버 SIM 스케줄러 상태 동기화        │
│  UI: 기회 목록, 잔고, 거래 내역, 설정           │
│  v2.1 토글: ConfirmedSnipeConfig 6개 스위치     │
└──────────────┬────────────────────────────────┘
               │ REST API
┌──────────────▼────────────────────────────────┐
│  Server (Next.js API Routes)                   │
│  ServerSimScheduler: SIM 모드 자동 거래         │
│  ServerScheduler: REAL 모드 자동 거래            │
│  ExchangeProfiles: 거래소별 tier/capability     │
│  CCXT: 6개 거래소 API 연동                      │
│  상태 파일 기반 영속성 (data/*.json)             │
└───────────────────────────────────────────────┘
```

---

## 17. 파일 구조

| 파일 | 역할 |
|------|------|
| `lib/exchangeProfiles.ts` | 거래소별 프로파일, tier, capability flags |
| `lib/types.ts` | 전략 타입, v2 상수, ConfirmedSnipeConfig |
| `lib/opportunities.ts` | 기회 탐색, drift buffer, conservative EV, 시간 정규화 점수 |
| `lib/exchanges/index.ts` | CCXT 래퍼, 오더북 분석, impact 계산, settlement check, IOC-limit 진입 |
| `lib/serverScheduler.ts` | REAL 모드 스케줄러 (거래소별 entry lead, confirmed close, dynamic notional) |
| `lib/serverSimScheduler.ts` | SIM 모드 스케줄러 (config passthrough) |
| `app/api/strategy/execute/route.ts` | 수동 실행 API (impact guard, hedge ratio, IOC flag) |
| `components/dashboard/StrategyPanel.tsx` | 전략 설정 UI + v2 토글 섹션 |
| `store/fundingStore.ts` | Zustand 상태 (양 scheduler에 config 전달) |

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
