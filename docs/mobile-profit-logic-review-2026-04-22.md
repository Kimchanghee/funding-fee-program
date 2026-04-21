# 모바일 최적화 + 예약 ROI/미체결 분석 + 수익률 로직 재검토 (2026-04-22)

- 작성 시각(KST): `2026-04-22`
- 기준 데이터
  - `data/remote-47.128.214.182/events-all-72h-latest.json`
  - `data/remote-47.128.214.182/analysis-missed-72h-latest.json`
  - `data/remote-47.128.214.182/live-sim-scheduler-status-latest.json`
  - `data/remote-47.128.214.182/live-snipe-state-latest.json`

## 1) 모바일 최적화 적용 범위 (컴포넌트 전수)

이번 작업은 인라인 고정폭/고정그리드가 많은 구조를 기준으로,
`컴포넌트 클래스 훅 추가 + globals.css 반응형 오버라이드` 방식으로 반영했다.

적용 파일:

- 페이지: `app/page.tsx`, `app/settings/page.tsx`, `app/login/page.tsx`, `app/error.tsx`, `app/global-error.tsx`
- 대시보드: `Header`, `DataStatusBar`, `OpportunityCard`, `FeePaybackSummary`, `BalanceCards`, `BalanceEqualizationPanel`, `FundingHistory`, `TradeHistory`, `FundingRateTable`, `PositionsTable`, `LogPanel`, `ReturnProjectionPanel`, `ApiPanel`, `StrategyPanel`
- 공통 UI: `ConfirmDialog`, `KSTClock`, `CountdownTimer`, `LogBadge`, `StatusDot`
- 공통 스타일: `app/globals.css` (1200/1024/768/480 브레이크포인트)

핵심 개선:

- 헤더/필터/액션 영역 줄바꿈, 스택, 가로 스크롤 안전화
- 고정폭 모달/카드(`minWidth`) 모바일에서 강제 해제
- 대형 테이블 최소폭 + 래퍼 스크롤 분리로 레이아웃 붕괴 방지
- 설정 페이지 입력/토글/거래소 행 전체 1열 대응
- 에러 화면/공용 뱃지/카운트다운까지 모바일 타이포 축소 적용

## 2) 72시간 기준 "예약/미체결" 실제 집계

분석 윈도우:

- 시작: `2026-04-19 03:29:47.891 KST`
- 종료: `2026-04-22 03:26:59.099 KST`
- 이벤트 수: `19,093`

`schedule_probe` 집계:

- 전체: `18,924`
- `execute`: `114`
- `execute_success`: `14`
- `execute_failed`: `99`
- `canceled_before_execute`: `350` (전부 `schedule_replanned`)

즉, "거래를 아예 안 도는 상태"가 아니라,
실행 직전 재평가/재스케줄로 취소되는 비중이 큰 구조다.

## 3) 10~11% / 10~12% 예약 ROI 검증

기준: `schedule_probe.expectedRoiPercent`

- `10% <= ROI < 11%`: `0건`
- `10% <= ROI < 12%`: `2건`
  - `pre_30m`: 1건
  - `canceled_before_execute(schedule_replanned)`: 1건
  - `execute/execute_success/execute_failed`: 0건

해석:

- 최근 72시간 구간에서는 **10~11% 예약이 실제 체결로 넘어간 케이스가 없음**.
- "10~11% 예약이었는데 막상 거래 수익 못 먹었다"는 패턴보다,
  **재계획 취소로 실행 자체가 보류된 패턴**이 핵심이다.

## 4) 완화했으면 수익/손해였는지 (가상 시나리오)

주의: 아래는 실현손익이 아니라 이벤트의 `expectedNetProfit` 합산 가정.

### S1. `execute_failed` 99건 전부 완화 강행

- 기대손익 합: `-5699.4955 USD`
- 결론: 일괄 완화는 손해 위험이 큼

### S2. `execute_failed` 중 `expectedNetProfit > 0`만 선별 (22건)

- 기대손익 합: `+229.9540 USD`
- 결론: 선별 완화는 여지 있으나, 체결시 슬리피지로 악화 가능

### S3. `canceled_before_execute(schedule_replanned)` 350건 전부 강행

- 기대손익 합: `-18779.6608 USD`
- 결론: 재계획 취소 무시는 매우 비효율적

### S4. 재계획 취소 중 양수 기대값만 선별 (120건)

- 기대손익 합: `+1249.0422 USD`
- 결론: 완화 자체보다 **양수 기대 + 리스크 캡 기반 선별**이 필요

