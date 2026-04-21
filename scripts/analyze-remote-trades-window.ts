import fs from 'fs';
import path from 'path';

type TradeEvent = {
  timestamp: number;
  timestampText?: string;
  type: string;
  simulation: boolean;
  baseAsset?: string;
  shortExchange?: string;
  longExchange?: string;
  exchange?: string;
  side?: 'long' | 'short';
  symbol?: string;
  pairId?: string;
  executionScope?: 'sim' | 'real';
  milestone?: string;
  reason?: string;
  detail?: string;
  spread?: number;
  spreadPercent?: number;
  margin?: number;
  leverage?: number;
  notional?: number;
  perFunding?: number;
  totalRoundTripFees?: number;
  expectedNetProfit?: number;
  expectedRoiPercent?: number;
  hedgedNetSpreadPercent?: number;
  netProfit?: number;
  pnl?: number;
  fundingAmount?: number;
  pricePnl?: number;
  entryFee?: number;
  exitFee?: number;
};

type SchedulerStatus = {
  active?: boolean;
  config?: {
    investmentUSDT?: number;
    leverage?: number;
    minSpreadPercent?: number;
    compoundInvesting?: boolean;
    enabledExchanges?: string[];
    timingConfig?: {
      entryLeadMs?: number;
      closeDelayMs?: number;
      fundingVerifyRetryMs?: number;
      fundingVerifyAttempts?: number;
    };
    maxSlippagePercent?: number;
    minVolume24hUSD?: number;
    confirmedSnipeConfig?: {
      useImpactGuards?: boolean;
      targetImpactBps?: number;
      maxRoundTripImpactBps?: number;
      useDynamicNotional?: boolean;
      dynamicNotionalCap?: number;
      useDriftBuffer?: boolean;
      useConfirmedClose?: boolean;
      useIocLimitOnly?: boolean;
      useStrictHedge?: boolean;
    };
  };
  startedAt?: number;
  state?: {
    simBalances?: Record<string, number>;
    simInitialBalances?: Record<string, number>;
    simTotalFundingEarned?: number;
    simTotalClosedPnl?: number;
    simTotalFees?: number;
  };
};

type SnipeState = {
  success?: boolean;
  data?: {
    simSnipeActive?: boolean;
    realSnipeActive?: boolean;
    simulationMode?: boolean;
    updatedAt?: number;
  };
};

type SnapshotRow = {
  milestone: string;
  timestamp: number;
  timestampText?: string;
  expectedNetProfit: number | null;
  expectedRoiPercent: number | null;
  hedgedNetSpreadPercent: number | null;
  passEV: boolean | null;
  evRatio: number | null;
  impactUsedPercent: number | null;
};

type PairResult = {
  pairId: string;
  route: string;
  baseAsset: string;
  shortExchange: string;
  longExchange: string;
  entryTimestamp: number;
  entryTimestampText: string;
  realizedPnl: number;
  fundingPnl: number;
  pricePnl: number;
  feePnl: number;
  holdingSeconds: number | null;
  expectedAtExecute: number | null;
  expectedAtPre1m: number | null;
  expectedAtPre10m: number | null;
  predictionErrorAtExecute: number | null;
  snapshots: Partial<Record<string, SnapshotRow>>;
  legCount: number;
  fundingLegCount: number;
};

