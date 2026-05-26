import { NextRequest, NextResponse } from 'next/server';
import { buildRuntimeAuditReport } from '@/lib/analysis/runtime/buildRuntimeAuditReport';
import { getServerSimScheduler } from '@/lib/serverSimScheduler';
import { formatTimestampYmdHmsMs } from '@/lib/timeFormat';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function parsePositiveInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const floored = Math.floor(numeric);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function getTopKey(items: Array<{ key: string; count: number }>, fallback: string): string {
  if (!items || items.length === 0) return fallback;
  return items[0].key;
}

function buildDiagnosis(args: {
  simActive: boolean;
  executionTotal: number;
  guardTotal: number;
  topGuardReason: string;
  lastExecutionAt: number | null;
  now: number;
}) {
  const hoursSinceLastExecution = args.lastExecutionAt == null
    ? null
    : Number(((args.now - args.lastExecutionAt) / (60 * 60 * 1000)).toFixed(2));

  if (!args.simActive) {
    return {
      code: 'scheduler_inactive',
      summary: 'SIM 스케줄러가 비활성이라 신규 시뮬레이션 거래가 발생하지 않았습니다.',
      hoursSinceLastExecution,
      evidence: {
        simActive: args.simActive,
      },
    };
  }

  if (args.executionTotal === 0 && args.guardTotal > 0) {
    return {
      code: 'guard_blocked',
      summary: `진입 시도는 있었지만 가드 조건으로 모두 차단되었습니다. (최다 사유: ${args.topGuardReason})`,
      hoursSinceLastExecution,
      evidence: {
        guardBlocks: args.guardTotal,
        topGuardReason: args.topGuardReason,
      },
    };
  }

  if (args.executionTotal === 0) {
    return {
      code: 'no_execution_events',
      summary: '스케줄러는 동작했지만 실행 이벤트가 없습니다. 후보/예약/가드 로그를 추가 확인해야 합니다.',
      hoursSinceLastExecution,
      evidence: {
        executionTotal: args.executionTotal,
        guardBlocks: args.guardTotal,
      },
    };
  }

  if (hoursSinceLastExecution !== null && hoursSinceLastExecution >= 2) {
    return {
      code: 'execution_stale',
      summary: `최근 실행 이벤트가 ${hoursSinceLastExecution}시간 전 이후로 없습니다.`,
      hoursSinceLastExecution,
      evidence: {
        executionTotal: args.executionTotal,
      },
    };
  }

  return {
    code: 'normal',
    summary: '실행 이벤트가 최근 윈도우 내에서 확인됩니다.',
    hoursSinceLastExecution,
    evidence: {
      executionTotal: args.executionTotal,
    },
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const hours = parsePositiveInt(url.searchParams.get('hours'), 24, 1, 168);
  const sampleLimit = parsePositiveInt(url.searchParams.get('sampleLimit'), 30, 0, 200);
  const now = Date.now();

  const report = buildRuntimeAuditReport({
    windowHours: hours,
    sampleLimit,
    now,
  });

  const simStatus = getServerSimScheduler().getStatus();
  const runtime = {
    real: {
      active: false,
      startedAt: null,
      removed: true,
    },
    sim: {
      active: !!simStatus.active,
      startedAt: simStatus.startedAt ?? null,
    },
  };

  const diagnosis = buildDiagnosis({
    simActive: runtime.sim.active,
    executionTotal: report.execution.total,
    guardTotal: report.guardBlocks.total,
    topGuardReason: getTopKey(report.guardBlocks.byReason, 'unknown'),
    lastExecutionAt: report.execution.latestAt,
    now,
  });

  return NextResponse.json({
    success: true,
    generatedAt: now,
    generatedAtText: formatTimestampYmdHmsMs(now),
    runtime,
    diagnosis,
    report: {
      ...report,
      window: {
        ...report.window,
        fromText: formatTimestampYmdHmsMs(report.window.from),
        toText: formatTimestampYmdHmsMs(report.window.to),
      },
      execution: {
        ...report.execution,
        samples: report.execution.samples.map((event) => ({
          ...event,
          timestampText: formatTimestampYmdHmsMs(event.timestamp),
        })),
      },
      guardBlocks: {
        ...report.guardBlocks,
        samples: report.guardBlocks.samples.map((event) => ({
          ...event,
          timestampText: formatTimestampYmdHmsMs(event.timestamp),
        })),
      },
      nonExecutionTradeEvents: {
        ...report.nonExecutionTradeEvents,
        samples: report.nonExecutionTradeEvents.samples.map((event) => ({
          ...event,
          timestampText: formatTimestampYmdHmsMs(event.timestamp),
        })),
      },
      systemLogs: {
        ...report.systemLogs,
        samples: report.systemLogs.samples.map((entry) => ({
          ...entry,
          timestampText: formatTimestampYmdHmsMs(entry.timestamp),
        })),
      },
    },
  }, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
