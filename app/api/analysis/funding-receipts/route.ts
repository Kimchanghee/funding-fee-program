import { NextRequest, NextResponse } from 'next/server';
import {
  listFundingReceiptDates,
  readFundingReceipts,
  type ExecutedTradeScope,
  type TradeEvent,
} from '@/lib/fileLogger';

type ReceiptScope = ExecutedTradeScope | 'all';

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseScope(value: string | null): ReceiptScope | null {
  if (!value || value === 'all') return 'all';
  if (value === 'sim' || value === 'real') return value;
  return null;
}

function normalizeScope(event: TradeEvent, scope: ExecutedTradeScope): TradeEvent {
  if (event.executionScope) return event;
  return { ...event, executionScope: scope };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const scope = parseScope(url.searchParams.get('scope'));
  if (!scope) {
    return NextResponse.json({ success: false, error: 'Invalid scope (all|sim|real)' }, { status: 400 });
  }

  const allDates = url.searchParams.get('all') === 'true';
  const listOnly = url.searchParams.get('list') === 'true';
  const date = url.searchParams.get('date') || undefined;
  const from = parseTimestamp(url.searchParams.get('from'));
  const to = parseTimestamp(url.searchParams.get('to'));
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : null;

  const scopes: ExecutedTradeScope[] = scope === 'all' ? ['sim', 'real'] : [scope];

  if (listOnly) {
    const datesByScope = {
      sim: listFundingReceiptDates('sim'),
      real: listFundingReceiptDates('real'),
    };
    return NextResponse.json({
      success: true,
      scope,
      dates: scope === 'all' ? datesByScope : datesByScope[scope],
    });
  }

  let events: TradeEvent[] = [];
  if (allDates) {
    for (const scopeKey of scopes) {
      const dates = listFundingReceiptDates(scopeKey);
      for (const targetDate of dates) {
        const rows = readFundingReceipts(scopeKey, targetDate).map((event) => normalizeScope(event, scopeKey));
        events.push(...rows);
      }
    }
  } else {
    for (const scopeKey of scopes) {
      const rows = readFundingReceipts(scopeKey, date).map((event) => normalizeScope(event, scopeKey));
      events.push(...rows);
    }
  }

  events = events
    .filter((event) => {
      if (from != null && event.timestamp < from) return false;
      if (to != null && event.timestamp > to) return false;
      return true;
    })
    .sort((a, b) => b.timestamp - a.timestamp);

  const total = events.length;
  if (limit != null && events.length > limit) {
    events = events.slice(0, limit);
  }

  return NextResponse.json({
    success: true,
    scope,
    date: allDates ? null : (date ?? 'today'),
    count: events.length,
    total,
    events,
  });
}
