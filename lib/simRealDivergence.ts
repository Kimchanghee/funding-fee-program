import { listDates, readTrades, type TradeEvent } from './fileLogger';

type DivergenceKind = 'entry' | 'guard_block' | 'exit' | 'exit_failed' | 'error' | 'other';

export interface DivergenceParams {
  from?: number;
  to?: number;
  days?: number;
  windowMs?: number;
  limit?: number;
}

interface NormalizedTradeEvent {
  timestamp: number;
  simulation: boolean;
  kind: DivergenceKind;
  rawType: TradeEvent['type'];
  routeKey: string;
  routeLabel: string;
  baseAsset: string;
  shortExchange?: string;
  longExchange?: string;
  exchange?: string;
  side?: 'long' | 'short';
  symbol?: string;
  reason?: string;
  spreadPercent?: number;
  notional?: number;
  netProfit?: number;
  pnl?: number;
  entryFee?: number;
  exitFee?: number;
  pairId?: string;
  detail?: string;
}

interface MatchPair {
  key: string;
  kind: DivergenceKind;
  routeKey: string;
  routeLabel: string;
  sim: NormalizedTradeEvent;
  real: NormalizedTradeEvent;
  timeDeltaMs: number;
  reasonMatch: boolean;
  spreadPercentDelta?: number;
  notionalDelta?: number;
  profitDelta?: number;
}

interface RouteAggregate {
  routeKey: string;
  routeLabel: string;
  simCount: number;
  realCount: number;
  matchedCount: number;
  simOnlyCount: number;
  realOnlyCount: number;
  reasonMismatchCount: number;
}

function normalizeKind(type: TradeEvent['type']): DivergenceKind {
  switch (type) {
    case 'entry':
    case 'snipe_entry':
      return 'entry';
    case 'guard_block':
      return 'guard_block';
    case 'exit':
    case 'snipe_exit':
    case 'auto_exit':
    case 'snipe_complete':
      return 'exit';
    case 'exit_failed':
      return 'exit_failed';
    case 'error':
      return 'error';
    default:
      return 'other';
  }
}

function buildRouteInfo(event: TradeEvent): { routeKey: string; routeLabel: string; baseAsset: string } | null {
  const baseAsset = event.baseAsset ?? event.symbol?.split('/')[0] ?? 'unknown';
  if (event.shortExchange && event.longExchange) {
    return {
      routeKey: `${baseAsset}:${event.shortExchange}:${event.longExchange}`,
      routeLabel: `${baseAsset} ${event.shortExchange}->${event.longExchange}`,
      baseAsset,
    };
  }
  if (event.exchange && event.side && event.symbol) {
    return {
      routeKey: `${baseAsset}:${event.exchange}:${event.side}:${event.symbol}`,
      routeLabel: `${baseAsset} ${event.exchange} ${event.side} ${event.symbol}`,
      baseAsset,
    };
  }
  if (event.pairId) {
    return {
      routeKey: `${baseAsset}:pair:${event.pairId}`,
      routeLabel: `${baseAsset} pair ${event.pairId}`,
      baseAsset,
    };
  }
  return null;
}

