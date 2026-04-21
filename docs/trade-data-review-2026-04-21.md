# 거래 데이터 추가 검토 보고서 (2026-04-21)

- 작성일시(KST): `2026-04-21`
- 검토 범위: 최근 서버 실데이터(60h/72h), 저장 구조, 추후 분석 정밀도 개선을 위한 데이터 요구사항
- 전제: **설정/튜닝은 즉시 적용하지 않음** (요청사항 반영)

## 1) 현재 상태 재확인 (요약)

- 라이브 누적 손익률(현재 상태): **-2.548129%**
- 기준 수치: 초기자본 `2000` → 현재 `1949.037427` (net `-50.962573`)
- 최근 60시간 실현손익: **+44.934294 USD** (13페어, 승률 53.85%)
- 최근 72시간 실현손익: **-55.280809 USD** (18페어, 승률 50.00%)
- 즉, `-2.83%`는 최신 스냅샷이 아니라 과거값일 가능성이 높음

## 2) 추가 검토에서 확인한 데이터/분석 리스크

### 2-1. API 파라미터 혼동 위험

- `app/api/trades/list`는 전체조회 파라미터로 `all=true`를 사용함
- `allDates=true`, `hours=60` 같은 파라미터는 현재 라우트에서 직접 처리하지 않음
- 결과적으로 파라미터를 잘못 쓰면 “전체/60h/72h”가 아닌 일부 데이터만 읽히는 상황이 생길 수 있음

### 2-2. 대용량 단건 응답 신뢰성

- `/api/trades/list?all=true`를 단건으로 크게 받으면 네트워크에서 중간 끊김(`curl 18`)이 발생할 수 있음
- 이번 검토에서는 `page/pageSize` 페이지네이션으로 전량 수집해서 보정함

### 2-3. 체결 전(pre)/체결(execute) 이벤트 조인 난이도

- `pre_*`, `execute` 이벤트는 `pairId`가 없는 경우가 많음
- `execute_success/post_*`는 `pairId`가 존재
- 따라서 거래 단위 분석 시, pre/execute는 라우트+시간 근접 매칭이 필요해 조인 복잡도/오차 가능성이 증가함

## 3) “있으면 더 좋은 데이터” (우선순위)

### P0 (가장 먼저 필요)

- `schedule_probe` 전 구간에 `probeId`를 이벤트 필드로 저장
- `schedule_probe` 전 구간에 `opportunityId`를 이벤트 필드로 저장
- `pre_*`/`execute`에도 `pairId` 또는 `linkedPairId`를 기록

효과:
- 거래 1건의 라이프사이클(1h/30m/15m/10m/직전/체결/직후) 조인이 1:1로 고정됨
- 현재의 근접시간 매칭 오차를 사실상 제거 가능

### P1 (분석 품질 향상)

- 실행 시점 설정 스냅샷을 이벤트에 기록
- 예: `minSpreadPercent`, `maxSlippagePercent`, `confirmedSnipeConfig`, `minVolume24hUSD`

효과:
- “왜 그때 그 판단이 나왔는지”를 나중에 정확히 역추적 가능
- 설정 변경 전/후 효과 비교가 쉬워짐

### P1 (실행 원인 해상도 향상)

- 체결/실패 시 양 레그별 상세 수치 기록 강화
- 예: `filledNotional`, `fillPrice`, `slippagePercent`, `orderbook depth`, `entryGap drift`, `fundingShiftMs`

효과:
- 손익 변동의 원인이 funding인지 price인지 execution quality인지 분리 정확도 상승

### P2 (운영 안정성/품질 감시)

- 이벤트 증가 시퀀스(`eventSeq`), 런 식별자(`runId`), 프로세스 재시작 식별자(`restartId`) 기록

효과:
- 누락/중복/재시작 경계 구간을 자동 검출 가능

## 4) 지금 당장 적용 없이 “추가 검토”로 할 일

### Step A. 데이터 계약(로그 스키마) 확정

- `schedule_probe`에 공통 식별자(`probeId`, `opportunityId`) 추가 여부 확정
- 실행계열 이벤트(`snipe_entry`, `snipe_exit`, `funding`)와의 연결키 표준화

### Step B. 품질 검증 리포트 자동화

- 매 1시간 리포트에서 아래 4개를 자동 검증
- `체결 전환율`, `execute_failed reason 분포`, `expected vs realized 오차`, `라우트별 손익 집중도`

### Step C. 설정 변경 전 샘플 검증

- 설정을 바꾸기 전, 최근 72h로 “가상 필터 재생산” 리포트 생성
- 예: `pre_1m expected > 0` 조건이 실제 손익에 미치는 영향 비교

## 5) 앞으로 거래 데이터가 저장되는 위치

기본 루트:

- `FUNDING_FEE_DATA_DIR` 환경변수가 있으면 해당 경로
- 없으면 서버 실행 `cwd` 기준 `./data`
- standalone 실행 시 `scripts/start-standalone.js`에서 명시적으로 `<프로젝트 루트>/data`로 고정

주요 파일/디렉토리:

- 전체 거래 이벤트: `data/trades/YYYY-MM-DD.jsonl`
- 실행 거래(시뮬): `data/trades-executed/sim/YYYY-MM-DD.jsonl`
- 실행 거래(실계좌): `data/trades-executed/real/YYYY-MM-DD.jsonl`
- 펀딩 영수증(시뮬): `data/funding-receipts/sim/YYYY-MM-DD.jsonl`
- 펀딩 영수증(실계좌): `data/funding-receipts/real/YYYY-MM-DD.jsonl`
- 일반 로그: `data/logs/YYYY-MM-DD.jsonl`
- 시뮬 스케줄러 상태: `data/sim-scheduler-state.json`
- 실거래 스케줄러 상태: `data/scheduler-state.json`
- 시뮬 상태: `data/sim-state.json` (+ backup/tmp)
- 스나이프 상태: `data/snipe-state.json`
- 실계좌 포지션 메타: `data/real-position-meta.json`
- 시간대별 기회 스냅샷: `data/analysis/opportunities-hourly/<source>/<YYYY-MM-DD-HH>.json`
- 랭킹 변화 스냅샷: `data/snapshots/<timestamp>.json`
- 스케줄러 로그: `data/scheduler.log`

주의:

- `app/api/trades/clear`는 옵션에 따라 `trades-executed`, `funding-receipts`까지 함께 삭제할 수 있음
- `fileLogger`에는 자동 보관기간 삭제 로직이 없어서, 명시 삭제 전까지 누적 저장됨

## 6) 결론

- 즉시 튜닝 없이도, 현재 데이터만으로 60h/72h 재분석은 충분히 가능함
- 다만 거래 단위 정밀 분석(특히 pre/execute 구간)의 안정성을 높이려면 식별자 기반 로그 보강이 필요함
- 다음 단계는 “설정 변경”보다 “로그 스키마 고정 + 품질 검증 자동화”를 먼저 진행하는 것이 안전함

