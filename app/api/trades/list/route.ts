import { NextRequest, NextResponse } from 'next/server';
import { listDates, listExecutedTradeDates, readExecutedTrades, readTrades } from '@/lib/fileLogger';

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const EXECUTED_TYPES = new Set([
  'entry',
  'snipe_entry',
  'exit',
  'snipe_exit',
  'auto_exit',
  'funding',
  'snipe_complete',
]);

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
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : null;

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
    return readTrades(targetDate).filter((event) => event.simulation === simulation && EXECUTED_TYPES.has(event.type));
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

  let events = allEvents.filter((event) => {
    if (typeSet && !typeSet.has(event.type)) return false;
    if (simulationValue !== null && event.simulation !== simulationValue) return false;
    if (from !== null && event.timestamp < from) return false;
    if (to !== null && event.timestamp > to) return false;
    return true;
  });

  if (limit !== null && events.length > limit) {
    events = events.slice(0, limit);
  }

  return NextResponse.json({
    success: true,
    scope,
    date: date || 'today',
    count: events.length,
    total: allEvents.length,
    events,
  });
}
