import { listTradeHistoryDates, readTradeHistory, type TradeEvent, type TradeHistoryScope } from './fileLogger';

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
  modeBreakdown: Record<'SIM' | 'REAL', {
    totalEvents: number;
    entries: number;
    exits: number;
    completed: number;
    fundingEvents: number;
    scheduleProbes: number;
    guardBlocks: number;
    pnlUSD: number;
    fundingUSD: number;
    feesUSD: number;
  }>;
  diagnostics: {
    scheduleMilestones: Record<string, number>;
    scheduleReasons: Record<string, number>;
    guardReasons: Record<string, number>;
    scheduledCount: number;
    selectedCandidateCount: number;
    rejectedCandidateCount: number;
    executeCount: number;
    executeSuccessCount: number;
    executeFailedCount: number;
    canceledBeforeExecuteCount: number;
  };
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

export type TradeAuditScope = TradeHistoryScope;

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

function increment(counts: Record<string, number>, key: string | undefined): void {
  const normalized = key || 'unknown';
  counts[normalized] = (counts[normalized] ?? 0) + 1;
}

function createModeBreakdown() {
  return {
    totalEvents: 0,
    entries: 0,
    exits: 0,
    completed: 0,
    fundingEvents: 0,
    scheduleProbes: 0,
    guardBlocks: 0,
    pnlUSD: 0,
    fundingUSD: 0,
    feesUSD: 0,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pairFinancialKey(event: TradeEvent): string | null {
  if (!event.pairId) return null;
  return `${event.simulation ? 'SIM' : 'REAL'}:${event.pairId}`;
}

function completionQualityScore(event: TradeEvent): number {
  let score = 0;
  if (typeof event.pnl === 'number' && Number.isFinite(event.pnl)) score += 1;
  if (typeof event.pricePnl === 'number' && Number.isFinite(event.pricePnl)) score += 2;
  if (typeof event.entryFee === 'number' && Number.isFinite(event.entryFee)) score += 4;
  if (typeof event.exitFee === 'number' && Number.isFinite(event.exitFee)) score += 4;
  if (typeof event.fundingCollected === 'number' && Number.isFinite(event.fundingCollected)) score += 1;
  if (event.detail?.includes('fundingVerified:')) score += 1;
  return score;
}

function selectCompletionEvents(events: TradeEvent[]): Map<string, TradeEvent> {
  const completions = new Map<string, TradeEvent>();
  for (const event of events) {
    if (event.type !== 'snipe_complete') continue;
    const key = pairFinancialKey(event);
    if (!key) continue;

    const current = completions.get(key);
    if (
      !current
      || completionQualityScore(event) > completionQualityScore(current)
      || (
        completionQualityScore(event) === completionQualityScore(current)
        && event.timestamp > current.timestamp
      )
    ) {
      completions.set(key, event);
    }
  }
  return completions;
}

function hasFundingAmount(event: TradeEvent): boolean {
  return typeof event.fundingAmount === 'number' && Number.isFinite(event.fundingAmount);
}

function eventFees(event: TradeEvent): number {
  return finiteNumber(event.entryFee) + finiteNumber(event.exitFee);
}

export function filterTradeEvents(
  events: TradeEvent[],
  options?: {
    from?: number | null;
    to?: number | null;
    simulation?: boolean | null;
    engineIds?: string[] | null;
    eventSources?: string[] | null;
  },
): TradeEvent[] {
  const engineIdSet = options?.engineIds && options.engineIds.length > 0
    ? new Set(options.engineIds)
    : null;
  const eventSourceSet = options?.eventSources && options.eventSources.length > 0
    ? new Set(options.eventSources)
    : null;

  return events.filter((event) => {
    if (options?.from != null && event.timestamp < options.from) return false;
    if (options?.to != null && event.timestamp > options.to) return false;
    if (options?.simulation != null && event.simulation !== options.simulation) return false;
    if (engineIdSet && !engineIdSet.has(event.engineId ?? '')) return false;
    if (eventSourceSet && !eventSourceSet.has(event.eventSource ?? '')) return false;
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
  const modeBreakdown: TradeAuditSummary['modeBreakdown'] = {
    SIM: createModeBreakdown(),
    REAL: createModeBreakdown(),
  };
  const scheduleMilestones: Record<string, number> = {};
  const scheduleReasons: Record<string, number> = {};
  const guardReasons: Record<string, number> = {};
  const routeMap = new Map<string, TradeAuditRouteSummary>();
  const completionByPair = selectCompletionEvents(events);
  const pairsWithFundingEvents = new Set<string>();
  const pairsWithExitFunding = new Set<string>();

  for (const event of events) {
    const key = pairFinancialKey(event);
    if (!key) continue;
    const bucket = normalizeTradeBucket(event.type);
    if (bucket === 'funding' && hasFundingAmount(event)) {
      pairsWithFundingEvents.add(key);
    }
    if (bucket === 'exit' && hasFundingAmount(event)) {
      pairsWithExitFunding.add(key);
    }
  }

  let simulationEvents = 0;
  let realEvents = 0;
  let fundingUSD = 0;
  let realizedPnlUSD = 0;

  for (const event of events) {
    const bucket = normalizeTradeBucket(event.type);
    const mode = event.simulation ? 'SIM' : 'REAL';
    const modeStats = modeBreakdown[mode];
    normalizedCounts[bucket] += 1;
    rawTypeCounts[event.type] = (rawTypeCounts[event.type] ?? 0) + 1;
    if (event.simulation) simulationEvents += 1;
    else realEvents += 1;

    const route = buildRouteLabel(event);
    const pairKey = pairFinancialKey(event);
    const rawPnl = finiteNumber(event.pnl);
    const rawFunding = finiteNumber(event.fundingAmount);
    const rawFundingCollected = finiteNumber(event.fundingCollected);
    const rawFees = eventFees(event);
    let financialPnl = 0;
    let financialFunding = 0;
    let financialFees = 0;

    if (bucket === 'completion') {
      const shouldCountCompletion = pairKey == null || completionByPair.get(pairKey) === event;
      if (shouldCountCompletion) {
        financialPnl = rawPnl;
        financialFees = rawFees;
        if (
          !pairKey
          || (!pairsWithFundingEvents.has(pairKey) && !pairsWithExitFunding.has(pairKey))
        ) {
          financialFunding = rawFundingCollected;
        }
      }
    } else if (bucket === 'exit') {
      if (!pairKey || !completionByPair.has(pairKey)) {
        financialPnl = rawPnl;
        financialFees = rawFees;
      }
      if (!pairKey || !pairsWithFundingEvents.has(pairKey)) {
        financialFunding = rawFunding;
      }
    } else if (bucket === 'funding') {
      financialFunding = rawFunding;
    }

    modeStats.totalEvents += 1;
    modeStats.pnlUSD += financialPnl;
    modeStats.fundingUSD += financialFunding;
    modeStats.feesUSD += financialFees;
    if (bucket === 'entry') modeStats.entries += 1;
    if (bucket === 'exit') modeStats.exits += 1;
    if (bucket === 'completion') modeStats.completed += 1;
    if (bucket === 'funding') modeStats.fundingEvents += 1;
    if (bucket === 'schedule_probe') {
      modeStats.scheduleProbes += 1;
      increment(scheduleMilestones, event.milestone);
      increment(scheduleReasons, event.reason);
    }
    if (bucket === 'guard_block') {
      modeStats.guardBlocks += 1;
      increment(guardReasons, event.reason);
    }

    fundingUSD += financialFunding;
    realizedPnlUSD += financialPnl;

    const summary = routeMap.get(route) ?? {
      route,
      count: 0,
      types: {},
      pnlUSD: 0,
      fundingUSD: 0,
    };
    summary.count += 1;
    summary.types[event.type] = (summary.types[event.type] ?? 0) + 1;
    summary.pnlUSD += financialPnl;
    summary.fundingUSD += financialFunding;
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
    modeBreakdown,
    diagnostics: {
      scheduleMilestones,
      scheduleReasons,
      guardReasons,
      scheduledCount: scheduleMilestones.scheduled ?? 0,
      selectedCandidateCount: scheduleReasons.selected ?? 0,
      rejectedCandidateCount: scheduleReasons.rejected ?? 0,
      executeCount: scheduleMilestones.execute ?? 0,
      executeSuccessCount: scheduleMilestones.execute_success ?? 0,
      executeFailedCount: scheduleMilestones.execute_failed ?? 0,
      canceledBeforeExecuteCount: scheduleMilestones.canceled_before_execute ?? 0,
    },
    realized: {
      fundingUSD,
      exitPnlUSD: realizedPnlUSD,
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
  engineIds?: string[] | null;
  eventSources?: string[] | null;
}): { scannedDates: string[]; coveredDates: string[]; events: TradeEvent[] } {
  const scope = options?.scope ?? 'all';
  const allDates = listTradeHistoryDates(scope);
  const readByDate = (date: string) => readTradeHistory(scope, date);
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
        engineIds: options?.engineIds,
        eventSources: options?.eventSources,
      });
      if (filteredForDate.length > 0) {
        coveredDates.push(date);
      }
      return filteredForDate;
    })
    .sort((a, b) => b.timestamp - a.timestamp);
  return { scannedDates, coveredDates, events };
}
