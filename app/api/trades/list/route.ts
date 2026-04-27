import { NextRequest, NextResponse } from 'next/server';
import {
  listTradeHistoryDates,
  readTradeHistory,
  type TradeHistoryScope,
  type TradeEvent,
} from '@/lib/fileLogger';
import { formatTimestampYmdHmsMs } from '@/lib/timeFormat';

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function parseScope(value: string | null): TradeHistoryScope | null {
  if (value === null || value === 'all') return 'all';
  if (value === 'sim' || value === 'sim_executed') return value;
  if (value === 'real' || value === 'real_executed') return value;
  return null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || undefined;
  const allDates = url.searchParams.get('all') === 'true';
  const listOnly = url.searchParams.get('list') === 'true';
  const scope = parseScope(url.searchParams.get('scope'));
  const typeFilter = url.searchParams.get('type');
  const simulationFilter = url.searchParams.get('simulation');
  const from = parseTimestamp(url.searchParams.get('from'));
  const to = parseTimestamp(url.searchParams.get('to'));
  const limit = parsePositiveInt(url.searchParams.get('limit'));
  const page = parsePositiveInt(url.searchParams.get('page'));
  const pageSize = parsePositiveInt(url.searchParams.get('pageSize'));

  if (!scope) {
    return NextResponse.json({ success: false, error: 'Invalid scope (all|sim|real|sim_executed|real_executed)' }, { status: 400 });
  }

  const listTargetDates = listTradeHistoryDates(scope);
  const readByDate = (targetDate?: string) => readTradeHistory(scope, targetDate);

  if (listOnly) {
    return NextResponse.json({ success: true, scope, dates: listTargetDates });
  }

  const allEvents = allDates
    ? listTargetDates
      .flatMap((targetDate) => readByDate(targetDate))
      .sort((a, b) => b.timestamp - a.timestamp)
    : readByDate(date);
  const typeSet = typeFilter
    ? new Set(typeFilter.split(',').map((value) => value.trim()).filter(Boolean))
    : null;
  const simulationValue = simulationFilter == null
    ? null
    : simulationFilter === 'true'
      ? true
      : simulationFilter === 'false'
        ? false
        : null;

  const normalized: TradeEvent[] = [];
  for (const event of allEvents) {
    const rawTimestamp = (event as { timestamp?: unknown }).timestamp;
    const timestamp = typeof rawTimestamp === 'number'
      ? (Number.isFinite(rawTimestamp) ? rawTimestamp : null)
      : typeof rawTimestamp === 'string'
        ? parseTimestamp(rawTimestamp)
        : null;
    if (timestamp === null) continue;
    if (typeSet && !typeSet.has(event.type)) continue;
    if (simulationValue !== null && event.simulation !== simulationValue) continue;
    if (from !== null && timestamp < from) continue;
    if (to !== null && timestamp > to) continue;
    normalized.push({ ...event, timestamp });
  }

  let events = normalized.sort((a, b) => b.timestamp - a.timestamp);

  const filteredTotal = events.length;
  let resolvedPage: number | null = null;
  let resolvedPageSize: number | null = null;
  let totalPages: number | null = null;
  let fromIndex = 0;
  let toIndex = 0;

  if (page != null || pageSize != null) {
    resolvedPageSize = pageSize ?? limit ?? 15;
    totalPages = Math.max(1, Math.ceil(filteredTotal / resolvedPageSize));
    resolvedPage = Math.min(Math.max(page ?? 1, 1), totalPages);
    const start = (resolvedPage - 1) * resolvedPageSize;
    const end = start + resolvedPageSize;
    events = events.slice(start, end);
    fromIndex = filteredTotal === 0 ? 0 : start + 1;
    toIndex = filteredTotal === 0 ? 0 : Math.min(end, filteredTotal);
  } else if (limit !== null && events.length > limit) {
    events = events.slice(0, limit);
  }

  return NextResponse.json({
    success: true,
    scope,
    date: date || 'today',
    availableDates: listTargetDates,
    count: events.length,
    total: allEvents.length,
    filteredTotal,
    page: resolvedPage,
    pageSize: resolvedPageSize,
    totalPages,
    fromIndex,
    toIndex,
    events: events.map((event) => ({
      ...event,
      timestampText: formatTimestampYmdHmsMs(event.timestamp),
    })),
  });
}
