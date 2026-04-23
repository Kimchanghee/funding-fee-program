# Runtime Audit 구조 정리 (2026-04-23)

## 목적
- 거래 실행(`execution`) / 미실행 차단(`guard_block`) / 시스템 로그(`logs`)를 분리해 원인 분석 속도를 높인다.
- UI 표시 상태와 서버 런타임 실제 상태를 분리/대조해 오인 가능성을 줄인다.

## 파일/폴더 분리
- 런타임 상태 클라이언트 모듈
  - `lib/runtime/schedulerRuntimeClient.ts`
- 24시간 감사 리포트(분석 모듈)
  - `lib/analysis/runtime/types.ts`
  - `lib/analysis/runtime/buildRuntimeAuditReport.ts`
- 감사 리포트 API
  - `app/api/analysis/runtime-audit/route.ts`
- UI 상태 표시/동기화
  - `store/fundingStore.ts`
  - `components/dashboard/Header.tsx`

## API
- `GET /api/analysis/runtime-audit?hours=24&sampleLimit=30`
  - `runtime`: REAL/SIM 런타임 활성 상태
  - `diagnosis`: 왜 거래가 없었는지 1차 원인 코드/설명
  - `report.execution`: 실행 이벤트 집계/샘플
  - `report.guardBlocks`: guard_block 집계/샘플
  - `report.nonExecutionTradeEvents`: schedule_probe 등 비실행 이벤트
  - `report.systemLogs`: 시스템 로그 집계/샘플

## 운영 체크 포인트
- UI의 자동투자 표시와 `runtime` 표시가 다르면 런타임 기준으로 판단
- 런타임 active source of truth는 `/api/scheduler`, `/api/sim-scheduler` 이며,
  `/api/snipe-state`는 `simulationMode` 동기화에만 사용 (상태 경합 방지)
- 거래 원인 분석은 아래 순서 권장
  1. `runtime` 활성 여부
  2. `execution.total`
  3. `guardBlocks.byReason`
  4. `systemLogs.byLevel`
