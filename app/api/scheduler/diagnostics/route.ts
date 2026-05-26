import { NextRequest, NextResponse } from 'next/server';
import {
  listTradeHistoryDates,
  readTradeHistory,
  type TradeHistoryScope,
  type TradeEvent,
} from '@/lib/fileLogger';
import { getServerSimScheduler } from '@/lib/serverSimScheduler';
import { formatTimestampYmdHmsMs } from '@/lib/timeFormat';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CountItem {
  key: string;
  count: number;
}

type DiagnosticsMode = 'sim';

function parseHours(value: string | null): number {
  if (!value) return 24;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 24;
  return Math.max(1, Math.min(168, Math.floor(parsed)));
}

function parseMode(value: string | null): DiagnosticsMode {
  void value;
  return 'sim';
}

function countBy(items: string[]): CountItem[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.trim() || 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function collectEvents(scope: TradeHistoryScope, from: number, to: number): TradeEvent[] {
  const events: TradeEvent[] = [];
  for (const date of listTradeHistoryDates(scope)) {
    for (const event of readTradeHistory(scope, date)) {
      const timestamp = normalizeTimestamp((event as { timestamp?: unknown }).timestamp);
      if (timestamp === null || timestamp < from || timestamp > to) continue;
      events.push({ ...event, timestamp });
    }
  }
  return events.sort((a, b) => b.timestamp - a.timestamp);
}

function getPairKey(event: TradeEvent): string {
  const base = event.baseAsset ?? event.symbol?.split('/')[0] ?? 'UNKNOWN';
  const shortExchange = event.shortExchange ?? 'unknown';
  const longExchange = event.longExchange ?? 'unknown';
  return `${base}:${shortExchange}->${longExchange}`;
}

function getProbeStatus(event: TradeEvent): string {
  const status = event.analysis && typeof event.analysis.status === 'string'
    ? event.analysis.status.trim()
    : '';
  return status || event.reason?.trim() || event.milestone?.trim() || 'unknown';
}

function getRejectReasons(event: TradeEvent): string[] {
  const raw = event.analysis && Array.isArray(event.analysis.rejectReasons)
    ? event.analysis.rejectReasons
    : [];
  return raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isSelectedProbe(event: TradeEvent): boolean {
  return event.type === 'schedule_probe'
    && (
      event.milestone === 'analysis_selected'
      || getProbeStatus(event) === 'selected'
      || event.analysis?.selected === true
    );
}

function isExecutionSuccess(event: TradeEvent): boolean {
  return (event.type === 'entry' || event.type === 'snipe_entry')
    && event.success !== false;
}

function buildNoEntrySample(event: TradeEvent) {
  const rejectReasons = getRejectReasons(event);
  return {
    timestamp: event.timestamp,
    timestampText: formatTimestampYmdHmsMs(event.timestamp),
    type: event.type,
    mode: event.simulation ? 'sim' : 'real',
    simulation: event.simulation,
    status: event.type === 'schedule_probe' ? getProbeStatus(event) : event.reason ?? event.type,
    baseAsset: event.baseAsset ?? null,
    pair: getPairKey(event),
    spreadPercent: event.spreadPercent ?? null,
    expectedNetProfit: event.expectedNetProfit ?? event.netProfit ?? null,
    rejectReasons,
    reason: event.reason ?? null,
    detail: event.detail ?? null,
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const hours = parseHours(url.searchParams.get('hours'));
  const mode = parseMode(url.searchParams.get('mode'));
  const scope: TradeHistoryScope = 'sim';
  const now = Date.now();
  const from = now - hours * 60 * 60 * 1000;
  const events = collectEvents(scope, from, now);

  const simScheduler = getServerSimScheduler().getStatus();
  const schedulerMode = 'sim';
  const scheduler = simScheduler;

  const scheduleProbes = events.filter((event) => event.type === 'schedule_probe');
  const selectedProbes = scheduleProbes.filter(isSelectedProbe);
  const executionSuccesses = events.filter(isExecutionSuccess);
  const guardBlocks = events.filter((event) => event.type === 'guard_block');
  const errors = events.filter((event) => event.type === 'error' || event.success === false);
  const rejectedProbes = scheduleProbes.filter((event) => {
    const status = getProbeStatus(event);
    return status === 'rejected' || status === 'unselected' || getRejectReasons(event).length > 0;
  });

  const topRejectReasons = countBy(rejectedProbes.flatMap(getRejectReasons));
  const topGuardReasons = countBy(guardBlocks.map((event) => event.reason ?? 'unknown'));
  const topSelectedPairs = countBy(selectedProbes.map(getPairKey));
  const topExecutedPairs = countBy(executionSuccesses.map(getPairKey));

  return NextResponse.json({
    success: true,
    generatedAt: now,
    generatedAtText: formatTimestampYmdHmsMs(now),
    window: {
      hours,
      mode,
      from,
      to: now,
      fromText: formatTimestampYmdHmsMs(from),
      toText: formatTimestampYmdHmsMs(now),
    },
    schedulerMode,
    scheduler,
    schedulers: {
      real: { active: false, removed: true },
      sim: simScheduler,
    },
    totals: {
      tradeEvents: events.length,
      analysisEvents: scheduleProbes.length,
      selectedCandidates: selectedProbes.length,
      executionSuccesses: executionSuccesses.length,
      guardBlocks: guardBlocks.length,
      errors: errors.length,
      rejectedOrUnselected: rejectedProbes.length,
    },
    topRejectReasons,
    topGuardReasons,
    topSelectedPairs,
    topExecutedPairs,
    recentNoEntryExamples: [
      ...rejectedProbes,
      ...guardBlocks,
    ]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 30)
      .map(buildNoEntrySample),
  });
}
