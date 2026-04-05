import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fetchFundingRates, fetchMarketFillPrice, fetchOrderbook, calcOrderbookImpactBps } from './exchanges';
import { pairUsesInstantaneousRate, hasTierCExchange, getPairEntryLeadMs, getPairMaxSettlementWaitMs } from './exchangeProfiles';
import { getEntryGapMetrics } from './entryGapGuard';
import { resolveRuntimeFee, resolveRuntimeFeeDetailed } from './runtimeFeeCache';
import { appendTrades, readTrades, type TradeEvent } from './fileLogger';
import { RouteFailureMemory, makeRouteFailureKey } from './routeFailureMemory';
import {
  findOpportunities,
  getOpportunityHourlyNetProfit,
  getOpportunityId,
  getOpportunityIntervalHours,
  getOpportunityLegKeys,
  makeOpportunityId,
  calcConservativeEV,
  calcDriftBuffer,
} from './opportunities';
import {
  calcNetSpreadPercent,
  calcHedgedNetSpreadPercent,
  DEFAULT_CONFIRMED_SNIPE_CONFIG,
  MAX_ROUND_TRIP_IMPACT_BPS,
  MAX_FUNDING_TIMESTAMP_DIFF_MS,
  MIN_FREE_MARGIN_PCT,
  HEDGE_RATIO_MIN,
  HEDGE_RATIO_MAX,
  getResolvedTimingConfig,
  sanitizeFeeOverrides,
  sanitizePaybackOverrides,
  sanitizeTimingConfig,
  type ArbitrageOpportunity,
  type ConfirmedSnipeConfig,
  type ExchangeId,
  type FeeOverrides,
  type PaybackOverrides,
  type FundingPayment,
  type FundingRate,
  type SimPosition,
  type SimStateSnapshot,
  type StrategyConfig,
  type TimingConfig,
} from './types';
import {
  createDefaultSimState,
  getOrCreateServerSimState,
  loadServerSimState,
  resetServerSimState,
  saveServerSimState,
} from './serverSimState';
import { getDataDir } from './dataDir';

const DATA_DIR = getDataDir();
const STATE_FILE = join(DATA_DIR, 'sim-scheduler-state.json');
const LOOP_INTERVAL_MS = 1_000;
const RATES_REFRESH_INTERVAL_MS = 3_000;
const MAX_FUNDING_HISTORY = 500;
const BASE_REVALIDATE_BATCH_SIZE = 3;
const URGENT_REVALIDATE_BATCH_SIZE = 12;
const URGENT_REVALIDATE_WINDOW_MS = 15_000;
const FINAL_REVALIDATE_GUARD_MS = 1_000;
const FULL_REVALIDATE_CAP = 20;
const PROBE_STATE_RETENTION_MS = 2 * 60 * 60 * 1000;

const PRE_EXECUTION_PROBE_POINTS = [
  { key: 'pre_30m', thresholdMs: 30 * 60 * 1000 },
  { key: 'pre_10m', thresholdMs: 10 * 60 * 1000 },
  { key: 'pre_5m', thresholdMs: 5 * 60 * 1000 },
  { key: 'pre_3m', thresholdMs: 3 * 60 * 1000 },
  { key: 'pre_1m', thresholdMs: 1 * 60 * 1000 },
] as const;

const POST_EXECUTION_PROBE_POINTS = [
  { key: 'post_1m', thresholdMs: 1 * 60 * 1000 },
  { key: 'post_3m', thresholdMs: 3 * 60 * 1000 },
  { key: 'post_5m', thresholdMs: 5 * 60 * 1000 },
  { key: 'post_10m', thresholdMs: 10 * 60 * 1000 },
  { key: 'post_30m', thresholdMs: 30 * 60 * 1000 },
] as const;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getScheduleAheadWindowMs(opportunity: Pick<ArbitrageOpportunity, 'fundingIntervalMs'>): number {
  const defaultAheadMs = 5 * 60 * 60 * 1000;
  const fundingWindowMs = opportunity.fundingIntervalMs ?? 8 * 60 * 60 * 1000;
  return Math.max(defaultAheadMs, fundingWindowMs);
}

function makePositionLegKey(exchange: ExchangeId, symbol: string): string {
  return `${exchange}:${symbol}`;
}

function makeScheduleProbeId(opportunityId: string, targetTime: number): string {
  return `${opportunityId}@${targetTime}`;
}

function getPositionOpportunityKey(
  baseAsset: string,
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
  fundingIntervalMs?: number,
) {
  return makeOpportunityId(baseAsset, shortExchange, longExchange, fundingIntervalMs ?? 8 * 3600000);
}

function getSimPositionOpportunityKey(
  position: Pick<SimPosition, 'baseAsset' | 'exchange' | 'side' | 'pairId' | 'fundingIntervalMs' | 'simId'>,
  positions: Array<Pick<SimPosition, 'exchange' | 'side' | 'pairId' | 'fundingIntervalMs' | 'simId'>>,
) {
  const pair = position.pairId
    ? positions.find((candidate) => candidate.pairId === position.pairId && candidate.simId !== position.simId)
    : undefined;
  const shortExchange = position.side === 'short' ? position.exchange : pair?.exchange ?? position.exchange;
  const longExchange = position.side === 'long' ? position.exchange : pair?.exchange ?? position.exchange;
  return getPositionOpportunityKey(
    position.baseAsset,
    shortExchange,
    longExchange,
    position.fundingIntervalMs ?? pair?.fundingIntervalMs,
  );
}

function flipOpportunityDirection(opportunity: ArbitrageOpportunity): ArbitrageOpportunity {
  const fundingIntervalMs = opportunity.fundingIntervalMs ?? 8 * 3600000;
  const flippedSpread = opportunity.longRate - opportunity.shortRate;
  return {
    ...opportunity,
    id: makeOpportunityId(
      opportunity.baseAsset,
      opportunity.longExchange,
      opportunity.shortExchange,
      fundingIntervalMs,
    ),
    shortExchange: opportunity.longExchange,
    shortSymbol: opportunity.longSymbol,
    shortRate: opportunity.longRate,
    shortRatePercent: opportunity.longRatePercent,
    shortMarkPrice: opportunity.longMarkPrice,
    longExchange: opportunity.shortExchange,
    longSymbol: opportunity.shortSymbol,
    longRate: opportunity.shortRate,
    longRatePercent: opportunity.shortRatePercent,
    longMarkPrice: opportunity.shortMarkPrice,
    spread: flippedSpread,
    spreadPercent: flippedSpread * 100,
    annualReturnPercent: opportunity.annualReturnPercent * -1,
  };
}

function buildStrategyLikeConfig(config: ServerSimSchedulerConfig): StrategyConfig {
  return {
    investmentUSDT: config.investmentUSDT,
    leverage: config.leverage,
    minSpreadPercent: config.minSpreadPercent,
    autoExecute: true,
    compoundInvesting: config.compoundInvesting,
    feeOverrides: config.feeOverrides,
    paybackOverrides: config.paybackOverrides,
    timingConfig: config.timingConfig,
    confirmedSnipeConfig: config.confirmedSnipeConfig,
  };
}

function mapSimEntryErrorToGuardReason(error?: string): string {
  const normalized = (error ?? '').toLowerCase();
  if (normalized.includes('slippage exceeded')) return 'slippage_exceeded';
  if (normalized.includes('impact exceeded')) return 'impact_exceeded';
  if (normalized.includes('entry gap')) return 'entry_gap_exceeded';
  if (normalized.includes('insufficient sim balance')) return 'insufficient_balance';
  if (normalized.includes('free margin low')) return 'free_margin_low';
  if (normalized.includes('conservative ev failed')) return 'profitability_insufficient';
  if (normalized.includes('orderbook')) return 'orderbook_unavailable';
  if (normalized.includes('depth too shallow')) return 'depth_too_shallow';
  if (normalized.includes('position already active')) return 'position_already_active';
  return 'entry_failed';
}

function getOpportunityYieldScore(
  opportunity: ArbitrageOpportunity,
  feeOverrides?: FeeOverrides,
  paybackOverrides?: PaybackOverrides,
): number {
  const hedgeFeePct = (
    resolveRuntimeFee(opportunity.shortExchange, 'taker', feeOverrides, paybackOverrides)
    + resolveRuntimeFee(opportunity.longExchange, 'taker', feeOverrides, paybackOverrides)
  ) * 2 * 100;
  const netSpreadPercent = Math.max(0, calcNetSpreadPercent(opportunity.spreadPercent, 0, hedgeFeePct));
  return Math.max(0, netSpreadPercent / getOpportunityIntervalHours(opportunity));
}

