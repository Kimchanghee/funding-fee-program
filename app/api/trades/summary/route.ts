import { NextRequest, NextResponse } from 'next/server';
import { loadTradeEventsForAudit, summarizeTradeEvents, type TradeAuditScope } from '@/lib/tradeAudit';

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const from = parseTimestamp(url.searchParams.get('from'));
  const to = parseTimestamp(url.searchParams.get('to'));
  const daysRaw = Number(url.searchParams.get('days'));
  const simulationParam = url.searchParams.get('simulation');
  const limitDatesRaw = Number(url.searchParams.get('limitDates'));
  const scopeParam = url.searchParams.get('scope');

  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : null;
  const limitDates = Number.isFinite(limitDatesRaw) && limitDatesRaw > 0 ? Math.floor(limitDatesRaw) : null;
  const simulation = simulationParam == null
    ? null
    : simulationParam === 'true'
      ? true
      : simulationParam === 'false'
        ? false
        : null;
  const scope: TradeAuditScope = scopeParam === 'sim_executed'
    ? 'sim_executed'
    : scopeParam === 'real_executed'
      ? 'real_executed'
      : 'all';

  const effectiveFrom = from ?? (days != null ? Date.now() - (days * 24 * 60 * 60 * 1000) : null);
  const { scannedDates, coveredDates, events } = loadTradeEventsForAudit({
    from: effectiveFrom,
    to,
    simulation,
    limitDates,
    scope,
  });

  return NextResponse.json({
    success: true,
    scope,
    summary: summarizeTradeEvents(events, {
      from: effectiveFrom,
      to,
      dates: coveredDates,
      scannedDates,
    }),
  });
}
