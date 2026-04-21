# 예약/미체결(놓친 거래) 분석 보고서 (2026-04-22, 최신 재집계)

- 작성 시각(KST): `2026-04-22`
- 기준 파일: `data/remote-47.128.214.182/analysis-missed-72h-latest.json`
- 윈도우: `2026-04-19 03:29:47.891` ~ `2026-04-22 03:26:59.099` (KST)

## 1) 왜 거래를 안 했는가

`schedule_probe` 기준:

- `execute`: 114건
- `execute_success`: 14건
- `execute_failed`: 99건
- `canceled_before_execute`: 350건 (전부 `schedule_replanned`)

즉, 로직 자체가 정지한 것이 아니라, 실행 직전 재평가/재계획 취소가 매우 많다.

## 2) execute_failed 주요 사유

- `funding_window_shifted`: 36
- `profitability_insufficient`: 26
- `live_spread_reverted`: 18
- `slippage_exceeded`: 8
- `orderbook_unavailable`: 5
- `entry_gap_exceeded`: 3
- `position_already_active`: 3

## 3) 완화하면 수익인가 손해인가

주의: 아래 값은 실현손익이 아닌 `expectedNetProfit` 합산 가정.

- S1 (`execute_failed` 99건 전부 강행): `-5699.4955 USD`
- S2 (`execute_failed` 중 양수 기대값만 22건): `+229.9540 USD`
- S3 (`schedule_replanned` 취소 350건 전부 강행): `-18779.6608 USD`
- S4 (`schedule_replanned` 중 양수 기대값만 120건): `+1249.0422 USD`

결론:

- 일괄 완화는 손해 위험이 크다.
- 양수 기대값 선별 완화는 가능성이 있으나, 슬리피지/윈도우 이동 재검증 없이 강행하면 재악화될 수 있다.

## 4) 10~11% 예약 이슈 체크

- 최근 72시간 `10% <= expectedRoiPercent < 11%`: `0건`
- `10% <= expectedRoiPercent < 12%`: 2건
  - `pre_30m`: 1
  - `canceled_before_execute(schedule_replanned)`: 1
  - 실행(`execute/execute_success/execute_failed`) 전환: 0

즉 최근 구간 기준으로는 “10~11% 예약 후 체결 손실”보다,
재계획 취소로 실행이 보류된 케이스가 핵심이다.
