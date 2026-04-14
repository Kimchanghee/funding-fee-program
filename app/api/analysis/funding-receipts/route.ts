import { NextRequest, NextResponse } from 'next/server';
import {
  listFundingReceiptDates,
  readFundingReceipts,
  type ExecutedTradeScope,
  type TradeEvent,
} from '@/lib/fileLogger';
import { formatTimestampYmdHmsMs } from '@/lib/timeFormat';

type ReceiptScope = ExecutedTradeScope | 'all';

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
  const limit = parsePositiveInt(url.searchParams.get('limit'));
  const page = parsePositiveInt(url.searchParams.get('page'));
  const pageSize = parsePositiveInt(url.searchParams.get('pageSize'));

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

  const events: TradeEvent[] = [];
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

  const filtered = events
    .filter((event) => {
      if (from != null && event.timestamp < from) return false;
      if (to != null && event.timestamp > to) return false;
      return true;
    })
    .sort((a, b) => b.timestamp - a.timestamp);

  const total = filtered.length;
  const totalFundingAmount = filtered.reduce((sum, event) => sum + (event.fundingAmount ?? 0), 0);
  let paged = filtered;

  let resolvedPage: number | null = null;
  let resolvedPageSize: number | null = null;
  let totalPages: number | null = null;
  let fromIndex = 0;
  let toIndex = 0;

  if (page != null || pageSize != null) {
    resolvedPageSize = pageSize ?? limit ?? 15;
    totalPages = Math.max(1, Math.ceil(total / resolvedPageSize));
    resolvedPage = Math.min(Math.max(page ?? 1, 1), totalPages);
    const start = (resolvedPage - 1) * resolvedPageSize;
    const end = start + resolvedPageSize;
    paged = filtered.slice(start, end);
    fromIndex = total === 0 ? 0 : start + 1;
    toIndex = total === 0 ? 0 : Math.min(end, total);
  } else if (limit != null && filtered.length > limit) {
    paged = filtered.slice(0, limit);
  }

  return NextResponse.json({
    success: true,
    scope,
    date: allDates ? null : (date ?? 'today'),
    allDates,
    count: paged.length,
    total,
    page: resolvedPage,
    pageSize: resolvedPageSize,
    totalPages,
    fromIndex,
    toIndex,
    totalFundingAmount,
    events: paged.map((event) => ({
      ...event,
      timestampText: formatTimestampYmdHmsMs(event.timestamp),
    })),
  });
}
