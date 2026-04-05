import { NextRequest, NextResponse } from 'next/server';
import { readTrades, listDates } from '@/lib/fileLogger';

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || undefined;
  const listOnly = url.searchParams.get('list') === 'true';
  const typeFilter = url.searchParams.get('type');
  const simulationFilter = url.searchParams.get('simulation');
  const from = parseTimestamp(url.searchParams.get('from'));
  const to = parseTimestamp(url.searchParams.get('to'));
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : null;

  if (listOnly) {
    return NextResponse.json({ success: true, dates: listDates('trades') });
  }

  const allEvents = readTrades(date);
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
    date: date || 'today',
    count: events.length,
    total: allEvents.length,
    events,
  });
}