function normalizeTradeEvent(event: TradeEvent): NormalizedTradeEvent | null {
  const route = buildRouteInfo(event);
  if (!route) return null;
  return {
    timestamp: event.timestamp,
    simulation: event.simulation,
    kind: normalizeKind(event.type),
    rawType: event.type,
    routeKey: route.routeKey,
    routeLabel: route.routeLabel,
    baseAsset: route.baseAsset,
    shortExchange: event.shortExchange,
    longExchange: event.longExchange,
    exchange: event.exchange,
    side: event.side,
    symbol: event.symbol,
    reason: event.reason,
    spreadPercent: event.spreadPercent,
    notional: event.notional,
    netProfit: event.netProfit,
    pnl: event.pnl,
    entryFee: event.entryFee,
    exitFee: event.exitFee,
    pairId: event.pairId,
    detail: event.detail,
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function collectTradesInRange(from: number, to: number): TradeEvent[] {
  return listDates('trades')
    .flatMap((date) => readTrades(date))
    .filter((event) => event.timestamp >= from && event.timestamp <= to)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function matchEventBuckets(
  simEvents: NormalizedTradeEvent[],
  realEvents: NormalizedTradeEvent[],
  windowMs: number,
) {
  const realBuckets = new Map<string, Array<{ event: NormalizedTradeEvent; used: boolean }>>();
  for (const event of realEvents) {
    const key = `${event.kind}|${event.routeKey}`;
    const bucket = realBuckets.get(key) ?? [];
    bucket.push({ event, used: false });
    realBuckets.set(key, bucket);
  }

  const matched: MatchPair[] = [];
  const simOnly: NormalizedTradeEvent[] = [];

  for (const sim of simEvents) {
    const key = `${sim.kind}|${sim.routeKey}`;
    const bucket = realBuckets.get(key) ?? [];
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (let index = 0; index < bucket.length; index += 1) {
      const candidate = bucket[index];
      if (candidate.used) continue;
      const delta = Math.abs(candidate.event.timestamp - sim.timestamp);
      if (delta > windowMs || delta >= bestDelta) continue;
      bestIndex = index;
      bestDelta = delta;
    }

    if (bestIndex === -1) {
      simOnly.push(sim);
      continue;
    }

    bucket[bestIndex].used = true;
    const real = bucket[bestIndex].event;
    matched.push({
      key,
      kind: sim.kind,
      routeKey: sim.routeKey,
      routeLabel: sim.routeLabel,
      sim,
      real,
      timeDeltaMs: bestDelta,
      reasonMatch: (sim.reason ?? null) === (real.reason ?? null),
      spreadPercentDelta: Number.isFinite(sim.spreadPercent) && Number.isFinite(real.spreadPercent)
        ? (sim.spreadPercent as number) - (real.spreadPercent as number)
        : undefined,
      notionalDelta: Number.isFinite(sim.notional) && Number.isFinite(real.notional)
        ? (sim.notional as number) - (real.notional as number)
        : undefined,
      profitDelta: Number.isFinite(sim.netProfit) && Number.isFinite(real.netProfit)
        ? (sim.netProfit as number) - (real.netProfit as number)
        : Number.isFinite(sim.pnl) && Number.isFinite(real.pnl)
          ? (sim.pnl as number) - (real.pnl as number)
          : undefined,
    });
  }

  const realOnly: NormalizedTradeEvent[] = [];
  for (const bucket of realBuckets.values()) {
    for (const candidate of bucket) {
      if (!candidate.used) realOnly.push(candidate.event);
    }
  }

  return { matched, simOnly, realOnly };
}

export function analyzeSimRealDivergence(params: DivergenceParams = {}) {
  const now = Date.now();
  const to = Number.isFinite(params.to) ? (params.to as number) : now;
  const days = Number.isFinite(params.days) && (params.days as number) > 0
    ? Math.min(7, Math.floor(params.days as number))
    : 3;
  const from = Number.isFinite(params.from)
    ? (params.from as number)
    : (to - (days * 24 * 60 * 60 * 1000));
  const windowMs = Number.isFinite(params.windowMs) && (params.windowMs as number) > 0
    ? Math.floor(params.windowMs as number)
    : 15 * 60 * 1000;
  const limit = Number.isFinite(params.limit) && (params.limit as number) > 0
    ? Math.floor(params.limit as number)
    : 30;

  const rawEvents = collectTradesInRange(from, to);
  const normalized = rawEvents
    .map(normalizeTradeEvent)
    .filter((event): event is NormalizedTradeEvent => event !== null)
    .filter((event) => event.kind !== 'other');

  const simEvents = normalized.filter((event) => event.simulation);
  const realEvents = normalized.filter((event) => !event.simulation);
  const { matched, simOnly, realOnly } = matchEventBuckets(simEvents, realEvents, windowMs);

  const kinds: DivergenceKind[] = ['entry', 'guard_block', 'exit', 'exit_failed', 'error'];
  const byKind = Object.fromEntries(kinds.map((kind) => {
    const simKind = simEvents.filter((event) => event.kind === kind);
    const realKind = realEvents.filter((event) => event.kind === kind);
    const matchedKind = matched.filter((pair) => pair.kind === kind);
    const simOnlyKind = simOnly.filter((event) => event.kind === kind);
    const realOnlyKind = realOnly.filter((event) => event.kind === kind);
    const reasonMismatchCount = matchedKind.filter((pair) => !pair.reasonMatch).length;
    return [kind, {
      simCount: simKind.length,
      realCount: realKind.length,
      matchedCount: matchedKind.length,
      simOnlyCount: simOnlyKind.length,
      realOnlyCount: realOnlyKind.length,
      reasonMismatchCount,
      avgTimeDeltaMs: average(matchedKind.map((pair) => pair.timeDeltaMs)),
      avgSpreadPercentDelta: average(
        matchedKind
          .map((pair) => pair.spreadPercentDelta)
          .filter((value): value is number => Number.isFinite(value)),
      ),
      avgNotionalDelta: average(
        matchedKind
          .map((pair) => pair.notionalDelta)
          .filter((value): value is number => Number.isFinite(value)),
      ),
      avgProfitDelta: average(
        matchedKind
          .map((pair) => pair.profitDelta)
          .filter((value): value is number => Number.isFinite(value)),
      ),
    }];
  }));

  const routeStats = new Map<string, RouteAggregate>();
  const ensureRoute = (routeKey: string, routeLabel: string): RouteAggregate => {
    const existing = routeStats.get(routeKey);
    if (existing) return existing;
    const created: RouteAggregate = {
      routeKey,
      routeLabel,
      simCount: 0,
      realCount: 0,
      matchedCount: 0,
      simOnlyCount: 0,
      realOnlyCount: 0,
      reasonMismatchCount: 0,
    };
    routeStats.set(routeKey, created);
    return created;
  };

  for (const event of simEvents) {
    ensureRoute(event.routeKey, event.routeLabel).simCount += 1;
  }
  for (const event of realEvents) {
    ensureRoute(event.routeKey, event.routeLabel).realCount += 1;
  }
  for (const pair of matched) {
    const route = ensureRoute(pair.routeKey, pair.routeLabel);
    route.matchedCount += 1;
    if (!pair.reasonMatch) route.reasonMismatchCount += 1;
  }
  for (const event of simOnly) {
    ensureRoute(event.routeKey, event.routeLabel).simOnlyCount += 1;
  }
  for (const event of realOnly) {
    ensureRoute(event.routeKey, event.routeLabel).realOnlyCount += 1;
  }

  const topRoutes = Array.from(routeStats.values())
    .sort((a, b) => {
      const aScore = (a.simOnlyCount + a.realOnlyCount + a.reasonMismatchCount);
      const bScore = (b.simOnlyCount + b.realOnlyCount + b.reasonMismatchCount);
      return bScore - aScore || b.matchedCount - a.matchedCount;
    })
    .slice(0, limit);

  const reasonMismatchSamples = matched
    .filter((pair) => !pair.reasonMatch)
    .sort((a, b) => b.timeDeltaMs - a.timeDeltaMs)
    .slice(0, limit)
    .map((pair) => ({
      kind: pair.kind,
      routeKey: pair.routeKey,
      routeLabel: pair.routeLabel,
      timeDeltaMs: pair.timeDeltaMs,
      simTimestamp: pair.sim.timestamp,
      realTimestamp: pair.real.timestamp,
      simType: pair.sim.rawType,
      realType: pair.real.rawType,
      simReason: pair.sim.reason ?? null,
      realReason: pair.real.reason ?? null,
      spreadPercentDelta: pair.spreadPercentDelta ?? null,
      notionalDelta: pair.notionalDelta ?? null,
      profitDelta: pair.profitDelta ?? null,
    }));

  const sampleEvent = (event: NormalizedTradeEvent) => ({
    kind: event.kind,
    routeKey: event.routeKey,
    routeLabel: event.routeLabel,
    timestamp: event.timestamp,
    type: event.rawType,
    reason: event.reason ?? null,
    spreadPercent: event.spreadPercent ?? null,
    notional: event.notional ?? null,
    netProfit: event.netProfit ?? null,
    pnl: event.pnl ?? null,
    detail: event.detail ?? null,
  });

  return {
    generatedAt: now,
    params: {
      from,
      to,
      days,
      windowMs,
      limit,
    },
    summary: {
      totalEvents: normalized.length,
      simEvents: simEvents.length,
      realEvents: realEvents.length,
      matchedPairs: matched.length,
      simOnly: simOnly.length,
      realOnly: realOnly.length,
      reasonMismatchPairs: matched.filter((pair) => !pair.reasonMatch).length,
      uniqueRoutes: routeStats.size,
    },
    byKind,
    topRoutes,
    reasonMismatchSamples,
    simOnlySamples: simOnly.slice(0, limit).map(sampleEvent),
    realOnlySamples: realOnly.slice(0, limit).map(sampleEvent),
  };
}
