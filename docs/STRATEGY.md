# Funding Fee Arbitrage Strategy

> 최종 업데이트: 2026-03-30
> v2.1 Confirmed Snipe 지원 추가 (feature flag 방식, 기본 OFF)

## 개요

크립토 선물 거래소 간 **펀딩비 스프레드**를 이용한 델타 뉴트럴 차익거래 프로그램.
6개 거래소(Binance, Bybit, OKX, Bitget, Gate, BingX)의 펀딩레이트를 실시간 비교하여,
스프레드가 수수료를 초과하는 기회를 포착하고 자동으로 진입/청산한다.

## 전략: Snipe (스나이프)

**펀딩 시간 직전 진입 → 펀딩 수령 → 즉시 청산.**

가격 변동 리스크를 최소화하기 위해 포지션 보유 시간을 10~15초로 극한 압축.
Hold(장기 보유) 모드는 가격 변동 리스크가 크므로 영구 제거됨.

### 타임라인

```
펀딩 시간 -5초  →  양쪽 거래소 동시 진입 (숏 + 롱)
펀딩 시간  0초  →  펀딩비 정산 (숏 거래소에서 수령)
펀딩 시간 +2초  →  양쪽 동시 청산
```

## 수익 구조

### 펀딩비 차익

```
수익 = 노셔널 × (숏거래소 펀딩레이트 - 롱거래소 펀딩레이트)
비용 = 왕복 수수료 (진입+청산, 양쪽) + 슬리피지
순수익 = 수익 - 비용
```

### 예시 (실제 설정 기준)

- 포지션당 마진: $100, 레버리지: 17x → 노셔널: $1,700
- 숏 거래소 펀딩레이트: +0.50% / 롱 거래소 펀딩레이트: +0.05%
- 스프레드: 0.45%
- 왕복 수수료 (Referral Max): ~0.16%
- 슬리피지 (양방향): ~0.10%
- **순수익: $1,700 × (0.45% - 0.16% - 0.10%) = $3.23 / 1회**

## 헷징 방식

**교차 거래소 선물-선물 (Cross-Exchange Perp-Perp)**

- 숏: 펀딩레이트가 높은 거래소 (펀딩비 수령)
- 롱: 펀딩레이트가 낮은 거래소 (펀딩비 지급 최소화)
- 양쪽 동일 노셔널 (Equal-Notional) → 가격 변동 상쇄

같은 거래소 현물-선물(Spot-Perp)이 아닌 교차 거래소 방식을 사용하는 이유:
현물 보유 불필요, 양방향 레버리지 활용, 거래소 간 레이트 차이가 클 때 유리.

## 진입 가드 (Safety Guards)

| 가드 | 기준 | 설명 |
|---|---|---|
| 슬리피지 상한 | maxSlippagePercent (기본 1.5%) | 오더북 기반 체결가 시뮬레이션 |
| 거래소 간 가격 괴리 | maxSlippagePercent | 숏/롱 체결가 차이 제한 |
| 수익성 검증 | realNetSpread > 0 | 스프레드 - 왕복슬리피지×2 - 왕복수수료 - 안전마진 |
| 최소 거래량 | minVolume24hUSD (기본 $7.5M) | 유동성 부족 코인 제외 |
| 오더북 필수 | fetchMarketFillPrice 필수 성공 | 실패 시 진입 거부 (markPrice 폴백 금지) |

## 수수료 체계

Referral Max 할인 프리셋 적용 (사용자 커스텀 가능):

| 거래소 | Taker | Maker |
|---|---|---|
| Binance | 0.040% | 0.016% |
| Bybit | 0.044% | 0.016% |
| OKX | 0.040% | 0.016% |
| Bitget | 0.048% | 0.016% |
| Gate | 0.040% | 0.016% |
| BingX | 0.040% | 0.016% |

왕복 수수료 = (숏 taker + 롱 taker) × 2 (진입+청산)

## 순수익 계산식

```
realNetSpread = spreadPercent
              - (shortSlippage + longSlippage) × 2    // 왕복 슬리피지
              - hedgeFeePct                            // 왕복 수수료
              - 0.015%                                 // 안전 마진 (1.5bps)
```

`realNetSpread > 0` 일 때만 진입 허용.

## 시스템 아키텍처

