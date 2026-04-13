import { listDates, listExecutedTradeDates, readExecutedTrades, readTrades, type TradeEvent } from './fileLogger';

export type TradeAuditBucket =
  | 'entry'
  | 'exit'
  | 'funding'
  | 'guard_block'
  | 'schedule_probe'
  | 'error'
  | 'exit_failed'
  | 'completion'
  | 'other';

export interface TradeAuditRouteSummary {
  route: string;
  count: number;
  types: Record<string, number>;
  pnlUSD: number;
  fundingUSD: number;
}

export interface TradeAuditSummary {
  generatedAt: string;
  window: {
    from: string | null;
    to: string | null;
  };
  coverage: {
    dates: string[];
    scannedDates: string[];
    totalEvents: number;
    simulationEvents: number;
    realEvents: number;
  };
  normalizedCounts: Record<TradeAuditBucket, number>;
  rawTypeCounts: Record<string, number>;
  realized: {
    fundingUSD: number;
    exitPnlUSD: number;
  };
  routeSummaries: TradeAuditRouteSummary[];
  latestEvents: Array<{
    timestamp: number;
    type: string;
    simulation: boolean;
    route: string;
    pnlUSD: number;
    fundingUSD: number;
  }>;
}

export type TradeAuditScope = 'all' | 'sim_executed' | 'real_executed';

export function normalizeTradeBucket(type: TradeEvent['type']): TradeAuditBucket {
  switch (type) {
    case 'entry':
    case 'snipe_entry':
      return 'entry';
    case 'exit':
    case 'snipe_exit':
    case 'auto_exit':
      return 'exit';
    case 'funding':
      return 'funding';
    case 'guard_block':
      return 'guard_block';
    case 'schedule_probe':
      return 'schedule_probe';
    case 'error':
      return 'error';
    case 'exit_failed':
      return 'exit_failed';
    case 'snipe_complete':
      return 'completion';
    default:
      return 'other';
  }
}

function buildRouteLabel(event: TradeEvent): string {
  if (event.baseAsset && event.shortExchange && event.longExchange) {
    return `${event.baseAsset}:${event.shortExchange}->${event.longExchange}`;
  }
  if (event.baseAsset && event.exchange) {
    return `${event.baseAsset}:${event.exchange}`;
  }
  if (event.exchange && event.symbol) {
    return `${event.exchange}:${event.symbol}`;
  }
  return 'n/a';
}

function createEmptyCounts(): Record<TradeAuditBucket, number> {
  return {
    entry: 0,
    exit: 0,
    funding: 0,
    guard_block: 0,
    schedule_probe: 0,
    error: 0,
    exit_failed: 0,
    completion: 0,
    other: 0,
  };
}

export function filterTradeEvents(
  events: TradeEvent[],
  options?: {
    from?: number | null;
    to?: number | null;
    simulation?: boolean | null;
  },
): TradeEvent[] {
  return events.filter((event) => {
    if (options?.from != null && event.timestamp < options.from) return false;
    if (options?.to != null && event.timestamp > options.to) return false;
    if (options?.simulation != null && event.simulation !== options.simulation) return false;
    return true;
  });
}

export function summarizeTradeEvents(
  events: TradeEvent[],
  options?: {
    from?: number | null;
    to?: number | null;
    dates?: string[];
    scannedDates?: string[];
  },
): TradeAuditSummary {
  const normalizedCounts = createEmptyCounts();
  const rawTypeCounts: Record<string, number> = {};
  const routeMap = new Map<string, TradeAuditRouteSummary>();

  let simulationEvents = 0;
  let realEvents = 0;
  let fundingUSD = 0;
  let exitPnlUSD = 0;

  for (const event of events) {
    const bucket = normalizeTradeBucket(event.type);
    normalizedCounts[bucket] += 1;
    rawTypeCounts[event.type] = (rawTypeCounts[event.type] ?? 0) + 1;
    if (event.simulation) simulationEvents += 1;
    else realEvents += 1;

    const route = buildRouteLabel(event);
    const pnl = typeof event.pnl === 'number' && Number.isFinite(event.pnl) ? event.pnl : 0;
    const funding = typeof event.fundingAmount === 'number' && Number.isFinite(event.fundingAmount)
      ? event.fundingAmount
      : 0;

    if (bucket === 'funding') {
      fundingUSD += funding;
    }
    if (bucket === 'exit') {
      exitPnlUSD += pnl;
    }

    const summary = routeMap.get(route) ?? {
      route,
      count: 0,
      types: {},
      pnlUSD: 0,
      fundingUSD: 0,
    };
    summary.count += 1;
    summary.types[event.type] = (summary.types[event.type] ?? 0) + 1;
    summary.pnlUSD += pnl;
    summary.fundingUSD += funding;
    routeMap.set(route, summary);
  }

  return {
    generatedAt: new Date().toISOString(),
    window: {
      from: options?.from != null ? new Date(options.from).toISOString() : null,
      to: options?.to != null ? new Date(options.to).toISOString() : null,
    },
    coverage: {
      dates: options?.dates ?? [],
      scannedDates: options?.scannedDates ?? options?.dates ?? [],
      totalEvents: events.length,
      simulationEvents,
      realEvents,
    },
    normalizedCounts,
    rawTypeCounts,
    realized: {
      fundingUSD,
      exitPnlUSD,
    },
    routeSummaries: Array.from(routeMap.values())
      .sort((a, b) => b.count - a.count || b.fundingUSD - a.fundingUSD || b.pnlUSD - a.pnlUSD)
      .slice(0, 20),
    latestEvents: [...events]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map((event) => ({
        timestamp: event.timestamp,
        type: event.type,
        simulation: event.simulation,
        route: buildRouteLabel(event),
        pnlUSD: typeof event.pnl === 'number' && Number.isFinite(event.pnl) ? event.pnl : 0,
        fundingUSD: typeof event.fundingAmount === 'number' && Number.isFinite(event.fundingAmount)
          ? event.fundingAmount
          : 0,
      })),
  };
}

export function loadTradeEventsForAudit(options?: {
  from?: number | null;
  to?: number | null;
  simulation?: boolean | null;
  limitDates?: number | null;
  scope?: TradeAuditScope;
}): { scannedDates: string[]; coveredDates: string[]; events: TradeEvent[] } {
  const scope = options?.scope ?? 'all';
  const allDates = scope === 'sim_executed'
    ? listExecutedTradeDates('sim')
    : scope === 'real_executed'
      ? listExecutedTradeDates('real')
      : listDates('trades');
  const readByDate = (date: string) => (
    scope === 'sim_executed'
      ? readExecutedTrades('sim', date)
      : scope === 'real_executed'
        ? readExecutedTrades('real', date)
        : readTrades(date)
  );
  const scannedDates = options?.limitDates != null
    ? allDates.slice(0, Math.max(0, options.limitDates))
    : allDates;
  const coveredDates: string[] = [];
  const events = scannedDates
    .flatMap((date) => {
      const filteredForDate = filterTradeEvents(readByDate(date), {
        from: options?.from,
        to: options?.to,
        simulation: options?.simulation,
      });
      if (filteredForDate.length > 0) {
        coveredDates.push(date);
      }
      return filteredForDate;
    })
    .sort((a, b) => b.timestamp - a.timestamp);
  return { scannedDates, coveredDates, events };
}