type AnalysisSummary = {
  generatedAt: number;
  generatedAtIso: string;
  sourceFile: string;
  hours: number;
  window: {
    from: number;
    fromIso: string;
    to: number;
    toIso: string;
  };
  eventCounts: Record<string, number>;
  executed: {
    pairCount: number;
    winRate: number;
    totalRealizedPnl: number;
    totalFundingPnl: number;
    totalPricePnl: number;
    totalFeePnl: number;
    averagePnlPerPair: number;
    medianPnlPerPair: number;
    totalExpectedAtExecute: number;
    totalPredictionErrorAtExecute: number;
    expectedPositiveButLossCount: number;
  };
  executionScopeCounts: Record<string, number>;
  milestoneCoverage: Record<string, number>;
  failures: {
    executeFailedByReason: Record<string, number>;
    executeFailedPositiveExpectedCount: number;
    executeFailedPositiveExpectedTotal: number;
    guardBlockByReason: Record<string, number>;
  };
  liveStatus: {
    schedulerActive: boolean | null;
    simSnipeActive: boolean | null;
    realSnipeActive: boolean | null;
    simulationMode: boolean | null;
    config: {
      investmentUSDT: number | null;
      leverage: number | null;
      minSpreadPercent: number | null;
      compoundInvesting: boolean | null;
      enabledExchanges: string[] | null;
      entryLeadMs: number | null;
      closeDelayMs: number | null;
      maxSlippagePercent: number | null;
      minVolume24hUSD: number | null;
      confirmedSnipeConfigPresent: boolean;
      confirmedSnipeEnabledToggleCount: number;
    };
    equity: {
      initialTotal: number | null;
      currentTotal: number | null;
      netPnl: number | null;
      netPnlPercent: number | null;
      totalFundingEarned: number | null;
      totalClosedPnl: number | null;
      totalFees: number | null;
    };
  };
  routePerformanceTop: Array<{
    route: string;
    pairCount: number;
    winCount: number;
    totalPnl: number;
    avgPnl: number;
  }>;
  bestPairs: PairResult[];
  worstPairs: PairResult[];
  pairs: PairResult[];
};

type PairWork = {
  pairId: string;
  route: string;
  baseAsset: string;
  shortExchange: string;
  longExchange: string;
  entry: TradeEvent;
  exits: TradeEvent[];
  fundings: TradeEvent[];
  snapshots: Partial<Record<string, TradeEvent>>;
};