function planWindowAllocations(
  opportunities: ArbitrageOpportunity[],
  availableBalance: Record<string, number>,
  strategyConfig: StrategyConfig,
): Array<{ opportunity: ArbitrageOpportunity; investmentUSDT: number }> {
  const candidates = opportunities
    .map((opportunity) => ({
      opportunity,
      score: getOpportunityYieldScore(
        opportunity,
        strategyConfig.feeOverrides,
        strategyConfig.paybackOverrides,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return getOpportunityHourlyNetProfit(b.opportunity) - getOpportunityHourlyNetProfit(a.opportunity);
    });

  const occupiedLegs = new Set<string>();
  const selected = candidates.filter((candidate) => {
    if (getOpportunityLegKeys(candidate.opportunity).some((legKey) => occupiedLegs.has(legKey))) {
      return false;
    }
    getOpportunityLegKeys(candidate.opportunity).forEach((legKey) => occupiedLegs.add(legKey));
    return true;
  });

  if (selected.length === 0) return [];

  const allocations = new Map<string, number>();
  const allocationStep = Math.max(25, Math.min(strategyConfig.investmentUSDT / 5, 250));
  const minAllocation = Math.min(Math.max(10, strategyConfig.investmentUSDT * 0.1), allocationStep);
  const getCostFactor = (exchange: ExchangeId) => (
    1 + (strategyConfig.leverage * resolveRuntimeFee(
      exchange,
      'taker',
      strategyConfig.feeOverrides,
      strategyConfig.paybackOverrides,
    ))
  );

  const getCap = (opportunity: ArbitrageOpportunity) => {
    const shortAvail = availableBalance[opportunity.shortExchange] ?? 0;
    const longAvail = availableBalance[opportunity.longExchange] ?? 0;
    const shortFactor = getCostFactor(opportunity.shortExchange);
    const longFactor = getCostFactor(opportunity.longExchange);
    const maxByShort = shortFactor > 0 ? shortAvail / shortFactor : 0;
    const maxByLong = longFactor > 0 ? longAvail / longFactor : 0;
    const maxByBalance = Math.max(0, Math.min(maxByShort, maxByLong));
    if (strategyConfig.compoundInvesting) {
      return maxByBalance * 0.9;
    }
    return Math.min(strategyConfig.investmentUSDT, maxByBalance);
  };

  let totalAllocated = 0;
  while (true) {
    const eligible = selected.filter((candidate) => {
      const allocated = allocations.get(getOpportunityId(candidate.opportunity)) ?? 0;
      return getCap(candidate.opportunity) - allocated >= minAllocation;
    });
    if (eligible.length === 0) break;

    const totalScore = eligible.reduce((sum, candidate) => sum + candidate.score, 0);
    let bestCandidate = eligible[0];
    let bestDeficit = Number.NEGATIVE_INFINITY;

    for (const candidate of eligible) {
      const opportunityId = getOpportunityId(candidate.opportunity);
      const allocated = allocations.get(opportunityId) ?? 0;
      const targetAllocated = totalScore > 0
        ? (totalAllocated + allocationStep) * (candidate.score / totalScore)
        : totalAllocated + allocationStep;
      const deficit = targetAllocated - allocated;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestCandidate = candidate;
      }
    }

    const opportunity = bestCandidate.opportunity;
    const opportunityId = getOpportunityId(opportunity);
    const allocated = allocations.get(opportunityId) ?? 0;
    const shortAvail = availableBalance[opportunity.shortExchange] ?? 0;
    const longAvail = availableBalance[opportunity.longExchange] ?? 0;
    const shortFactor = getCostFactor(opportunity.shortExchange);
    const longFactor = getCostFactor(opportunity.longExchange);
    const chunk = Math.min(
      allocationStep,
      getCap(opportunity) - allocated,
    );

    if (chunk < minAllocation) break;

    const shortCost = chunk * shortFactor;
    const longCost = chunk * longFactor;
    allocations.set(opportunityId, allocated + chunk);
    availableBalance[opportunity.shortExchange] = Math.max(0, shortAvail - shortCost);
    availableBalance[opportunity.longExchange] = Math.max(0, longAvail - longCost);
    totalAllocated += chunk;
  }

  return selected
    .map((candidate) => ({
      opportunity: candidate.opportunity,
      investmentUSDT: allocations.get(getOpportunityId(candidate.opportunity)) ?? 0,
    }))
    .filter((candidate) => candidate.investmentUSDT >= minAllocation);
}

export interface ServerSimSchedulerConfig {
  investmentUSDT: number;
  leverage: number;
  minSpreadPercent: number;
  compoundInvesting: boolean;
  enabledExchanges: ExchangeId[];
  feeOverrides?: FeeOverrides;
  paybackOverrides?: PaybackOverrides;
  timingConfig?: TimingConfig;
  maxSlippagePercent?: number; // maximum slippage percent (default 1.5%)
  minVolume24hUSD?: number; // minimum 24h volume in USD
  confirmedSnipeConfig?: ConfirmedSnipeConfig; // v2.1 — undefined = all toggles OFF (profile timing & Tier C still apply)
}

interface ScheduledSimEntry {
  opportunityId: string;
  probeId: string;
  asset: string;
  opportunity: ArbitrageOpportunity;
  targetTime: number;
  investmentUSDT: number;
}

interface ScheduleProbeState {
  probeId: string;
  opportunityId: string;
  asset: string;
  shortExchange: ExchangeId;
  longExchange: ExchangeId;
  shortSymbol: string;
  longSymbol: string;
  targetTime: number;
  investmentUSDT: number;
  createdAt: number;
  preMilestones: string[];
  postMilestones: string[];
  executeCaptured: boolean;
  executeResultCaptured: boolean;
  status: 'scheduled' | 'executed' | 'failed' | 'canceled';
  executedAt?: number;
  finalizedAt?: number;
  pairId?: string;
  executedNotional?: number;
  lastReason?: string;
}

interface PersistedSimSchedulerState {
  active: boolean;
  config: ServerSimSchedulerConfig;
  startedAt: number | null;
  scheduledEntries: ScheduledSimEntry[];
  scheduleProbeStates?: ScheduleProbeState[];
  pendingAutoCloses: Record<string, number>;
  lastRatesUpdate: number;
}

type SimTradeResult = {
  success: boolean;
  error?: string;
  state?: SimStateSnapshot;
  pairId?: string;
  executedNotional?: number;
};

type ProbeRoute = Pick<
  ArbitrageOpportunity,
  | 'baseAsset'
  | 'shortExchange'
  | 'longExchange'
  | 'shortSymbol'
  | 'longSymbol'
  | 'shortRate'
  | 'longRate'
  | 'fundingIntervalMs'
  | 'nextFundingTime'
>;

class ServerSimScheduler {
  private static instance: ServerSimScheduler | null = null;

  private active = false;
  private config: ServerSimSchedulerConfig = {
    investmentUSDT: 500,
    leverage: 5,
    minSpreadPercent: 0.01,
    compoundInvesting: true,
    enabledExchanges: [],
    timingConfig: getResolvedTimingConfig(),
  };
  private startedAt: number | null = null;
  private latestRates: FundingRate[] = [];
  private opportunities: ArbitrageOpportunity[] = [];
  private scheduledEntries = new Map<string, ScheduledSimEntry>();
  private pendingAutoCloses = new Map<string, number>();
  private lastRatesUpdate = 0;
  private loopInterval: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private revalidateCursor = 0;
  private mutationQueue: Promise<void> = Promise.resolve();
  private routeFailureMemory = new RouteFailureMemory();
  private scheduleProbeStates = new Map<string, ScheduleProbeState>();

  static getInstance() {
    if (!ServerSimScheduler.instance) {
      ServerSimScheduler.instance = new ServerSimScheduler();
    }
    return ServerSimScheduler.instance;
  }

  private constructor() {
    this.loadState();
    this.bootstrapRouteFailureMemory();
    if (this.active) {
      this.startLoop();
    }
  }

  private bootstrapRouteFailureMemory() {
    this.routeFailureMemory.ingestEvents(readTrades(), { simulation: true });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(task, task);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private normalizeConfig(config: ServerSimSchedulerConfig): ServerSimSchedulerConfig {
    return {
      ...config,
      feeOverrides: sanitizeFeeOverrides(config.feeOverrides),
      paybackOverrides: sanitizePaybackOverrides(config.paybackOverrides),
      timingConfig: getResolvedTimingConfig(sanitizeTimingConfig(config.timingConfig)),
    };
  }

  private saveState() {
    ensureDataDir();
    const state: PersistedSimSchedulerState = {
      active: this.active,
      config: this.config,
      startedAt: this.startedAt,
      scheduledEntries: Array.from(this.scheduledEntries.values()),
      scheduleProbeStates: Array.from(this.scheduleProbeStates.values()),
      pendingAutoCloses: Object.fromEntries(this.pendingAutoCloses.entries()),
      lastRatesUpdate: this.lastRatesUpdate,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  }

  private loadState() {
    try {
      if (!existsSync(STATE_FILE)) return;
      const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as PersistedSimSchedulerState;
      this.active = !!parsed.active;
      if (parsed.config) {
        this.config = this.normalizeConfig(parsed.config);
      }
      this.startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : null;
      this.scheduledEntries = new Map(
        Array.isArray(parsed.scheduledEntries)
          ? parsed.scheduledEntries.map((entry) => {
            const normalizedEntry: ScheduledSimEntry = {
              ...entry,
              probeId: entry.probeId || makeScheduleProbeId(entry.opportunityId, entry.targetTime),
            };
            return [entry.opportunityId, normalizedEntry] as const;
          })
          : [],
      );
      this.scheduleProbeStates = new Map(
        Array.isArray(parsed.scheduleProbeStates)
          ? parsed.scheduleProbeStates.map((state) => {
            const probeId = state.probeId || makeScheduleProbeId(state.opportunityId, state.targetTime);
            return [
              probeId,
              {
                ...state,
                probeId,
                preMilestones: Array.isArray(state.preMilestones) ? state.preMilestones : [],
                postMilestones: Array.isArray(state.postMilestones) ? state.postMilestones : [],
                executeCaptured: !!state.executeCaptured,
                executeResultCaptured: !!state.executeResultCaptured,
                status: state.status ?? 'scheduled',
              },
            ] as const;
          })
          : [],
      );
      this.pendingAutoCloses = new Map(
        parsed.pendingAutoCloses
          ? Object.entries(parsed.pendingAutoCloses)
            .filter(([, timestamp]) => typeof timestamp === 'number' && Number.isFinite(timestamp))
            .map(([pairId, timestamp]) => [pairId, timestamp as number])
          : [],
      );
      this.lastRatesUpdate = typeof parsed.lastRatesUpdate === 'number' ? parsed.lastRatesUpdate : 0;
    } catch {
      this.active = false;
      this.scheduledEntries.clear();
      this.scheduleProbeStates.clear();
      this.pendingAutoCloses.clear();
    }
  }

  private getTimingConfig() {
    return getResolvedTimingConfig(this.config.timingConfig);
  }

  private shouldRepairEmptySimBalances(state: SimStateSnapshot): boolean {
    if (this.config.enabledExchanges.length === 0 || this.config.investmentUSDT <= 0) {
      return false;
    }
    if (
      state.simPositions.length > 0
      || state.fundingHistory.length > 0
      || state.simTotalFundingEarned !== 0
      || state.simTotalFees !== 0
      || state.simTotalClosedPnl !== 0
    ) {
      return false;
    }
    return this.config.enabledExchanges.every((exchange) => (
      (state.simBalances[exchange] ?? 0) <= 0
      && (state.simInitialBalances[exchange] ?? 0) <= 0
    ));
  }

  private getState() {
    const state = getOrCreateServerSimState(this.config.enabledExchanges, this.config.investmentUSDT);
    if (!this.shouldRepairEmptySimBalances(state)) {
      return state;
    }
    const repaired = createDefaultSimState(this.config.enabledExchanges, this.config.investmentUSDT);
    return saveServerSimState(repaired);
  }

  private setState(state: SimStateSnapshot) {
    return saveServerSimState(state);
  }

  getStatus() {
    return {
      active: this.active,
      config: this.config,
      startedAt: this.startedAt,
      lastRatesUpdate: this.lastRatesUpdate,
      scheduledEntries: Array.from(this.scheduledEntries.values()).sort((a, b) => a.targetTime - b.targetTime),
      snipeTargets: Object.fromEntries(
        Array.from(this.scheduledEntries.values()).map((entry) => [`sim:${entry.opportunityId}`, entry.targetTime]),
      ),
      snipeAllocations: Object.fromEntries(
        Array.from(this.scheduledEntries.values()).map((entry) => [`sim:${entry.opportunityId}`, entry.investmentUSDT]),
      ),
      state: this.getState(),
    };
  }

  start(config: ServerSimSchedulerConfig) {
    return this.enqueue(async () => {
      this.active = true;
      this.config = this.normalizeConfig(config);
      if (!this.startedAt) {
        this.startedAt = Date.now();
      }
      getOrCreateServerSimState(this.config.enabledExchanges, this.config.investmentUSDT);
      this.startLoop();
      this.saveState();
      // rates 로딩은 백그라운드 — API 즉시 응답
      void this.refreshRatesAndPlans();
      return this.getStatus();
    });
  }

  updateConfig(config: ServerSimSchedulerConfig) {
    return this.enqueue(async () => {
      this.config = this.normalizeConfig(config);
      this.saveState();
      if (this.active) {
        await this.refreshRatesAndPlans();
      }
      return this.getStatus();
    });
  }

  stop() {
    return this.enqueue(async () => {
      this.active = false;
      this.scheduledEntries.clear();
      this.scheduleProbeStates.clear();
      this.pendingAutoCloses.clear();
      if (this.loopInterval) {
        clearInterval(this.loopInterval);
        this.loopInterval = null;
      }
      this.saveState();
      return this.getStatus();
    });
  }

  resetState(enabledExchanges: ExchangeId[], investmentUSDT: number) {
    return this.enqueue(async () => {
      const nextState = resetServerSimState(enabledExchanges, investmentUSDT);
      this.scheduleProbeStates.clear();
      this.pendingAutoCloses.clear();
      if (this.active) {
        await this.refreshRatesAndPlans();
      } else {
        this.saveState();
      }
      return nextState;
    });
  }

  reconfigureState(enabledExchanges: ExchangeId[], investmentUSDT: number) {
    return this.enqueue(async () => {
      const current = loadServerSimState() ?? createDefaultSimState(enabledExchanges, investmentUSDT);
      if (current.simPositions.length > 0) {
        return current;
      }

      const perExchange = Math.max(0, investmentUSDT * 2);
      const simBalances = { ...current.simBalances };
      const simInitialBalances = { ...current.simInitialBalances };
      for (const exchange of Object.keys(simBalances) as ExchangeId[]) {
        simBalances[exchange] = enabledExchanges.includes(exchange) ? perExchange : 0;
        simInitialBalances[exchange] = enabledExchanges.includes(exchange) ? perExchange : 0;
      }
      for (const exchange of enabledExchanges) {
        simBalances[exchange] = perExchange;
        simInitialBalances[exchange] = perExchange;
      }

      return this.setState({
        ...current,
        simBalances,
        simInitialBalances,
      });
    });
  }

  clearFundingHistory() {
    return this.enqueue(async () => {
      const state = this.getState();
      return this.setState({
        ...state,
        fundingHistory: [],
      });
    });
  }

  replaceState(snapshot: SimStateSnapshot) {
    return this.enqueue(async () => this.setState(snapshot));
  }

  executeManual(opportunity: ArbitrageOpportunity, investmentUSDT: number) {
    return this.enqueue(async () => this.executeOpportunity(opportunity, investmentUSDT, false));
  }

  closeManual(simId: string) {
    return this.enqueue(async () => {
      const result = await this.closePositionInternal(simId);
      return {
        success: !!result,
        result,
        state: this.getState(),
      };
    });
  }

  private recordTrades(events: TradeEvent[]) {
    if (events.length === 0) return;
    appendTrades(events);
    this.routeFailureMemory.ingestEvents(events, { simulation: true });
  }

  private createProbeStateFromEntry(entry: ScheduledSimEntry, now: number): ScheduleProbeState {
    return {
      probeId: entry.probeId,
      opportunityId: entry.opportunityId,
      asset: entry.asset,
      shortExchange: entry.opportunity.shortExchange,
      longExchange: entry.opportunity.longExchange,
      shortSymbol: entry.opportunity.shortSymbol,
      longSymbol: entry.opportunity.longSymbol,
      targetTime: entry.targetTime,
      investmentUSDT: entry.investmentUSDT,
      createdAt: now,
      preMilestones: [],
      postMilestones: [],
      executeCaptured: false,
      executeResultCaptured: false,
      status: 'scheduled',
    };
  }

  private ensureProbeState(entry: ScheduledSimEntry, now: number): ScheduleProbeState {
    const existing = this.scheduleProbeStates.get(entry.probeId);
    if (!existing) {
      const created = this.createProbeStateFromEntry(entry, now);
      this.scheduleProbeStates.set(entry.probeId, created);
      return created;
    }

    if (existing.status === 'canceled' && now < entry.targetTime) {
      existing.status = 'scheduled';
      existing.finalizedAt = undefined;
      existing.lastReason = undefined;
    }

    if (existing.status === 'scheduled') {
      existing.targetTime = entry.targetTime;
      existing.investmentUSDT = entry.investmentUSDT;
      existing.asset = entry.asset;
      existing.shortExchange = entry.opportunity.shortExchange;
      existing.longExchange = entry.opportunity.longExchange;
      existing.shortSymbol = entry.opportunity.shortSymbol;
      existing.longSymbol = entry.opportunity.longSymbol;
      existing.opportunityId = entry.opportunityId;
    }

    this.scheduleProbeStates.set(entry.probeId, existing);
    return existing;
  }

  private resolveProbeRoute(state: ScheduleProbeState): ProbeRoute {
    const live = this.scheduledEntries.get(state.opportunityId)?.opportunity
      ?? this.opportunities.find((candidate) => getOpportunityId(candidate) === state.opportunityId);
    if (live) {
      return {
        baseAsset: live.baseAsset,
        shortExchange: live.shortExchange,
        longExchange: live.longExchange,
        shortSymbol: live.shortSymbol,
        longSymbol: live.longSymbol,
        shortRate: live.shortRate,
        longRate: live.longRate,
        fundingIntervalMs: live.fundingIntervalMs,
        nextFundingTime: live.nextFundingTime,
      };
    }

    return {
      baseAsset: state.asset,
      shortExchange: state.shortExchange,
      longExchange: state.longExchange,
      shortSymbol: state.shortSymbol,
      longSymbol: state.longSymbol,
      shortRate: 0,
      longRate: 0,
      fundingIntervalMs: 8 * 3600000,
      nextFundingTime: state.targetTime,
    };
  }

  private buildScheduleProbeEvent(
    milestone: string,
    route: ProbeRoute,
    investmentUSDT: number,
    now: number,
    options?: {
      pairId?: string;
      status?: ScheduleProbeState['status'];
      timeToExecutionMs?: number;
      reason?: string;
      executedNotional?: number;
    },
  ): TradeEvent {
    const shortLive = this.latestRates.find((rate) => (
      rate.exchange === route.shortExchange && rate.symbol === route.shortSymbol
    ));
    const longLive = this.latestRates.find((rate) => (
      rate.exchange === route.longExchange && rate.symbol === route.longSymbol
    ));
    const shortRate = shortLive?.rate ?? route.shortRate ?? 0;
    const longRate = longLive?.rate ?? route.longRate ?? 0;
    const spread = shortRate - longRate;
    const spreadPercent = spread * 100;

    const notional = Math.max(0, options?.executedNotional ?? investmentUSDT * this.config.leverage);
    const shortFeeRate = resolveRuntimeFee(
      route.shortExchange,
      'taker',
      this.config.feeOverrides,
      this.config.paybackOverrides,
    );
    const longFeeRate = resolveRuntimeFee(
      route.longExchange,
      'taker',
      this.config.feeOverrides,
      this.config.paybackOverrides,
    );
    const totalRoundTripFees = notional * shortFeeRate * 2 + notional * longFeeRate * 2;
    const perFunding = notional * spread;
    const expectedNetProfit = perFunding - totalRoundTripFees;
    const hedgedNetSpreadPercent = calcNetSpreadPercent(
      spreadPercent,
      0,
      (shortFeeRate + longFeeRate) * 2 * 100,
    );
    const expectedRoiPercent = investmentUSDT > 0
      ? (expectedNetProfit / Math.max(1, investmentUSDT * 2)) * 100
      : 0;
    const timeToExecutionMs = options?.timeToExecutionMs;

    return {
      timestamp: now,
      type: 'schedule_probe',
      simulation: true,
      baseAsset: route.baseAsset,
      shortExchange: route.shortExchange,
      longExchange: route.longExchange,
      spread,
      spreadPercent,
      margin: investmentUSDT,
      leverage: this.config.leverage,
      notional,
      perFunding,
      totalRoundTripFees,
      netProfit: expectedNetProfit,
      pairId: options?.pairId,
      reason: options?.reason ?? milestone,
      milestone,
      timeToExecutionMs,
      shortRate,
      longRate,
      hedgedNetSpreadPercent,
      expectedNetProfit,
      expectedRoiPercent,
      detail: [
        `status=${options?.status ?? 'scheduled'}`,
        timeToExecutionMs == null ? null : `tteMs=${Math.round(timeToExecutionMs)}`,
        `shortRate=${shortRate.toFixed(8)}`,
        `longRate=${longRate.toFixed(8)}`,
        `netSpread=${hedgedNetSpreadPercent.toFixed(4)}%`,
        `expNet=${expectedNetProfit.toFixed(6)}`,
        `expRoi=${expectedRoiPercent.toFixed(4)}%`,
      ].filter(Boolean).join(' '),
    };
  }

  private captureScheduledProbeMilestones(now: number) {
    if (this.scheduledEntries.size === 0) return;
    const events: TradeEvent[] = [];

    for (const entry of this.scheduledEntries.values()) {
      const state = this.ensureProbeState(entry, now);
      if (state.status !== 'scheduled') continue;
      const timeToExecutionMs = entry.targetTime - now;
      if (timeToExecutionMs <= 0) continue;

      const uncaptured = PRE_EXECUTION_PROBE_POINTS.filter((point) => (
        !state.preMilestones.includes(point.key) && timeToExecutionMs <= point.thresholdMs
      ));
      if (uncaptured.length === 0) {
        this.scheduleProbeStates.set(state.probeId, state);
        continue;
      }

      const pointsToCapture = state.preMilestones.length === 0
        ? [uncaptured[uncaptured.length - 1]]
        : uncaptured;
      for (const point of pointsToCapture) {
        events.push(this.buildScheduleProbeEvent(
          point.key,
          entry.opportunity,
          entry.investmentUSDT,
          now,
          {
            status: 'scheduled',
            timeToExecutionMs,
          },
        ));
        state.preMilestones.push(point.key);
      }

      this.scheduleProbeStates.set(state.probeId, state);
    }

    if (events.length > 0) {
      this.recordTrades(events);
    }
  }

  private capturePostExecutionProbeMilestones(now: number) {
    if (this.scheduleProbeStates.size === 0) return;
    const events: TradeEvent[] = [];

    for (const state of this.scheduleProbeStates.values()) {
      if (state.status !== 'executed' || !state.executedAt) continue;
      const elapsedMs = now - state.executedAt;
      if (elapsedMs < 0) continue;
      const route = this.resolveProbeRoute(state);

      for (const point of POST_EXECUTION_PROBE_POINTS) {
        if (state.postMilestones.includes(point.key)) continue;
        if (elapsedMs >= point.thresholdMs) {
          events.push(this.buildScheduleProbeEvent(
            point.key,
            route,
            state.investmentUSDT,
            now,
            {
              pairId: state.pairId,
              status: 'executed',
              timeToExecutionMs: state.targetTime - now,
              executedNotional: state.executedNotional,
            },
          ));
          state.postMilestones.push(point.key);
        }
      }

      if (state.postMilestones.length === POST_EXECUTION_PROBE_POINTS.length) {
        state.finalizedAt = state.finalizedAt ?? now;
      }

      this.scheduleProbeStates.set(state.probeId, state);
    }

    if (events.length > 0) {
      this.recordTrades(events);
    }
  }

  private pruneProbeStates(now: number) {
    for (const [probeId, state] of this.scheduleProbeStates.entries()) {
      const finalizedAt = state.finalizedAt
        ?? state.executedAt
        ?? state.targetTime;
      if (now - finalizedAt > PROBE_STATE_RETENTION_MS) {
        this.scheduleProbeStates.delete(probeId);
      }
    }
  }

  private startLoop() {
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
    }
    this.loopInterval = setInterval(() => {
      void this.tick();
    }, LOOP_INTERVAL_MS);
    void this.tick();
  }

  private async tick() {
    if (!this.active || this.ticking) return;
    this.ticking = true;
    try {
      await this.enqueue(async () => {
        if (!this.active) return;
        // Execute due entries first so refresh/rebuild cannot drop matured schedules.
        await this.executeDueEntries();
        if (this.lastRatesUpdate === 0 || Date.now() - this.lastRatesUpdate >= RATES_REFRESH_INTERVAL_MS) {
          await this.refreshRatesAndPlans();
        } else {
          const markedState = this.updatePositionMarks(this.getState());
          this.setState(markedState);
        }
        await this.revalidateScheduledByOrderbook();
        this.captureScheduledProbeMilestones(Date.now());
        await this.executeDueEntries();
        this.capturePostExecutionProbeMilestones(Date.now());
        await this.processFunding();
        await this.processPendingAutoCloses();
        this.pruneProbeStates(Date.now());
        this.saveState();
      });
    } finally {
      this.ticking = false;
    }
  }

  /** Orderbook-based schedule revalidation. Only replaces route when flipped direction is better. */
  private async revalidateScheduledByOrderbook() {
    if (this.scheduledEntries.size === 0) return;

    const now = Date.now();
    const toReplace = new Map<string, ScheduledSimEntry>();

    // ???60珥??댁긽 ?⑥? ?덉빟留??ш?利?(吏곸쟾? executeDueEntries?먯꽌 泥섎━)
    const candidates = Array.from(this.scheduledEntries.entries())
      .filter(([, entry]) => entry.targetTime - now > FINAL_REVALIDATE_GUARD_MS)
      .sort((a, b) => a[1].targetTime - b[1].targetTime);
    if (candidates.length === 0) return;

    // 理쒕? 3媛쒖뵫 諛곗튂濡??ㅻ뜑遺?議고쉶 (API 遺???쒗븳)
    // 怨좎젙 slice(0,3) ???round-robin?쇰줈 ?쒗솚 ?먭??댁꽌 ?꾨씫??諛⑹??쒕떎.
    let batch: Array<[string, ScheduledSimEntry]> = [];
    if (candidates.length <= FULL_REVALIDATE_CAP) {
      batch = candidates;
      this.revalidateCursor = 0;
    } else {
      const urgent = candidates.filter(([, entry]) => entry.targetTime - now <= URGENT_REVALIDATE_WINDOW_MS);
      const regular = candidates.filter(([, entry]) => entry.targetTime - now > URGENT_REVALIDATE_WINDOW_MS);
      const urgentBatch = urgent.slice(0, Math.min(URGENT_REVALIDATE_BATCH_SIZE, urgent.length));

      const regularBudget = Math.max(BASE_REVALIDATE_BATCH_SIZE - urgentBatch.length, 0);
      let regularBatch: Array<[string, ScheduledSimEntry]> = [];
      if (regularBudget > 0 && regular.length > 0) {
        const startIndex = this.revalidateCursor % regular.length;
        regularBatch = Array.from(
          { length: Math.min(regularBudget, regular.length) },
          (_, index) => regular[(startIndex + index) % regular.length],
        );
        this.revalidateCursor = (startIndex + regularBatch.length) % regular.length;
      } else {
        this.revalidateCursor = 0;
      }

      batch = [...urgentBatch, ...regularBatch];
      if (batch.length === 0) {
        batch = candidates.slice(0, Math.min(BASE_REVALIDATE_BATCH_SIZE, candidates.length));
      }
    }

    await Promise.allSettled(batch.map(async ([opportunityId, entry]) => {
      try {
        const notional = entry.investmentUSDT * this.config.leverage;
        if (notional <= 0) return;

        const [shortFill, longFill] = await Promise.all([
          fetchMarketFillPrice(entry.opportunity.shortExchange, entry.opportunity.shortSymbol, 'sell', notional),
          fetchMarketFillPrice(entry.opportunity.longExchange, entry.opportunity.longSymbol, 'buy', notional),
        ]);

        const revalHedgeFeePct = (
          resolveRuntimeFee(entry.opportunity.shortExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides)
          + resolveRuntimeFee(entry.opportunity.longExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides)
        ) * 2 * 100;
        const realNetSpread = calcHedgedNetSpreadPercent(
          entry.opportunity.spreadPercent,
          shortFill.slippagePercent,
          longFill.slippagePercent,
          revalHedgeFeePct,
        );

        if (realNetSpread <= 0) {
          // Keep schedule for due-time adaptive notional retry.
          // Only flip route when reverse direction is already net-positive.
          const flipped = flipOpportunityDirection(entry.opportunity);
          try {
            const [flipShortFill, flipLongFill] = await Promise.all([
              fetchMarketFillPrice(flipped.shortExchange, flipped.shortSymbol, 'sell', notional),
              fetchMarketFillPrice(flipped.longExchange, flipped.longSymbol, 'buy', notional),
            ]);
            const flipHedgeFeePct = (
              resolveRuntimeFee(flipped.shortExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides)
              + resolveRuntimeFee(flipped.longExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides)
            ) * 2 * 100;
            const flippedNetSpread = calcHedgedNetSpreadPercent(
              flipped.spreadPercent,
              flipShortFill.slippagePercent,
              flipLongFill.slippagePercent,
              flipHedgeFeePct,
            );
            if (flippedNetSpread > 0) {
              toReplace.set(opportunityId, {
                ...entry,
                opportunity: flipped,
              });
            }
          } catch {
            // Keep original schedule when flip check fails.
          }
        }
      } catch {
        // ?ㅻ뜑遺?議고쉶 ?ㅽ뙣 ???좎? (?ㅽ뻾 ?쒖젏?먯꽌 ?ㅼ떆 寃利?
      }
    }));

    for (const [opportunityId, nextEntry] of toReplace.entries()) {
      if (!this.scheduledEntries.has(opportunityId)) continue;
      this.scheduledEntries.set(opportunityId, nextEntry);
    }
  }

  private async refreshRatesAndPlans() {
    if (this.config.enabledExchanges.length === 0) {
      this.latestRates = [];
      this.opportunities = [];
      this.scheduledEntries.clear();
      this.lastRatesUpdate = Date.now();
      this.saveState();
      return;
    }

    const results = await Promise.allSettled(
      this.config.enabledExchanges.map((exchange) => fetchFundingRates(exchange)),
    );

    const allRates: FundingRate[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allRates.push(...result.value);
      }
    }

    this.latestRates = allRates;
    this.opportunities = findOpportunities(
      allRates,
      200,
      this.config.investmentUSDT,
      this.config.leverage,
      this.config.feeOverrides,
      this.config.paybackOverrides,
      this.config.minVolume24hUSD,
    );
    this.lastRatesUpdate = Date.now();

    const markedState = this.updatePositionMarks(this.getState());
    this.setState(markedState);
    this.rebuildSchedules(markedState);
    this.saveState();
  }

  private updatePositionMarks(state: SimStateSnapshot) {
    if (state.simPositions.length === 0 || this.latestRates.length === 0) return state;

    let changed = false;
    const nextPositions = state.simPositions.map((position) => {
      const liveRate = this.latestRates.find(
        (rate) => rate.exchange === position.exchange && rate.symbol === position.symbol,
      );
      if (!liveRate) return position;

      const pricePnl = position.side === 'short'
        ? (position.entryPrice - liveRate.markPrice) * position.size
        : (liveRate.markPrice - position.entryPrice) * position.size;
      const unrealizedPnl = pricePnl - (position.entryFee ?? 0);
      const unrealizedPnlPercent = position.margin > 0
        ? (unrealizedPnl / position.margin) * 100
        : 0;

      changed = true;
      return {
        ...position,
        markPrice: liveRate.markPrice,
        fundingRate: liveRate.rate,
        unrealizedPnl,
        unrealizedPnlPercent,
      };
    });

    return changed
      ? {
        ...state,
        simPositions: nextPositions,
      }
      : state;
  }

  private rebuildSchedules(state: SimStateSnapshot) {
    if (!this.active) {
      this.scheduledEntries.clear();
      return;
    }

    const now = Date.now();
    const previousEntries = this.scheduledEntries;
    const timing = this.getTimingConfig();
    const availableBalance = { ...state.simBalances } as Record<string, number>;
    const occupiedLegs = new Set<string>();

    for (const position of state.simPositions) {
      occupiedLegs.add(makePositionLegKey(position.exchange, position.symbol));
    }

    const snipeConfig = this.config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
    const candidates = this.opportunities.filter((opportunity) => {
      if (!this.config.enabledExchanges.includes(opportunity.shortExchange) || !this.config.enabledExchanges.includes(opportunity.longExchange)) {
        return false;
      }
      // v2: Tier C filter
      if (hasTierCExchange(opportunity.shortExchange, opportunity.longExchange)) {
        const tierCEx = opportunity.shortExchange === 'bingx' ? opportunity.shortExchange : opportunity.longExchange;
        if (!this.config.enabledExchanges.includes(tierCEx)) return false;
      }
      if (opportunity.spreadPercent < Math.max(0, this.config.minSpreadPercent)) {
        return false;
      }
      const routeFailureKey = makeRouteFailureKey(
        opportunity.baseAsset,
        opportunity.shortExchange,
        opportunity.longExchange,
      );
      if (this.routeFailureMemory.isBlocked(routeFailureKey, now)) {
        return false;
      }
      if (getOpportunityLegKeys(opportunity).some((legKey) => occupiedLegs.has(legKey))) {
        return false;
      }
      // v2: funding timestamp alignment
      if (snipeConfig.useConfirmedClose) {
        const shortRate = this.latestRates.find(r => r.exchange === opportunity.shortExchange && r.symbol === opportunity.shortSymbol);
        const longRate = this.latestRates.find(r => r.exchange === opportunity.longExchange && r.symbol === opportunity.longSymbol);
        if (shortRate && longRate) {
          const tsDiff = Math.abs(shortRate.nextFundingTime - longRate.nextFundingTime);
          if (tsDiff > MAX_FUNDING_TIMESTAMP_DIFF_MS) return false;
        }
      }
      const profileLeadMs = getPairEntryLeadMs(opportunity.shortExchange, opportunity.longExchange);
      const entryLeadMs = Math.max(profileLeadMs, timing.entryLeadMs);
      const targetTime = opportunity.nextFundingTime - entryLeadMs;
      if (targetTime <= now) {
        return false;
      }
      return targetTime <= now + getScheduleAheadWindowMs(opportunity);
    });

    const plans = planWindowAllocations(
      candidates,
      availableBalance,
      buildStrategyLikeConfig(this.config),
    );

    const nextEntries = new Map<string, ScheduledSimEntry>();
    const canceledProbeEvents: TradeEvent[] = [];
    for (const plan of plans) {
      const opportunityId = getOpportunityId(plan.opportunity);
      const previousEntry = previousEntries.get(opportunityId);
      const profileLead = getPairEntryLeadMs(plan.opportunity.shortExchange, plan.opportunity.longExchange);
      const entryLead = Math.max(profileLead, timing.entryLeadMs);
      const targetTime = plan.opportunity.nextFundingTime - entryLead;
      const probeId = previousEntry && Math.abs(previousEntry.targetTime - targetTime) <= 60_000
        ? previousEntry.probeId
        : makeScheduleProbeId(opportunityId, targetTime);
      nextEntries.set(opportunityId, {
        opportunityId,
        probeId,
        asset: plan.opportunity.baseAsset,
        opportunity: plan.opportunity,
        targetTime,
        investmentUSDT: plan.investmentUSDT,
      });
    }

    for (const entry of nextEntries.values()) {
      this.ensureProbeState(entry, now);
    }

    for (const [opportunityId, previousEntry] of previousEntries.entries()) {
      if (nextEntries.has(opportunityId)) continue;
      const probeState = this.scheduleProbeStates.get(previousEntry.probeId);
      if (!probeState || probeState.status !== 'scheduled') continue;

      probeState.status = 'canceled';
      probeState.finalizedAt = now;
      probeState.lastReason = 'schedule_replanned';
      this.scheduleProbeStates.set(probeState.probeId, probeState);

      const timeToExecutionMs = previousEntry.targetTime - now;
      if (
        probeState.preMilestones.length > 0
        || timeToExecutionMs <= PRE_EXECUTION_PROBE_POINTS[0].thresholdMs
      ) {
        canceledProbeEvents.push(this.buildScheduleProbeEvent(
          'canceled_before_execute',
          previousEntry.opportunity,
          previousEntry.investmentUSDT,
          now,
          {
            status: 'canceled',
            reason: 'schedule_replanned',
            timeToExecutionMs,
          },
        ));
      }
    }

    this.scheduledEntries = nextEntries;
    if (canceledProbeEvents.length > 0) {
      this.recordTrades(canceledProbeEvents);
    }
  }

  private async executeDueEntries() {
    const now = Date.now();
    const dueEntries = Array.from(this.scheduledEntries.values())
      .filter((entry) => entry.targetTime <= now)
      .sort((a, b) => a.targetTime - b.targetTime);

    for (const entry of dueEntries) {
      this.scheduledEntries.delete(entry.opportunityId);
      const probeState = this.ensureProbeState(entry, now);
      if (!probeState.executeCaptured) {
        this.recordTrades([this.buildScheduleProbeEvent(
          'execute',
          entry.opportunity,
          entry.investmentUSDT,
          now,
          {
            status: probeState.status,
            timeToExecutionMs: entry.targetTime - now,
          },
        )]);
        probeState.executeCaptured = true;
        this.scheduleProbeStates.set(probeState.probeId, probeState);
      }
      const latestById = this.opportunities.find(
        (candidate) => getOpportunityId(candidate) === entry.opportunityId,
      );
      const isRouteOverridden = !!latestById
        && (
          latestById.shortExchange !== entry.opportunity.shortExchange
          || latestById.longExchange !== entry.opportunity.longExchange
          || latestById.shortSymbol !== entry.opportunity.shortSymbol
          || latestById.longSymbol !== entry.opportunity.longSymbol
        );
      const primaryOpportunity = isRouteOverridden
        ? entry.opportunity
        : (latestById ?? entry.opportunity);

      const primaryResult = await this.executeOpportunity(primaryOpportunity, entry.investmentUSDT, true);
      if (primaryResult.success) {
        const executedAt = Date.now();
        probeState.executeResultCaptured = true;
        probeState.status = 'executed';
        probeState.executedAt = executedAt;
        probeState.pairId = primaryResult.pairId;
        probeState.executedNotional = primaryResult.executedNotional;
        probeState.lastReason = 'primary_success';
        this.scheduleProbeStates.set(probeState.probeId, probeState);
        this.recordTrades([this.buildScheduleProbeEvent(
          'execute_success',
          primaryOpportunity,
          entry.investmentUSDT,
          executedAt,
          {
            pairId: probeState.pairId,
            status: 'executed',
            reason: 'primary_success',
            timeToExecutionMs: entry.targetTime - executedAt,
            executedNotional: probeState.executedNotional,
          },
        )]);
        continue;
      }

      // 留덉?留?吏꾩엯 吏곸쟾???쒖꽭媛 ?ㅼ쭛?덈뒗 寃쎌슦瑜??鍮꾪빐 諛섎? 諛⑺뼢????踰????쒕룄?쒕떎.
      const flipped = flipOpportunityDirection(primaryOpportunity);
      const flippedResult = await this.executeOpportunity(flipped, entry.investmentUSDT, true);
      if (flippedResult.success) {
        const executedAt = Date.now();
        probeState.executeResultCaptured = true;
        probeState.status = 'executed';
        probeState.executedAt = executedAt;
        probeState.pairId = flippedResult.pairId;
        probeState.executedNotional = flippedResult.executedNotional;
        probeState.lastReason = 'flipped_success';
        this.scheduleProbeStates.set(probeState.probeId, probeState);
        this.recordTrades([this.buildScheduleProbeEvent(
          'execute_success',
          flipped,
          entry.investmentUSDT,
          executedAt,
          {
            pairId: probeState.pairId,
            status: 'executed',
            reason: 'flipped_success',
            timeToExecutionMs: entry.targetTime - executedAt,
            executedNotional: probeState.executedNotional,
          },
        )]);
        continue;
      }

      const failedAt = Date.now();
      const failureReason = mapSimEntryErrorToGuardReason(primaryResult.error);
      probeState.executeResultCaptured = true;
      probeState.status = 'failed';
      probeState.finalizedAt = failedAt;
      probeState.lastReason = failureReason;
      this.scheduleProbeStates.set(probeState.probeId, probeState);

      this.recordTrades([
        this.buildScheduleProbeEvent(
          'execute_failed',
          primaryOpportunity,
          entry.investmentUSDT,
          failedAt,
          {
            status: 'failed',
            reason: failureReason,
            timeToExecutionMs: entry.targetTime - failedAt,
          },
        ),
        {
          timestamp: failedAt,
          type: 'guard_block',
          simulation: true,
          baseAsset: primaryOpportunity.baseAsset,
          shortExchange: primaryOpportunity.shortExchange,
          longExchange: primaryOpportunity.longExchange,
          spread: primaryOpportunity.spread,
          spreadPercent: primaryOpportunity.spreadPercent,
          reason: failureReason,
          detail: `primary:${primaryResult.error ?? 'unknown'} | flipped:${flippedResult.error ?? 'unknown'}`,
        },
      ]);
    }
  }

  private async processFunding() {
    const state = this.getState();
    if (state.simPositions.length === 0) return;

    const now = Date.now();
    const timing = this.getTimingConfig();
    const closeDelayMs = Math.max(0, Math.min(timing.closeDelayMs, 1_000));
    const fundingEvents: FundingPayment[] = [];
    const tradeEvents: Array<Parameters<typeof appendTrades>[0][number]> = [];
    let changed = false;

    const nextPositions = state.simPositions.map((position) => {
      const liveRate = this.latestRates.find(
        (rate) => rate.exchange === position.exchange && rate.symbol === position.symbol,
      );
      const markPrice = liveRate?.markPrice ?? position.markPrice;
      const liveFundingRate = liveRate?.rate ?? position.fundingRate;

      if (position.nextFundingTime > now) {
        const pricePnl = position.side === 'short'
          ? (position.entryPrice - markPrice) * position.size
          : (markPrice - position.entryPrice) * position.size;
        const unrealizedPnl = pricePnl - (position.entryFee ?? 0);
        return {
          ...position,
          markPrice,
          fundingRate: liveFundingRate,
          unrealizedPnl,
          unrealizedPnlPercent: position.margin > 0 ? (unrealizedPnl / position.margin) * 100 : 0,
        };
      }

      const funding = position.side === 'short'
        ? position.sizeUSD * liveFundingRate
        : position.sizeUSD * (-liveFundingRate);
      state.simBalances[position.exchange] = (state.simBalances[position.exchange] ?? 0) + funding;
      state.simTotalFundingEarned += funding;

      const payment: FundingPayment = {
        exchange: position.exchange,
        symbol: position.symbol,
        amount: funding,
        rate: liveFundingRate,
        timestamp: now,
        side: position.side,
      };
      fundingEvents.push(payment);
      tradeEvents.push({
        timestamp: now,
        type: 'funding',
        simulation: true,
        baseAsset: position.baseAsset,
        exchange: position.exchange,
        side: position.side,
        symbol: position.symbol,
        pairId: position.pairId,
        fundingAmount: funding,
        fundingRate: liveFundingRate,
      });
      changed = true;

      const updatedFundingReceived = (position.fundingReceived ?? 0) + 1;
      if (position.isSnipe && position.pairId && updatedFundingReceived >= 1) {
        // v2: confirmed close — model settlement wait window for realistic SIM KPI
        const simSnipeConfig = this.config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
        let settlementWaitMs = closeDelayMs;
        if (simSnipeConfig.useConfirmedClose && position.pairId) {
          const pair = state.simPositions.find(
            p => p.pairId === position.pairId && p.simId !== position.simId,
          );
          if (pair) {
            const shortEx = position.side === 'short' ? position.exchange : pair.exchange;
            const longEx = position.side === 'long' ? position.exchange : pair.exchange;
            settlementWaitMs = getPairMaxSettlementWaitMs(shortEx, longEx);
          }
        }
        const closeAt = Math.max(Date.now(), position.nextFundingTime + settlementWaitMs);
        this.pendingAutoCloses.set(position.pairId, closeAt);
      }

      const pricePnl = position.side === 'short'
        ? (position.entryPrice - markPrice) * position.size
        : (markPrice - position.entryPrice) * position.size;
      const unrealizedPnl = pricePnl - (position.entryFee ?? 0);

      return {
        ...position,
        markPrice,
        fundingRate: liveFundingRate,
        fundingCollected: position.fundingCollected + funding,
        fundingReceived: updatedFundingReceived,
        nextFundingTime: position.nextFundingTime + (position.fundingIntervalMs ?? 8 * 3600 * 1000),
        unrealizedPnl,
        unrealizedPnlPercent: position.margin > 0 ? (unrealizedPnl / position.margin) * 100 : 0,
      };
    });

    if (!changed) return;

    state.simPositions = nextPositions;
    state.fundingHistory = [...fundingEvents, ...state.fundingHistory]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_FUNDING_HISTORY);
    this.setState(state);
    if (tradeEvents.length > 0) {
      this.recordTrades(tradeEvents);
    }
  }

  private async processPendingAutoCloses() {
    const now = Date.now();
    const duePairIds = Array.from(this.pendingAutoCloses.entries())
      .filter(([, closeAt]) => closeAt <= now)
      .map(([pairId]) => pairId);

    for (const pairId of duePairIds) {
      this.pendingAutoCloses.delete(pairId);
      await this.closePair(pairId);
    }
  }

  private async closePair(pairId: string) {
    const state = this.getState();
    const pairPositions = state.simPositions.filter((position) => position.pairId === pairId);
    for (const position of pairPositions) {
      await this.closePositionInternal(position.simId);
    }
  }

  private async closePositionInternal(simId: string): Promise<{ netPnl: number; funding: number; pairId?: string } | null> {
    const state = this.getState();
    const position = state.simPositions.find((candidate) => candidate.simId === simId);
    if (!position) return null;

    let exitPrice = position.markPrice;
    try {
      const fill = await fetchMarketFillPrice(
        position.exchange,
        position.symbol,
        position.side === 'short' ? 'buy' : 'sell',
        position.sizeUSD,
      );
      exitPrice = fill.fillPrice;
    } catch {
      // Use mark price fallback.
    }

    const exitNotional = position.size * exitPrice;
    const exitFee = exitNotional * resolveRuntimeFee(position.exchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides);
    const pricePnl = position.side === 'short'
      ? (position.entryPrice - exitPrice) * position.size
      : (exitPrice - position.entryPrice) * position.size;

    let actualFunding = position.fundingCollected;
    const fundingAlreadyRecorded = position.fundingCollected !== 0;
    let fundingHistory: FundingPayment[] = state.fundingHistory;
    let fundingBalanceCredit = 0;

    if (position.isSnipe && actualFunding === 0) {
      actualFunding = position.side === 'short'
        ? position.sizeUSD * position.fundingRate
        : position.sizeUSD * (-position.fundingRate);
      fundingBalanceCredit = actualFunding;
      state.simTotalFundingEarned += actualFunding;
      const payment: FundingPayment = {
        exchange: position.exchange,
        symbol: position.symbol,
        amount: actualFunding,
        rate: position.fundingRate,
        timestamp: Date.now(),
        side: position.side,
      };
      fundingHistory = [payment, ...fundingHistory].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_FUNDING_HISTORY);
    }

    const returnAmount = position.margin + pricePnl - exitFee;
    const netPnl = pricePnl + actualFunding - (position.entryFee ?? 0) - exitFee;

    state.simPositions = state.simPositions.filter((candidate) => candidate.simId !== simId);
    state.simBalances[position.exchange] = (state.simBalances[position.exchange] ?? 0) + returnAmount + fundingBalanceCredit;
    state.fundingHistory = fundingHistory;
    state.simTotalFees += exitFee;
    state.simTotalClosedPnl += pricePnl;
    state.simClosedPnlPerExchange = {
      ...state.simClosedPnlPerExchange,
      [position.exchange]: (state.simClosedPnlPerExchange[position.exchange] ?? 0) + pricePnl,
    };
    state.simClosedFeesPerExchange = {
      ...state.simClosedFeesPerExchange,
      [position.exchange]: (state.simClosedFeesPerExchange[position.exchange] ?? 0) + (position.entryFee ?? 0) + exitFee,
    };

    this.setState(state);
    if (position.pairId) {
      const remainingPairPositions = state.simPositions.filter((candidate) => candidate.pairId === position.pairId);
      if (remainingPairPositions.length === 0) {
        this.pendingAutoCloses.delete(position.pairId);
      }
    }

    this.recordTrades([
      ...(position.isSnipe && !fundingAlreadyRecorded && actualFunding !== 0
        ? [{
          timestamp: Date.now(),
          type: 'funding' as const,
          simulation: true,
          baseAsset: position.baseAsset,
          exchange: position.exchange,
          side: position.side,
          symbol: position.symbol,
          pairId: position.pairId,
          fundingAmount: actualFunding,
          fundingRate: position.fundingRate,
        }]
        : []),
      {
        timestamp: Date.now(),
        type: position.isSnipe ? 'snipe_exit' : 'exit',
        simulation: true,
        baseAsset: position.baseAsset,
        exchange: position.exchange,
        side: position.side,
        symbol: position.symbol,
        pairId: position.pairId,
        pnl: netPnl,
        fundingAmount: actualFunding,
        exitFee,
        entryFee: position.entryFee ?? 0,
        pricePnl,
      },
    ]);

    return { netPnl, funding: actualFunding, pairId: position.pairId };
  }

  private async executeOpportunity(
    opportunity: ArbitrageOpportunity,
    investmentUSDT: number,
    isSnipe: boolean,
  ): Promise<SimTradeResult> {
    if (!isSnipe && opportunity.spreadPercent < Math.max(0, this.config.minSpreadPercent)) {
      return { success: false, error: 'spread below threshold' };
    }

    const state = this.getState();
    const opportunityLegs = new Set(getOpportunityLegKeys(opportunity));
    const existingPair = state.simPositions.find((position) => {
      const pairKey = getSimPositionOpportunityKey(position, state.simPositions);
      const latestOpportunity = this.opportunities.find(
        (candidate) => getOpportunityId(candidate) === pairKey,
      );
      return latestOpportunity
        ? getOpportunityLegKeys(latestOpportunity).some((legKey) => opportunityLegs.has(legKey))
        : opportunityLegs.has(makePositionLegKey(position.exchange, position.symbol));
    });
    if (existingPair) {
      return { success: false, error: 'position already active for route' };
    }

    // v2: Tier C filter — skip unless explicitly enabled
    if (hasTierCExchange(opportunity.shortExchange, opportunity.longExchange)) {
      const tierCEx = opportunity.shortExchange === 'bingx' ? opportunity.shortExchange : opportunity.longExchange;
      if (!this.config.enabledExchanges.includes(tierCEx)) {
        return { success: false, error: `Tier C exchange ${tierCEx} not enabled` };
      }
    }

    const margin = Math.max(0, investmentUSDT);
    const leverage = this.config.leverage;
    const baseNotional = margin * leverage;
    if (baseNotional <= 0 || opportunity.shortMarkPrice <= 0 || opportunity.longMarkPrice <= 0) {
      return { success: false, error: 'invalid notional or mark price' };
    }

    const snipeConfig = this.config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;

    // v2: dynamic notional based on orderbook depth
    let notional = baseNotional;
    if (snipeConfig.useDynamicNotional) {
      try {
        const [shortOb, longOb] = await Promise.all([
          fetchOrderbook(opportunity.shortExchange, opportunity.shortSymbol, 50),
          fetchOrderbook(opportunity.longExchange, opportunity.longSymbol, 50),
        ]);
        const shortImpact = calcOrderbookImpactBps(shortOb.bids, shortOb.asks, baseNotional, 'sell');
        const longImpact = calcOrderbookImpactBps(longOb.bids, longOb.asks, baseNotional, 'buy');
        notional = Math.min(baseNotional, shortImpact.depthCapNotional, longImpact.depthCapNotional, snipeConfig.dynamicNotionalCap);
        if (notional < 100) {
          return { success: false, error: `depth too shallow: $${notional.toFixed(0)}` };
        }
      } catch (err) {
        return { success: false, error: `orderbook unavailable for dynamic notional: ${(err as Error).message ?? err}` };
      }
    }

    // v2: free margin guard (simulated)
    const shortBal = state.simBalances[opportunity.shortExchange] ?? 0;
    const longBal = state.simBalances[opportunity.longExchange] ?? 0;
    const shortInitial = state.simInitialBalances[opportunity.shortExchange] ?? 1;
    const longInitial = state.simInitialBalances[opportunity.longExchange] ?? 1;
    const shortFreeRatio = shortInitial > 0 ? (shortBal / shortInitial) * 100 : 0;
    const longFreeRatio = longInitial > 0 ? (longBal / longInitial) * 100 : 0;
    if (shortFreeRatio < MIN_FREE_MARGIN_PCT || longFreeRatio < MIN_FREE_MARGIN_PCT) {
      return { success: false, error: `free margin low: ${opportunity.shortExchange}=${shortFreeRatio.toFixed(1)}% ${opportunity.longExchange}=${longFreeRatio.toFixed(1)}%` };
    }

    let shortFillPrice = opportunity.shortMarkPrice;
    let longFillPrice = opportunity.longMarkPrice;
    let shortSlippagePercent = 0;
    let longSlippagePercent = 0;
    const maxSlippagePct = this.config.maxSlippagePercent ?? 1.5;
    const impactCapBps = snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS;
    const minAdaptiveNotional = 100;
    const maxAdaptiveAttempts = 4;
    let fillsValidated = false;
    for (let attempt = 0; attempt < maxAdaptiveAttempts; attempt += 1) {
      let shortFill: Awaited<ReturnType<typeof fetchMarketFillPrice>>;
      let longFill: Awaited<ReturnType<typeof fetchMarketFillPrice>>;
      try {
        [shortFill, longFill] = await Promise.all([
          fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', notional),
          fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', notional),
        ]);
      } catch (err) {
        return { success: false, error: `orderbook fetch failed ??cannot validate slippage: ${(err as Error).message ?? err}` };
      }

      if (snipeConfig.useImpactGuards) {
        const roundTripImpactBps = (shortFill.slippagePercent + longFill.slippagePercent) * 2 * 100;
        if (roundTripImpactBps > impactCapBps) {
          const scale = Math.max(0.2, Math.min(0.98, (impactCapBps / Math.max(roundTripImpactBps, 0.0001)) * 0.97));
          const nextNotional = Math.floor(notional * scale * 100) / 100;
          if (attempt < maxAdaptiveAttempts - 1 && nextNotional >= minAdaptiveNotional && nextNotional < notional - 1) {
            notional = nextNotional;
            continue;
          }
          return { success: false, error: `impact exceeded: ${roundTripImpactBps.toFixed(1)}bps > ${impactCapBps}bps (notional=$${notional.toFixed(2)})` };
        }
      } else {
        const worstSlippage = Math.max(shortFill.slippagePercent, longFill.slippagePercent);
        if (worstSlippage > maxSlippagePct) {
          const scale = Math.max(0.2, Math.min(0.98, (maxSlippagePct / Math.max(worstSlippage, 0.0001)) * 0.97));
          const nextNotional = Math.floor(notional * scale * 100) / 100;
          if (attempt < maxAdaptiveAttempts - 1 && nextNotional >= minAdaptiveNotional && nextNotional < notional - 1) {
            notional = nextNotional;
            continue;
          }
          return {
            success: false,
            error: `slippage exceeded: short=${shortFill.slippagePercent.toFixed(4)}% long=${longFill.slippagePercent.toFixed(4)}% max=${maxSlippagePct}% (notional=$${notional.toFixed(2)})`,
          };
        }
      }

      // Entry-gap drift guard: allow stable basis, block sudden divergence.
      const gapThreshold = snipeConfig.useImpactGuards
        ? impactCapBps / 100
        : maxSlippagePct;
      const entryGap = getEntryGapMetrics({
        shortPrice: shortFill.fillPrice,
        longPrice: longFill.fillPrice,
        baselineShortPrice: opportunity.shortMarkPrice,
        baselineLongPrice: opportunity.longMarkPrice,
      });
      if (entryGap.driftPercent > gapThreshold) {
        return {
          success: false,
          error: `entry gap drift exceeded: ${entryGap.driftPercent.toFixed(4)}% > ${gapThreshold.toFixed(4)}% (live=${entryGap.liveGapPercent.toFixed(4)}% base=${entryGap.baselineGapPercent.toFixed(4)}%)`,
        };
      }
      // v2: hedge ratio pre-check
      if (snipeConfig.useStrictHedge) {
        const shortQtyEst = notional / shortFill.fillPrice;
        const longQtyEst = notional / longFill.fillPrice;
        const hedgeRatio = Math.abs((longQtyEst * longFill.fillPrice) / (shortQtyEst * shortFill.fillPrice));
        if (hedgeRatio < HEDGE_RATIO_MIN || hedgeRatio > HEDGE_RATIO_MAX) {
          return { success: false, error: `hedge ratio ${hedgeRatio.toFixed(6)} outside [${HEDGE_RATIO_MIN}, ${HEDGE_RATIO_MAX}]` };
        }
      }

      shortFillPrice = shortFill.fillPrice;
      longFillPrice = longFill.fillPrice;
      shortSlippagePercent = shortFill.slippagePercent;
      longSlippagePercent = longFill.slippagePercent;
      fillsValidated = true;
      break;
    }
    if (!fillsValidated) {
      return { success: false, error: 'unable to validate entry slippage' };
    }
    // Sign convention: (longFill - shortFill) / shortFill. Positive means worse entry.
    const entryGap = getEntryGapMetrics({
      shortPrice: shortFillPrice,
      longPrice: longFillPrice,
      baselineShortPrice: opportunity.shortMarkPrice,
      baselineLongPrice: opportunity.longMarkPrice,
    });
    const entryGapPercent = entryGap.liveGapPercent;

    // SIM: warn (but don't block) when fee falls back to preset — for KPI accuracy tracking
    const shortFeeInfo = resolveRuntimeFeeDetailed(opportunity.shortExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides);
    const longFeeInfo = resolveRuntimeFeeDetailed(opportunity.longExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides);
    if (shortFeeInfo.source === 'preset' || longFeeInfo.source === 'preset') {
      console.warn(
        `[SIM] fee source fallback: ${opportunity.shortExchange}=${shortFeeInfo.source} ${opportunity.longExchange}=${longFeeInfo.source} — KPI may diverge from REAL`,
      );
    }
    const execHedgeFeePct = (shortFeeInfo.fee + longFeeInfo.fee) * 2 * 100;

    // Conservative EV — always forced ON (matches REAL fail-safe policy)
    {
      const usesInstantRate = pairUsesInstantaneousRate(
        opportunity.shortExchange, opportunity.longExchange,
      );
      const shortDrift = snipeConfig.useDriftBuffer
        ? calcDriftBuffer(opportunity.shortRate, undefined, usesInstantRate)
        : 0;
      const longDrift = snipeConfig.useDriftBuffer
        ? calcDriftBuffer(opportunity.longRate, undefined, usesInstantRate)
        : 0;
      const roundTripFeeDec = execHedgeFeePct / 100;
      const entryImpactDec = (shortSlippagePercent + longSlippagePercent) / 100;
      const ev = calcConservativeEV(
        notional, opportunity.shortRate, opportunity.longRate,
        shortDrift, longDrift, roundTripFeeDec, entryImpactDec, entryImpactDec,
      );
      if (!ev.passesMinProfit || !ev.passesEVRatio) {
        return { success: false, error: `conservative EV failed: $${ev.expectedNetUSD.toFixed(4)} ratio=${ev.evRatio.toFixed(2)}` };
      }
    }

    const shortEntryFee = notional * resolveRuntimeFee(opportunity.shortExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides);
    const longEntryFee = notional * resolveRuntimeFee(opportunity.longExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides);
    const shortCostPerSide = margin + shortEntryFee;
    const longMargin = margin;
    const longCostPerSide = longMargin + longEntryFee;

    const workingBalances = { ...state.simBalances };
    const minBalance = Math.max(0, investmentUSDT);
    for (const [target, required] of [
      [opportunity.shortExchange, shortCostPerSide],
      [opportunity.longExchange, longCostPerSide],
    ] as const) {
      const balance = workingBalances[target] ?? 0;
      if (balance >= required) continue;

      let remaining = Math.max(required - balance, minBalance - balance, 0);
      const donors = Object.entries(workingBalances)
        .filter(([exchange]) => exchange !== target)
        .map(([exchange, donorBalance]) => ({
          exchange: exchange as ExchangeId,
          surplus: Math.max(0, donorBalance - minBalance),
        }))
        .filter((donor) => donor.surplus > 0)
        .sort((a, b) => b.surplus - a.surplus);

      for (const donor of donors) {
        if (remaining <= 0) break;
        const transfer = Math.min(donor.surplus, remaining);
        workingBalances[donor.exchange] = (workingBalances[donor.exchange] ?? 0) - transfer;
        workingBalances[target] = (workingBalances[target] ?? 0) + transfer;
        remaining -= transfer;
      }

      if ((workingBalances[target] ?? 0) < required) {
        return { success: false, error: `insufficient sim balance on ${target}` };
      }
    }

    const timestamp = Date.now();
    const pairId = `sim-pair-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const shortPosition: SimPosition = {
      simId: `sim-${timestamp}-short`,
      pairId,
      exchange: opportunity.shortExchange,
      symbol: opportunity.shortSymbol,
      displaySymbol: `${opportunity.baseAsset}/USDT`,
      baseAsset: opportunity.baseAsset,
      side: 'short',
      size: notional / shortFillPrice,
      sizeUSD: notional,
      entryPrice: shortFillPrice,
      markPrice: opportunity.shortMarkPrice,
      leverage,
      margin,
      unrealizedPnl: -shortEntryFee,
      unrealizedPnlPercent: margin > 0 ? (-shortEntryFee / margin) * 100 : 0,
      liquidationPrice: shortFillPrice * (1 + (1 / leverage) * 0.9),
      fundingRate: opportunity.shortRate,
      openedAt: timestamp,
      positionType: 'hedge_short',
      fundingCollected: 0,
      spread: opportunity.spread,
      nextFundingTime: opportunity.nextFundingTime,
      isSnipe,
      fundingReceived: 0,
      entryFee: shortEntryFee,
      fundingIntervalMs: opportunity.fundingIntervalMs,
      entryGapPercent,
    };
    const longPosition: SimPosition = {
      simId: `sim-${timestamp}-long`,
      pairId,
      exchange: opportunity.longExchange,
      symbol: opportunity.longSymbol,
      displaySymbol: `${opportunity.baseAsset}/USDT`,
      baseAsset: opportunity.baseAsset,
      side: 'long',
      size: notional / longFillPrice,
      sizeUSD: notional,
      entryPrice: longFillPrice,
      markPrice: opportunity.longMarkPrice,
      leverage,
      margin: longMargin,
      unrealizedPnl: -longEntryFee,
      unrealizedPnlPercent: longMargin > 0 ? (-longEntryFee / longMargin) * 100 : 0,
      liquidationPrice: longFillPrice * (1 - (1 / leverage) * 0.9),
      fundingRate: opportunity.longRate,
      openedAt: timestamp,
      positionType: 'hedge_long',
      fundingCollected: 0,
      spread: opportunity.spread,
      nextFundingTime: opportunity.nextFundingTime,
      isSnipe,
      fundingReceived: 0,
      entryFee: longEntryFee,
      fundingIntervalMs: opportunity.fundingIntervalMs,
      entryGapPercent,
    };

    const perFunding = notional * opportunity.shortRate - notional * opportunity.longRate;
    const totalRoundTripFees = notional * resolveRuntimeFee(opportunity.shortExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides) * 2
      + notional * resolveRuntimeFee(opportunity.longExchange, 'taker', this.config.feeOverrides, this.config.paybackOverrides) * 2;
    const netProfit = perFunding - totalRoundTripFees;

    const nextState: SimStateSnapshot = {
      ...state,
      simBalances: {
        ...workingBalances,
        [opportunity.shortExchange]: (workingBalances[opportunity.shortExchange] ?? 0) - shortCostPerSide,
        [opportunity.longExchange]: (workingBalances[opportunity.longExchange] ?? 0) - longCostPerSide,
      },
      simPositions: [...state.simPositions, shortPosition, longPosition],
      simTotalFees: state.simTotalFees + shortEntryFee + longEntryFee,
    };

    const savedState = this.setState(nextState);
    this.recordTrades([
      {
        timestamp,
        type: isSnipe ? 'snipe_entry' : 'entry',
        simulation: true,
        baseAsset: opportunity.baseAsset,
        shortExchange: opportunity.shortExchange,
        longExchange: opportunity.longExchange,
        spread: opportunity.spread,
        spreadPercent: opportunity.spreadPercent,
        margin,
        leverage,
        notional,
        entryFee: shortEntryFee + longEntryFee,
        netProfit,
        perFunding,
        totalRoundTripFees,
        pairId,
      },
    ]);

    return {
      success: true,
      state: savedState,
      pairId,
      executedNotional: notional,
    };
  }
}

export function getServerSimScheduler() {
  return ServerSimScheduler.getInstance();
}