## 5) 수익률 로직 검토 (오더북/거래량/슬리피지/수수료)

### 반영되는 부분

- 수수료/페이백 반영:
  - `resolveRuntimeFee` + `calcConservativeEV`
- 오더북/임팩트/슬리피지 반영:
  - `fetchOrderbook`, `fetchMarketFillPrice`, `calcOrderbookImpactBps`
  - 실행 단계에서 `slippage_exceeded`, `entry_gap_exceeded`, `profitability_insufficient` 가드 작동

### 보완 필요(중요)

1. SIM의 `minVolume24hUSD` 실질 미적용

- `serverSimScheduler`는 `findOpportunities(..., minVolume24hUSD)` 호출
- `findOpportunities` 내부에서 `minVolume24hUSD`를 `void` 처리
- 즉, SIM 후보 생성 단계에서 최소 거래량 필터가 실제로 적용되지 않음

2. SIM/REAL `expectedRoiPercent` 분모 기준 불일치

- SIM: `expectedNetProfit / (investmentUSDT * 2)`
- REAL: `expectedNetProfit / (investmentUSDT * leverage)`
- 같은 ROI 라벨이지만 의미가 달라 화면 비교 시 혼선 가능

3. SIM `analysis_candidate` 기대손익이 보수 EV가 아닌 `opportunity.netProfit` 기준

- 후보 단계 수치와 실행 직전(실측 반영) 수치 괴리가 발생할 수 있음

## 6) 현재 예약 상태(실행 대기)

`/api/sim-scheduler` 기준 예약 3건:

- `CHIP bybit->binance` 목표 `2026-04-22 04:59:53 KST` / 펀딩 `05:00:00`
- `FIO bybit->binance` 목표 `2026-04-22 04:59:53 KST` / 펀딩 `05:00:00`
- `TRU binance->bybit` 목표 `2026-04-22 08:59:53 KST` / 펀딩 `09:00:00`

즉, 최근 무거래처럼 보인 구간은 일부는 대기 시간대 영향이며,
핵심은 실행 단계 가드/재계획 취소 누적으로 보는 것이 맞다.

## 7) 거래 데이터 저장 위치

저장 루트 우선순위:

1. `FUNDING_FEE_DATA_DIR` 환경변수
2. 기본 `./data` (standalone 실행 시 `.next/standalone` 바깥 `data`)

주요 경로:

- 거래 이벤트 원본: `data/trades/YYYY-MM-DD.jsonl`
- 실행 거래 분리: `data/trades-executed/sim/YYYY-MM-DD.jsonl`, `data/trades-executed/real/YYYY-MM-DD.jsonl`
- 펀딩 수령내역: `data/funding-receipts/sim/YYYY-MM-DD.jsonl`, `data/funding-receipts/real/YYYY-MM-DD.jsonl`
- 로그: `data/logs/YYYY-MM-DD.jsonl`

## 8) 결론

- 모바일 최적화는 공용/UI/에러 화면까지 포함해 컴포넌트 전수 반영 완료.
- 최근 72시간의 10~11% 이슈는 "체결 후 수익 미실현"보다 "재계획 취소"가 주원인.
- 완화 전략은 일괄 완화가 아니라, 양수 기대값 선별 + 리스크 캡 조건으로만 제한 적용해야 함.
- 로직 측면에서 `SIM 거래량 필터`, `ROI 분모 일관성`, `후보 기대손익 계산식` 3개는 우선 보완 대상.

## 9) 추가 반영(같은 날 후속 패치)

아래 3개 보완점은 코드에 반영 완료(배포/재시작 전 기준):

1. SIM 후보 단계 최소 거래량 필터 적용
   - `rebuildSchedules` 후보 필터에 `minVolume24hUSD` 체크 추가
   - `analysis_candidate`에도 `volume_below_min` 사유/볼륨 수치 기록 추가

2. SIM ROI 분모 기준 REAL과 일치
   - `expectedRoiPercent` 계산식을 `expectedNet / (investment * leverage)`로 통일

3. SIM `analysis_candidate` 기대손익을 보수 EV 기준으로 교체
   - 기존 `opportunity.netProfit` 중심에서 `estimatePreEntryConservativeEV` 기반으로 변경
   - 분석 payload에 `passesMinProfit`, `passesEVRatio`, `evRatio` 포함

적용 파일:

- `lib/serverSimScheduler.ts`
- `lib/opportunities.ts` (볼륨 필터 적용 위치 주석 갱신)