type MilestoneAssignRule = {
  label: string;
  milestone: string;
  expectedLeadMs: number;
  maxLookbackMs: number;
  maxAfterMs: number;
};

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function round(value: number, decimals = 6): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function formatKst(timestamp: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function routeOf(event: Partial<TradeEvent>): string {
  return `${event.baseAsset ?? 'n/a'}:${event.shortExchange ?? 'n/a'}->${event.longExchange ?? 'n/a'}`;
}

function parseDetailValue(detail: string | undefined, regex: RegExp): number | null {
  if (!detail) return null;
  const match = detail.match(regex);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePassEV(detail: string | undefined): boolean | null {
  if (!detail) return null;
  const match = detail.match(/passEV=(true|false)/);
  if (!match?.[1]) return null;
  return match[1] === 'true';
}

function makeSnapshot(milestone: string, event: TradeEvent): SnapshotRow {
  return {
    milestone,
    timestamp: event.timestamp,
    timestampText: event.timestampText,
    expectedNetProfit: Number.isFinite(event.expectedNetProfit ?? NaN) ? event.expectedNetProfit ?? null : null,
    expectedRoiPercent: Number.isFinite(event.expectedRoiPercent ?? NaN) ? event.expectedRoiPercent ?? null : null,
    hedgedNetSpreadPercent: Number.isFinite(event.hedgedNetSpreadPercent ?? NaN) ? event.hedgedNetSpreadPercent ?? null : null,
    passEV: parsePassEV(event.detail),
    evRatio: parseDetailValue(event.detail, /evRatio=([-0-9.]+)/),
    impactUsedPercent: parseDetailValue(event.detail, /impactUsed=([-0-9.]+)%/),
  };
}

function readJsonOrNull<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function ensureArrayEvents(value: unknown): TradeEvent[] {
  if (!value || typeof value !== 'object') return [];
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  return events
    .map((event) => event as TradeEvent)
    .filter((event) => Number.isFinite(toNumber(event.timestamp, NaN)))
    .map((event) => ({
      ...event,
      timestamp: toNumber(event.timestamp),
    }));
}

function assignMilestonesByRoute(
  pairs: PairWork[],
  events: TradeEvent[],
  rule: MilestoneAssignRule,
) {
  const byRoute = new Map<string, PairWork[]>();
  for (const pair of pairs) {
    const list = byRoute.get(pair.route) ?? [];
    list.push(pair);
    byRoute.set(pair.route, list);
  }
  for (const list of byRoute.values()) {
    list.sort((a, b) => a.entry.timestamp - b.entry.timestamp);
  }

  const eventsByRoute = new Map<string, TradeEvent[]>();
  for (const event of events) {
    if (event.milestone !== rule.milestone) continue;
    if (!event.baseAsset || !event.shortExchange || !event.longExchange) continue;
    if (event.pairId) continue;
    const route = routeOf(event);
    const list = eventsByRoute.get(route) ?? [];
    list.push(event);
    eventsByRoute.set(route, list);
  }
  for (const list of eventsByRoute.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
  }

  for (const [route, routePairs] of byRoute.entries()) {
    const routeEvents = eventsByRoute.get(route);
    if (!routeEvents || routeEvents.length === 0) continue;
    const used = new Set<number>();

    for (const pair of routePairs) {
      const entryTs = pair.entry.timestamp;
      const targetTs = entryTs - rule.expectedLeadMs;

      let bestIndex = -1;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let idx = 0; idx < routeEvents.length; idx += 1) {
        if (used.has(idx)) continue;
        const candidate = routeEvents[idx];
        const lowerBound = entryTs - rule.maxLookbackMs;
        const upperBound = entryTs + rule.maxAfterMs;
        if (candidate.timestamp < lowerBound || candidate.timestamp > upperBound) continue;

        const score = Math.abs(candidate.timestamp - targetTs);
        if (score < bestScore) {
          bestScore = score;
          bestIndex = idx;
        } else if (score === bestScore && bestIndex >= 0 && candidate.timestamp > routeEvents[bestIndex].timestamp) {
          bestIndex = idx;
        }
      }

      if (bestIndex >= 0) {
        pair.snapshots[rule.label] = routeEvents[bestIndex];
        used.add(bestIndex);
      }
    }
  }
}

function assignDirectPairMilestones(pairs: PairWork[], events: TradeEvent[]) {
  const pairMap = new Map<string, PairWork>();
  for (const pair of pairs) {
    pairMap.set(pair.pairId, pair);
  }

  for (const event of events) {
    if (event.type !== 'schedule_probe') continue;
    if (!event.pairId || !event.milestone) continue;
    const pair = pairMap.get(event.pairId);
    if (!pair) continue;

    const label = event.milestone;
    const existing = pair.snapshots[label];
    if (!existing) {
      pair.snapshots[label] = event;
      continue;
    }

    const expectedOffsetByMilestone: Record<string, number> = {
      execute_success: 0,
      post_1m: 60_000,
      post_3m: 180_000,
      post_5m: 300_000,
      post_10m: 600_000,
      post_30m: 1_800_000,
      post_funding_1s: 1_000,
      post_funding_5s: 5_000,
      post_funding_7s: 7_000,
      post_funding_10s: 10_000,
      post_funding_15s: 15_000,
      post_funding_20s: 20_000,
      post_funding_25s: 25_000,
      post_funding_30s: 30_000,
    };
    const expectedOffset = expectedOffsetByMilestone[label] ?? 0;
    const target = pair.entry.timestamp + expectedOffset;
    const oldGap = Math.abs(existing.timestamp - target);
    const newGap = Math.abs(event.timestamp - target);
    if (newGap < oldGap) {
      pair.snapshots[label] = event;
    }
  }
}

function addDerivedSnapshot(
  pairs: PairWork[],
  events: TradeEvent[],
  label: string,
  expectedLeadMs: number,
  maxLookbackMs: number,
) {
  assignMilestonesByRoute(pairs, events, {
    label,
    milestone: 'analysis_candidate',
    expectedLeadMs,
    maxLookbackMs,
    maxAfterMs: 0,
  });
}

function analyzePairs(windowEvents: TradeEvent[]): PairResult[] {
  const entryEvents = windowEvents
    .filter((event) => event.type === 'snipe_entry' && !!event.pairId)
    .sort((a, b) => a.timestamp - b.timestamp);

  const pairs: PairWork[] = entryEvents.map((entry) => ({
    pairId: entry.pairId as string,
    route: routeOf(entry),
    baseAsset: entry.baseAsset ?? 'n/a',
    shortExchange: entry.shortExchange ?? 'n/a',
    longExchange: entry.longExchange ?? 'n/a',
    entry,
    exits: [],
    fundings: [],
    snapshots: {},
  }));

  const pairMap = new Map<string, PairWork>();
  for (const pair of pairs) {
    pairMap.set(pair.pairId, pair);
  }

  for (const event of windowEvents) {
    if (!event.pairId) continue;
    const pair = pairMap.get(event.pairId);
    if (!pair) continue;
    if (event.type === 'snipe_exit') pair.exits.push(event);
    if (event.type === 'funding') pair.fundings.push(event);
  }

  assignDirectPairMilestones(pairs, windowEvents);

  const preRules: MilestoneAssignRule[] = [
    { label: 'pre_30m', milestone: 'pre_30m', expectedLeadMs: 30 * 60_000, maxLookbackMs: 2 * 60 * 60_000, maxAfterMs: 0 },
    { label: 'pre_10m', milestone: 'pre_10m', expectedLeadMs: 10 * 60_000, maxLookbackMs: 60 * 60_000, maxAfterMs: 0 },
    { label: 'pre_5m', milestone: 'pre_5m', expectedLeadMs: 5 * 60_000, maxLookbackMs: 30 * 60_000, maxAfterMs: 0 },
    { label: 'pre_3m', milestone: 'pre_3m', expectedLeadMs: 3 * 60_000, maxLookbackMs: 20 * 60_000, maxAfterMs: 0 },
    { label: 'pre_1m', milestone: 'pre_1m', expectedLeadMs: 1 * 60_000, maxLookbackMs: 10 * 60_000, maxAfterMs: 0 },
    { label: 'execute', milestone: 'execute', expectedLeadMs: 0, maxLookbackMs: 2 * 60_000, maxAfterMs: 10_000 },
  ];
  for (const rule of preRules) {
    assignMilestonesByRoute(pairs, windowEvents, rule);
  }

  addDerivedSnapshot(pairs, windowEvents, 'derived_1h', 60 * 60_000, 3 * 60 * 60_000);
  addDerivedSnapshot(pairs, windowEvents, 'derived_15m', 15 * 60_000, 60 * 60_000);

  const results: PairResult[] = pairs.map((pair) => {
    const exits = [...pair.exits].sort((a, b) => a.timestamp - b.timestamp);
    const fundings = [...pair.fundings].sort((a, b) => a.timestamp - b.timestamp);

    const realizedPnl = sum(exits.map((event) => toNumber(event.pnl)));
    const fundingPnl = sum(exits.map((event) => toNumber(event.fundingAmount)));
    const pricePnl = sum(exits.map((event) => toNumber(event.pricePnl)));
    const feePnl = sum(exits.map((event) => toNumber(event.entryFee) + toNumber(event.exitFee)));
    const holdingSeconds = exits.length > 0
      ? round((exits[exits.length - 1].timestamp - pair.entry.timestamp) / 1000, 3)
      : null;

    const expectedAtExecute = toNumber(
      pair.snapshots.execute_success?.expectedNetProfit
      ?? pair.snapshots.execute?.expectedNetProfit,
      Number.NaN,
    );
    const expectedAtPre1m = toNumber(pair.snapshots.pre_1m?.expectedNetProfit, Number.NaN);
    const expectedAtPre10m = toNumber(pair.snapshots.pre_10m?.expectedNetProfit, Number.NaN);

    const normalizedSnapshots: Partial<Record<string, SnapshotRow>> = {};
    for (const [milestone, event] of Object.entries(pair.snapshots)) {
      if (!event) continue;
      normalizedSnapshots[milestone] = makeSnapshot(milestone, event);
    }

    return {
      pairId: pair.pairId,
      route: pair.route,
      baseAsset: pair.baseAsset,
      shortExchange: pair.shortExchange,
      longExchange: pair.longExchange,
      entryTimestamp: pair.entry.timestamp,
      entryTimestampText: formatKst(pair.entry.timestamp),
      realizedPnl: round(realizedPnl),
      fundingPnl: round(fundingPnl),
      pricePnl: round(pricePnl),
      feePnl: round(feePnl),
      holdingSeconds,
      expectedAtExecute: Number.isFinite(expectedAtExecute) ? round(expectedAtExecute) : null,
      expectedAtPre1m: Number.isFinite(expectedAtPre1m) ? round(expectedAtPre1m) : null,
      expectedAtPre10m: Number.isFinite(expectedAtPre10m) ? round(expectedAtPre10m) : null,
      predictionErrorAtExecute: Number.isFinite(expectedAtExecute) ? round(realizedPnl - expectedAtExecute) : null,
      snapshots: normalizedSnapshots,
      legCount: exits.length,
      fundingLegCount: fundings.length,
    };
  }).sort((a, b) => a.entryTimestamp - b.entryTimestamp);

  return results;
}

function buildSummary(
  sourceFile: string,
  hours: number,
  windowEvents: TradeEvent[],
  pairs: PairResult[],
  schedulerStatus: SchedulerStatus | null,
  snipeState: SnipeState | null,
): AnalysisSummary {
  const sortedDesc = [...windowEvents].sort((a, b) => b.timestamp - a.timestamp);
  const windowTo = sortedDesc[0]?.timestamp ?? Date.now();
  const windowFrom = sortedDesc[sortedDesc.length - 1]?.timestamp ?? (windowTo - hours * 3600_000);

  const eventCounts: Record<string, number> = {};
  const scopeCounts: Record<string, number> = {};
  for (const event of windowEvents) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    const scopeKey = event.executionScope ?? (event.simulation ? 'sim' : 'real');
    scopeCounts[scopeKey] = (scopeCounts[scopeKey] ?? 0) + 1;
  }

  const pnlValues = pairs.map((pair) => pair.realizedPnl);
  const totalRealizedPnl = sum(pnlValues);
  const totalFundingPnl = sum(pairs.map((pair) => pair.fundingPnl));
  const totalPricePnl = sum(pairs.map((pair) => pair.pricePnl));
  const totalFeePnl = sum(pairs.map((pair) => pair.feePnl));
  const wins = pairs.filter((pair) => pair.realizedPnl > 0).length;
  const expectedAtExecuteValues = pairs
    .map((pair) => pair.expectedAtExecute)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const predictionErrors = pairs
    .map((pair) => pair.predictionErrorAtExecute)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  const executeFailed = windowEvents.filter((event) => event.type === 'schedule_probe' && event.milestone === 'execute_failed');
  const executeFailedByReason: Record<string, number> = {};
  let executeFailedPositiveExpectedCount = 0;
  let executeFailedPositiveExpectedTotal = 0;
  for (const event of executeFailed) {
    const reason = event.reason ?? 'unknown';
    executeFailedByReason[reason] = (executeFailedByReason[reason] ?? 0) + 1;
    const expected = toNumber(event.expectedNetProfit, Number.NaN);
    if (Number.isFinite(expected) && expected > 0) {
      executeFailedPositiveExpectedCount += 1;
      executeFailedPositiveExpectedTotal += expected;
    }
  }

  const guardBlockByReason: Record<string, number> = {};
  for (const event of windowEvents) {
    if (event.type !== 'guard_block') continue;
    const reason = event.reason ?? 'unknown';
    guardBlockByReason[reason] = (guardBlockByReason[reason] ?? 0) + 1;
  }

  const coverageKeys = [
    'derived_1h',
    'pre_30m',
    'derived_15m',
    'pre_10m',
    'pre_5m',
    'pre_3m',
    'pre_1m',
    'execute',
    'execute_success',
    'post_1m',
    'post_3m',
    'post_5m',
    'post_10m',
    'post_30m',
  ];
  const milestoneCoverage: Record<string, number> = {};
  for (const key of coverageKeys) {
    milestoneCoverage[key] = pairs.filter((pair) => pair.snapshots[key] != null).length;
  }

  const routeMap = new Map<string, { pairCount: number; winCount: number; totalPnl: number }>();
  for (const pair of pairs) {
    const current = routeMap.get(pair.route) ?? { pairCount: 0, winCount: 0, totalPnl: 0 };
    current.pairCount += 1;
    if (pair.realizedPnl > 0) current.winCount += 1;
    current.totalPnl += pair.realizedPnl;
    routeMap.set(pair.route, current);
  }
  const routePerformanceTop = [...routeMap.entries()]
    .map(([route, row]) => ({
      route,
      pairCount: row.pairCount,
      winCount: row.winCount,
      totalPnl: round(row.totalPnl),
      avgPnl: round(row.totalPnl / Math.max(1, row.pairCount)),
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl)
    .slice(0, 20);

  const confirmedConfig = schedulerStatus?.config?.confirmedSnipeConfig;
  const confirmedToggles = confirmedConfig
    ? Object.values({
      useImpactGuards: confirmedConfig.useImpactGuards,
      useDynamicNotional: confirmedConfig.useDynamicNotional,
      useDriftBuffer: confirmedConfig.useDriftBuffer,
      useConfirmedClose: confirmedConfig.useConfirmedClose,
      useIocLimitOnly: confirmedConfig.useIocLimitOnly,
      useStrictHedge: confirmedConfig.useStrictHedge,
    }).filter(Boolean).length
    : 0;

  const simBalances = schedulerStatus?.state?.simBalances ?? null;
  const simInitialBalances = schedulerStatus?.state?.simInitialBalances ?? null;
  const initialTotal = simInitialBalances
    ? sum(Object.values(simInitialBalances).map((value) => toNumber(value)))
    : null;
  const currentTotal = simBalances
    ? sum(Object.values(simBalances).map((value) => toNumber(value)))
    : null;
  const netPnl = initialTotal != null && currentTotal != null ? currentTotal - initialTotal : null;
  const netPnlPercent = netPnl != null && initialTotal != null && initialTotal > 0
    ? (netPnl / initialTotal) * 100
    : null;

  const now = Date.now();
  return {
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    sourceFile,
    hours,
    window: {
      from: windowFrom,
      fromIso: new Date(windowFrom).toISOString(),
      to: windowTo,
      toIso: new Date(windowTo).toISOString(),
    },
    eventCounts: Object.fromEntries(
      Object.entries(eventCounts).sort((a, b) => b[1] - a[1]),
    ),
    executed: {
      pairCount: pairs.length,
      winRate: pairs.length > 0 ? round(wins / pairs.length, 6) : 0,
      totalRealizedPnl: round(totalRealizedPnl),
      totalFundingPnl: round(totalFundingPnl),
      totalPricePnl: round(totalPricePnl),
      totalFeePnl: round(totalFeePnl),
      averagePnlPerPair: pairs.length > 0 ? round(totalRealizedPnl / pairs.length) : 0,
      medianPnlPerPair: round(median(pnlValues)),
      totalExpectedAtExecute: round(sum(expectedAtExecuteValues)),
      totalPredictionErrorAtExecute: round(sum(predictionErrors)),
      expectedPositiveButLossCount: pairs.filter((pair) => (pair.expectedAtExecute ?? -Infinity) > 0 && pair.realizedPnl < 0).length,
    },
    executionScopeCounts: scopeCounts,
    milestoneCoverage,
    failures: {
      executeFailedByReason: Object.fromEntries(
        Object.entries(executeFailedByReason).sort((a, b) => b[1] - a[1]),
      ),
      executeFailedPositiveExpectedCount,
      executeFailedPositiveExpectedTotal: round(executeFailedPositiveExpectedTotal),
      guardBlockByReason: Object.fromEntries(
        Object.entries(guardBlockByReason).sort((a, b) => b[1] - a[1]),
      ),
    },
    liveStatus: {
      schedulerActive: typeof schedulerStatus?.active === 'boolean' ? schedulerStatus.active : null,
      simSnipeActive: snipeState?.data?.simSnipeActive ?? null,
      realSnipeActive: snipeState?.data?.realSnipeActive ?? null,
      simulationMode: snipeState?.data?.simulationMode ?? null,
      config: {
        investmentUSDT: schedulerStatus?.config?.investmentUSDT ?? null,
        leverage: schedulerStatus?.config?.leverage ?? null,
        minSpreadPercent: schedulerStatus?.config?.minSpreadPercent ?? null,
        compoundInvesting: schedulerStatus?.config?.compoundInvesting ?? null,
        enabledExchanges: schedulerStatus?.config?.enabledExchanges ?? null,
        entryLeadMs: schedulerStatus?.config?.timingConfig?.entryLeadMs ?? null,
        closeDelayMs: schedulerStatus?.config?.timingConfig?.closeDelayMs ?? null,
        maxSlippagePercent: schedulerStatus?.config?.maxSlippagePercent ?? null,
        minVolume24hUSD: schedulerStatus?.config?.minVolume24hUSD ?? null,
        confirmedSnipeConfigPresent: confirmedConfig != null,
        confirmedSnipeEnabledToggleCount: confirmedToggles,
      },
      equity: {
        initialTotal: initialTotal != null ? round(initialTotal) : null,
        currentTotal: currentTotal != null ? round(currentTotal) : null,
        netPnl: netPnl != null ? round(netPnl) : null,
        netPnlPercent: netPnlPercent != null ? round(netPnlPercent) : null,
        totalFundingEarned: schedulerStatus?.state?.simTotalFundingEarned ?? null,
        totalClosedPnl: schedulerStatus?.state?.simTotalClosedPnl ?? null,
        totalFees: schedulerStatus?.state?.simTotalFees ?? null,
      },
    },
    routePerformanceTop,
    bestPairs: [...pairs].sort((a, b) => b.realizedPnl - a.realizedPnl).slice(0, 10),
    worstPairs: [...pairs].sort((a, b) => a.realizedPnl - b.realizedPnl).slice(0, 10),
    pairs,
  };
}

function toMarkdown(summary: AnalysisSummary): string {
  const lines: string[] = [];

  lines.push(`# ${summary.hours}h Trade Analysis (Server Data)`);
  lines.push('');
  lines.push(`- Generated (KST): \`${formatKst(summary.generatedAt)}\``);
  lines.push(`- Window (UTC): \`${summary.window.fromIso}\` ~ \`${summary.window.toIso}\``);
  lines.push(`- Source: \`${summary.sourceFile}\``);
  lines.push('');

  lines.push('## 1) Core Snapshot');
  lines.push('');
  lines.push(`- Executed pairs: **${summary.executed.pairCount}**`);
  lines.push(`- Realized PnL: **${summary.executed.totalRealizedPnl.toFixed(4)} USD**`);
  lines.push(`- Win rate: **${(summary.executed.winRate * 100).toFixed(2)}%**`);
  lines.push(`- Funding / Price / Fee: \`${summary.executed.totalFundingPnl.toFixed(4)} / ${summary.executed.totalPricePnl.toFixed(4)} / ${summary.executed.totalFeePnl.toFixed(4)}\``);
  lines.push(`- Expected@execute sum: \`${summary.executed.totalExpectedAtExecute.toFixed(4)}\`, prediction error sum: \`${summary.executed.totalPredictionErrorAtExecute.toFixed(4)}\``);
  lines.push(`- Expected positive but loss: \`${summary.executed.expectedPositiveButLossCount}\` pairs`);
  lines.push('');

  lines.push('## 2) Live Setting/State Check');
  lines.push('');
  lines.push(`- Scheduler active: \`${String(summary.liveStatus.schedulerActive)}\``);
  lines.push(`- SIM snipe active: \`${String(summary.liveStatus.simSnipeActive)}\`, REAL snipe active: \`${String(summary.liveStatus.realSnipeActive)}\``);
  lines.push(`- Simulation mode: \`${String(summary.liveStatus.simulationMode)}\``);
  lines.push(`- Config: investment \`${summary.liveStatus.config.investmentUSDT ?? '-'}\`, leverage \`${summary.liveStatus.config.leverage ?? '-'}\`, minSpread \`${summary.liveStatus.config.minSpreadPercent ?? '-'}%\``);
  lines.push(`- Timing: entryLead \`${summary.liveStatus.config.entryLeadMs ?? '-'}ms\`, closeDelay \`${summary.liveStatus.config.closeDelayMs ?? '-'}ms\``);
  lines.push(`- confirmedSnipeConfig present: \`${summary.liveStatus.config.confirmedSnipeConfigPresent}\`, enabled toggles: \`${summary.liveStatus.config.confirmedSnipeEnabledToggleCount}\``);
  lines.push(`- Equity (initial/current/net): \`${summary.liveStatus.equity.initialTotal ?? '-'} / ${summary.liveStatus.equity.currentTotal ?? '-'} / ${summary.liveStatus.equity.netPnl ?? '-'}\``);
  lines.push(`- Equity return: \`${summary.liveStatus.equity.netPnlPercent ?? '-'}%\``);
  lines.push('');

  lines.push('## 3) Failure Reasons');
  lines.push('');
  lines.push('- Execute failed by reason:');
  for (const [reason, count] of Object.entries(summary.failures.executeFailedByReason)) {
    lines.push(`  - \`${reason}\`: ${count}`);
  }
  lines.push(`- Execute failed with expectedNetProfit>0: \`${summary.failures.executeFailedPositiveExpectedCount}\` (sum \`${summary.failures.executeFailedPositiveExpectedTotal.toFixed(4)}\`)`);
  lines.push('- Guard block by reason:');
  for (const [reason, count] of Object.entries(summary.failures.guardBlockByReason)) {
    lines.push(`  - \`${reason}\`: ${count}`);
  }
  lines.push('');

  lines.push('## 4) Milestone Coverage');
  lines.push('');
  for (const [milestone, count] of Object.entries(summary.milestoneCoverage)) {
    lines.push(`- \`${milestone}\`: ${count}/${summary.executed.pairCount}`);
  }
  lines.push('');

  lines.push('## 5) Top/Worst Pairs');
  lines.push('');
  lines.push('### Best');
  for (const pair of summary.bestPairs.slice(0, 5)) {
    lines.push(`- \`${pair.entryTimestampText}\` \`${pair.route}\` pnl=\`${pair.realizedPnl.toFixed(4)}\` expected@execute=\`${pair.expectedAtExecute ?? '-'}\``);
  }
  lines.push('');
  lines.push('### Worst');
  for (const pair of summary.worstPairs.slice(0, 5)) {
    lines.push(`- \`${pair.entryTimestampText}\` \`${pair.route}\` pnl=\`${pair.realizedPnl.toFixed(4)}\` expected@execute=\`${pair.expectedAtExecute ?? '-'}\``);
  }
  lines.push('');

  lines.push('## 6) Pair Table');
  lines.push('');
  lines.push('| Entry(KST) | Route | Exp@1m | Exp@Execute | Realized | Error |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const pair of summary.pairs) {
    const exp1m = pair.expectedAtPre1m ?? 0;
    const expExec = pair.expectedAtExecute ?? 0;
    const err = pair.predictionErrorAtExecute ?? 0;
    lines.push(`| ${pair.entryTimestampText} | ${pair.route} | ${exp1m.toFixed(4)} | ${expExec.toFixed(4)} | ${pair.realizedPnl.toFixed(4)} | ${err.toFixed(4)} |`);
  }

  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const hours = Math.max(1, Math.floor(toNumber(args.hours, 60)));
  const sourceFile = path.resolve(
    args.source ?? path.join('data', 'remote-47.128.214.182', 'events-all-all.json'),
  );
  const schedulerStatusFile = path.resolve(
    args.schedulerStatus ?? path.join('data', 'remote-47.128.214.182', 'live-sim-scheduler-status.json'),
  );
  const snipeStateFile = path.resolve(
    args.snipeState ?? path.join('data', 'remote-47.128.214.182', 'live-snipe-state.json'),
  );

  const sourceJson = readJsonOrNull<{ events?: TradeEvent[] }>(sourceFile);
  if (!sourceJson) {
    throw new Error(`source file not found or invalid: ${sourceFile}`);
  }
  const allEvents = ensureArrayEvents(sourceJson);
  if (allEvents.length === 0) {
    throw new Error(`no events found in: ${sourceFile}`);
  }
  allEvents.sort((a, b) => b.timestamp - a.timestamp);

  const maxTimestamp = allEvents[0].timestamp;
  const minTimestamp = maxTimestamp - hours * 3600_000;
  const windowEvents = allEvents.filter((event) => event.timestamp >= minTimestamp);

  const schedulerStatus = readJsonOrNull<SchedulerStatus>(schedulerStatusFile);
  const snipeState = readJsonOrNull<SnipeState>(snipeStateFile);
  const pairs = analyzePairs(windowEvents);
  const summary = buildSummary(sourceFile, hours, windowEvents, pairs, schedulerStatus, snipeState);

  const outJson = path.resolve(
    args.outJson ?? path.join('data', 'remote-47.128.214.182', `analysis-${hours}h-v2.json`),
  );
  const outMd = path.resolve(
    args.outMd ?? path.join('docs', `trade-audit-${hours}h-analysis-${formatKst(Date.now()).slice(0, 10)}.md`),
  );

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outMd, `${toMarkdown(summary)}\n`, 'utf8');

  const report = {
    outJson,
    outMd,
    pairCount: summary.executed.pairCount,
    totalRealizedPnl: summary.executed.totalRealizedPnl,
    winRate: summary.executed.winRate,
    netPnlPercentLive: summary.liveStatus.equity.netPnlPercent,
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
