import { NextRequest, NextResponse } from 'next/server';
import {
  listDates,
  listExecutedTradeDates,
  readExecutedTrades,
  readTrades,
  type TradeEvent,
} from '@/lib/fileLogger';
import { EXECUTED_TRADE_EVENT_TYPES } from '@/lib/tradeEvents';
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

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || undefined;
  const allDates = url.searchParams.get('all') === 'true';
  const listOnly = url.searchParams.get('list') === 'true';
  const scope = url.searchParams.get('scope') ?? 'all';
  const typeFilter = url.searchParams.get('type');
  const simulationFilter = url.searchParams.get('simulation');
  const from = parseTimestamp(url.searchParams.get('from'));
  const to = parseTimestamp(url.searchParams.get('to'));
  const limit = parsePositiveInt(url.searchParams.get('limit'));
  const page = parsePositiveInt(url.searchParams.get('page'));
  const pageSize = parsePositiveInt(url.searchParams.get('pageSize'));

  if (scope !== 'all' && scope !== 'sim_executed' && scope !== 'real_executed') {
    return NextResponse.json({ success: false, error: 'Invalid scope (all|sim_executed|real_executed)' }, { status: 400 });
  }

  const legacyDates = listDates('trades');
  const executedDates = scope === 'sim_executed'
    ? listExecutedTradeDates('sim')
    : scope === 'real_executed'
      ? listExecutedTradeDates('real')
      : [];
  const listTargetDates = scope === 'all'
    ? legacyDates
    : executedDates.length > 0
      ? executedDates
      : legacyDates;
  const readByDate = (targetDate?: string) => {
    if (scope === 'all') {
      return readTrades(targetDate);
    }

    const scopeValue = scope === 'sim_executed' ? 'sim' : 'real';
    const separated = readExecutedTrades(scopeValue, targetDate);
    if (separated.length > 0) {
      return separated;
    }

    const simulation = scope === 'sim_executed';
    return readTrades(targetDate).filter((event) => event.simulation === simulation && EXECUTED_TRADE_EVENT_TYPES.has(event.type));
  };

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