```
┌─ Client (Next.js React) ──────────────────────┐
│  5초 폴링: 펀딩레이트, 오더북 스프레드          │
│  3초 폴링: 서버 SIM 스케줄러 상태 동기화        │
│  UI: 기회 목록, 잔고, 거래 내역, 설정           │
└──────────────┬────────────────────────────────┘
               │ REST API
┌──────────────▼────────────────────────────────┐
│  Server (Next.js API Routes)                   │
│  ServerSimScheduler: SIM 모드 자동 거래         │
│  ServerScheduler: REAL 모드 자동 거래            │
│  CCXT: 6개 거래소 API 연동                      │
│  상태 파일 기반 영속성 (data/*.json)             │
└───────────────────────────────────────────────┘
```

## SIM 모드 vs REAL 모드

| | SIM | REAL |
|---|---|---|
| 잔고 | 가상 ($200/거래소) | 실제 API 잔고 |
| 주문 | 오더북 시뮬레이션 | 실제 주문 실행 |
| 펀딩 수령 | 추정 계산 | 거래소 API 검증 |
| 용도 | 전략 검증 | 실 수익 |

## 주문 실행 전략

1. **Post-Only 메이커** 시도 (수수료 절감)
2. 90% 미만 체결 시 → **IOC 테이커** 폴백
3. 그래도 미달 시 → **시장가** 최종 폴백

## 리스크 관리

- **가격 리스크**: 스나이프 (10초 보유)로 최소화
- **슬리피지 리스크**: 오더북 기반 사전 시뮬레이션 + 가드
- **유동성 리스크**: 최소 거래량 $7.5M 필터
- **거래소 리스크**: 6개 거래소 분산
- **시스템 리스크**: API 30회 연속 실패 시 자동 중단 + 텔레그램 알림

## 설정 값 (현재)

```
포지션당 마진: $100
거래소당 잔고: $200 (롱+숏)
레버리지: 17x
노셔널/포지션: $1,700
최소 스프레드: 0.20%
최대 슬리피지: 1.5%
최소 24h 거래량: $7,500,000
진입 타이밍: 펀딩 5초 전
청산 지연: 펀딩 후 2초
```

## 배포

- AWS EC2 t3.small (ap-southeast-1)
- PM2 프로세스 매니저
- Next.js standalone 빌드
- 1GB 스왑 파일 (OOM 방지)

---

## v2.1 Confirmed Snipe (opt-in)

모든 v2.1 기능은 `ConfirmedSnipeConfig` 뒤에 위치하며, **기본 OFF**. 기존 동작 100% 유지.

### 거래소 프로파일 (`lib/exchangeProfiles.ts`)

| 거래소 | Tier | 진입 리드(초) | 정산 대기(초) | Settlement Check | IOC 지원 |
|--------|------|-------------|-------------|-----------------|---------|
| Binance | A | 7 | 20 | O | O |
| Bybit | A | 5 | 12 | O | O |
| OKX | B | 7 | 75 | O | O |
| Bitget | A | 7 | 20 | O | O |
| Gate | A | 5 | 12 | O | O |
| BingX | C | 35 | 75 | X | O |

### 토글 목록 (`ConfirmedSnipeConfig`)

| 토글 | 기본 | 설명 |
|------|------|------|
| `useImpactGuards` | OFF | impact bps 기반 가드 (슬리피지 % 대체) |
| `useDynamicNotional` | OFF | 오더북 깊이 기반 동적 노셔널 (floor 없음, 경제성 미달 시 skip) |
| `useDriftBuffer` | OFF | 펀딩레이트 drift 버퍼 적용 |
| `useConfirmedClose` | OFF | 펀딩 정산 확인 후 청산 (거래소 profile 기반) |
| `useIocLimitOnly` | OFF | IOC-limit only 진입 (Post-Only cascade 제거) |
| `useStrictHedge` | OFF | 헷지 비율 0.998~1.002, mismatch 0.20% |

### impact 계산 기준

- **각 거래소 오더북 mid 기준**으로 impact 산출 (교차 거래소 평균 아님)
- round-trip hard cap: 12bps (설정 가능)
- leg당 depth cap: 6bps

### 동적 노셔널

- floor 없음 — depth가 얕으면 진입 자체를 skip
- 경제성 판단: `minProfitUSD`, `minEVRatio`, impact cap으로 결정
- 상한: `dynamicNotionalCap` (기본 $2,200)

### Confirmed Close

- 펀딩 시간에 close timer 발화 → 양쪽 settlement 확인 polling
- 양쪽 모두 confirmed → 즉시 동시 청산
- `maxSettlementWaitSec` 초과 → 강제 동시 청산
- `supportsFundingSettlementCheck = false`인 거래소는 legacy 방식 유지
