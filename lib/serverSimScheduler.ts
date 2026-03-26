import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fetchFundingRates, fetchMarketFillPrice } from './exchanges';
import { appendTrades } from './fileLogger';
import {
  findOpportunities,
  getOpportunityHourlyNetProfit,
  getOpportunityId,
  getOpportunityIntervalHours,
  getOpportunityLegKeys,
  makeOpportunityId,
} from './opportunities';
import {
  calcNetSpreadPercent,
  getExchangeFee,
  getHedgeFeesWithOverrides,
  getResolvedTimingConfig,
  sanitizeFeeOverrides,
  sanitizeTimingConfig,
  type ArbitrageOpportunity,
  type ExchangeId,
  type FeeOverrides,
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

const DATA_DIR = join(process.cwd(), 'data');
const STATE_FILE = join(DATA_DIR, 'sim-scheduler-state.json');
const LOOP_INTERVAL_MS = 1_000;
const RATES_REFRESH_INTERVAL_MS = 8_000;
const MAX_FUNDING_HISTORY = 500;

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

function buildStrategyLikeConfig(config: ServerSimSchedulerConfig): StrategyConfig {
  return {
    investmentUSDT: config.investmentUSDT,
    leverage: config.leverage,
    minSpreadPercent: config.minSpreadPercent,
    autoExecute: true,
    compoundInvesting: config.compoundInvesting,
    feeOverrides: config.feeOverrides,
    timingConfig: config.timingConfig,
  };
}

function getOpportunityYieldScore(
  opportunity: ArbitrageOpportunity,
  feeOverrides?: FeeOverrides,
): number {
  const hedgeFeePct = getHedgeFeesWithOverrides(
    opportunity.shortExchange,
    opportunity.longExchange,
    'taker',
    feeOverrides,
  ) * 100;
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
      score: getOpportunityYieldScore(opportunity, strategyConfig.feeOverrides),
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

  const getCap = (opportunity: ArbitrageOpportunity) => {
    const shortAvail = availableBalance[opportunity.shortExchange] ?? 0;
    const longAvail = availableBalance[opportunity.longExchange] ?? 0;
    const maxByBalance = Math.max(0, Math.min(shortAvail, longAvail));
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
    const chunk = Math.min(
      allocationStep,
      getCap(opportunity) - allocated,
      shortAvail,
      longAvail,
    );

    if (chunk < minAllocation) break;

    allocations.set(opportunityId, allocated + chunk);
    availableBalance[opportunity.shortExchange] = Math.max(0, shortAvail - chunk);
    availableBalance[opportunity.longExchange] = Math.max(0, longAvail - chunk);
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
  timingConfig?: TimingConfig;
  maxSlippagePercent?: number; // 최대 슬리피지 % (기본 1.5%)
}

interface ScheduledSimEntry {
  opportunityId: string;
  asset: string;
  opportunity: ArbitrageOpportunity;
  targetTime: number;
  investmentUSDT: number;
}

interface PersistedSimSchedulerState {
  active: boolean;
  config: ServerSimSchedulerConfig;
  startedAt: number | null;
  scheduledEntries: ScheduledSimEntry[];
  pendingAutoCloses: Record<string, number>;
  lastRatesUpdate: number;
}

type SimTradeResult = {
  success: boolean;
  error?: string;
  state?: SimStateSnapshot;
};

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
  private mutationQueue: Promise<void> = Promise.resolve();

  static getInstance() {
    if (!ServerSimScheduler.instance) {
      ServerSimScheduler.instance = new ServerSimScheduler();
    }
    return ServerSimScheduler.instance;
  }

  private constructor() {
    this.loadState();
    if (this.active) {
      this.startLoop();
    }
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
          ? parsed.scheduledEntries.map((entry) => [entry.opportunityId, entry])
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
      this.pendingAutoCloses.clear();
    }
  }

  private getTimingConfig() {
    return getResolvedTimingConfig(this.config.timingConfig);
  }

  private getState() {
    return getOrCreateServerSimState(this.config.enabledExchanges, this.config.investmentUSDT);
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
      await this.refreshRatesAndPlans();
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
        if (this.lastRatesUpdate === 0 || Date.now() - this.lastRatesUpdate >= RATES_REFRESH_INTERVAL_MS) {
          await this.refreshRatesAndPlans();
        } else {
          const markedState = this.updatePositionMarks(this.getState());
          this.setState(markedState);
        }
        await this.revalidateScheduledByOrderbook();
        await this.executeDueEntries();
        await this.processFunding();
        await this.processPendingAutoCloses();
        this.saveState();
      });
    } finally {
      this.ticking = false;
    }
  }

  /** ★ 오더북 기반 예약 재검증 — 실측 수익성 미달 시 예약 해제 */
  private async revalidateScheduledByOrderbook() {
    if (this.scheduledEntries.size === 0) return;

    const now = Date.now();
    const toRemove: string[] = [];

    // 펀딩 60초 이상 남은 예약만 재검증 (직전은 executeDueEntries에서 처리)
    const candidates = Array.from(this.scheduledEntries.entries())
      .filter(([, entry]) => entry.targetTime - now > 60_000);

    // 최대 3개씩 배치로 오더북 조회 (API 부하 제한)
    const batch = candidates.slice(0, 3);

    await Promise.allSettled(batch.map(async ([opportunityId, entry]) => {
      try {
        const notional = entry.investmentUSDT * this.config.leverage;
        if (notional <= 0) return;

        const [shortFill, longFill] = await Promise.all([
          fetchMarketFillPrice(entry.opportunity.shortExchange, entry.opportunity.shortSymbol, 'sell', notional),
          fetchMarketFillPrice(entry.opportunity.longExchange, entry.opportunity.longSymbol, 'buy', notional),
        ]);

        const entryGapPct = ((longFill.fillPrice - shortFill.fillPrice) / shortFill.fillPrice) * 100;
        const hedgeFeePct = getHedgeFeesWithOverrides(
          entry.opportunity.shortExchange,
          entry.opportunity.longExchange,
          'taker',
          this.config.feeOverrides,
        ) * 100;
        const realNetSpread = calcNetSpreadPercent(entry.opportunity.spreadPercent, entryGapPct, hedgeFeePct);

        if (realNetSpread <= 0) {
          toRemove.push(opportunityId);
        }
      } catch {
        // 오더북 조회 실패 시 유지 (실행 시점에서 다시 검증)
      }
    }));

    for (const id of toRemove) {
      this.scheduledEntries.delete(id);
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
    const timing = this.getTimingConfig();
    const availableBalance = { ...state.simBalances } as Record<string, number>;
    const occupiedLegs = new Set<string>();

    for (const position of state.simPositions) {
      occupiedLegs.add(makePositionLegKey(position.exchange, position.symbol));
    }

    const candidates = this.opportunities.filter((opportunity) => {
      if (!this.config.enabledExchanges.includes(opportunity.shortExchange) || !this.config.enabledExchanges.includes(opportunity.longExchange)) {
        return false;
      }
      if (opportunity.spreadPercent < Math.max(0, this.config.minSpreadPercent)) {
        return false;
      }
      if (getOpportunityLegKeys(opportunity).some((legKey) => occupiedLegs.has(legKey))) {
        return false;
      }
      const targetTime = opportunity.nextFundingTime - timing.entryLeadMs;
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
    for (const plan of plans) {
      const opportunityId = getOpportunityId(plan.opportunity);
      nextEntries.set(opportunityId, {
        opportunityId,
        asset: plan.opportunity.baseAsset,
        opportunity: plan.opportunity,
        targetTime: plan.opportunity.nextFundingTime - timing.entryLeadMs,
        investmentUSDT: plan.investmentUSDT,
      });
    }

    this.scheduledEntries = nextEntries;
  }

  private async executeDueEntries() {
    const now = Date.now();
    const dueEntries = Array.from(this.scheduledEntries.values())
      .filter((entry) => entry.targetTime <= now)
      .sort((a, b) => a.targetTime - b.targetTime);

    for (const entry of dueEntries) {
      this.scheduledEntries.delete(entry.opportunityId);
      const opportunity = this.opportunities.find(
        (candidate) => getOpportunityId(candidate) === entry.opportunityId,
      ) ?? entry.opportunity;
      await this.executeOpportunity(opportunity, entry.investmentUSDT, true);
    }
  }

  private async processFunding() {
    const state = this.getState();
    if (state.simPositions.length === 0) return;

    const now = Date.now();
    const timing = this.getTimingConfig();
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
        this.pendingAutoCloses.set(position.pairId, position.nextFundingTime + timing.closeDelayMs);
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
      appendTrades(tradeEvents);
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
    const exitFee = exitNotional * getExchangeFee(position.exchange, 'taker', this.config.feeOverrides);
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

    appendTrades([
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
    if (opportunity.spreadPercent < Math.max(0, this.config.minSpreadPercent)) {
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
        : makePositionLegKey(position.exchange, position.symbol) === `${position.exchange}:${position.symbol}`;
    });
    if (existingPair) {
      return { success: false, error: 'position already active for route' };
    }

    const margin = Math.max(0, investmentUSDT);
    const leverage = this.config.leverage;
    const notional = margin * leverage;
    if (notional <= 0 || opportunity.shortMarkPrice <= 0 || opportunity.longMarkPrice <= 0) {
      return { success: false, error: 'invalid notional or mark price' };
    }

    let shortFillPrice = opportunity.shortMarkPrice;
    let longFillPrice = opportunity.longMarkPrice;
    try {
      const [shortFill, longFill] = await Promise.all([
        fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', notional),
        fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', notional),
      ]);

      // ★ 슬리피지 하드캡 — 설정값 사용 (기본 1.5%)
      const MAX_SLIPPAGE_PCT = this.config.maxSlippagePercent ?? 1.5;
      if (shortFill.slippagePercent > MAX_SLIPPAGE_PCT || longFill.slippagePercent > MAX_SLIPPAGE_PCT) {
        return {
          success: false,
          error: `slippage exceeded: short=${shortFill.slippagePercent.toFixed(4)}% long=${longFill.slippagePercent.toFixed(4)}% max=${MAX_SLIPPAGE_PCT}%`,
        };
      }

      shortFillPrice = shortFill.fillPrice;
      longFillPrice = longFill.fillPrice;
    } catch {
      // Fall back to mark prices.
    }

    // ★ 부호 통일: (longFill - shortFill) / shortFill — 양수 = 진입 손실 (execute route/클라이언트와 동일)
    const entryGapPercent = ((longFillPrice - shortFillPrice) / shortFillPrice) * 100;
    let adjustedLongNotional = notional;
    if (Math.abs(entryGapPercent) > 0.1) {
      adjustedLongNotional = notional * (longFillPrice / shortFillPrice);
    }

    const hedgeFeePct = getHedgeFeesWithOverrides(
      opportunity.shortExchange,
      opportunity.longExchange,
      'taker',
      this.config.feeOverrides,
    ) * 100;
    const realNetSpread = calcNetSpreadPercent(opportunity.spreadPercent, entryGapPercent, hedgeFeePct);
    if (realNetSpread <= 0) {
      return { success: false, error: 'real net spread not profitable' };
    }

    const shortEntryFee = notional * getExchangeFee(opportunity.shortExchange, 'taker', this.config.feeOverrides);
    const longEntryFee = adjustedLongNotional * getExchangeFee(opportunity.longExchange, 'taker', this.config.feeOverrides);
    const shortCostPerSide = margin + shortEntryFee;
    const longMargin = adjustedLongNotional / leverage;
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
      size: adjustedLongNotional / longFillPrice,
      sizeUSD: adjustedLongNotional,
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

    const perFunding = notional * opportunity.shortRate - adjustedLongNotional * opportunity.longRate;
    const totalRoundTripFees = notional * getExchangeFee(opportunity.shortExchange, 'taker', this.config.feeOverrides) * 2
      + adjustedLongNotional * getExchangeFee(opportunity.longExchange, 'taker', this.config.feeOverrides) * 2;
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
    appendTrades([
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

    return { success: true, state: savedState };
  }
}

export function getServerSimScheduler() {
  return ServerSimScheduler.getInstance();
}
