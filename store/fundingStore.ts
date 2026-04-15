'use client';

import { create } from 'zustand';
import type {
  FundingRate,
  ArbitrageOpportunity,
  Position,
  SimPosition,
  Balance,
  ApiConfig,
  StrategyConfig,
  LogEntry,
  LogLevel,
  ExchangeId,
  FundingPayment,
  OrderLiquidity,
  SimStateSnapshot,
  SnipeStateSnapshot,
} from '@/lib/types';
import { OPERABLE_EXCHANGES, SUPPORTED_EXCHANGES, isExchangeOperable, sanitizeEnabledExchanges } from '@/lib/types';
import {
  saveApiConfigs,
  loadApiConfigs,
  saveEnabledExchanges,
  loadEnabledExchanges,
  saveStrategyConfig,
  loadStrategyConfig,
  saveLogs,
  loadLogs,
  saveFundingHistory,
  loadFundingHistory,
  saveSimState,
  loadSimState,
  clearSimState,
  saveSimMode,
  loadSimMode,
  saveRealPositionMeta,
  loadRealPositionMeta,
  saveSimHistoryResetAt,
  loadSimHistoryResetAt,
  saveRealHistoryResetAt,
  loadRealHistoryResetAt,
} from '@/lib/keyStore';
import {
  estimateProfit,
  findOpportunities,
  getOpportunityId,
  getOpportunityIntervalHours,
  getOpportunityLegKeys,
  makeOpportunityId,
} from '@/lib/opportunities';
import {
  buildBalanceEqualizationPlan,
  getBalanceEqualizationPlanningBalances,
  getOpportunityBalanceEqualizationMultiplier,
  type BalanceEqualizationPlan,
} from '@/lib/balanceEqualization';
import { fmtNum } from '@/lib/format';
import {
  RATES_POLL_INTERVAL_MS,
  SNIPE_CHECK_INTERVAL_MS,
  SIM_SYNC_INTERVAL_MS,
  POSITIONS_POLL_INTERVAL_MS,
} from '@/lib/polling';
import { sendTelegramMessage, formatBalanceWarning, formatSnipeCompleteAlert } from '@/lib/telegram';
import {
  DEFAULT_TIMING_CONFIG,
  getHedgeFeesWithOverrides,
  getExchangeFee,
  calcNetSpreadPercent,
  calcHedgedNetSpreadPercent,
  SAFETY_MARGIN_PCT,
  getResolvedTimingConfig,
  sanitizeFeeOverrides,
  sanitizePaybackOverrides,
  sanitizeTimingConfig,
} from '@/lib/types';

// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
// Fee constants (fallback for contexts without exchange info)
// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
const TAKER_FEE_FALLBACK = 0.00048; // 0.048% referral-max worst-case fallback (bitget taker)

function getHistoryResetAtForMode(simulationMode: boolean): number {
  return simulationMode ? loadSimHistoryResetAt() : loadRealHistoryResetAt();
}
let _lastScheduleDiagAt = 0; // 진단 로그 ?�팸 방�?

/** ?�버 ?��?줄러 ?��? ???�시??2?? ?�패 ??경고 로그 */
async function stopServerScheduler(addLog?: (level: LogLevel, msg: string, exchange?: ExchangeId, detail?: string) => void): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('/api/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      if (res.ok) return true;
    } catch { /* retry */ }
    if (attempt < 2) await new Promise(r => setTimeout(r, 1_000));
  }
  addLog?.('error', '[?��?줄러] ?�버 ?��?줄러 ?��? ?�패 (3???�시?? ???�동 ?�인 ?�요');
  return false;
}
let _lastBalanceWarnAt = 0;  // ?�레그램 ?�고 경고 쿨다??(30�?
// 최소 ?�프?�드???�용???�정값을 그�?�??�고,
// ?�제 ?�익???�단?� 거래?�별 ?�수�?override�?반영??계산?�으�?처리?�다.
function getEffectiveMinSpread(config: { minSpreadPercent: number }): number {
  return Math.max(0, config.minSpreadPercent);
}

function getConfiguredHedgeFees(
  config: Pick<StrategyConfig, 'feeOverrides' | 'paybackOverrides'>,
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
  orderType: 'taker' | 'maker' = 'taker',
): number {
  return getHedgeFeesWithOverrides(
    shortExchange,
    longExchange,
    orderType,
    config.feeOverrides,
    config.paybackOverrides,
  );
}

function getConfiguredExchangeFee(
  config: Pick<StrategyConfig, 'feeOverrides' | 'paybackOverrides'>,
  exchange: ExchangeId,
  orderType: 'taker' | 'maker' = 'taker',
): number {
  return getExchangeFee(exchange, orderType, config.feeOverrides, config.paybackOverrides);
}

function getResolvedStrategyConfig(config: StrategyConfig): StrategyConfig {
  return {
    ...config,
    feeOverrides: sanitizeFeeOverrides(config.feeOverrides),
    paybackOverrides: sanitizePaybackOverrides(config.paybackOverrides),
    timingConfig: getResolvedTimingConfig(sanitizeTimingConfig(config.timingConfig)),
  };
}

function getOpportunityResultLimit(activeModes: {
  simSnipeActive: boolean;
  realSnipeActive: boolean;
}): number {
  return (activeModes.simSnipeActive || activeModes.realSnipeActive) ? 200 : 20;
}

function buildOpportunitiesFromRates(
  rates: FundingRate[],
  config: Pick<StrategyConfig, 'investmentUSDT' | 'leverage' | 'feeOverrides' | 'paybackOverrides' | 'minVolume24hUSD'>,
  activeModes: {
    simSnipeActive: boolean;
    realSnipeActive: boolean;
  },
): ArbitrageOpportunity[] {
  return findOpportunities(
    rates,
    getOpportunityResultLimit(activeModes),
    config.investmentUSDT,
    config.leverage,
    config.feeOverrides,
    config.paybackOverrides,
    config.minVolume24hUSD,
  );
}

function rebuildRealSpreadsForConfig(
  currentSpreads: Record<string, RealSpreadSnapshot>,
  opportunities: ArbitrageOpportunity[],
  strategyConfig: Pick<StrategyConfig, 'feeOverrides' | 'paybackOverrides'>,
): Record<string, RealSpreadSnapshot> {
  if (Object.keys(currentSpreads).length === 0) return currentSpreads;

  const opportunitiesById = new Map(
    opportunities.map((opportunity) => [getOpportunityId(opportunity), opportunity]),
  );

  const next: Record<string, RealSpreadSnapshot> = {};
  for (const [key, spread] of Object.entries(currentSpreads)) {
    const opportunity = opportunitiesById.get(key);
    if (!opportunity) {
      next[key] = spread;
      continue;
    }

    const hedgeFeePct = getConfiguredHedgeFees(
      strategyConfig,
      opportunity.shortExchange,
      opportunity.longExchange,
      'taker',
    ) * 100;
    next[key] = {
      ...spread,
      effectiveSpread: calcHedgedNetSpreadPercent(
        opportunity.spreadPercent,
        spread.shortSlippage,
        spread.longSlippage,
        hedgeFeePct,
        0, // ?�시?? ?�전마진 미포??
      ),
    };
  }

  return next;
}

export function buildSchedulerConfig(
  strategyConfig: StrategyConfig,
  enabledExchanges: ExchangeId[],
) {
  return {
    investmentUSDT: strategyConfig.investmentUSDT,
    leverage: strategyConfig.leverage,
    minSpreadPercent: strategyConfig.minSpreadPercent,
    compoundInvesting: strategyConfig.compoundInvesting,
    enabledExchanges: sanitizeEnabledExchanges(enabledExchanges),
    maxConcurrentPairs: 5,
    feeOverrides: strategyConfig.feeOverrides,
    paybackOverrides: strategyConfig.paybackOverrides,
    timingConfig: getResolvedTimingConfig(strategyConfig.timingConfig),
    maxSlippagePercent: strategyConfig.maxSlippagePercent,
    minVolume24hUSD: strategyConfig.minVolume24hUSD,
    confirmedSnipeConfig: strategyConfig.confirmedSnipeConfig,
  };
}

async function syncServerSchedulerConfig(
  strategyConfig: StrategyConfig,
  enabledExchanges: ExchangeId[],
  addLog: (level: LogLevel, message: string, exchange?: ExchangeId, detail?: string) => void,
) {
  try {
    const response = await fetch('/api/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update',
        config: buildSchedulerConfig(strategyConfig, enabledExchanges),
      }),
    });

    const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
  } catch (error) {
    addLog(
      'error',
      '[?��?줄러] ?�정 ?�기???�패',
      undefined,
      (error as Error).message,
    );
  }
}

export function buildServerSimSchedulerConfig(
  strategyConfig: StrategyConfig,
  enabledExchanges: ExchangeId[],
) {
  return {
    investmentUSDT: strategyConfig.investmentUSDT,
    leverage: strategyConfig.leverage,
    minSpreadPercent: strategyConfig.minSpreadPercent,
    compoundInvesting: strategyConfig.compoundInvesting,
    enabledExchanges: sanitizeEnabledExchanges(enabledExchanges),
    feeOverrides: strategyConfig.feeOverrides,
    paybackOverrides: strategyConfig.paybackOverrides,
    timingConfig: getResolvedTimingConfig(strategyConfig.timingConfig),
    maxSlippagePercent: strategyConfig.maxSlippagePercent,
    minVolume24hUSD: strategyConfig.minVolume24hUSD,
    confirmedSnipeConfig: strategyConfig.confirmedSnipeConfig,
  };
}

async function syncServerSimSchedulerConfig(
  strategyConfig: StrategyConfig,
  enabledExchanges: ExchangeId[],
  addLog: (level: LogLevel, message: string, exchange?: ExchangeId, detail?: string) => void,
) {
  try {
    const response = await fetch('/api/sim-scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update',
        config: buildServerSimSchedulerConfig(strategyConfig, enabledExchanges),
      }),
    });

    const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
  } catch (error) {
    addLog(
      'error',
      '[SIM Scheduler] ?�정 ?�기???�패',
      undefined,
      (error as Error).message,
    );
  }
}

function buildEmptySimState(): SimStateSnapshot {
  const simBalances = {} as Record<ExchangeId, number>;
  const simInitialBalances = {} as Record<ExchangeId, number>;
  for (const exchange of SUPPORTED_EXCHANGES) {
    simBalances[exchange] = 0;
    simInitialBalances[exchange] = 0;
  }
  return {
    simBalances,
    simInitialBalances,
    simPositions: [],
    simTotalFundingEarned: 0,
    simTotalTopUps: 0,
    simTotalFees: 0,
    simTotalClosedPnl: 0,
    simClosedPnlPerExchange: {},
    simClosedFeesPerExchange: {},
    fundingHistory: [],
    updatedAt: Date.now(),
  };
}

function buildExchangeAllocationMap(
  perExchange: number,
  enabledExchanges: ExchangeId[],
): Record<ExchangeId, number> {
  const normalizedEnabled = new Set(sanitizeEnabledExchanges(enabledExchanges));
  const balances = {} as Record<ExchangeId, number>;
  for (const exchange of SUPPORTED_EXCHANGES) {
    balances[exchange] = normalizedEnabled.has(exchange) ? perExchange : 0;
  }
  return balances;
}

/** server state snapshot has real data (not defaults) */
function snapshotHasRealData(state: SimStateSnapshot): boolean {
  return state.simPositions.length > 0
    || state.fundingHistory.length > 0
    || state.simTotalFundingEarned !== 0
    || state.simTotalTopUps !== 0
    || state.simTotalFees !== 0
    || state.simTotalClosedPnl !== 0
    || SUPPORTED_EXCHANGES.some((exchange) => (
      (state.simBalances[exchange] ?? 0) > 0
      || (state.simInitialBalances[exchange] ?? 0) > 0
    ));
}

function applyServerSimStateSnapshot(
  setState: (partial: Partial<FundingState>) => void,
  snapshot?: SimStateSnapshot | null,
  options?: { force?: boolean; getState?: () => FundingState },
) {
  if (!snapshot) return;

  if (!options?.force && options?.getState) {
    const local = options.getState();
    const localHasData = local.simPositions.length > 0
      || local.fundingHistory.length > 0
      || local.simTotalFundingEarned !== 0
      || local.simTotalTopUps !== 0
      || local.simTotalFees !== 0
      || local.simTotalClosedPnl !== 0
      || SUPPORTED_EXCHANGES.some((exchange) => (
        (local.simBalances[exchange] ?? 0) > 0
        || (local.simInitialBalances[exchange] ?? 0) > 0
      ));
    if (localHasData && !snapshotHasRealData(snapshot)) {
      return;
    }
  }

  setState({
    simBalances: snapshot.simBalances,
    simInitialBalances: snapshot.simInitialBalances,
    simPositions: snapshot.simPositions,
    simTotalFundingEarned: snapshot.simTotalFundingEarned,
    simTotalTopUps: snapshot.simTotalTopUps,
    simTotalFees: snapshot.simTotalFees,
    simTotalClosedPnl: snapshot.simTotalClosedPnl,
    simClosedPnlPerExchange: snapshot.simClosedPnlPerExchange as Partial<Record<ExchangeId, number>>,
    simClosedFeesPerExchange: snapshot.simClosedFeesPerExchange as Partial<Record<ExchangeId, number>>,
    fundingHistory: snapshot.fundingHistory,
  });
}

async function fetchServerSimStateSnapshot() {
  const response = await fetch('/api/sim-state');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json() as { success?: boolean; data?: SimStateSnapshot; error?: string };
  if (!payload.success || !payload.data) {
    throw new Error(payload.error || 'failed to load sim state');
  }
  return payload.data;
}

async function fetchServerSimSchedulerStatus() {
  const response = await fetch('/api/sim-scheduler');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<{
    active?: boolean;
    snipeTargets?: Record<string, number>;
    snipeAllocations?: Record<string, number>;
    state?: SimStateSnapshot;
  }>;
}

/** 복리/?�리???�른 ?�제 notional 계산 */
function getEffectiveNotional(
  opp: { shortExchange: ExchangeId; longExchange: ExchangeId },
  config: { investmentUSDT: number; leverage: number; compoundInvesting: boolean },
  simBalances: Record<string, number>,
  realBalances: Partial<Record<ExchangeId, { availableUSDT?: number }>>,
  isSimulation: boolean,
  investmentOverrideUSDT?: number,
): number {
  const shortBal = isSimulation
    ? (simBalances[opp.shortExchange] ?? 0)
    : (realBalances[opp.shortExchange]?.availableUSDT ?? 0);
  const longBal = isSimulation
    ? (simBalances[opp.longExchange] ?? 0)
    : (realBalances[opp.longExchange]?.availableUSDT ?? 0);
  const minPerSideBalance = Math.max(0, Math.min(shortBal, longBal));
  if (minPerSideBalance <= 0) return 0;
  const targetPerSide = investmentOverrideUSDT ?? config.investmentUSDT;
  const cappedPerSide = config.compoundInvesting
    ? Math.min(targetPerSide, minPerSideBalance * 0.9)
    : Math.min(targetPerSide, minPerSideBalance);
  const perSide = Math.max(cappedPerSide, 0);
  return Math.max(perSide, 0) * config.leverage;
}

function applySharedSnipeStateSnapshot(
  setState: (partial: Partial<FundingState>) => void,
  snapshot?: SnipeStateSnapshot | null,
  options?: { includeActives?: boolean },
) {
  if (!snapshot) return;
  const includeActives = options?.includeActives ?? true;
  setState(
    includeActives
      ? {
        simulationMode: snapshot.simulationMode,
        simSnipeActive: snapshot.simSnipeActive,
        realSnipeActive: snapshot.realSnipeActive,
      }
      : {
        simulationMode: snapshot.simulationMode,
      },
  );
}

async function fetchSharedSnipeStateSnapshot() {
  const response = await fetch('/api/snipe-state');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json() as { success?: boolean; data?: SnipeStateSnapshot; error?: string };
  if (!payload.success || !payload.data) {
    throw new Error(payload.error || 'failed to load shared snipe state');
  }
  return payload.data;
}

async function updateSharedSnipeStateSnapshot(partial: Partial<SnipeStateSnapshot>) {
  const response = await fetch('/api/snipe-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json() as { success?: boolean; data?: SnipeStateSnapshot; error?: string };
  if (!payload.success || !payload.data) {
    throw new Error(payload.error || 'failed to update shared snipe state');
  }
  return payload.data;
}

function getScheduleAheadWindowMs(opportunity: Pick<ArbitrageOpportunity, 'fundingIntervalMs'>): number {
  const DEFAULT_AHEAD_MS = 5 * 60 * 60 * 1000;
  const fundingWindowMs = opportunity.fundingIntervalMs ?? 8 * 60 * 60 * 1000;
  return Math.max(DEFAULT_AHEAD_MS, fundingWindowMs);
}

function makePositionKey(
  exchange: ExchangeId,
  symbol: string,
  side: 'long' | 'short',
): string {
  return `${exchange}:${symbol}:${side}`;
}

function getPositionLegKeys(position: {
  exchange: ExchangeId;
  symbol: string;
  side: 'long' | 'short';
}): string[] {
  return [
    makePositionKey(position.exchange, position.symbol, position.side),
    `${position.exchange}:${position.symbol}`,
  ];
}

type RealSpreadSnapshot = {
  effectiveSpread: number;
  shortSlippage: number;
  longSlippage: number;
  entryGapPct: number;
  shortFillPrice: number;
  longFillPrice: number;
  updatedAt: number;
};

function getRealSpreadForOpportunity(
  spreads: Record<string, RealSpreadSnapshot>,
  opportunity: ArbitrageOpportunity,
): RealSpreadSnapshot | undefined {
  return spreads[getOpportunityId(opportunity)] ?? spreads[opportunity.baseAsset];
}

function findOpportunityById(
  opportunities: ArbitrageOpportunity[],
  opportunityId: string,
): ArbitrageOpportunity | undefined {
  return opportunities.find((opportunity) => getOpportunityId(opportunity) === opportunityId);
}

function getPositionOpportunityKey(
  baseAsset: string,
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
  fundingIntervalMs?: number,
): string {
  return makeOpportunityId(
    baseAsset,
    shortExchange,
    longExchange,
    fundingIntervalMs ?? 8 * 3600000,
  );
}

function getSimPositionOpportunityKey(
  position: Pick<SimPosition, 'baseAsset' | 'exchange' | 'side' | 'pairId' | 'fundingIntervalMs' | 'simId'>,
  positions: Array<Pick<SimPosition, 'exchange' | 'side' | 'pairId' | 'fundingIntervalMs' | 'simId'>>,
): string {
  const pair = position.pairId
    ? positions.find((candidate) => candidate.pairId === position.pairId && candidate.simId !== position.simId)
    : undefined;
  const shortExchange = position.side === 'short'
    ? position.exchange
    : pair?.exchange ?? position.exchange;
  const longExchange = position.side === 'long'
    ? position.exchange
    : pair?.exchange ?? position.exchange;
  return getPositionOpportunityKey(
    position.baseAsset,
    shortExchange,
    longExchange,
    position.fundingIntervalMs ?? pair?.fundingIntervalMs,
  );
}

function getOpportunityYieldScore(
  opportunity: ArbitrageOpportunity,
  spread?: RealSpreadSnapshot,
  strategyConfig?: StrategyConfig,
): number {
  const cfg = strategyConfig;
  if (!cfg) return 0;
  const hasRealSpread = !!spread;
  const effectiveOpp = hasRealSpread
    ? { ...opportunity, spread: spread.effectiveSpread / 100, spreadPercent: spread.effectiveSpread }
    : opportunity;
  const profit = estimateProfit(effectiveOpp, cfg.investmentUSDT, cfg.leverage, {
    skipFees: hasRealSpread,
    feeOverrides: cfg.feeOverrides,
    paybackOverrides: cfg.paybackOverrides,
    useDriftBuffer: cfg.confirmedSnipeConfig?.useDriftBuffer,
  });
  if (profit.netPerFunding <= 0) return 0;
  if (!hasRealSpread && (!profit.conservativeEV.passesMinProfit || !profit.conservativeEV.passesEVRatio)) {
    return 0;
  }
  return Math.max(0, profit.netPerFunding / getOpportunityIntervalHours(opportunity));
}

function opportunityConflictsWithLegs(
  opportunity: ArbitrageOpportunity,
  occupiedLegs: Set<string>,
): boolean {
  return getOpportunityLegKeys(opportunity).some((legKey) => occupiedLegs.has(legKey));
}

type PlannedSnipeAllocation = {
  opportunity: ArbitrageOpportunity;
  investmentUSDT: number;
};

function planWindowAllocations(
  opportunities: ArbitrageOpportunity[],
  availableBalance: Record<string, number>,
  strategyConfig: StrategyConfig,
  realSpreads: Record<string, RealSpreadSnapshot>,
  planningBalance?: Record<string, number>,
  balancePlan?: BalanceEqualizationPlan,
): PlannedSnipeAllocation[] {
  const effectiveBalance = planningBalance ? { ...planningBalance } : availableBalance;
  const candidates = opportunities
    .map((opportunity) => ({
        opportunity,
        score: (
          getOpportunityYieldScore(
            opportunity,
            getRealSpreadForOpportunity(realSpreads, opportunity),
            strategyConfig,
          ) * getOpportunityBalanceEqualizationMultiplier(balancePlan, opportunity)
        ),
      }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.opportunity.nextFundingTime - b.opportunity.nextFundingTime;
    });

  const occupiedLegs = new Set<string>();
  const selected = candidates.filter((candidate) => {
    if (opportunityConflictsWithLegs(candidate.opportunity, occupiedLegs)) return false;
    getOpportunityLegKeys(candidate.opportunity).forEach((legKey) => occupiedLegs.add(legKey));
    return true;
  });

  if (selected.length === 0) return [];

  const allocations = new Map<string, number>();
  const allocationStep = Math.max(25, Math.min(strategyConfig.investmentUSDT / 5, 250));
  const minAllocation = Math.min(Math.max(10, strategyConfig.investmentUSDT * 0.1), allocationStep);
  const getCostFactor = (exchange: ExchangeId) => (
    1 + (strategyConfig.leverage * getConfiguredExchangeFee(strategyConfig, exchange, 'taker'))
  );

  const getCap = (opportunity: ArbitrageOpportunity) => {
    const shortAvail = effectiveBalance[opportunity.shortExchange] ?? 0;
    const longAvail = effectiveBalance[opportunity.longExchange] ?? 0;
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
    const effectiveShortAvail = effectiveBalance[opportunity.shortExchange] ?? 0;
    const effectiveLongAvail = effectiveBalance[opportunity.longExchange] ?? 0;
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
    effectiveBalance[opportunity.shortExchange] = Math.max(0, effectiveShortAvail - shortCost);
    effectiveBalance[opportunity.longExchange] = Math.max(0, effectiveLongAvail - longCost);
    totalAllocated += chunk;
  }

  return selected
    .map((candidate) => ({
      opportunity: candidate.opportunity,
      investmentUSDT: allocations.get(getOpportunityId(candidate.opportunity)) ?? 0,
    }))
    .filter((candidate) => candidate.investmentUSDT >= minAllocation);
}

// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
// Snipe key helpers (mode-prefixed)
// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
const mkSnipeKey = (sim: boolean, opportunityId: string) => `${sim ? 'sim' : 'real'}:${opportunityId}`;
const parseSnipeKey = (key: string) => ({
  isSim: key.startsWith('sim:'),
  opportunityId: key.slice(key.indexOf(':') + 1),
});

// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
// State shape
// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
interface FundingState {
  // Data
  fundingRates: FundingRate[];
  opportunities: ArbitrageOpportunity[];
  positions: Position[];
  balances: Partial<Record<ExchangeId, Balance>>;
  logs: LogEntry[];
  fundingHistory: FundingPayment[];

  // Config
  apiConfigs: Partial<Record<ExchangeId, ApiConfig>>;
  strategyConfig: StrategyConfig;

  // Status
  isLoadingRates: boolean;
  isLoadingPositions: boolean;
  isLoadingHistory: boolean;
  tradesClearedAt: number;
  strategyRunning: boolean;
  connectedExchanges: ExchangeId[];
  lastRatesUpdate: number | null;
  lastPositionsUpdate: number | null;
  ratesStatus: 'idle' | 'loading' | 'success' | 'error';
  ratesError: string | null;
  consecutiveAllFailCount: number;  // ??거래???�속 ?�패 ?�수

  // Exchange toggle
  enabledExchanges: ExchangeId[];

  // Per-exchange fetch status
  exchangeFetchStatus: Partial<Record<ExchangeId, 'ok' | 'error' | 'loading'>>;
  exchangeFetchErrors: Partial<Record<ExchangeId, string>>;

  // Simulation (?�징 ?�용 ?�고 ?�)
  simulationMode: boolean;
  realPositionMeta: Record<string, RealPositionMeta>;
  simBalances: Record<ExchangeId, number>;
  simInitialBalances: Record<ExchangeId, number>;
  simPositions: SimPosition[];
  simTotalFundingEarned: number;
  simTotalTopUps: number;
  simTotalFees: number;
  simTotalClosedPnl: number;
  simClosedPnlPerExchange: Partial<Record<ExchangeId, number>>;
  simClosedFeesPerExchange: Partial<Record<ExchangeId, number>>;

  // Snipe mode (모드�??�립 ??sim/real ?�시 ?�행 가??
  simSnipeActive: boolean;           // SIM 모드 ?�나?�프 ?�성
  realSnipeActive: boolean;          // REAL 모드 ?�나?�프 ?�성
  simSnipeStartCapital: number;      // SIM ?�동?�자 ON ?�점??�??�입 ?�본
  realSnipeStartCapital: number;     // REAL ?�동?�자 ON ?�점??�??�입 ?�본
  snipeTargets: Record<string, number>;  // mode-prefixed opportunity key ??targetFundingTime
  snipeAllocations: Record<string, number>;
  _snipeTimers: Record<string, ReturnType<typeof setTimeout>>;      // mode-prefixed key ??진입 ?�?�머
  _snipeCloseTimers: Record<string, ReturnType<typeof setTimeout>>; // mode-prefixed key ??�?�� ?�?�머

  // UI state
  showApiPanel: boolean;
  showStrategyPanel: boolean;
  rateFilter: string;
  exchangeFilter: ExchangeId[];
  positionToClose: Position | null;

  // Real orderbook spreads (keyed by baseAsset) ??effectiveSpread???�리?��?+베이?�스+?�수�?모두 반영
  realSpreads: Record<string, RealSpreadSnapshot>;

  // Polling interval handles
  _ratesInterval: ReturnType<typeof setInterval> | null;
  _positionsInterval: ReturnType<typeof setInterval> | null;
  _snipeCheckInterval: ReturnType<typeof setInterval> | null;
  _simSyncInterval: ReturnType<typeof setInterval> | null;

  // Actions
  init: () => void;
  setApiConfig: (exchange: ExchangeId, config: ApiConfig) => void;
  removeApiConfig: (exchange: ExchangeId) => void;
  setStrategyConfig: (config: Partial<StrategyConfig>) => void;

  refreshRates: (options?: { silent?: boolean }) => Promise<void>;
  refreshPositions: () => Promise<void>;
  refreshAndStampPositions: (baseAsset: string, exchanges: ExchangeId[]) => Promise<void>;
  refreshBalances: () => Promise<void>;
  refreshRealSpreads: () => Promise<void>;
  revalidateScheduledSnipes: () => void;

  startPolling: () => void;
  stopPolling: () => void;

  executeStrategy: (
    opportunity: ArbitrageOpportunity,
    simModeOverride?: boolean,
    investmentOverrideUSDT?: number,
  ) => Promise<ExecuteStrategyResult>;
  closePosition: (position: Position) => Promise<ClosePositionResult>;
  testConnection: (exchange: ExchangeId) => Promise<boolean>;

  addLog: (level: LogLevel, message: string, exchange?: ExchangeId, detail?: string) => void;
  clearLogs: () => void;

  // Simulation actions
  toggleSimulationMode: () => Promise<void>;
  resetSimulation: () => void;
  clearSimFundingHistory: () => void;
  closeSimPosition: (simId: string) => Promise<{ netPnl: number; funding: number } | null>;
  tickSimFunding: () => void;

  // Snipe actions (모드�??�립 ?�나?�핑)
  scheduleAllSnipes: () => void;
  _scheduleSnipesForMode: (isSim: boolean) => void;
  scheduleSnipeForAsset: (
    opportunity: ArbitrageOpportunity,
    isSim: boolean,
    investmentUSDT?: number,
  ) => void;
  cancelSnipe: (mode?: 'sim' | 'real' | 'all') => void;
  cancelSnipeForAsset: (
    snipeKey: string,
    decision?: { reason?: string; detail?: string; status?: string; selected?: boolean },
  ) => void;
  _executeSnipeEntry: (opportunity: ArbitrageOpportunity, targetFundingTime: number, isSim: boolean) => void;
  _executeSnipeClose: (target: ArbitrageOpportunity, isSim: boolean) => Promise<void>;

  toggleExchange: (exchange: ExchangeId) => void;
  setShowApiPanel: (v: boolean) => void;
  setShowStrategyPanel: (v: boolean) => void;
  setRateFilter: (v: string) => void;
  setExchangeFilter: (v: ExchangeId[]) => void;
  setPositionToClose: (v: Position | null) => void;

  fetchFundingHistory: () => Promise<void>;
  redistributeBalances: () => void;
}

// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
// Helpers
// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
function makeApiHeaders(config: ApiConfig): Record<string, string> {
  const h: Record<string, string> = {
    'x-api-key': config.apiKey,
    'x-api-secret': config.secret,
    'Content-Type': 'application/json',
  };
  if (config.passphrase) h['x-api-passphrase'] = config.passphrase;
  return h;
}

let logCounter = 0;
let ratesRefreshInFlight = false;
let ratesRefreshStartedAt = 0;
const RATE_FETCH_TIMEOUT_MS = 20_000;
const RATE_RETRY_DELAY_MS = 1_500;
const RATE_RETRY_TIMEOUT_MS = 15_000;
const EXCHANGE_STATUS_STALE_OK_MS = 90_000;
const RATE_REFRESH_STUCK_MS = 70_000;

async function fetchJsonWithDeadline<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const hardTimeout = new Promise<never>((_, reject) => {
      hardTimeoutTimer = setTimeout(() => {
        reject(new Error(`timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs + 500);
    });

    const response = await Promise.race([
      fetch(url, { signal: controller.signal }),
      hardTimeout,
    ]) as Response;

    return await response.json() as T;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`timeout (${Math.round(timeoutMs / 1000)}s)`);
    }
    throw error;
  } finally {
    clearTimeout(abortTimer);
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
  }
}

function makeLog(level: LogLevel, message: string, exchange?: ExchangeId, detail?: string): LogEntry {
  return {
    id: `${Date.now()}-${++logCounter}`,
    timestamp: Date.now(),
    level,
    message,
    exchange,
    detail,
  };
}

interface StrategyOrderExecution {
  orderId: string;
  price: number;
  amount: number;
  filledNotional: number;
  liquidity: OrderLiquidity;
  estimatedFee: number;
}

interface StrategyExecutionLeg {
  success: boolean;
  data?: StrategyOrderExecution;
  error?: string;
}

interface ExecuteStrategyResult {
  success: boolean;
  short?: StrategyExecutionLeg;
  long?: StrategyExecutionLeg;
  rollback?: string;
  hedgeTrim?: string;
  error?: string;
  reason?: string;
  shortSlippage?: number;
  longSlippage?: number;
  maxSlippage?: number;
  entryGapPct?: number;
  hedgeFeePct?: number;
  realNetSpread?: number;
  pairId?: string;
}

interface RealPositionMeta {
  pairId: string;
  positionType: 'hedge_long' | 'hedge_short';
  openedAt: number;
  entryFee: number;
  entryOrderLiquidity: OrderLiquidity;
  entryFilledNotional: number;
}

interface ClosePositionResult extends StrategyOrderExecution {
  exchange: ExchangeId;
  baseAsset: string;
  symbol: string;
  side: 'long' | 'short';
  pairId?: string;
  entryFee: number;
  exitFee: number;
  pricePnl: number;
  pnl: number;
  fundingAmount: number;
}

function makeSyntheticClosePosition(
  opportunity: ArbitrageOpportunity,
  legSide: 'long' | 'short',
  data: StrategyOrderExecution,
  leverage: number,
  pairId?: string,
): Position {
  const isShort = legSide === 'short';
  const markPrice = isShort ? opportunity.shortMarkPrice : opportunity.longMarkPrice;
  const price = data.price || markPrice;
  const sizeUSD = data.filledNotional || data.amount * price;
  const margin = leverage > 0 ? sizeUSD / leverage : 0;

  return {
    exchange: isShort ? opportunity.shortExchange : opportunity.longExchange,
    symbol: isShort ? opportunity.shortSymbol : opportunity.longSymbol,
    displaySymbol: `${opportunity.baseAsset}/USDT`,
    baseAsset: opportunity.baseAsset,
    side: legSide,
    size: data.amount,
    sizeUSD,
    entryPrice: price,
    markPrice,
    leverage,
    margin,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    liquidationPrice: price,
    fundingRate: isShort ? opportunity.shortRate : opportunity.longRate,
    openedAt: Date.now(),
    positionType: isShort ? 'hedge_short' : 'hedge_long',
    pairId,
    entryFee: data.estimatedFee,
    entryOrderLiquidity: data.liquidity,
    entryFilledNotional: data.filledNotional,
  };
}

// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
// File persistence: batch log/trade sending
// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
interface PendingLog {
  timestamp: number;
  level: string;
  message: string;
  exchange?: string;
  detail?: string;
}

interface PendingTrade {
  timestamp: number;
  type: string;
  simulation: boolean;
  [key: string]: unknown;
}

let logBatch: PendingLog[] = [];
let tradeBatch: PendingTrade[] = [];
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;
let tradeFlushTimer: ReturnType<typeof setTimeout> | null = null;
let tradePersistenceHooksInstalled = false;

const CRITICAL_TRADE_EVENT_TYPES = new Set<string>([
  'entry',
  'snipe_entry',
  'exit',
  'snipe_exit',
  'auto_exit',
  'funding',
  'snipe_complete',
  'error',
  'schedule_probe',
  'guard_block',
  'exit_failed',
]);

const LOG_INVALID_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]+/g;
const LOG_MOJIBAKE_PATTERN_RE = /(Ã|â|ä|å|æ|ç|ë|î|ï|ô|ø|ú|û|ü|ÿ|Â|©|†|ƒ|�)/;

function normalizeLiveLogField(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  if (!text) return '';
  const base = text.replace(LOG_INVALID_CONTROL_CHARS_RE, '').replace(/\u0000/g, '').trim();
  if (!base) return '';
  if (!LOG_MOJIBAKE_PATTERN_RE.test(base)) {
    return base.normalize('NFC');
  }
  try {
    const bytes = Uint8Array.from(base, (char) => char.charCodeAt(0) & 0xFF);
    const decoded = new TextDecoder('utf-8').decode(bytes).trim();
    if (decoded && !decoded.includes('\uFFFD')) {
      return decoded.normalize('NFC').replace(LOG_INVALID_CONTROL_CHARS_RE, '');
    }
  } catch {
    // Ignore decode errors and keep original cleaned text.
  }
  return base.normalize('NFC').replace(/\uFFFD+/g, '');
}

type ScheduleDecisionReason = {
  status: string;
  selected: boolean;
  reason?: string;
  detail?: string;
  rejectReasons?: string[];
  targetFundingTime?: number;
  timeToFundingMs?: number;
};

const SNIPER_DECISION_CACHE_TTL_MS = 30_000;
const scheduledDecisionEmitCache = new Map<string, { selected: boolean; signature: string; at: number; status: string }>();

function normalizeDecisionRejectReasons(value?: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)));
}

function emitScheduleProbeDecision(
  opportunity: ArbitrageOpportunity,
  isSim: boolean,
  reason: ScheduleDecisionReason,
) {
  const opportunityId = getOpportunityId(opportunity);
  const cacheKey = `${isSim ? 'sim' : 'real'}:${opportunityId}`;
  const rejectReasons = normalizeDecisionRejectReasons(reason.rejectReasons);
  const timeToFundingMs = Number.isFinite(reason.timeToFundingMs as number)
    ? reason.timeToFundingMs
    : Number.isFinite(reason.targetFundingTime as number)
      ? Math.max(0, (reason.targetFundingTime as number) - Date.now())
      : undefined;
  const signature = `${reason.status}|${reason.selected ? 'selected' : 'rejected'}|${rejectReasons.join(',')}|${reason.reason ?? ''}`;
  const now = Date.now();
  const cached = scheduledDecisionEmitCache.get(cacheKey);
  if (cached && cached.selected === reason.selected && cached.status === reason.status && cached.signature === signature && now - cached.at < SNIPER_DECISION_CACHE_TTL_MS) {
    return;
  }
  scheduledDecisionEmitCache.set(cacheKey, { selected: reason.selected, signature, at: now, status: reason.status });

  queueTrade({
    timestamp: now,
    type: 'schedule_probe',
    simulation: isSim,
    baseAsset: opportunity.baseAsset,
    shortExchange: opportunity.shortExchange,
    longExchange: opportunity.longExchange,
    reason: reason.reason,
    detail: reason.detail,
    spreadPercent: opportunity.spreadPercent,
    analysis: {
      opportunityId,
      status: reason.status,
      selected: reason.selected,
      rejectReasons,
      timeToFundingMs,
    },
    timeToFundingMs: Number.isFinite(timeToFundingMs) ? timeToFundingMs : undefined,
  });
}

function installTradePersistenceHooks() {
  if (tradePersistenceHooksInstalled || typeof window === 'undefined') return;
  tradePersistenceHooksInstalled = true;

  const flushWithBeacon = () => {
    flushTrades({ preferBeacon: true });
    flushLogs();
  };

  window.addEventListener('pagehide', flushWithBeacon);
  window.addEventListener('beforeunload', flushWithBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushWithBeacon();
    }
  });
}

function queueLog(level: string, message: string, exchange?: string, detail?: string) {
  installTradePersistenceHooks();
  logBatch.push({ timestamp: Date.now(), level, message, exchange, detail });
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogs, 2000); // 2초마??배치 ?�송
  }
}

function queueTrade(event: PendingTrade) {
  installTradePersistenceHooks();
  tradeBatch.push(event);
  if (CRITICAL_TRADE_EVENT_TYPES.has(event.type)) {
    flushTrades();
    return;
  }
  if (!tradeFlushTimer) {
    tradeFlushTimer = setTimeout(flushTrades, 1000); // 거래??1초마??즉시 ?�송
  }
}

function clearPendingPersistenceQueues() {
  logBatch = [];
  tradeBatch = [];
  scheduledDecisionEmitCache.clear();
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (tradeFlushTimer) {
    clearTimeout(tradeFlushTimer);
    tradeFlushTimer = null;
  }
}

function flushLogs() {
  logFlushTimer = null;
  if (logBatch.length === 0) return;
  const entries = [...logBatch];
  logBatch = [];
  fetch('/api/logs/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  }).catch(() => { /* silent ??don't break UI for log persistence */ });
}

function flushTrades(options?: { preferBeacon?: boolean }) {
  tradeFlushTimer = null;
  if (tradeBatch.length === 0) return;
  const events = [...tradeBatch];
  tradeBatch = [];
  if (options?.preferBeacon && typeof navigator !== 'undefined') {
    try {
      const payload = JSON.stringify({ events });
      const blob = new Blob([payload], { type: 'application/json' });
      const sent = navigator.sendBeacon('/api/trades/save', blob);
      if (sent) return;
    } catch {
      // Ignore beacon fallback errors and continue with fetch keepalive.
    }
  }
  fetch('/api/trades/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({ events }),
  }).catch(() => {
    // Requeue on transient transport failures to avoid dropping executed trades.
    tradeBatch = [...events, ...tradeBatch];
    if (!tradeFlushTimer) {
      tradeFlushTimer = setTimeout(flushTrades, 1500);
    }
  });
}

interface StoredTradeEventFundingShape {
  type: string;
  timestamp: number;
  exchange?: string;
  symbol?: string;
  fundingAmount?: number;
  fundingRate?: number;
  side?: string;
  simulation?: boolean;
}

function makeFundingHistoryKey(payment: FundingPayment): string {
  return [
    payment.exchange,
    payment.symbol,
    payment.side,
    payment.timestamp,
    payment.amount.toFixed(8),
  ].join('|');
}

function mergeFundingHistory(primary: FundingPayment[], fallback: FundingPayment[]): FundingPayment[] {
  const merged = new Map<string, FundingPayment>();

  for (const payment of [...primary, ...fallback]) {
    merged.set(makeFundingHistoryKey(payment), payment);
  }

  return Array.from(merged.values()).sort((a, b) => b.timestamp - a.timestamp);
}

async function loadFundingHistoryFromTradeLog(simulation: boolean): Promise<FundingPayment[]> {
  const listRes = await fetch('/api/trades/list?list=true');
  const listJson = await listRes.json() as { dates?: string[] };
  const dates = (listJson.dates ?? []).slice(0, 7);
  if (dates.length === 0) return [];

  const results = await Promise.all(
    dates.map(async (date) => {
      const res = await fetch(`/api/trades/list?date=${date}`);
      return res.json() as Promise<{ events?: StoredTradeEventFundingShape[] }>;
    }),
  );

  const payments: FundingPayment[] = [];
  for (const result of results) {
    for (const event of result.events ?? []) {
      if (event.type !== 'funding') continue;
      if (!!event.simulation !== simulation) continue;
      if (!event.exchange || !event.symbol) continue;
      const amount = event.fundingAmount ?? 0;
      if (Math.abs(amount) <= 0.0000001) continue;

      payments.push({
        exchange: event.exchange as ExchangeId,
        symbol: event.symbol,
        amount,
        rate: event.fundingRate ?? 0,
        timestamp: event.timestamp,
        side: (event.side === 'short' ? 'short' : 'long'),
      });
    }
  }

  return mergeFundingHistory([], payments);
}

// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
// Store
// ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
export const useFundingStore = create<FundingState>((set, get) => ({
  fundingRates: [],
  opportunities: [],
  positions: [],
  balances: {},
  logs: [],
  apiConfigs: {},
  strategyConfig: {
    investmentUSDT: 1000,
    leverage: 5,
    minSpreadPercent: 0.08,
    autoExecute: false,
    compoundInvesting: true,
    timingConfig: { ...DEFAULT_TIMING_CONFIG },
  },
  fundingHistory: [],
  simulationMode: true,
  realPositionMeta: {},
  simBalances: buildExchangeAllocationMap(2000, OPERABLE_EXCHANGES),
  simInitialBalances: buildExchangeAllocationMap(2000, OPERABLE_EXCHANGES),
  simPositions: [],
  simTotalFundingEarned: 0,
  simTotalTopUps: 0,
  simTotalFees: 0,
  simTotalClosedPnl: 0,
  simClosedPnlPerExchange: {},
  simClosedFeesPerExchange: {},
  simSnipeActive: false,
  realSnipeActive: false,
  simSnipeStartCapital: 0,
  realSnipeStartCapital: 0,
  snipeTargets: {},
  snipeAllocations: {},
  _snipeTimers: {},
  _snipeCloseTimers: {},
  isLoadingRates: false,
  isLoadingPositions: false,
  isLoadingHistory: false,
  tradesClearedAt: 0,
  strategyRunning: false,
  connectedExchanges: [],
  lastRatesUpdate: null,
  lastPositionsUpdate: null,
  ratesStatus: 'idle',
  ratesError: null,
  consecutiveAllFailCount: 0,
  enabledExchanges: [...OPERABLE_EXCHANGES],
  exchangeFetchStatus: {},
  exchangeFetchErrors: {},
  showApiPanel: false,
  showStrategyPanel: false,
  rateFilter: '',
  exchangeFilter: [],
  positionToClose: null,
  realSpreads: {},
  _ratesInterval: null,
  _positionsInterval: null,
  _snipeCheckInterval: null,
  _simSyncInterval: null,

  // ?�?� Init ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  init() {
    try {
      // React 18 Strict Mode / HMR?�서 ?�태 초기??(snipeActive???�버 ?�태가 source of truth ???�기??리셋?��? ?�음)
      set({ isLoadingRates: false, _snipeTimers: {}, _snipeCloseTimers: {} });

      // ?�?� 1?�성 ?�이???�리: ?��? 초기??(v3 마이그레?�션) ?�?�
      const MIGRATION_KEY = 'funding_fee_migration_v3';
      if (typeof window !== 'undefined' && !localStorage.getItem(MIGRATION_KEY)) {
        localStorage.removeItem('funding_fee_history');
        localStorage.removeItem('funding_fee_sim_state');
        localStorage.removeItem('funding_fee_logs');
        localStorage.setItem(MIGRATION_KEY, '1');
      }

      // ?�?�된 로그 & ?�???�스?�리 복원 (HMR/?�로고침?�서???��?)
      const savedLogs = loadLogs();
      const savedHistory = loadFundingHistory();
      if (savedLogs.length > 0) set({ logs: savedLogs });
      if (savedHistory !== null && savedHistory.length > 0) {
        set({ fundingHistory: savedHistory });
      } else if (savedHistory === null) {
        // localStorage?????�체가 ?�을 ?�만 ?�버?�서 복원 (명시??초기???�엔 ?�킵)
        fetch('/api/trades/list?list=true').then(r => r.json()).then((res: { dates?: string[] }) => {
          if (!res.dates || res.dates.length === 0) return;
          // 최근 7?�치 ?�??기록 복원
          const dates = res.dates.slice(0, 7);
          Promise.all(dates.map(d => fetch(`/api/trades/list?date=${d}`).then(r => r.json()))).then(results => {
            const fundingRecords: FundingPayment[] = [];
            for (const res of results) {
              if (!res.events) continue;
              for (const e of res.events as Array<{ type: string; timestamp: number; exchange: string; symbol: string; fundingAmount: number; fundingRate: number; side: string; simulation: boolean }>) {
                if (e.type === 'funding' && e.simulation && e.fundingAmount && Math.abs(e.fundingAmount) > 0.0001) {
                  fundingRecords.push({
                    exchange: e.exchange as ExchangeId,
                    symbol: e.symbol || '',
                    amount: e.fundingAmount,
                    rate: e.fundingRate || 0,
                    timestamp: e.timestamp,
                    side: (e.side as 'long' | 'short') || 'long',
                  });
                }
              }
            }
            if (fundingRecords.length > 0) {
              fundingRecords.sort((a, b) => b.timestamp - a.timestamp);
              set({ fundingHistory: fundingRecords });
              saveFundingHistory(fundingRecords);
              get().addLog('info', `[복원] 로컬 ?�일?�서 ?�???�령 ?�역 ${fundingRecords.length}�?복원`);
            }
          });
        }).catch(() => { /* silent */ });
      }

      const saved = loadApiConfigs();
      set({ apiConfigs: saved });
      const connected = (Object.keys(saved) as ExchangeId[]).filter((exchange) => isExchangeOperable(exchange));
      set({ connectedExchanges: connected });

      // ?�?�된 ?�략 ?�정 로드
      const savedStrategy = loadStrategyConfig();
      if (savedStrategy) {
        set({
          strategyConfig: getResolvedStrategyConfig({
            ...get().strategyConfig,
            ...savedStrategy,
            timingConfig: {
              ...getResolvedTimingConfig(get().strategyConfig.timingConfig),
              ...getResolvedTimingConfig(savedStrategy.timingConfig),
            },
          }),
        });
      }

      // ?�?�된 거래??ON/OFF ?�정 로드
      const savedEnabled = loadEnabledExchanges();
      if (savedEnabled && savedEnabled.length > 0) {
        const valid = savedEnabled.filter((exchange): exchange is ExchangeId => isExchangeOperable(exchange));
        if (valid.length >= 2) {
          set({ enabledExchanges: sanitizeEnabledExchanges(valid) });
        }
      }

      // ?�?�된 모드 복원 (SIM/REAL)
      const savedMode = loadSimMode();
      if (savedMode !== null) {
        set({ simulationMode: savedMode });
      }
      const effectiveMode = savedMode ?? get().simulationMode;
      const restoredHistoryResetAt = getHistoryResetAtForMode(effectiveMode);
      if (restoredHistoryResetAt > 0) {
        set({ tradesClearedAt: restoredHistoryResetAt });
      }

      // ?�?�된 REAL ?��???메�? 복원
      const savedRealMeta = loadRealPositionMeta();
      if (savedRealMeta) {
        set({ realPositionMeta: savedRealMeta as Record<string, RealPositionMeta> });
      }

      // ?�버???�?�된 ?�동?�자 ?�태 복원 (PC?�모바일 ?�기??
      fetchSharedSnipeStateSnapshot().then(async (sharedState) => {
        applySharedSnipeStateSnapshot(set, sharedState, { includeActives: false });
        set({ tradesClearedAt: getHistoryResetAtForMode(sharedState.simulationMode) });
        saveSimMode(sharedState.simulationMode);

        // REAL: ?�버 ?��?줄러가 ?�제�??�고 ?�는지 ?�인 ?�에�?UI ?�태�?ON?�로
        let realConfirmed = false;
        {
          try {
            const schedulerRes = await fetch('/api/scheduler');
            if (schedulerRes.ok) {
              const schedulerData = await schedulerRes.json() as { active?: boolean };
              realConfirmed = !!schedulerData.active;
            }
          } catch { /* ?�인 불�? ??OFF ?��? */ }
          if (!realConfirmed && sharedState.realSnipeActive) {
            // ?�버 ?��?줄러가 ???�고 ?�으�?snipe-state???�정
            void updateSharedSnipeStateSnapshot({ realSnipeActive: false }).catch(() => {});
            get().addLog('warning', '[복원] REAL ?�동?�자 ?�태 OFF ???�버 ?��?줄러 미실??);
          }
        }

        set({ realSnipeActive: realConfirmed });
        if (realConfirmed) {
          void syncServerSchedulerConfig(
            getResolvedStrategyConfig(get().strategyConfig),
            get().enabledExchanges,
            get().addLog,
          );
          get().addLog('info', '[복원] ?�동?�자 ?�태 복원 ??REAL');
        }
      }).catch(() => { /* silent */ });

      // ?�?�된 ?��??�이???�태 복원 (?�고, ?��??? ?�적 ?�??
      const savedSim = loadSimState();
      if (savedSim) {
        // ?�고가 거래?�당 기�?(?�자금�?)보다 ??���?보정 (??�??�쪽 참여 가?�하?�록)
        const minBal = get().strategyConfig.investmentUSDT * 2;
        const restoredBal = savedSim.simBalances as Record<ExchangeId, number>;
        const restoredInitial = (savedSim.simInitialBalances as Record<ExchangeId, number> | undefined)
          ?? savedSim.simBalances as Record<ExchangeId, number>;
        const enabled = get().enabledExchanges;
        for (const ex of enabled) {
          if ((restoredBal[ex] ?? 0) < minBal) {
            restoredBal[ex] = minBal;
          }
          if ((restoredInitial[ex] ?? 0) < minBal) {
            restoredInitial[ex] = minBal;
          }
        }
        set({
          simBalances: restoredBal,
          simInitialBalances: restoredInitial,
          simPositions: savedSim.simPositions,
          simTotalFundingEarned: savedSim.simTotalFundingEarned,
          simTotalTopUps: savedSim.simTotalTopUps ?? 0,
          simTotalFees: savedSim.simTotalFees ?? 0,
          simTotalClosedPnl: savedSim.simTotalClosedPnl ?? 0,
          simClosedPnlPerExchange: (savedSim.simClosedPnlPerExchange ?? {}) as Partial<Record<ExchangeId, number>>,
          simClosedFeesPerExchange: (savedSim.simClosedFeesPerExchange ?? {}) as Partial<Record<ExchangeId, number>>,
        });
      } else {
        // 최초 ?�행: ?�성 거래??기�??�로 초기 ?�고 ?�정 (거래?�당 ?�자금�? ????�??�쪽 참여 가??
        const enabled = get().enabledExchanges;
        const perExchange = get().strategyConfig.investmentUSDT * 2;
        const newBal = buildExchangeAllocationMap(perExchange, enabled);
        set({ simBalances: newBal, simInitialBalances: { ...newBal } });
      }

      void fetchServerSimSchedulerStatus()
        .then((simScheduler) => {
          applyServerSimStateSnapshot(set, simScheduler.state, { getState: get });
          set({
            simSnipeActive: !!simScheduler.active,
            snipeTargets: simScheduler.snipeTargets ?? {},
            snipeAllocations: simScheduler.snipeAllocations ?? {},
          });
        })
        .catch(() => {
          const savedSim = loadSimState();
          if (!savedSim) return;
          void fetch('/api/sim-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'replace',
              state: {
                ...buildEmptySimState(),
                ...savedSim,
                fundingHistory: loadFundingHistory() ?? [],
                updatedAt: Date.now(),
              },
            }),
          })
            .then(r => r.json())
            .then((migrated: { success?: boolean; data?: SimStateSnapshot }) => {
              if (migrated.success && migrated.data) {
                applyServerSimStateSnapshot(set, migrated.data, { force: true });
                return;
              }
              applyServerSimStateSnapshot(set, {
                ...buildEmptySimState(),
                ...savedSim,
                fundingHistory: loadFundingHistory() ?? [],
                updatedAt: Date.now(),
              }, { force: true });
            })
            .catch(() => {
              applyServerSimStateSnapshot(set, {
                ...buildEmptySimState(),
                ...savedSim,
                fundingHistory: loadFundingHistory() ?? [],
                updatedAt: Date.now(),
              }, { force: true });
            });
        });

      const enabled = get().enabledExchanges;
      get().addLog('info', '?�?�피 ?�로그램 초기???�료', undefined,
        `?�성 거래?? ${enabled.map(e => e.toUpperCase()).join(', ')} (${enabled.length}�?`);
      set({ ratesStatus: 'loading' });
      get().refreshRates().catch((err) => {
        console.error('[init] refreshRates failed:', err);
        set({ ratesStatus: 'error', ratesError: (err as Error).message, isLoadingRates: false });
      });
      get().startPolling();
    } catch (err) {
      console.error('[init] 초기???�패:', err);
      set({ ratesStatus: 'error', ratesError: `초기???�패: ${(err as Error).message}`, isLoadingRates: false });
    }
  },

  // ?�?� API config ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  setApiConfig(exchange, config) {
    if (!isExchangeOperable(exchange)) {
      get().addLog('warning', `${exchange.toUpperCase()} currently disabled`, exchange);
      return;
    }
    const prev = get().apiConfigs;
    const next = { ...prev, [exchange]: config };
    set({ apiConfigs: next });
    saveApiConfigs(next);
    // ?�버 �??�호???�?�소?�도 ?�??
    fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange, config }),
    }).catch(() => {});
    const connected = (Object.keys(next) as ExchangeId[]).filter((ex) => isExchangeOperable(ex));
    set({ connectedExchanges: connected });
    get().addLog('success', `${exchange.toUpperCase()} API ???�?�됨 (?�버 ?�호??`, exchange);
  },

  removeApiConfig(exchange) {
    const prev = get().apiConfigs;
    const next = { ...prev };
    delete next[exchange];
    set({ apiConfigs: next });
    saveApiConfigs(next);
    // ?�버 측에?�도 ??��
    fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange }),
    }).catch(() => {});
    const connected = (Object.keys(next) as ExchangeId[]).filter((ex) => isExchangeOperable(ex));
    set({ connectedExchanges: connected });
    get().addLog('warning', `${exchange.toUpperCase()} API ????��??, exchange);
  },

  setStrategyConfig(config) {
    const previousState = get();
    const previousConfig = previousState.strategyConfig;
    const currentTiming = getResolvedTimingConfig(previousConfig.timingConfig);
    const nextTiming = config.timingConfig
      ? getResolvedTimingConfig({
        entryLeadMs: Number.isFinite(config.timingConfig.entryLeadMs)
          ? config.timingConfig.entryLeadMs
          : currentTiming.entryLeadMs,
        closeDelayMs: Number.isFinite(config.timingConfig.closeDelayMs)
          ? config.timingConfig.closeDelayMs
          : currentTiming.closeDelayMs,
        fundingVerifyRetryMs: Number.isFinite(config.timingConfig.fundingVerifyRetryMs)
          ? config.timingConfig.fundingVerifyRetryMs
          : currentTiming.fundingVerifyRetryMs,
        fundingVerifyAttempts: Number.isInteger(config.timingConfig.fundingVerifyAttempts)
          ? config.timingConfig.fundingVerifyAttempts
          : currentTiming.fundingVerifyAttempts,
      })
      : currentTiming;

    const next = getResolvedStrategyConfig({
      ...previousConfig,
      ...config,
      feeOverrides: config.feeOverrides !== undefined
        ? sanitizeFeeOverrides(config.feeOverrides)
        : previousConfig.feeOverrides,
      paybackOverrides: config.paybackOverrides !== undefined
        ? sanitizePaybackOverrides(config.paybackOverrides)
        : previousConfig.paybackOverrides,
      timingConfig: nextTiming,
    });

    const investmentChanged = next.investmentUSDT !== previousConfig.investmentUSDT;
    const leverageChanged = next.leverage !== previousConfig.leverage;
    const minSpreadChanged = next.minSpreadPercent !== previousConfig.minSpreadPercent;
    const compoundChanged = next.compoundInvesting !== previousConfig.compoundInvesting;
    const feeChanged = JSON.stringify(next.feeOverrides ?? {}) !== JSON.stringify(previousConfig.feeOverrides ?? {});
    const paybackChanged = JSON.stringify(next.paybackOverrides ?? {}) !== JSON.stringify(previousConfig.paybackOverrides ?? {});
    const maxSlippageChanged = next.maxSlippagePercent !== previousConfig.maxSlippagePercent;
    const minVolumeChanged = next.minVolume24hUSD !== previousConfig.minVolume24hUSD;
    const timingChanged = JSON.stringify(next.timingConfig ?? DEFAULT_TIMING_CONFIG) !== JSON.stringify(previousConfig.timingConfig ?? DEFAULT_TIMING_CONFIG);
    const schedulerRelevantChanged = investmentChanged
      || leverageChanged
      || minSpreadChanged
      || compoundChanged
      || feeChanged
      || paybackChanged
      || maxSlippageChanged
      || minVolumeChanged
      || timingChanged;

    set((s) => {
      const opportunities = buildOpportunitiesFromRates(s.fundingRates, next, s);
      const nextRealSpreads = (feeChanged || paybackChanged)
        ? rebuildRealSpreadsForConfig(s.realSpreads, opportunities, next)
        : s.realSpreads;

      saveStrategyConfig(next);

      // investmentUSDT 변�????��? ?�고 ?�기??(?��????�을 ?�만)
      if (investmentChanged && s.simPositions.length === 0) {
        const newBal = buildExchangeAllocationMap(next.investmentUSDT * 2, s.enabledExchanges);
        return {
          strategyConfig: next,
          opportunities,
          realSpreads: nextRealSpreads,
          simBalances: newBal,
          simInitialBalances: { ...newBal },
        };
      }

      return {
        strategyConfig: next,
        opportunities,
        realSpreads: nextRealSpreads,
      };
    });

    if (previousState.realSnipeActive) {
      get().revalidateScheduledSnipes();
    }

    if (investmentChanged || leverageChanged || feeChanged || paybackChanged) {
      void get().refreshRealSpreads();
    }

    if (investmentChanged && previousState.simPositions.length === 0) {
      void fetch('/api/sim-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reconfigure',
          enabledExchanges: get().enabledExchanges,
          investmentUSDT: next.investmentUSDT,
        }),
      })
        .then(r => r.json())
        .then((res: { success?: boolean; data?: SimStateSnapshot }) => {
          if (res.success && res.data) {
            applyServerSimStateSnapshot(set, res.data, { force: true });
          }
        })
        .catch(() => {});
    }

    if (previousState.realSnipeActive && schedulerRelevantChanged) {
      void syncServerSchedulerConfig(
        get().strategyConfig,
        get().enabledExchanges,
        get().addLog,
      );
    }
    if (previousState.simSnipeActive && schedulerRelevantChanged) {
      void syncServerSimSchedulerConfig(
        get().strategyConfig,
        get().enabledExchanges,
        get().addLog,
      );
      void fetchServerSimSchedulerStatus()
        .then((status) => {
          applyServerSimStateSnapshot(set, status.state, { getState: get });
          set({
            simSnipeActive: !!status.active,
            snipeTargets: status.snipeTargets ?? {},
            snipeAllocations: status.snipeAllocations ?? {},
          });
        })
        .catch(() => {});
    }
  },

  // ?�?� Refresh rates (거래?�별 개별 비동�????�답 즉시 UI ?�데?�트) ?�?�
  async refreshRates(options) {
    if (ratesRefreshInFlight) {
      const elapsedMs = Date.now() - ratesRefreshStartedAt;
      if (elapsedMs > RATE_REFRESH_STUCK_MS) {
        console.warn(`[refreshRates] stale in-flight detected (${Math.round(elapsedMs / 1000)}s) - forcing reset`);
        ratesRefreshInFlight = false;
        ratesRefreshStartedAt = 0;
        set({ isLoadingRates: false });
      } else {
        console.log('[refreshRates] skip - already loading');
        return;
      }
    }
    ratesRefreshInFlight = true;
    ratesRefreshStartedAt = Date.now();
    const showLoading = !options?.silent || !get().lastRatesUpdate;
    if (showLoading) {
      set({ isLoadingRates: true, ratesStatus: get().lastRatesUpdate ? get().ratesStatus : 'loading', ratesError: null });
    } else {
      set({ ratesError: null });
    }

    try {
      const enabled = get().enabledExchanges;
      console.log('[refreshRates] start:', enabled.join(','));
      const markExchangeFetchFailure = (exchangeId: ExchangeId, errorMessage: string) => {
        set(s => {
          const hasExistingRates = s.fundingRates.some(r => r.exchange === exchangeId);
          const hasFreshSnapshot = !!s.lastRatesUpdate
            && (Date.now() - s.lastRatesUpdate) <= EXCHANGE_STATUS_STALE_OK_MS;
          const keepOk = hasExistingRates && hasFreshSnapshot;
          return {
            exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: keepOk ? 'ok' : 'error' },
            exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: errorMessage },
          };
        });
      };

    // 비활??거래???�이???�거 (OFF??거래?��? 기회 계산???�는 �?방�?)
    set(s => ({
      fundingRates: s.fundingRates.filter(r => enabled.includes(r.exchange)),
    }));

    // 거래?�별 개별 fetch ??먼�? ?�답 ?�는 거래?��???즉시 반영
    await Promise.allSettled(
      enabled.map(async (exchangeId) => {
        const current = get();
        const hasExistingRates = current.fundingRates.some(r => r.exchange === exchangeId);
        if (!hasExistingRates || current.exchangeFetchStatus[exchangeId] === 'error') {
          set(s => ({ exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'loading' } }));
        }
        try {
          const json = await fetchJsonWithDeadline<{
            success: boolean;
            error?: string;
            data: { rates: FundingRate[]; errors: { exchange: ExchangeId; error: string }[] };
            timestamp: number;
          }>(`/api/funding-rates?exchanges=${exchangeId}`, RATE_FETCH_TIMEOUT_MS);

          if (json.success && json.data.rates.length > 0) {
            console.log(`[refreshRates] ${exchangeId}: ${json.data.rates.length}�??�신`);
            // ??거래???�이?��? 기존 ?�이?�에 머�? ??즉시 기회 ?�계??
            try {
              set(s => {
                const otherRates = s.fundingRates.filter(r => r.exchange !== exchangeId);
                const merged = [...otherRates, ...json.data.rates];
                const { investmentUSDT, leverage } = s.strategyConfig;
                const opportunities = findOpportunities(
                  merged,
                  (s.simSnipeActive || s.realSnipeActive) ? 200 : 20,
                  investmentUSDT,
                  leverage,
                  s.strategyConfig.feeOverrides,
                  s.strategyConfig.paybackOverrides,
                  s.strategyConfig.minVolume24hUSD,
                );

                // ?��? ?��???마크가�??�데?�트
                let updatedSimPositions = s.simPositions;
                if (s.simPositions.length > 0) {
                  updatedSimPositions = s.simPositions.map(pos => {
                    if (pos.exchange !== exchangeId) return pos;
                    const liveRate = json.data.rates.find(r => r.symbol === pos.symbol);
                    if (!liveRate) return pos;
                    const mp = liveRate.markPrice || pos.markPrice;
                    const pricePnl = pos.side === 'short'
                      ? (pos.entryPrice - mp) * pos.size
                      : (mp - pos.entryPrice) * pos.size;
                    const pnl = pricePnl - (pos.entryFee ?? 0);
                    const margin = pos.margin || 1;
                    return { ...pos, markPrice: mp, unrealizedPnl: pnl, unrealizedPnlPercent: (pnl / margin) * 100, fundingRate: liveRate.rate };
                  });
                }

                return {
                  fundingRates: merged,
                  opportunities,
                  lastRatesUpdate: json.timestamp || Date.now(),
                  ratesStatus: 'success',
                  ratesError: null,
                  simPositions: updatedSimPositions,
                  exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'ok' },
                  exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: undefined },
                };
              });
            } catch (setErr) {
              console.error(`[refreshRates] ${exchangeId} set() ?�패:`, setErr);
              // set() ?�패?�도 최소???�태???�데?�트
              set({
                lastRatesUpdate: Date.now(),
                ratesStatus: 'success',
                exchangeFetchStatus: { ...get().exchangeFetchStatus, [exchangeId]: 'ok' },
              });
            }

            if (json.data.errors?.length > 0) {
              for (const e of json.data.errors) {
                get().addLog('warning', `${(e.exchange || '?').toUpperCase()} ?�?�률 ?�류`, e.exchange, e.error);
              }
            }
          } else {
            // success:false ?�는 ?�이??0�???짧�? ?��????�시??
            const errMsg = json.error || '?�이???�음';
            console.warn(`[refreshRates] ${exchangeId} 1�??�패(?�답): ${errMsg} ??${RATE_RETRY_DELAY_MS / 1000}�????�시??);
            await new Promise(r => setTimeout(r, RATE_RETRY_DELAY_MS));
            const retryJson2 = await fetchJsonWithDeadline<typeof json>(
              `/api/funding-rates?exchanges=${exchangeId}`,
              RATE_RETRY_TIMEOUT_MS,
            );
            if (retryJson2.success && retryJson2.data.rates.length > 0) {
              console.log(`[refreshRates] ${exchangeId} ?�시???�공: ${retryJson2.data.rates.length}�?);
              set(s => {
                const otherRates = s.fundingRates.filter(r => r.exchange !== exchangeId);
                const merged = [...otherRates, ...retryJson2.data.rates];
                const { investmentUSDT, leverage } = s.strategyConfig;
                const opportunities = findOpportunities(
                  merged,
                  (s.simSnipeActive || s.realSnipeActive) ? 200 : 20,
                  investmentUSDT,
                  leverage,
                  s.strategyConfig.feeOverrides,
                  s.strategyConfig.paybackOverrides,
                  s.strategyConfig.minVolume24hUSD,
                );
                return {
                  fundingRates: merged, opportunities,
                  lastRatesUpdate: retryJson2.timestamp || Date.now(),
                  ratesStatus: 'success', ratesError: null,
                  exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'ok' },
                  exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: undefined },
                };
              });
            } else {
              console.warn(`[refreshRates] ${exchangeId} ?�시?�도 ?�패: ${retryJson2.error || '?�이???�음'}`);
              markExchangeFetchFailure(exchangeId, retryJson2.error || errMsg);
            }
          }
        } catch (err) {
          // ?�트?�크/?�?�아???�러 ??짧�? ?��????�시??
          console.warn(`[refreshRates] ${exchangeId} 1�??�패(?�트?�크) ??${RATE_RETRY_DELAY_MS / 1000}�????�시??`, (err as Error).message);
          try {
            await new Promise(r => setTimeout(r, RATE_RETRY_DELAY_MS));
            const retryJson = await fetchJsonWithDeadline<{
              success: boolean;
              error?: string;
              data: { rates: FundingRate[]; errors: { exchange: ExchangeId; error: string }[] };
              timestamp: number;
            }>(`/api/funding-rates?exchanges=${exchangeId}`, RATE_RETRY_TIMEOUT_MS);
            if (retryJson.success && retryJson.data.rates.length > 0) {
              console.log(`[refreshRates] ${exchangeId} ?�시???�공: ${retryJson.data.rates.length}�?);
              set(s => {
                const otherRates = s.fundingRates.filter(r => r.exchange !== exchangeId);
                const merged = [...otherRates, ...retryJson.data.rates];
                const { investmentUSDT, leverage } = s.strategyConfig;
                const opportunities = findOpportunities(
                  merged,
                  (s.simSnipeActive || s.realSnipeActive) ? 200 : 20,
                  investmentUSDT,
                  leverage,
                  s.strategyConfig.feeOverrides,
                  s.strategyConfig.paybackOverrides,
                  s.strategyConfig.minVolume24hUSD,
                );
                return {
                  fundingRates: merged, opportunities,
                  lastRatesUpdate: retryJson.timestamp || Date.now(),
                  ratesStatus: 'success', ratesError: null,
                  exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'ok' },
                  exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: undefined },
                };
              });
            } else {
              throw new Error(retryJson.error || '?�시???�이???�음');
            }
          } catch (retryErr) {
            console.warn(`[refreshRates] ${exchangeId} ?�시?�도 ?�패:`, (retryErr as Error).message);
            markExchangeFetchFailure(exchangeId, (retryErr as Error).message);
          }
        }
      }),
    );

    // 모든 거래???�료 ?????�번 ?�운?�에???�나???�공 못했?�면 ?�러
    const anyOk = enabled.some(ex => get().exchangeFetchStatus[ex] === 'ok');
    console.log('[refreshRates] done ??anyOk:', anyOk, 'lastUpdate:', get().lastRatesUpdate);
    if (!anyOk) {
      const failCount = get().consecutiveAllFailCount + 1;
      set({ ratesStatus: 'error', ratesError: '모든 거래?�에???�이??조회 ?�패', consecutiveAllFailCount: failCount });

      // 5???�속 ?�체 ?�패 (~40�? ??경고 로그 + ?�레그램
      if (failCount === 5) {
        const msg = `?�️ API ?�체 ?�애: 모든 거래???�이??조회가 ${failCount}???�속 ?�패?�습?�다. ?�버 ?�태�??�인?�세?? (.next 캐시 ?�상 가?????�버 ?�시???�요)`;
        get().addLog('warning', msg);
        sendTelegramMessage(msg).catch(() => {});
      }
      // 30???�속 (~4�? ??경고�?발생 (?�버 ?�동?�자??강제 중단?��? ?�음)
      if (failCount === 30 && (get().simSnipeActive || get().realSnipeActive)) {
        get().addLog('warning', `?�️ API ?�애 지??(${failCount}???�속 ?�패) ???�동 중단?� ?��? ?�고 감시 ?��?`);
        sendTelegramMessage(`?�️ API ?�체 ?�애 ${failCount}???�속 감�?. ?�동 ?�자???��??�며 ?�태 ?��? ?�요.`).catch(() => {});
      }

      if (!get().lastRatesUpdate) {
        setTimeout(() => get().refreshRates(), 3000);
      }
    } else {
      // ?�공 ??카운??리셋
      if (get().consecutiveAllFailCount > 0) {
        set({ consecutiveAllFailCount: 0 });
      }
    }
    } finally {
      ratesRefreshInFlight = false;
      ratesRefreshStartedAt = 0;
      if (showLoading) set({ isLoadingRates: false });
    }
  },

  // ?�?� Refresh positions (?�성 거래?�만) ?�?�?�?�?�?�?�?�?�?�?�?�?�
  async refreshPositions() {
    const configs = get().apiConfigs;
    const enabled = get().enabledExchanges;
    const activeConfigs = (Object.entries(configs) as [ExchangeId, ApiConfig][])
      .filter(([exchange]) => enabled.includes(exchange) && isExchangeOperable(exchange));
    if (activeConfigs.length === 0) return;
    set({ isLoadingPositions: true });

    const allPositions: Position[] = [];

    await Promise.allSettled(
      activeConfigs.map(async ([exchange, config]) => {
        const res = await fetch(`/api/exchanges/${exchange}/positions`, {
          headers: makeApiHeaders(config),
        });
        const json = await res.json() as { success: boolean; data: Position[] };
        if (json.success && json.data) allPositions.push(...json.data);
      }),
    );

    const metaMap = get().realPositionMeta;

    // 기존 ?��??�의 positionType / 메�? 보존 (exchange+symbol+side 기�? 매칭)
    const prevPositions = get().positions;
    for (const pos of allPositions) {
      const meta = metaMap[makePositionKey(pos.exchange, pos.symbol, pos.side)];
      if (meta) {
        pos.positionType = meta.positionType;
        pos.openedAt = meta.openedAt;
        pos.pairId = meta.pairId;
        pos.entryFee = meta.entryFee;
        pos.entryOrderLiquidity = meta.entryOrderLiquidity;
        pos.entryFilledNotional = meta.entryFilledNotional;
      }

      const prev = prevPositions.find(p =>
        p.exchange === pos.exchange && p.symbol === pos.symbol && p.side === pos.side,
      );
      if (prev && prev.positionType !== 'manual') {
        pos.positionType = prev.positionType;
        pos.openedAt = prev.openedAt;
        pos.pairId = prev.pairId;
        pos.entryFee = prev.entryFee;
        pos.entryOrderLiquidity = prev.entryOrderLiquidity;
        pos.entryFilledNotional = prev.entryFilledNotional;
      }
    }

    set({ positions: allPositions, isLoadingPositions: false, lastPositionsUpdate: Date.now() });
  },

  // refreshPositions ???�로 ?�긴 ?��??�에�?positionType ?�팅
  // (기존???�던 manual ?��??��? 건드리�? ?�음)
  async refreshAndStampPositions(baseAsset: string, exchanges: ExchangeId[]) {
    // refresh ??기존 ?��????�냅??(exchange+symbol+side ??
    const beforeKeys = new Set(
      get().positions.map(p => `${p.exchange}:${p.symbol}:${p.side}`),
    );
    await get().refreshPositions();
    set(s => {
      const updated = s.positions.map(p => {
        if (p.baseAsset !== baseAsset) return p;
        if (!exchanges.includes(p.exchange)) return p;
        if (p.positionType !== 'manual') return p; // ?��? ?�?�이 ?�으�??��?
        // refresh ?�에 ?��? ?�던 ?��??�이�??�킵 (?�용??기존 ?��???
        const key = `${p.exchange}:${p.symbol}:${p.side}`;
        if (beforeKeys.has(key)) return p;
        // hedge: ??�?구분
        return {
          ...p,
          positionType: (p.side === 'short' ? 'hedge_short' : 'hedge_long') as Position['positionType'],
        };
      });
      return { positions: updated };
    });
  },

  // ?�?� Refresh balances (?�성 거래?�만) ?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  async refreshBalances() {
    const configs = get().apiConfigs;
    const enabled = get().enabledExchanges;
    const activeConfigs = (Object.entries(configs) as [ExchangeId, ApiConfig][])
      .filter(([exchange]) => enabled.includes(exchange) && isExchangeOperable(exchange));
    if (activeConfigs.length === 0) return;

    const previous = get().balances;
    const next: Partial<Record<ExchangeId, Balance>> = { ...previous };

    await Promise.allSettled(
      activeConfigs.map(async ([exchange, config]) => {
        try {
          const res = await fetch(`/api/exchanges/${exchange}/balance`, {
            headers: makeApiHeaders(config),
          });
          const json = await res.json().catch(() => null) as {
            success?: boolean;
            data?: Balance;
            error?: string;
          } | null;
          if (!res.ok || !json?.success || !json.data || json.data.status !== 'connected') {
            throw new Error(json?.error || `HTTP ${res.status}`);
          }
          next[exchange] = json.data;
        } catch {
          // Keep last good snapshot to avoid transient API errors being interpreted as $0 balance.
          if (!next[exchange]) {
            next[exchange] = {
              exchange,
              totalUSDT: 0,
              availableUSDT: 0,
              usedUSDT: 0,
              unrealizedPnl: 0,
              status: 'error',
              updatedAt: Date.now(),
            };
          }
        }
      }),
    );

    set({ balances: next });
  },

  // ?�?� Refresh real orderbook spreads for scheduled coins ?�?�
  async refreshRealSpreads() {
    const { snipeTargets, snipeAllocations, opportunities, strategyConfig, realSpreads, simBalances, balances: realBalances, simulationMode } = get();
    const now = Date.now();
    const STALE_MS = 5_000;

    // Collect from scheduled targets + near-term opportunities (route key 기�?)
    const opportunityIds = new Set<string>();
    const previewInvestmentByOpportunityId = new Map<string, number>();
    for (const key of Object.keys(snipeTargets)) {
      const opportunityId = parseSnipeKey(key).opportunityId;
      opportunityIds.add(opportunityId);
      const plannedInvestmentUSDT = snipeAllocations[key] ?? strategyConfig.investmentUSDT;
      const existingPreview = previewInvestmentByOpportunityId.get(opportunityId);
      if (existingPreview == null || plannedInvestmentUSDT < existingPreview) {
        previewInvestmentByOpportunityId.set(opportunityId, plannedInvestmentUSDT);
      }
    }
    // 5?�간 ?�내 ?�??기회 ?�전 조회 (?��?줄링 ???�론�?fallback 방�?)
    const LOOKAHEAD_MS = 5 * 60 * 60 * 1000;
    for (const opp of opportunities) {
      if (opp.nextFundingTime - Date.now() <= LOOKAHEAD_MS) {
        opportunityIds.add(getOpportunityId(opp));
      }
    }
    if (opportunityIds.size === 0) return;

    await Promise.allSettled(
      Array.from(opportunityIds).map(async (opportunityId) => {
        const opp = findOpportunityById(opportunities, opportunityId);
        if (!opp) return;

        // Skip if data is fresh
        const existing = realSpreads[opportunityId];
        if (existing && now - existing.updatedAt < STALE_MS) return;

        try {
          // ?�쪽 모드 �???notional ?�용 ???�리?��???주문 ?�기??비�??��?�?보수??추정
          const previewInvestmentUSDT = previewInvestmentByOpportunityId.get(opportunityId);
          const simNotional = getEffectiveNotional(opp, strategyConfig, simBalances, realBalances, true, previewInvestmentUSDT);
          const realNotional = getEffectiveNotional(opp, strategyConfig, simBalances, realBalances, false, previewInvestmentUSDT);
          const notional = Math.max(simNotional, realNotional) || Math.min(simNotional, realNotional);
          if (notional <= 0) return;
          const [shortRes, longRes] = await Promise.all([
            fetch(`/api/exchanges/${opp.shortExchange}/orderbook?symbol=${encodeURIComponent(opp.shortSymbol)}&side=sell&notional=${notional}`),
            fetch(`/api/exchanges/${opp.longExchange}/orderbook?symbol=${encodeURIComponent(opp.longSymbol)}&side=buy&notional=${notional}`),
          ]);
          const [shortJson, longJson] = await Promise.all([shortRes.json(), longRes.json()]) as [
            { success: boolean; slippagePercent: number; fillPrice: number; midPrice: number },
            { success: boolean; slippagePercent: number; fillPrice: number; midPrice: number },
          ];

          if (shortJson.success && longJson.success) {
            const shortSlippage = shortJson.slippagePercent;
            const longSlippage = longJson.slippagePercent;
            // ???�심: fillPrice�?진입 가�?�?직접 계산 (?�리?��? + 거래??�?베이?�스 모두 ?�착)
            // short(sell) fillPrice < midPrice, long(buy) fillPrice > midPrice
            // entryGapPct = (longFill - shortFill) / shortFill * 100 ???�수 = 진입 ?�실
            const entryGapPct = ((longJson.fillPrice - shortJson.fillPrice) / shortJson.fillPrice) * 100;
            const hedgeFeePct = getConfiguredHedgeFees(
              strategyConfig,
              opp.shortExchange,
              opp.longExchange,
              'taker',
            ) * 100;
            // ??equal-notional ?�나?�프: 가�?괴리 무�?, ?�리?��?+?�수료만 차감
            const effectiveSpread = calcHedgedNetSpreadPercent(
              opp.spreadPercent,
              shortSlippage,
              longSlippage,
              hedgeFeePct,
              0, // ?�전마진?� ?�행 ?�점?�만 별도 ?�용
            );
            set(state => ({
              realSpreads: {
                ...state.realSpreads,
                [opportunityId]: {
                  effectiveSpread, shortSlippage, longSlippage,
                  entryGapPct, shortFillPrice: shortJson.fillPrice, longFillPrice: longJson.fillPrice,
                  updatedAt: Date.now(),
                },
              },
            }));
          }
        } catch {
          // Silent ??real spread just won't be shown
        }
      }),
    );
  },

  // ?�?� Balance redistribution ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  redistributeBalances() {
    const { simBalances, simPositions, enabledExchanges, strategyConfig } = get();
    const threshold = strategyConfig.investmentUSDT * 0.5;

    // Compute free balance (balance minus locked margin) per exchange
    const freeBalances: Partial<Record<ExchangeId, number>> = {};
    for (const ex of enabledExchanges) {
      const bal = simBalances[ex] ?? 0;
      const locked = simPositions.filter(p => p.exchange === ex).reduce((s, p) => s + p.margin, 0);
      freeBalances[ex] = Math.max(0, bal - locked);
    }

    // Find critically low exchanges (free balance below threshold)
    const lowExchanges = enabledExchanges.filter(ex => (freeBalances[ex] ?? 0) < threshold);
    if (lowExchanges.length === 0) return;

    // Equalize: transfer from highest-surplus donors toward average
    const avgFree = enabledExchanges.reduce((s, ex) => s + (freeBalances[ex] ?? 0), 0) / enabledExchanges.length;

    for (const target of lowExchanges) {
      const targetFree = freeBalances[target] ?? 0;
      const needed = avgFree - targetFree;
      if (needed <= 0) continue;

      // Donors: exchanges with free balance above average, sorted by surplus desc
      const donors = enabledExchanges
        .filter(ex => ex !== target && (freeBalances[ex] ?? 0) > avgFree)
        .sort((a, b) => (freeBalances[b] ?? 0) - (freeBalances[a] ?? 0));

      let remaining = needed;
      for (const donor of donors) {
        if (remaining <= 0) break;
        const surplus = (freeBalances[donor] ?? 0) - avgFree;
        const transfer = Math.min(surplus, remaining);
        if (transfer <= 0) continue;

        set(s => ({
          simBalances: {
            ...s.simBalances,
            [donor]: (s.simBalances[donor] ?? 0) - transfer,
            [target]: (s.simBalances[target] ?? 0) + transfer,
          },
        }));
        freeBalances[donor] = (freeBalances[donor] ?? 0) - transfer;
        freeBalances[target] = (freeBalances[target] ?? 0) + transfer;
        remaining -= transfer;

        get().addLog('info',
          `[SIM] ?�고 ?�분�? ${donor.toUpperCase()} ??${target.toUpperCase()} $${fmtNum(transfer, 0)}`,
          target,
          `${donor.toUpperCase()} ?�유?�고 ??${target.toUpperCase()} (?�계�?$${fmtNum(threshold, 0)} 미만 감�?)`,
        );
      }
    }
  },

  // ?�?� Polling ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  startPolling() {
    const s = get();
    if (s._ratesInterval) clearInterval(s._ratesInterval);
    if (s._positionsInterval) clearInterval(s._positionsInterval);

    // �??�이?��? ?�직 ?�으�?1�???즉시 ?�시??(init ?�패 보완)
    if (!get().lastRatesUpdate) {
      setTimeout(() => {
        if (!get().lastRatesUpdate) get().refreshRates();
      }, 1000);
    }

    // 5�?간격 ?�?�률 + ?�더�??�링 (기회 ?��? ?�도 ?�상)
    const ratesInterval = setInterval(() => {
      get().refreshRates({ silent: true });
      if (get().simSnipeActive || get().realSnipeActive) {
        get().refreshRealSpreads();
      }
      void fetchSharedSnipeStateSnapshot()
        .then((snapshot) => {
          applySharedSnipeStateSnapshot(set, snapshot, { includeActives: false });
          saveSimMode(snapshot.simulationMode);
        })
        .catch(() => {});
    }, RATES_POLL_INTERVAL_MS);

    // 1�?간격 ?��?�?+ ?��?줄링 (로컬 ?�이?�만 ?�용, API ?�출 ?�음)
    const snipeCheckInterval = setInterval(() => {
      if (get().realSnipeActive) {
        get().revalidateScheduledSnipes();
        get().scheduleAllSnipes();
      }
    }, SNIPE_CHECK_INTERVAL_MS);

    // 3�?간격 SIM ?�버 ?�태 ?�기??(API ?�출 ??매초??과도)
    const simSyncInterval = setInterval(() => {
      if (get().simSnipeActive) {
        void fetchServerSimSchedulerStatus()
          .then((status) => {
            applyServerSimStateSnapshot(set, status.state, { getState: get });
            set({
              simSnipeActive: !!status.active,
              snipeTargets: {
                ...Object.fromEntries(
                  Object.entries(get().snipeTargets).filter(([key]) => !key.startsWith('sim:')),
                ),
                ...(status.snipeTargets ?? {}),
              },
              snipeAllocations: {
                ...Object.fromEntries(
                  Object.entries(get().snipeAllocations).filter(([key]) => !key.startsWith('sim:')),
                ),
                ...(status.snipeAllocations ?? {}),
              },
            });
          })
          .catch(() => {});
      } else if (get().simulationMode) {
        void fetchServerSimStateSnapshot()
          .then((snapshot) => {
            applyServerSimStateSnapshot(set, snapshot, { getState: get });
          })
          .catch(() => {});
      }
    }, SIM_SYNC_INTERVAL_MS);

    const positionsInterval = setInterval(() => {
      const shouldPollRealAccountData = !get().simulationMode || get().realSnipeActive;
      if (shouldPollRealAccountData) {
        get().refreshPositions();
        get().refreshBalances();
        get().fetchFundingHistory();
      }
      if (get().simulationMode || get().simSnipeActive) {
        void fetchServerSimStateSnapshot()
          .then((snapshot) => applyServerSimStateSnapshot(set, snapshot, { getState: get }))
          .catch(() => {});
      } else {
        get().tickSimFunding();
      }
      // ?�고 ?�분�? ?�고 부�?거래?�에 ?�유 거래?�에??균등 분배
      if (get().simulationMode && !get().simSnipeActive) {
        get().redistributeBalances();
      }
    }, POSITIONS_POLL_INTERVAL_MS);

    set({ _ratesInterval: ratesInterval, _positionsInterval: positionsInterval, _snipeCheckInterval: snipeCheckInterval, _simSyncInterval: simSyncInterval });
  },

  stopPolling() {
    const { _ratesInterval, _positionsInterval, _snipeCheckInterval, _simSyncInterval, _snipeTimers, _snipeCloseTimers } = get();
    if (_ratesInterval) clearInterval(_ratesInterval);
    if (_positionsInterval) clearInterval(_positionsInterval);
    if (_snipeCheckInterval) clearInterval(_snipeCheckInterval);
    if (_simSyncInterval) clearInterval(_simSyncInterval);
    // 모든 코인�??�나?�핑 ?�?�머 ?�리
    for (const t of Object.values(_snipeTimers)) clearTimeout(t);
    for (const t of Object.values(_snipeCloseTimers)) clearTimeout(t);
    set({ _ratesInterval: null, _positionsInterval: null, _snipeCheckInterval: null, _simSyncInterval: null, _snipeTimers: {}, _snipeCloseTimers: {}, snipeTargets: {}, snipeAllocations: {} });
    flushLogs();
    flushTrades();
  },

  // ?�?� Execute strategy (hedge only) ?�?�?�?�?�?�?�?�?�?�?�?�?�
  async executeStrategy(opportunity, simModeOverride?, investmentOverrideUSDT?) {
    const { apiConfigs, strategyConfig, simBalances, balances } = get();
    const simulationMode = simModeOverride ?? get().simulationMode;
    const plannedInvestmentUSDT = investmentOverrideUSDT ?? strategyConfig.investmentUSDT;

    // Guard: spread check
    const effectiveMinSpread = getEffectiveMinSpread(strategyConfig);
    if (opportunity.spreadPercent < effectiveMinSpread) {
      get().addLog('warning',
        `?�프?�드 ${fmtNum(opportunity.spreadPercent, 4)}%가 최소 기�? ${effectiveMinSpread}% 미만 ??진입 ?�킵`,
        undefined,
        `${opportunity.baseAsset} ${opportunity.shortExchange}??{opportunity.longExchange}`,
      );
      queueTrade({
        timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
        baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
        spreadPercent: opportunity.spreadPercent, reason: `?�프?�드 ${opportunity.spreadPercent.toFixed(4)}% < 최소 ${effectiveMinSpread}%`,
      });
      return { success: false };
    }

    // Guard: ?�수??검�?
    const notionalEst = (() => {
      if (investmentOverrideUSDT != null) return plannedInvestmentUSDT * strategyConfig.leverage;
      if (!strategyConfig.compoundInvesting) return plannedInvestmentUSDT * strategyConfig.leverage;
      if (simulationMode) {
        return Math.min(
          (simBalances[opportunity.shortExchange] ?? 0) * 0.9,
          (simBalances[opportunity.longExchange] ?? 0) * 0.9,
        ) * strategyConfig.leverage;
      } else {
        return Math.min(
          (balances[opportunity.shortExchange]?.availableUSDT ?? 0) * 0.9,
          (balances[opportunity.longExchange]?.availableUSDT ?? 0) * 0.9,
        ) * strategyConfig.leverage;
      }
    })();
    // ?�측 ?�프?�드 기반 ?�익??검�?(effectiveSpread???�시?????�전마진 별도 ?�용)
    const rs = getRealSpreadForOpportunity(get().realSpreads, opportunity);
    const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
    if (hasRS) {
      // ??effectiveSpread?�는 ?�전마진 미포?????�행 ??별도 차감
      const realNetProfit = notionalEst * ((rs.effectiveSpread - SAFETY_MARGIN_PCT) / 100);
      if (realNetProfit <= 0) {
        get().addLog('warning',
          `[?�측 ?�익???�패] ${opportunity.baseAsset} ?�측 ?�스?�레??${fmtNum(rs.effectiveSpread, 4)}% ??0 ??진입 ?�킵`,
          undefined,
          `진입�? ${fmtNum(rs.entryGapPct, 4)}% | ?�리?��?: ??{fmtNum(rs.shortSlippage, 3)}% �?{fmtNum(rs.longSlippage, 3)}%`,
        );
        queueTrade({
          timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
          baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
          spreadPercent: opportunity.spreadPercent, reason: `?�측 ?�익???�패: ?�스?�레??${rs.effectiveSpread.toFixed(4)}% ??0 (?�전마진 ?�함)`,
        });
        return { success: false };
      }
    } else {
      // realSpread ?�으�??�론�?기반 보수??검�?(기존 로직)
      const estFundingRevenue = notionalEst * opportunity.spread;
      const estRoundTripFee = getConfiguredHedgeFees(
        strategyConfig,
        opportunity.shortExchange,
        opportunity.longExchange,
        'taker',
      );
      const estTotalFees = notionalEst * estRoundTripFee;
      if (estFundingRevenue <= estTotalFees) {
        get().addLog('warning',
          `[?�익??검�??�패] ${opportunity.baseAsset} ?�?�수??$${fmtNum(estFundingRevenue)} ???�수�?$${fmtNum(estTotalFees)} ??진입 ?�킵`,
          undefined,
          `?�프?�드: ${fmtNum(opportunity.spreadPercent, 4)}% | ?�요 최소: ${(estRoundTripFee * 100).toFixed(3)}%`,
        );
        queueTrade({
          timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
          baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
          spreadPercent: opportunity.spreadPercent, reason: `?�익???�패: ?�??$${estFundingRevenue.toFixed(2)} ???�수�?$${estTotalFees.toFixed(2)}`,
        });
        return { success: false };
      }
    }

    // Guard: duplicate position ??같�? 코인 중복 진입 방�?
    if (simulationMode) {
      const opportunityLegs = new Set(getOpportunityLegKeys(opportunity));
      const existingPair = get().simPositions.find((position) =>
        getPositionLegKeys(position).some((legKey) => opportunityLegs.has(legKey)),
      );
      if (existingPair) {
        get().addLog('warning',
          `[SIM] ${opportunity.baseAsset} ?��? ?�징 ?��???보유 �???중복 진입 ?�킵`,
          undefined,
          `기존 ?��??? ${existingPair.side.toUpperCase()} @ ${existingPair.exchange.toUpperCase()}`,
        );
        return { success: false };
      }
    }

    // ?�?� Simulation branch ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
    if (simulationMode) {
      try {
        const response = await fetch('/api/sim-execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            opportunity,
            investmentUSDT: plannedInvestmentUSDT,
          }),
        });
        const payload = await response.json().catch(() => null) as {
          success?: boolean;
          error?: string;
          state?: SimStateSnapshot;
        } | null;
        if (!response.ok || !payload?.success) {
          const errorMessage = payload?.error || `HTTP ${response.status}`;
          get().addLog('warning', `[SIM] ${opportunity.baseAsset} ?�버 ?��? 진입 ?�패`, undefined, errorMessage);
          return { success: false, error: errorMessage };
        }

        applyServerSimStateSnapshot(set, payload.state, { force: true });
        return { success: true };
      } catch (error) {
        const errorMessage = (error as Error).message;
        get().addLog('error', `[SIM] ${opportunity.baseAsset} ?�버 ?��? 진입 ?�류`, undefined, errorMessage);
        return { success: false, error: errorMessage };
      }

      const margin = strategyConfig.compoundInvesting && investmentOverrideUSDT == null
        ? Math.min(
            (simBalances[opportunity.shortExchange] ?? 0) * 0.9,
            (simBalances[opportunity.longExchange] ?? 0) * 0.9,
          )
        : plannedInvestmentUSDT;
      const leverage = strategyConfig.leverage;
      if (opportunity.shortMarkPrice <= 0 || opportunity.longMarkPrice <= 0) {
        get().addLog(
          'warning',
          `[SIM] ${opportunity.baseAsset} 진입 ?�킵: ?�효?��? ?��? 마크가�?,
          undefined,
          `??${opportunity.shortExchange.toUpperCase()}: ${opportunity.shortMarkPrice}, �?${opportunity.longExchange.toUpperCase()}: ${opportunity.longMarkPrice}`,
        );
        return { success: false };
      }
      const { shortExchange, longExchange } = opportunity;
      const notional = margin * leverage;
      const shortEntryFee = notional * getConfiguredExchangeFee(strategyConfig, shortExchange, 'taker');
      const shortCostPerSide = margin + shortEntryFee;

      // ?�?� ?�고 부�????�유 거래?�에???��? ?�체 (최소 $1,400 ?��?) ?�?�
      const MIN_BALANCE = plannedInvestmentUSDT; // 거래?�당 최소 ?��? ?�고
      const needsTransfer: { target: ExchangeId; needed: number }[] = [];
      for (const ex of [shortExchange, longExchange]) {
        const bal = simBalances[ex] ?? 0;
        if (bal < shortCostPerSide) {
          // 최소 ?��? ?�고 + 거래 비용 ?�보 (진입 ?�이므�?보수?�으�?short 기�? ?�용)
          const needed = Math.max(shortCostPerSide - bal, MIN_BALANCE - bal);
          needsTransfer.push({ target: ex, needed });
        }
      }
      for (const { target, needed } of needsTransfer) {
        // ?�유 거래??찾기: ?�재 ?��???마진 ?�외????가?�잔고�? 최소?�고 ?�상??거래??
        const currentBalances = get().simBalances;
        const currentPositions = get().simPositions;
        const donors = Object.entries(currentBalances)
          .filter(([exId]) => exId !== target)
          .map(([exId, bal]) => {
            const locked = currentPositions.filter(p => p.exchange === exId).reduce((s, p) => s + p.margin, 0);
            const available = bal - locked;
            return { exId: exId as ExchangeId, surplus: available - MIN_BALANCE };
          })
          .filter(d => d.surplus > 0)
          .sort((a, b) => b.surplus - a.surplus);

        let remaining = needed;
        for (const donor of donors) {
          if (remaining <= 0) break;
          const transfer = Math.min(donor.surplus, remaining);
          set(s => ({
            simBalances: {
              ...s.simBalances,
              [donor.exId]: (s.simBalances[donor.exId] ?? 0) - transfer,
              [target]: (s.simBalances[target] ?? 0) + transfer,
            },
          }));
          get().addLog('info',
            `[SIM] ?��? ?�체: ${donor.exId.toUpperCase()} ??${(target as string).toUpperCase()} $${fmtNum(transfer, 0)}`,
            target,
            `${donor.exId.toUpperCase()} ?�유: $${fmtNum(donor.surplus, 0)} ???�체 ??${(target as string).toUpperCase()} ?�고 ?�보`,
          );
          remaining -= transfer;
        }

        // ?�체 ?�에???�전??부족하�?진입 ?�킵
        if (remaining > 0) {
          get().addLog('warning',
            `[SIM] ${opportunity.baseAsset} 진입 ?�킵: ${(target as string).toUpperCase()} ?�고 부�?,
            target,
            `?�요: $${fmtNum(shortCostPerSide, 0)} | 가?? $${fmtNum((get().simBalances[target] ?? 0), 0)} | ?�체 가?�한 ?�유 거래???�음`,
          );
          return { success: false };
        }
      }

      // ?�?� ?�제 ?��?�?기반 체결가 계산 (?�리?��? 반영) ?�?�
      let shortFillPrice = opportunity.shortMarkPrice;
      let longFillPrice = opportunity.longMarkPrice;
      try {
        const [shortOB, longOB] = await Promise.all([
          fetch(`/api/exchanges/${shortExchange}/orderbook?symbol=${encodeURIComponent(opportunity.shortSymbol)}&side=sell&notional=${notional}`)
            .then(r => r.json()),
          fetch(`/api/exchanges/${longExchange}/orderbook?symbol=${encodeURIComponent(opportunity.longSymbol)}&side=buy&notional=${notional}`)
            .then(r => r.json()),
        ]);
        if (shortOB.success) {
          shortFillPrice = shortOB.fillPrice;
          get().addLog('info', `[SIM] ${opportunity.baseAsset} ??체결가: $${fmtNum(shortFillPrice, 2)} (?�리?��?: ${fmtNum(shortOB.slippagePercent, 4)}%)`, shortExchange);
        }
        if (longOB.success) {
          longFillPrice = longOB.fillPrice;
          get().addLog('info', `[SIM] ${opportunity.baseAsset} �?체결가: $${fmtNum(longFillPrice, 2)} (?�리?��?: ${fmtNum(longOB.slippagePercent, 4)}%)`, longExchange);
        }
      } catch (err) {
        get().addLog('warning', `[SIM] ${opportunity.baseAsset} ?��?�?조회 ?�패 ??마크가�??�용`, undefined, (err as Error).message);
      }

      // ?�?� 진입 �?계산 �?�??�셔??조정 ?�?�
      const entryGapPercent = ((shortFillPrice - longFillPrice) / ((shortFillPrice + longFillPrice) / 2)) * 100;
      get().addLog('info', `[SIM] ${opportunity.baseAsset} 진입 �? ${entryGapPercent.toFixed(4)}% (??$${fmtNum(shortFillPrice, 2)} �?$${fmtNum(longFillPrice, 2)})`);
      // Gap > 0.1% ??�??�셔??조정?�로 ?�쪽 ?�량(계약 ?? ?�치 ???��? 중립
      let adjustedLongNotional = notional;
      if (Math.abs(entryGapPercent) > 0.1) {
        adjustedLongNotional = notional * (longFillPrice / shortFillPrice);
        get().addLog('info', `[SIM] ${opportunity.baseAsset} �??�셔??조정: $${fmtNum(notional, 2)} ??$${fmtNum(adjustedLongNotional, 2)} (?�량 균등??`);
      }

      // ?�?� ?�쪽 별도 ?�수�?마진/비용 계산 ?�?�
      const longEntryFee = adjustedLongNotional * getConfiguredExchangeFee(strategyConfig, longExchange, 'taker');
      const longMargin = adjustedLongNotional / leverage;
      const longCostPerSide = longMargin + longEntryFee;

      const ts = Date.now();
      const pairId = `pair-${ts}-${Math.random().toString(36).slice(2, 8)}`;
      const isSnipe = true;
      const shortPos: SimPosition = {
        simId: `sim-${ts}-short`,
        pairId,
        exchange: shortExchange,
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
        unrealizedPnlPercent: (-shortEntryFee / margin) * 100,
        liquidationPrice: shortFillPrice * (1 + (1 / leverage) * 0.9),
        fundingRate: opportunity.shortRate,
        openedAt: ts,
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
      const longPos: SimPosition = {
        simId: `sim-${ts}-long`,
        pairId,
        exchange: longExchange,
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
        unrealizedPnlPercent: (-longEntryFee / longMargin) * 100,
        liquidationPrice: longFillPrice * (1 - (1 / leverage) * 0.9),
        fundingRate: opportunity.longRate,
        openedAt: ts,
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

      // ?�???�익: �??�리???�제 ?�셔??기�??�로 계산
      const perFunding = notional * opportunity.shortRate - adjustedLongNotional * opportunity.longRate;
      set(s => ({
        simPositions: [...s.simPositions, shortPos, longPos],
        simBalances: {
          ...s.simBalances,
          [shortExchange]: s.simBalances[shortExchange] - shortCostPerSide,
          [longExchange]: s.simBalances[longExchange] - longCostPerSide,
        },
        simTotalFees: s.simTotalFees + shortEntryFee + longEntryFee,
      }));
      // Persist sim state after entry
      const st1 = get();
      saveSimState({ simBalances: st1.simBalances, simInitialBalances: st1.simInitialBalances, simPositions: st1.simPositions, simTotalFundingEarned: st1.simTotalFundingEarned, simTotalTopUps: st1.simTotalTopUps, simTotalFees: st1.simTotalFees, simTotalClosedPnl: st1.simTotalClosedPnl, simClosedPnlPerExchange: st1.simClosedPnlPerExchange, simClosedFeesPerExchange: st1.simClosedFeesPerExchange });
      const totalRoundTripFees = notional * getConfiguredExchangeFee(strategyConfig, shortExchange, 'taker') * 2
        + adjustedLongNotional * getConfiguredExchangeFee(strategyConfig, longExchange, 'taker') * 2; // 진입+�?�� 보수??추정
      const netProfit = perFunding - totalRoundTripFees;
      get().addLog('success',
        `[SIM] ${opportunity.baseAsset} ?�징 진입 ?�료 (${isSnipe ? '?�나?�프' : '?�??})`,
        undefined,
        `??${shortExchange.toUpperCase()} �?${longExchange.toUpperCase()} | isSnipe:${isSnipe} | pairId:${pairId} | 마진:$${fmtNum(margin)} | ?�버리�?:${leverage}x | ?�프?�드:${fmtNum(opportunity.spreadPercent, 4)}% | ?�음?�??${new Date(opportunity.nextFundingTime).toLocaleTimeString('ko-KR')} | 8h?�수?? $${fmtNum(netProfit)} (?�?? $${fmtNum(perFunding)} - ?�수�? $${fmtNum(totalRoundTripFees)})`,
      );
      // Persist trade event
      queueTrade({
        timestamp: Date.now(),
        type: isSnipe ? 'snipe_entry' : 'entry',
        simulation: true,
        baseAsset: opportunity.baseAsset,
        shortExchange,
        longExchange,
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
      });
      return { success: true };
    }

    // ?�?� Real trading branch ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
    const shortConfig = apiConfigs[opportunity.shortExchange];
    const longConfig = apiConfigs[opportunity.longExchange];

    if (!shortConfig) {
      get().addLog('error', `${opportunity.shortExchange.toUpperCase()} API ???�음`, opportunity.shortExchange);
      return { success: false, error: `${opportunity.shortExchange.toUpperCase()} API ???�음` };
    }
    if (!longConfig) {
      get().addLog('error', `${opportunity.longExchange.toUpperCase()} API ???�음`, opportunity.longExchange);
      return { success: false, error: `${opportunity.longExchange.toUpperCase()} API ???�음` };
    }

    let realInvestment = plannedInvestmentUSDT;
    if (strategyConfig.compoundInvesting && investmentOverrideUSDT == null) {
      const shortBal = balances[opportunity.shortExchange]?.availableUSDT ?? 0;
      const longBal = balances[opportunity.longExchange]?.availableUSDT ?? 0;
      realInvestment = Math.min(shortBal, longBal) * 0.9;
      if (realInvestment < plannedInvestmentUSDT) {
        // ?�고 부�???진입 ?�킵 (?�백 ?�음 ???�고 ?�분배로 ?�결?�야 ??
        get().addLog('warning', `[복리] ?�잔�?부�???진입 ?�킵`,
          undefined,
          `??${opportunity.shortExchange.toUpperCase()}): $${fmtNum(shortBal, 0)} | �?${opportunity.longExchange.toUpperCase()}): $${fmtNum(longBal, 0)} | ?�요: $${fmtNum(plannedInvestmentUSDT, 0)}`);
        return { success: false, error: '?�잔�?부�???거래??�??�고 ?�분�??�요' };
      }
    }

    const previewProfit = estimateProfit(opportunity, realInvestment, strategyConfig.leverage, {
      feeOverrides: strategyConfig.feeOverrides,
      paybackOverrides: strategyConfig.paybackOverrides,
      useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
    });
    get().addLog('info',
      `?�략 ?�행 ?�작: ${opportunity.baseAsset} | ??${opportunity.shortExchange.toUpperCase()} �?${opportunity.longExchange.toUpperCase()}`,
      undefined,
      `?�자�? $${fmtNum(realInvestment, 0)} | ?�상 8h?�수?? $${fmtNum(previewProfit.netPerFunding)} (?�수�? -$${fmtNum(previewProfit.totalFees)})`,
    );

    const pairId = `pair-${Date.now()}-${opportunity.baseAsset}`;
    set({ strategyRunning: true });

    try {
      // ?�?� ?�징 ?�거?? ??�??�시 진입 ?�?�
      const res = await fetch('/api/strategy/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunity,
          investmentUSDT: realInvestment,
          leverage: strategyConfig.leverage,
          pairId,
          feeOverrides: strategyConfig.feeOverrides,
          paybackOverrides: strategyConfig.paybackOverrides,
          maxSlippagePercent: strategyConfig.maxSlippagePercent,
          confirmedSnipeConfig: strategyConfig.confirmedSnipeConfig,
          // apiConfigs???�버 �??�호???�?�소?�서 로드 (?�라?�언???�송 X)
        }),
      });

      const json = await res.json() as ExecuteStrategyResult;
      const result: ExecuteStrategyResult = { ...json, pairId: json.pairId ?? pairId };

      // Guard 차단 ?�답 처리 (?�리?��? 초과, ?�익??미달 ??
      if (!result.success && !result.short && !result.long) {
        const { reason, error: errorMsg } = result;
        const detailParts: string[] = [];
        if (
          typeof result.shortSlippage === 'number'
          || typeof result.longSlippage === 'number'
          || typeof result.maxSlippage === 'number'
        ) {
          detailParts.push(
            `shortSlippage:${result.shortSlippage?.toFixed(4) ?? 'n/a'} ` +
            `longSlippage:${result.longSlippage?.toFixed(4) ?? 'n/a'} ` +
            `maxSlippage:${result.maxSlippage?.toFixed(4) ?? 'n/a'}`,
          );
        }
        if (
          typeof result.realNetSpread === 'number'
          || typeof result.entryGapPct === 'number'
          || typeof result.hedgeFeePct === 'number'
        ) {
          detailParts.push(
            `realNetSpread:${result.realNetSpread?.toFixed(4) ?? 'n/a'} ` +
            `entryGapPct:${result.entryGapPct?.toFixed(4) ?? 'n/a'} ` +
            `hedgeFeePct:${result.hedgeFeePct?.toFixed(4) ?? 'n/a'}`,
          );
        }
        get().addLog('warning',
          `${opportunity.baseAsset} 진입 차단: ${errorMsg || '?�전 검�??�패'}`,
          undefined,
          `reason: ${reason || 'unknown'}${detailParts.length > 0 ? ` | ${detailParts.join(' | ')}` : ''}`,
        );
        queueTrade({
          timestamp: Date.now(), type: 'guard_block', simulation: false,
          baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
          spread: opportunity.spread, spreadPercent: opportunity.spreadPercent,
          reason: errorMsg || reason || 'pre_execution_guard',
          detail: detailParts.join(' | ') || undefined,
        });
        set({ strategyRunning: false });
        return result;
      }

      if (result.short?.success) {
        get().addLog('success',
          `${opportunity.shortExchange.toUpperCase()} ???��???진입 ?�공`,
          opportunity.shortExchange,
          `${opportunity.baseAsset} Short @${fmtNum(result.short.data?.price ?? opportunity.shortMarkPrice, 4)} | fee -$${fmtNum(result.short.data?.estimatedFee ?? 0, 4)} | ${result.short.data?.liquidity ?? 'unknown'}`,
        );
      } else {
        get().addLog('error',
          `${opportunity.shortExchange.toUpperCase()} ???��???진입 ?�패`,
          opportunity.shortExchange,
          result.short?.error,
        );
      }

      if (result.long?.success) {
        get().addLog('success',
          `${opportunity.longExchange.toUpperCase()} �??��???진입 ?�공`,
          opportunity.longExchange,
          `${opportunity.baseAsset} Long @${fmtNum(result.long.data?.price ?? opportunity.longMarkPrice, 4)} | fee -$${fmtNum(result.long.data?.estimatedFee ?? 0, 4)} | ${result.long.data?.liquidity ?? 'unknown'}`,
        );
      } else {
        get().addLog('error',
          `${opportunity.longExchange.toUpperCase()} �??��???진입 ?�패`,
          opportunity.longExchange,
          result.long?.error,
        );
      }

      const shortData = result.short?.data;
      const longData = result.long?.data;

      if (result.success && shortData && longData) {
        const openedAt = Date.now();
        set(s => ({
          realPositionMeta: {
            ...s.realPositionMeta,
            [makePositionKey(opportunity.shortExchange, opportunity.shortSymbol, 'short')]: {
              pairId,
              positionType: 'hedge_short',
              openedAt,
              entryFee: shortData.estimatedFee,
              entryOrderLiquidity: shortData.liquidity,
              entryFilledNotional: shortData.filledNotional,
            },
            [makePositionKey(opportunity.longExchange, opportunity.longSymbol, 'long')]: {
              pairId,
              positionType: 'hedge_long',
              openedAt,
              entryFee: longData.estimatedFee,
              entryOrderLiquidity: longData.liquidity,
              entryFilledNotional: longData.filledNotional,
            },
          },
        }));
        saveRealPositionMeta(get().realPositionMeta);
      }

      setTimeout(() => get().refreshAndStampPositions(
        opportunity.baseAsset, [opportunity.shortExchange, opportunity.longExchange],
      ), 2000);
      const expectedPerFunding = shortData && longData
        ? shortData.filledNotional * opportunity.shortRate - longData.filledNotional * opportunity.longRate
        : previewProfit.perFunding;
      const expectedTotalRoundTripFees = shortData && longData
        ? shortData.estimatedFee
          + longData.estimatedFee
          + shortData.filledNotional * getConfiguredExchangeFee(strategyConfig, opportunity.shortExchange, 'taker')
          + longData.filledNotional * getConfiguredExchangeFee(strategyConfig, opportunity.longExchange, 'taker')
        : previewProfit.totalFees;
      const expectedNetProfit = expectedPerFunding - expectedTotalRoundTripFees;
      const executedNotional = shortData && longData
        ? Math.min(shortData.filledNotional, longData.filledNotional)
        : result.short?.data?.filledNotional ?? result.long?.data?.filledNotional ?? (realInvestment * strategyConfig.leverage);

      queueTrade({
        timestamp: Date.now(), type: 'entry', simulation: false,
        baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
        spread: opportunity.spread, spreadPercent: opportunity.spreadPercent,
        margin: realInvestment, leverage: strategyConfig.leverage,
        notional: executedNotional,
        entryFee: (result.short?.data?.estimatedFee ?? 0) + (result.long?.data?.estimatedFee ?? 0),
        netProfit: expectedNetProfit,
        perFunding: expectedPerFunding,
        totalRoundTripFees: expectedTotalRoundTripFees,
        shortPrice: result.short?.data?.price,
        longPrice: result.long?.data?.price,
        shortLiquidity: result.short?.data?.liquidity,
        longLiquidity: result.long?.data?.liquidity,
        detail: `short:${result.short?.success ? 'OK' : result.short?.error} long:${result.long?.success ? 'OK' : result.long?.error}${result.hedgeTrim ? ` | trim:${result.hedgeTrim}` : ''}${result.rollback ? ` | rollback:${result.rollback}` : ''}`,
        success: result.success,
        pairId,
      });
      return result;
    } catch (err) {
      get().addLog('error', '?�략 ?�행 �??�류 발생', undefined, (err as Error).message);
      queueTrade({
        timestamp: Date.now(), type: 'error', simulation: false,
        baseAsset: opportunity.baseAsset, reason: (err as Error).message,
      });
      return { success: false, error: (err as Error).message };
    } finally {
      set({ strategyRunning: false });
    }
  },

  // ?�?� Close position ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  async closePosition(position) {
    const { apiConfigs } = get();
    const config = apiConfigs[position.exchange];
    if (!config) {
      get().addLog('error', `${position.exchange.toUpperCase()} API ???�음`, position.exchange);
      throw new Error(`${position.exchange.toUpperCase()} API ???�음`);
    }

    get().addLog('info', `?��???�?�� ?�도: ${position.displaySymbol} ${position.side}`, position.exchange);

    try {
      const res = await fetch(`/api/exchanges/${position.exchange}/close`, {
        method: 'POST',
        headers: makeApiHeaders(config),
        body: JSON.stringify({
          symbol: position.symbol,
          side: position.side,
          amount: position.size,
          feeOverrides: get().strategyConfig.feeOverrides,
          paybackOverrides: get().strategyConfig.paybackOverrides,
        }),
      });
      const json = await res.json() as { success: boolean; data?: StrategyOrderExecution; error?: string };

      if (json.success && json.data) {
        const entryNotional = position.entryFilledNotional ?? (position.entryPrice * position.size);
        const entryFee = position.entryFee ?? (entryNotional * TAKER_FEE_FALLBACK);
        const exitFee = json.data.estimatedFee;
        const pricePnl = position.side === 'short'
          ? (position.entryPrice - json.data.price) * json.data.amount
          : (json.data.price - position.entryPrice) * json.data.amount;
        const pnl = pricePnl - entryFee - exitFee;
        const pairId = position.pairId;
        const closeResult: ClosePositionResult = {
          ...json.data,
          exchange: position.exchange,
          baseAsset: position.baseAsset,
          symbol: position.symbol,
          side: position.side,
          pairId,
          entryFee,
          exitFee,
          pricePnl,
          pnl,
          fundingAmount: 0,
        };

        get().addLog('success',
          `${position.displaySymbol} ${position.side.toUpperCase()} �?�� ?�료`,
          position.exchange,
          `exit @${fmtNum(json.data.price, 4)} | pricePnL ${pricePnl >= 0 ? '+' : ''}$${fmtNum(pricePnl, 4)} | fees -$${fmtNum(entryFee + exitFee, 4)}`,
        );
        set(s => {
          const nextMeta = { ...s.realPositionMeta };
          delete nextMeta[makePositionKey(position.exchange, position.symbol, position.side)];
          return { realPositionMeta: nextMeta };
        });
        saveRealPositionMeta(get().realPositionMeta);
        queueTrade({
          timestamp: Date.now(),
          type: 'exit',
          simulation: false,
          baseAsset: position.baseAsset,
          exchange: position.exchange,
          side: position.side,
          symbol: position.symbol,
          pairId: pairId ?? `exit-${Date.now()}-${position.baseAsset}`,
          entryFee,
          exitFee,
          pricePnl,
          pnl,
          fundingAmount: 0,
          exitPrice: json.data.price,
          liquidity: json.data.liquidity,
          detail: `entry:${fmtNum(position.entryPrice, 4)} exit:${fmtNum(json.data.price, 4)} amount:${fmtNum(json.data.amount, 6)} liquidity:${json.data.liquidity}`,
        });
        setTimeout(() => get().refreshPositions(), 2000);
        return closeResult;
      } else {
        get().addLog('error', `�?�� ?�패: ${json.error}`, position.exchange);
        throw new Error(`�?�� ?�패: ${json.error}`);
      }
    } catch (err) {
      get().addLog('error', '�?�� �??�류', position.exchange, (err as Error).message);
      throw err;
    }
  },

  // ?�?� Test connection ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  async testConnection(exchange) {
    const config = get().apiConfigs[exchange];
    if (!config) return false;

    get().addLog('info', `${exchange.toUpperCase()} ?�결 ?�스??�?..`, exchange);

    try {
      const res = await fetch(`/api/exchanges/${exchange}/test`, {
        method: 'POST',
        headers: makeApiHeaders(config),
      });
      const json = await res.json() as { success: boolean; error?: string };

      if (json.success) {
        get().addLog('success', `${exchange.toUpperCase()} ?�결 ?�공`, exchange);
      } else {
        get().addLog('error', `${exchange.toUpperCase()} ?�결 ?�패`, exchange, json.error);
      }
      return json.success;
    } catch (err) {
      get().addLog('error', `${exchange.toUpperCase()} ?�결 ?�류`, exchange, (err as Error).message);
      return false;
    }
  },

  // ?�?� Logs ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  addLog(level, message, exchange, detail) {
    const normalizedMessage = normalizeLiveLogField(message);
    if (!normalizedMessage) return;
    const normalizedDetail = normalizeLiveLogField(detail);
    set((s) => {
      const newLogs = [makeLog(level, normalizedMessage, exchange, normalizedDetail || undefined), ...s.logs].slice(0, 500);
      saveLogs(newLogs);
      return { logs: newLogs };
    });
    // Auto-persist to file
    queueLog(level, normalizedMessage, exchange, normalizedDetail || undefined);
  },

  clearLogs() {
    set({ logs: [] });
    saveLogs([]);
  },

  // ?�?� Simulation ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  async toggleSimulationMode() {
    const current = get().simulationMode;
    const next = !current;
    // 모드 ?�환 ???�나?�프�?취소?��? ?�음 ??�?모드가 ?�립?�으�??�시 ?�행
    set({ simulationMode: next, tradesClearedAt: getHistoryResetAtForMode(next) });
    // 모드 ?�태 ?�속??
    saveSimMode(next);
    if (next && get().simPositions.length === 0) {
      // Keep SIM balances aligned with config on SIM mode entry when no open positions.
      void fetch('/api/sim-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reconfigure',
          enabledExchanges: get().enabledExchanges,
          investmentUSDT: get().strategyConfig.investmentUSDT,
        }),
      })
        .then(r => r.json())
        .then((res: { success?: boolean; data?: SimStateSnapshot }) => {
          if (res.success && res.data) {
            applyServerSimStateSnapshot(set, res.data, { force: true });
          }
        })
        .catch(() => {});
    }
    try {
      const sharedState = await updateSharedSnipeStateSnapshot({ simulationMode: next });
      applySharedSnipeStateSnapshot(set, sharedState, { includeActives: false });
      const resolvedMode = sharedState.simulationMode;
      set({ tradesClearedAt: getHistoryResetAtForMode(resolvedMode) });
      saveSimMode(resolvedMode);
      get().addLog(
        'info',
        resolvedMode
          ? `[SIM] shared mode ON ($${get().strategyConfig.investmentUSDT * 2} virtual balance per exchange)`
          : '[REAL] shared mode ON',
      );
    } catch (err) {
      set({ simulationMode: current });
      set({ tradesClearedAt: getHistoryResetAtForMode(current) });
      saveSimMode(current);
      get().addLog('error', '[shared-state] failed to sync SIM/REAL mode', undefined, (err as Error).message);
    }
  },

  resetSimulation() {
    clearPendingPersistenceQueues();
    const perExchange = get().strategyConfig.investmentUSDT * 2; // 거래?�당 ?�자금�? (??�??�쪽)
    const enabled = get().enabledExchanges;
    const newBal = buildExchangeAllocationMap(perExchange, enabled);
    const clearedAt = Date.now();
    const isSimulationMode = get().simulationMode;
    get().cancelSnipe('sim');
    set({
      simPositions: [],
      simBalances: newBal,
      simInitialBalances: { ...newBal },
      simTotalFundingEarned: 0,
      simTotalTopUps: 0,
      simTotalFees: 0,
      simTotalClosedPnl: 0,
      simClosedPnlPerExchange: {},
      simClosedFeesPerExchange: {},
      fundingHistory: [],
      tradesClearedAt: clearedAt,
    });
    clearSimState();
    saveFundingHistory([]);
    if (isSimulationMode) {
      saveSimHistoryResetAt(clearedAt);
    } else {
      saveRealHistoryResetAt(clearedAt);
    }
    void (async () => {
      let simStateCleared = false;
      let tradeHistoryCleared = false;
      let logCleared = false;
      try {
        const res = await fetch('/api/sim-state', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabledExchanges: enabled,
            investmentUSDT: get().strategyConfig.investmentUSDT,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${body}`);
        }
        const payload = await res.json() as { success?: boolean; data?: SimStateSnapshot; error?: string };
        if (!payload.success) {
          throw new Error(payload.error ?? 'sim-state clear failed');
        }
        if (payload.data) {
          applyServerSimStateSnapshot(set, payload.data, { force: true });
        }
        simStateCleared = true;
      } catch (err) {
        get().addLog('warning', '[SIM] 시뮬레이션 상태 초기화 실패', undefined, (err as Error).message);
      }

      try {
        const res = await fetch('/api/trades/clear?includeExecuted=true&includeFundingReceipts=true', { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${body}`);
        }
        const payload = await res.json() as { success?: boolean; error?: string };
        if (!payload.success) {
          throw new Error(payload.error ?? 'trades clear failed');
        }
        tradeHistoryCleared = true;
      } catch (err) {
        get().addLog('warning', '[SIM] 거래 내역 초기화 실패', undefined, (err as Error).message);
      }

      try {
        const res = await fetch('/api/logs/clear', { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${body}`);
        }
        const payload = await res.json() as { success?: boolean; error?: string };
        if (!payload.success) {
          throw new Error(payload.error ?? 'logs clear failed');
        }
        logCleared = true;
      } catch (err) {
        get().addLog('warning', '[SIM] 실시간 로그 초기화 실패', undefined, (err as Error).message);
      }

      if (simStateCleared && tradeHistoryCleared && logCleared) {
        get().addLog('info', '[SIM] 전체 초기화 완료 | 상태/거래내역/로그 모두 삭제');
      } else {
        get().addLog('warning', '[SIM] 초기화 일부 실패. 화면 데이터가 실제 저장소와 다를 수 있습니다.');
      }
    })();
  },

  clearSimFundingHistory() {
    set({ fundingHistory: [] });
    saveFundingHistory([]);
    void fetch('/api/sim-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clearFundingHistory' }),
    }).catch(() => {});
    get().addLog('info', '[SIM] ?�???�령 ?�역 초기???�료');
  },

  async closeSimPosition(simId) {
    try {
      const response = await fetch('/api/sim-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simId }),
      });
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        result?: { netPnl: number; funding: number } | null;
        state?: SimStateSnapshot;
        error?: string;
      } | null;
      if (response.ok && payload?.success) {
        applyServerSimStateSnapshot(set, payload.state, { force: true });
        return payload.result ?? null;
      }
    } catch {
      // fall back to legacy local simulation close path
    }

    const pos = get().simPositions.find(p => p.simId === simId);
    if (!pos) return null;

    // ?�?� ?�제 ?��?�?기반 �?�� 체결가 (?�리?��? 반영) ?�?�
    let exitPrice = pos.markPrice;
    try {
      const exitSide = pos.side === 'short' ? 'buy' : 'sell';
      const res = await fetch(`/api/exchanges/${pos.exchange}/orderbook?symbol=${encodeURIComponent(pos.symbol)}&side=${exitSide}&notional=${pos.sizeUSD}`).then(r => r.json());
      if (res.success) {
        exitPrice = res.fillPrice;
        get().addLog('info', `[SIM] ${pos.baseAsset} ${pos.side} �?�� 체결가: $${fmtNum(exitPrice, 2)} (?�리?��?: ${fmtNum(res.slippagePercent, 4)}%)`, pos.exchange);
      }
    } catch {
      // ?��?�?조회 ?�패 ??markPrice ?�용
    }

    const exitNotional = pos.size * exitPrice; // ?�재 가�?기반 ?�제 �?�� ?�셔??
    const exitFee = exitNotional * getConfiguredExchangeFee(get().strategyConfig, pos.exchange, 'taker');
    const pricePnl = pos.side === 'short'
      ? (pos.entryPrice - exitPrice) * pos.size
      : (exitPrice - pos.entryPrice) * pos.size;

    // ?�?� ?�나?�프 ?�??직접 계산 (tickSimFunding ?�존 X) ?�?�
    let actualFunding = pos.fundingCollected;
    if (pos.isSnipe && actualFunding === 0) {
      // tickSimFunding?�서 처리 �???경우 직접 계산
      // ??진입 ?�점 fundingRate ?�용 ??�?�� ?�점 liveRate???��? ?�음 주기�?갱신?�을 ???�음
      const currentRate = pos.fundingRate;
      actualFunding = pos.side === 'short'
        ? pos.sizeUSD * currentRate
        : pos.sizeUSD * (-currentRate);
      // ?�고?�도 반영
      set(s => ({
        simBalances: { ...s.simBalances, [pos.exchange]: (s.simBalances[pos.exchange] ?? 0) + actualFunding },
        simTotalFundingEarned: s.simTotalFundingEarned + actualFunding,
      }));
      get().addLog('info',
        `[SIM] ?�??직접 계산: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        pos.exchange,
        `$${fmtNum(Math.abs(actualFunding), 4)} (rate: ${fmtNum(currentRate * 100, 4)}%)`,
      );
    }

    const returnAmount = pos.margin + pricePnl - exitFee;
    const netPnl = pricePnl + actualFunding - (pos.entryFee ?? 0) - exitFee;

    // ?�?� ?�???�령 ?�역 기록: tickSimFunding???��? 기록??경우 ?�킵 (fallback 직접계산??경우�?기록) ?�?�
    const alreadyRecordedByTick = pos.fundingCollected > 0 && actualFunding === pos.fundingCollected;
    const fundingPayment: FundingPayment | null = (actualFunding !== 0 && !alreadyRecordedByTick)
      ? { exchange: pos.exchange, symbol: pos.symbol, amount: actualFunding, rate: pos.fundingRate, timestamp: Date.now(), side: pos.side }
      : null;

    const closedPosEntryFee = pos.entryFee ?? 0;
    set(s => {
      const newHistory = fundingPayment ? [fundingPayment, ...s.fundingHistory] : s.fundingHistory;
      if (fundingPayment) saveFundingHistory(newHistory);
      return {
        simPositions: s.simPositions.filter(p => p.simId !== simId),
        simBalances: { ...s.simBalances, [pos.exchange]: s.simBalances[pos.exchange] + returnAmount },
        fundingHistory: newHistory,
        simTotalFees: s.simTotalFees + exitFee,
        simTotalClosedPnl: s.simTotalClosedPnl + pricePnl,
        simClosedPnlPerExchange: {
          ...s.simClosedPnlPerExchange,
          [pos.exchange]: (s.simClosedPnlPerExchange[pos.exchange] ?? 0) + pricePnl,
        },
        simClosedFeesPerExchange: {
          ...s.simClosedFeesPerExchange,
          [pos.exchange]: (s.simClosedFeesPerExchange[pos.exchange] ?? 0) + closedPosEntryFee + exitFee,
        },
      };
    });
    // Persist sim state after close
    const st2 = get();
    saveSimState({ simBalances: st2.simBalances, simInitialBalances: st2.simInitialBalances, simPositions: st2.simPositions, simTotalFundingEarned: st2.simTotalFundingEarned, simTotalTopUps: st2.simTotalTopUps, simTotalFees: st2.simTotalFees, simTotalClosedPnl: st2.simTotalClosedPnl, simClosedPnlPerExchange: st2.simClosedPnlPerExchange, simClosedFeesPerExchange: st2.simClosedFeesPerExchange });
    get().addLog(netPnl >= 0 ? 'success' : 'warning',
      `[SIM] ?��???�?��: ${pos.displaySymbol} ${pos.side.toUpperCase()}`,
      pos.exchange,
      `?�손?? ${netPnl >= 0 ? '+' : ''}$${fmtNum(netPnl)} (?�?? $${fmtNum(actualFunding, 4)}, 가격손?? $${fmtNum(pricePnl)}, ?�수�? -$${fmtNum((pos.entryFee ?? 0) + exitFee)})`,
    );
    queueTrade({
      timestamp: Date.now(), type: pos.isSnipe ? 'snipe_exit' : 'exit', simulation: true,
      baseAsset: pos.baseAsset, exchange: pos.exchange, side: pos.side, symbol: pos.symbol,
      pnl: netPnl, fundingAmount: actualFunding, exitFee,
      entryFee: pos.entryFee ?? 0, pricePnl,
      detail: `margin:$${pos.margin.toFixed(2)} size:${pos.size.toFixed(6)} entry:${pos.entryPrice} exit:${exitPrice}`,
    });
    return { netPnl, funding: actualFunding };
  },

  tickSimFunding() {
    const { simPositions, fundingRates } = get();
    if (simPositions.length === 0) return;
    const now = Date.now();

    let totalNewFunding = 0;
    const balanceDeltaHedge: Partial<Record<ExchangeId, number>> = {};
    const pendingLogs: { level: LogLevel; message: string; exchange: ExchangeId; detail: string }[] = [];
    const simFundingPayments: FundingPayment[] = [];

    const updated = simPositions.map(pos => {
      if (pos.nextFundingTime > now) return pos;
      const liveRate = fundingRates.find(
        r => r.exchange === pos.exchange && r.symbol === pos.symbol,
      );
      const currentRate = liveRate?.rate ?? pos.fundingRate;
      const funding = pos.side === 'short'
        ? pos.sizeUSD * currentRate
        : pos.sizeUSD * (-currentRate);
      totalNewFunding += funding;
      balanceDeltaHedge[pos.exchange] = (balanceDeltaHedge[pos.exchange] ?? 0) + funding;
      pendingLogs.push({
        level: funding >= 0 ? 'success' : 'warning',
        message: `[SIM] ?�??${funding >= 0 ? '?�령' : '지�?}: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        exchange: pos.exchange,
        detail: `$${fmtNum(Math.abs(funding), 4)} (${fmtNum(currentRate * 100, 4)}%${liveRate ? '' : ' [진입?�rate]'})`,
      });
      queueTrade({
        timestamp: Date.now(), type: 'funding', simulation: true,
        baseAsset: pos.baseAsset, exchange: pos.exchange, side: pos.side, symbol: pos.symbol,
        fundingAmount: funding, fundingRate: currentRate,
        detail: `sizeUSD:$${pos.sizeUSD.toFixed(2)} cumulative:$${(pos.fundingCollected + funding).toFixed(4)}`,
      });
      simFundingPayments.push({
        exchange: pos.exchange,
        symbol: pos.symbol,
        amount: funding,
        rate: currentRate,
        timestamp: Date.now(),
        side: pos.side,
      });
      return {
        ...pos,
        fundingRate: currentRate,
        fundingCollected: pos.fundingCollected + funding,
        nextFundingTime: pos.nextFundingTime + (pos.fundingIntervalMs ?? 8 * 3600 * 1000),
        fundingReceived: (pos.fundingReceived ?? 0) + 1,
      };
    });

    const snipeToClose = updated.filter(p => p.isSnipe && (p.fundingReceived ?? 0) >= 1);

    // ?�버�? ?�나?�프 ?�동�?�� ?�단 로그
    if (updated.some(p => p.isSnipe)) {
      const snipePositions = updated.filter(p => p.isSnipe);
      for (const p of snipePositions) {
        if ((p.fundingReceived ?? 0) >= 1) {
          pendingLogs.push({
            level: 'info',
            message: `[?�나?�프 �?��?��? ${p.baseAsset} ${p.side} ??fundingReceived:${p.fundingReceived} ???�동�?�� ?�정`,
            exchange: p.exchange,
            detail: `simId:${p.simId} | pairId:${p.pairId} | ?�령?�??$${fmtNum(p.fundingCollected, 4)}`,
          });
        }
      }
    }

    set(s => {
      const newBal = { ...s.simBalances };
      for (const [ex, delta] of Object.entries(balanceDeltaHedge)) {
        newBal[ex as ExchangeId] = (newBal[ex as ExchangeId] ?? 0) + (delta as number);
      }
      const newHistory = simFundingPayments.length > 0
        ? [...simFundingPayments, ...s.fundingHistory]
        : s.fundingHistory;
      if (simFundingPayments.length > 0) saveFundingHistory(newHistory);
      return {
        simPositions: updated,
        simBalances: newBal,
        simTotalFundingEarned: s.simTotalFundingEarned + totalNewFunding,
        fundingHistory: newHistory,
      };
    });

    // Persist sim state after update
    const st3 = get();
    saveSimState({ simBalances: st3.simBalances, simInitialBalances: st3.simInitialBalances, simPositions: st3.simPositions, simTotalFundingEarned: st3.simTotalFundingEarned, simTotalTopUps: st3.simTotalTopUps, simTotalFees: st3.simTotalFees, simTotalClosedPnl: st3.simTotalClosedPnl, simClosedPnlPerExchange: st3.simClosedPnlPerExchange, simClosedFeesPerExchange: st3.simClosedFeesPerExchange });

    // #3: Add logs after state update to avoid mutation during iteration
    for (const log of pendingLogs) {
      get().addLog(log.level, log.message, log.exchange, log.detail);
    }

    // ?�레그램: ?�???�익 ?�림 (?�산 메시지)
    if (simFundingPayments.length > 0 && totalNewFunding !== 0) {
      const lines = simFundingPayments.map(p =>
        `  ${p.exchange.toUpperCase()} ${p.symbol} (${p.side}): ${p.amount >= 0 ? '+' : ''}$${p.amount.toFixed(4)}`
      );
      const icon = totalNewFunding >= 0 ? '?��' : '?��';
      void sendTelegramMessage([
        `${icon} <b>[SIM] ?�???�령: ${simFundingPayments.length}�?/b>`,
        ...lines,
        `\n?�계: ${totalNewFunding >= 0 ? '+' : ''}$${totalNewFunding.toFixed(4)}`,
      ].join('\n'));
    }

    // ?�레그램: ?�고 부�?경고 (?�균 ?��?50% ?�하, 30�?쿨다??
    {
      const st = get();
      const bals = st.enabledExchanges.map(ex => ({
        name: ex,
        balance: (st.simBalances[ex] ?? 0),
      }));
      const avg = bals.reduce((s, b) => s + b.balance, 0) / (bals.length || 1);
      if (avg > 0 && Date.now() - _lastBalanceWarnAt > 30 * 60 * 1000) {
        for (const b of bals) {
          if (b.balance < avg * 0.5) {
            _lastBalanceWarnAt = Date.now();
            void sendTelegramMessage(formatBalanceWarning({
              lowExchange: b.name,
              lowBalance: b.balance,
              avgBalance: avg,
              exchanges: bals,
              simulation: true, // tickSimFunding?� ??�� SIM ?�용
            }));
            break;
          }
        }
      }
    }

    // ?�나?�핑: ?�???�령 ?�료 ??즉시 �?�� ???�음 ?�이???�예??
    if (snipeToClose.length > 0) {
      queueMicrotask(async () => {
        // ?��????�기 ?�에 pair ?�보 캡처 (?��? ?�에??simPositions?�서 ?�라�?
        const positionsSnapshot = [...get().simPositions];

        // �?�� ???�제 결과�??�집
        const closeResults: { pos: typeof snipeToClose[0]; result: { netPnl: number; funding: number } | null }[] = [];
        for (const pos of snipeToClose) {
          const result = await get().closeSimPosition(pos.simId);
          closeResults.push({ pos, result });
        }
        const totalCollected = snipeToClose.reduce((s, p) => s + p.fundingCollected, 0);
        get().addLog('success',
          `[?�나?�핑] ?�???�령 ?�료 ??${snipeToClose.length}�??��????�동 �?��`,
          undefined,
          `�??�령: $${fmtNum(totalCollected, 4)}`,
        );

        // ?�레그램: ?�나?�프 ?�료 ?�림 ???�제 �?�� 결과(fillPrice 기반 netPnl) ?�용
        const byAsset = new Map<string, { short: string; long: string; funding: number; pnl: number }>();
        for (const { pos, result } of closeResults) {
          const pair = positionsSnapshot.find(p => p.pairId === pos.pairId && p.simId !== pos.simId);
          const key = pos.baseAsset;
          const prev = byAsset.get(key) ?? { short: '?', long: '?', funding: 0, pnl: 0 };
          if (pos.side === 'short') prev.short = pos.exchange;
          else prev.long = pos.exchange;
          if (pair) {
            if (pair.side === 'short') prev.short = pair.exchange;
            else prev.long = pair.exchange;
          }
          prev.funding += result?.funding ?? pos.fundingCollected;
          prev.pnl += result?.netPnl ?? 0;
          byAsset.set(key, prev);
        }
        for (const [asset, info] of byAsset) {
          void sendTelegramMessage(formatSnipeCompleteAlert({
            baseAsset: asset,
            shortExchange: info.short,
            longExchange: info.long,
            fundingCollected: info.funding,
            pnl: info.pnl,
            simulation: true, // tickSimFunding?� SIM ?�용
          }));
        }

        // �?��??코인???�?�머 ?�리 + ?�음 ?�이???�동 ?�예??
        const closedKeys = [...new Set(
          snipeToClose.map((position) => getSimPositionOpportunityKey(position, positionsSnapshot)),
        )];
        for (const key of closedKeys) {
          get().cancelSnipeForAsset(mkSnipeKey(true, key)); // tickSimFunding?� SIM ?�용
        }
        if (get().simSnipeActive || get().realSnipeActive) {
          get().scheduleAllSnipes();
        }
      });
    }

    // ?�?? ?�프?�드 ??�� 감�? ???�동 �?��
  },

  // ?�?� Exchange Toggle ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  toggleExchange(exchange) {
    const { enabledExchanges, simPositions } = get();
    if (!isExchangeOperable(exchange)) {
      get().addLog('warning', `${exchange.toUpperCase()} currently disabled`, exchange);
      return;
    }

    // ?�당 거래?�에 ?�린 ?��??�이 ?�으�?OFF 불�? (?��? + ?�거??모두 체크)
    if (enabledExchanges.includes(exchange)) {
      const hasSimPositions = simPositions.some(p => p.exchange === exchange);
      const hasRealPositions = get().positions.some(p => p.exchange === exchange);
      if (hasSimPositions || hasRealPositions) {
        get().addLog('warning',
          `${exchange.toUpperCase()} OFF 불�? ???�린 ?��??�이 ?�습?�다`,
          exchange,
          '?��??�을 먼�? �?��?�세??,
        );
        return;
      }
    }

    let next: ExchangeId[];
    if (enabledExchanges.includes(exchange)) {
      // OFF: 최소 2개는 ?��??�야 ?�징 가??
      if (enabledExchanges.length <= 2) {
        get().addLog('warning', '최소 2�?거래?��? ?�요?�니????비활?�화 불�?');
        return;
      }
      next = enabledExchanges.filter(e => e !== exchange);
    } else {
      // ON
      next = [...enabledExchanges, exchange];
    }
    next = sanitizeEnabledExchanges(next, enabledExchanges);

    // Smart sim balance redistribution ??preserve position margins
    const lockedPerExchangeHedge: Partial<Record<ExchangeId, number>> = {};
    for (const pos of simPositions) {
      lockedPerExchangeHedge[pos.exchange] = (lockedPerExchangeHedge[pos.exchange] ?? 0) + pos.margin;
    }

    const newBal = { ...get().simBalances };

    function redistributePool(
      pool: Record<ExchangeId, number>,
      lockedPerEx: Partial<Record<ExchangeId, number>>,
    ): Record<ExchangeId, number> {
      const p = { ...pool };
      if (enabledExchanges.includes(exchange)) {
        // OFF: redistribute disabled exchange's free balance to remaining
        const freedBal = p[exchange] ?? 0;
        p[exchange] = 0;
        const perRemaining = freedBal / next.length;
        for (const ex of next) {
          p[ex] = (p[ex] ?? 0) + perRemaining;
        }
      } else {
        // ON: redistribute only free (non-locked) balance equally
        let totalFree = 0;
        for (const ex of enabledExchanges) {
          const locked = lockedPerEx[ex] ?? 0;
          totalFree += Math.max(0, (p[ex] ?? 0) - locked);
        }
        const freePerExchange = totalFree / next.length;
        for (const ex of SUPPORTED_EXCHANGES) {
          if (next.includes(ex)) {
            const locked = lockedPerEx[ex] ?? 0;
            p[ex] = freePerExchange + locked;
          } else {
            p[ex] = 0;
          }
        }
      }
      return p;
    }

    const updatedBal = redistributePool(newBal, lockedPerExchangeHedge);

    const filteredRates = get().fundingRates.filter(rate => next.includes(rate.exchange));
    set(s => ({
      enabledExchanges: next,
      simBalances: updatedBal,
      fundingRates: filteredRates,
      opportunities: buildOpportunitiesFromRates(filteredRates, s.strategyConfig, s),
    }));
    saveEnabledExchanges(next);

    const action = enabledExchanges.includes(exchange) ? 'OFF' : 'ON';
    const totalSim = Object.values(updatedBal).reduce((s, v) => s + v, 0);
    get().addLog('info',
      `${exchange.toUpperCase()} ${action} ???�성 ${next.length}�?거래??,
      exchange,
      `?��? �??�산: $${fmtNum(totalSim, 0)} (?��???마진 보존??`,
    );

    // 즉시 ???�정?�로 ?�?�률 갱신
    if (get().realSnipeActive) {
      void syncServerSchedulerConfig(get().strategyConfig, next, get().addLog);
    }
    void fetch('/api/sim-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reconfigure',
        enabledExchanges: next,
        investmentUSDT: get().strategyConfig.investmentUSDT,
      }),
    }).then(r => r.json()).then((res: { success?: boolean; data?: SimStateSnapshot }) => {
      if (res.success && res.data) {
        applyServerSimStateSnapshot(set, res.data, { force: true });
      }
    }).catch(() => {});
    if (get().simSnipeActive) {
      void syncServerSimSchedulerConfig(get().strategyConfig, next, get().addLog);
    }
    get().refreshRates();
  },

  // ?�?� UI ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
  setShowApiPanel: (v) => set({ showApiPanel: v }),
  setShowStrategyPanel: (v) => set({ showStrategyPanel: v }),
  setRateFilter: (v) => set({ rateFilter: v }),
  setExchangeFilter: (v) => set({ exchangeFilter: v }),
  setPositionToClose: (v) => set({ positionToClose: v }),

  // ?�?� ?�약 코인 ?�시�??��?�? 1�?간격 체크 ??netProfit ??0 즉시 ?�제 + ??좋�? 기회�?교체 ?�?�
  revalidateScheduledSnipes() {
    const {
      snipeTargets,
      snipeAllocations,
      opportunities,
      strategyConfig,
      realSpreads: currentRealSpreads,
      simBalances,
      balances: realBalances,
      simPositions,
      positions,
    } = get();
    const snipeKeys = Object.keys(snipeTargets);
    if (snipeKeys.length === 0) return;

    const effectiveMinPercent = getEffectiveMinSpread(strategyConfig);

    // ?�슬리피지+?�수�?반영 ?�수??계산 ?�퍼 (복리 ???�잔�?기반 notional)
    const getLiveNetProfit = (
      opp: ArbitrageOpportunity,
      isSim: boolean,
      investmentOverrideUSDT?: number,
    ): number => {
      const notional = getEffectiveNotional(
        opp,
        strategyConfig,
        simBalances,
        realBalances,
        isSim,
        investmentOverrideUSDT,
      );
      const rs = getRealSpreadForOpportunity(currentRealSpreads, opp);
      const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
      // realSpread ?�으�?보수?�으�?-1 반환 (?�론�?진입 금�?)
      if (!hasRS) return -1;
      // effectiveSpread???�리?��?+?�수�?모두 반영??
      return notional * (rs.effectiveSpread / 100);
    };

    for (const key of snipeKeys) {
      const { isSim, opportunityId } = parseSnipeKey(key);
      const currentOpp = findOpportunityById(opportunities, opportunityId);
      const asset = currentOpp?.baseAsset ?? opportunityId;
      const scheduledInvestmentUSDT = snipeAllocations[key] ?? strategyConfig.investmentUSDT;
      const occupiedLegs = new Set<string>();

      const activePositions = isSim ? simPositions : positions;
      for (const position of activePositions) {
        if (position.positionType === 'manual') continue;
        getPositionLegKeys(position).forEach((legKey) => occupiedLegs.add(legKey));
      }

      for (const [otherKey] of Object.entries(snipeTargets)) {
        if (otherKey === key) continue;
        const otherTarget = parseSnipeKey(otherKey);
        if (otherTarget.isSim !== isSim) continue;
        const scheduledOpp = findOpportunityById(opportunities, otherTarget.opportunityId);
        if (!scheduledOpp) continue;
        getOpportunityLegKeys(scheduledOpp).forEach((legKey) => occupiedLegs.add(legKey));
      }

      const targetTime = snipeTargets[key];

      // ?�당 모드가 비활?�이�??�리
      if (isSim && !get().simSnipeActive) {
        if (currentOpp) {
          emitScheduleProbeDecision(currentOpp, isSim, {
            status: 'rejected',
            selected: false,
            reason: 'scheduler_inactive',
            detail: 'sim_snipe_inactive',
            targetFundingTime: targetTime,
          });
        }
        get().cancelSnipeForAsset(key);
        continue;
      }
      if (!isSim && !get().realSnipeActive) {
        if (currentOpp) {
          emitScheduleProbeDecision(currentOpp, isSim, {
            status: 'rejected',
            selected: false,
            reason: 'scheduler_inactive',
            detail: 'real_snipe_inactive',
            targetFundingTime: targetTime,
          });
        }
        get().cancelSnipeForAsset(key);
        continue;
      }

      // ?�??15�??�이�?lock-in ???��?�??�킵 (?�이??컨디??방�?)
      if (targetTime && targetTime - Date.now() < 15_000) continue;

      if (!currentOpp) {
        get().addLog('warning', `[?��?�? ${asset} 기회 ?�멸 ???�약 ?�제`);
        const parsed = parseSnipeKey(key);
        queueTrade({
          timestamp: Date.now(),
          type: 'schedule_probe',
          simulation: isSim,
          reason: 'funding_revalidate_missing',
          detail: 'opportunity_not_found_in_latest_snapshot',
          analysis: {
            opportunityId: parsed.opportunityId,
            status: 'rejected',
            selected: false,
            rejectReasons: ['funding_revalidate_missing'],
            timeToFundingMs: Number.isFinite(targetTime) ? Math.max(0, targetTime - Date.now()) : undefined,
          },
          timeToFundingMs: Number.isFinite(targetTime) ? Math.max(0, targetTime - Date.now()) : undefined,
        });
        get().cancelSnipeForAsset(key);
        continue;
      }

      // ?�효?�프?�드(?�더�??�리?��? 반영) 기�? ?�수???�계??
      const realSpreadData = getRealSpreadForOpportunity(currentRealSpreads, currentOpp);
      const hasRealSpreadData = realSpreadData && Date.now() - realSpreadData.updatedAt < 30_000;
      const effectiveSpreadPercent = hasRealSpreadData
        ? realSpreadData.effectiveSpread
        : calcNetSpreadPercent(
          currentOpp.spreadPercent,
          0,
          getConfiguredHedgeFees(
            strategyConfig,
            currentOpp.shortExchange,
            currentOpp.longExchange,
            'taker',
          ) * 100,
        );
      const oppNotional = getEffectiveNotional(
        currentOpp,
        strategyConfig,
        simBalances,
        realBalances,
        isSim,
        scheduledInvestmentUSDT,
      );
      // effectiveSpread???�시???�전마진 미포?? ???�행 ?�단 ???�전마진 별도 차감
      const liveNetProfit = oppNotional * ((effectiveSpreadPercent - SAFETY_MARGIN_PCT) / 100);

      // ?�수????0 ???�제 ??진입 기�?(3bps)�??�일???�전마진 ?�용
      if (liveNetProfit <= 0) {
        get().addLog('warning',
          `[?��?�? ${asset} ?�수??기�? 미달 ???�약 ?�제`,
          undefined,
          `?�효?�프?�드: ${fmtNum(effectiveSpreadPercent, 4)}% | ?�수?? $${fmtNum(liveNetProfit)}`,
        );
        emitScheduleProbeDecision(currentOpp, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'profitability_scan_failed',
          detail: `net_profit_non_positive:${fmtNum(liveNetProfit, 4)}`,
          targetFundingTime: targetTime,
        });
        get().cancelSnipeForAsset(key);
        continue;
      }

      // 10%+ ??좋�? 기회 발견 ??교체 (?�슬리피지 반영 ?�수??기�?)
      // ?? ????? ?�???�점?�로 갈아?�지 ?�게 ?�한?�다.
      // ???�보??realSpread가 ?�으�??�론�?과�??��? ??교체?�해??루프 방�?
      const MAX_REPLACEMENT_DELAY_MS = 10 * 60 * 1000;
      const betterOpp = opportunities.find(o => {
        if (getOpportunityId(o) === opportunityId) return false;
        // 같�? 모드?�서 ?��? ?�약??
        if (snipeTargets[mkSnipeKey(isSim, getOpportunityId(o))]) return false;
        if (opportunityConflictsWithLegs(o, occupiedLegs)) return false;
        if (o.spreadPercent < effectiveMinPercent) return false;
        if ((o.nextFundingTime - targetTime) > MAX_REPLACEMENT_DELAY_MS) return false;
        // ??realSpread ?�는 ?�보??교체 ?�?�에???�외 (?�론�?과�??��? 방�?)
        const candidateRs = getRealSpreadForOpportunity(currentRealSpreads, o);
        const hasRealSpread = candidateRs && Date.now() - candidateRs.updatedAt < 30_000;
        if (!hasRealSpread) return false;
        const candidateNetProfit = getLiveNetProfit(o, isSim);
        if (candidateNetProfit <= 0) return false;
        return (candidateNetProfit - liveNetProfit) / liveNetProfit >= 0.10;
      });

      if (betterOpp) {
        const betterLiveNet = getLiveNetProfit(betterOpp, isSim);
        const improvePct = ((betterLiveNet - liveNetProfit) / liveNetProfit * 100).toFixed(1);
        get().addLog('info',
          `[교체] ${asset}($${fmtNum(liveNetProfit)}) ??${betterOpp.baseAsset}($${fmtNum(betterLiveNet)}) +${improvePct}%`,
          undefined,
          `?�효?�프?�드 ?�인??,
        );
        emitScheduleProbeDecision(currentOpp, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'replaced_by_better_candidate',
          detail: `replaced_by:${betterOpp.baseAsset}|improve:${improvePct}%`,
          targetFundingTime: targetTime,
        });
        get().cancelSnipeForAsset(key);
        get().scheduleSnipeForAsset(betterOpp, isSim);
      }
    }
  },

  // ?�?� ?�루 ?�나?�핑: 코인�??�립 ?�?�머 ???�??7�???진입 ???�령 ?�인 ??즉시 �?�� ?�?�

  // ?�??주기�?1h/4h/8h) 버킷 ?�운?�로�???짧�? 주기 ?�선 보장
  // �??�성 모드(sim/real)???�???�립?�으�??��?줄링
  scheduleAllSnipes() {
    // SIM: ?�라?�언???�?�머�??��?줄링
    // REAL: ?�버 ?��?줄러가 ?�담 ???�라?�언?�에??중복 ?�?�머 ?�성?��? ?�음
    if (get().simSnipeActive) {
      void fetchServerSimSchedulerStatus()
        .then((status) => {
          applyServerSimStateSnapshot(set, status.state, { getState: get });
          set({
            simSnipeActive: !!status.active,
            snipeTargets: {
              ...Object.fromEntries(
                Object.entries(get().snipeTargets).filter(([key]) => !key.startsWith('sim:')),
              ),
              ...(status.snipeTargets ?? {}),
            },
            snipeAllocations: {
              ...Object.fromEntries(
                Object.entries(get().snipeAllocations).filter(([key]) => !key.startsWith('sim:')),
              ),
              ...(status.snipeAllocations ?? {}),
            },
          });
        })
        .catch(() => {});
    }
  },

  // ?��?: ?�정 모드???�???��?줄링
  _scheduleSnipesForMode(isSim: boolean) {
    const {
      opportunities,
      enabledExchanges: currentEnabled,
      snipeTargets,
      snipeAllocations,
      simPositions,
      positions,
      strategyConfig,
      fundingRates,
    } = get();
    const effectiveMinPercent = getEffectiveMinSpread(strategyConfig);
    const modePrefix = isSim ? 'sim' : 'real';

    // ?��? ?�약?�었거나 ?�성 ?��??�이 ?�힌 ?�그???�시 ?�우지 ?�는??
    const now = Date.now();
    const occupiedLegs = new Set<string>();
    for (const key of Object.keys(snipeTargets).filter((snipeKey) => snipeKey.startsWith(`${modePrefix}:`))) {
      const scheduledOpp = findOpportunityById(opportunities, parseSnipeKey(key).opportunityId);
      if (!scheduledOpp) continue;
      getOpportunityLegKeys(scheduledOpp).forEach((legKey) => occupiedLegs.add(legKey));
    }
    for (const position of (isSim ? simPositions : positions)) {
      if (position.positionType === 'manual') continue;
      getPositionLegKeys(position).forEach((legKey) => occupiedLegs.add(legKey));
    }

    const { realSpreads: preFilterRealSpreads } = get();

    const filterReasons = { legConflict: 0, exchangeDisabled: 0, tooFarAhead: 0, pastFunding: 0, lowSpread: 0, noProfit: 0 };

    const filtered = opportunities.filter(o => {
      if (opportunityConflictsWithLegs(o, occupiedLegs)) {
        filterReasons.legConflict++;
        emitScheduleProbeDecision(o, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'leg_occupied',
          detail: 'leg_conflict_with_active_or_scheduled',
          targetFundingTime: o.nextFundingTime,
        });
        return false;
      }
      if (!currentEnabled.includes(o.shortExchange) || !currentEnabled.includes(o.longExchange)) {
        filterReasons.exchangeDisabled++;
        emitScheduleProbeDecision(o, isSim, {
          status: 'rejected',
          selected: false,
          reason: !currentEnabled.includes(o.shortExchange) ? 'short_exchange_disabled' : 'long_exchange_disabled',
          detail: `${o.shortExchange}/${o.longExchange} disabled`,
          targetFundingTime: o.nextFundingTime,
        });
        return false;
      }
      if (o.nextFundingTime - now > getScheduleAheadWindowMs(o)) {
        filterReasons.tooFarAhead++;
        emitScheduleProbeDecision(o, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'outside_schedule_window',
          detail: `time_to_funding_ms:${Math.max(0, o.nextFundingTime - now)}`,
          targetFundingTime: o.nextFundingTime,
        });
        return false;
      }
      // 과거 ?�???�간�?차단 (normalizeFr?�서 ?��? 보정?��?�??�전?�치)
      if (o.nextFundingTime < now) {
        filterReasons.pastFunding++;
        emitScheduleProbeDecision(o, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'funding_time_past',
          detail: `past_by_ms:${now - o.nextFundingTime}`,
          targetFundingTime: o.nextFundingTime,
        });
        return false;
      }
      // ?�약 ?�계: realSpread ?�으�??�익?��? getLiveNetProfit(3bps ?�함)?�서 검�???minSpread???�론값에�??�용
      // effectiveSpread???��? ?�수�??�리?��? 차감 ?�료값이므�?minSpread(?�수�??�함)?� 비교?�면 ?�중 ?�터
      const rs = getRealSpreadForOpportunity(preFilterRealSpreads, o);
      const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
      // ???�동???�터: 개별 ?�리?��? ?�는 거래??�?가�?괴리가 maxSlippagePercent ?�상?�면 차단
      const maxSlip = strategyConfig.maxSlippagePercent ?? 1.5;
      if (hasRS && (rs.shortSlippage > maxSlip || rs.longSlippage > maxSlip)) {
        filterReasons.noProfit++;
        emitScheduleProbeDecision(o, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'profitability_scan_failed',
          detail: `slippage_exceeded short:${fmtNum(rs.shortSlippage, 4)} long:${fmtNum(rs.longSlippage, 4)} max:${fmtNum(maxSlip, 4)}`,
          targetFundingTime: o.nextFundingTime,
        });
        return false;
      }
      // effectiveSpread ??0?�면 ?�리?��?+?�수�?> ?�???�익
      if (hasRS && rs.effectiveSpread <= 0) {
        filterReasons.noProfit++;
        emitScheduleProbeDecision(o, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'profitability_scan_failed',
          detail: `effective_spread_non_positive:${fmtNum(rs.effectiveSpread, 4)}`,
          targetFundingTime: o.nextFundingTime,
        });
        return false;
      }
      // ??거래???�터: ?�쪽 거래??�??�나?�도 최소 거래??미달?�면 ?�외
      const minVol = strategyConfig.minVolume24hUSD ?? 7_500_000;
      if (minVol > 0) {
        const shortVol = fundingRates.find(r => r.exchange === o.shortExchange && r.baseAsset === o.baseAsset)?.quoteVolume24h;
        const longVol = fundingRates.find(r => r.exchange === o.longExchange && r.baseAsset === o.baseAsset)?.quoteVolume24h;
        if ((typeof shortVol === 'number' && shortVol < minVol) || (typeof longVol === 'number' && longVol < minVol)) {
          filterReasons.noProfit++;
          emitScheduleProbeDecision(o, isSim, {
            status: 'rejected',
            selected: false,
            reason: 'volume_below_min',
            detail: `shortVol:${fmtNum(shortVol ?? 0, 0)} longVol:${fmtNum(longVol ?? 0, 0)} min:${fmtNum(minVol, 0)}`,
            targetFundingTime: o.nextFundingTime,
          });
          return false;
        }
      }
      if (!hasRS && o.spreadPercent < effectiveMinPercent) {
        filterReasons.lowSpread++;
        emitScheduleProbeDecision(o, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'spread_below_threshold',
          detail: `spread:${fmtNum(o.spreadPercent, 4)} min:${fmtNum(effectiveMinPercent, 4)}`,
          targetFundingTime: o.nextFundingTime,
        });
        return false;
      }
      if (!hasRS) {
        const evProfit = estimateProfit(o, strategyConfig.investmentUSDT, strategyConfig.leverage, {
          feeOverrides: strategyConfig.feeOverrides,
          paybackOverrides: strategyConfig.paybackOverrides,
          useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
        });
        if (evProfit.netPerFunding <= 0 || !evProfit.conservativeEV.passesMinProfit || !evProfit.conservativeEV.passesEVRatio) {
          filterReasons.noProfit++;
          emitScheduleProbeDecision(o, isSim, {
            status: 'rejected',
            selected: false,
            reason: 'profitability_scan_failed',
            detail: `ev_net:${fmtNum(evProfit.netPerFunding, 4)} minProfit:${evProfit.conservativeEV.passesMinProfit} evRatio:${evProfit.conservativeEV.passesEVRatio}`,
            targetFundingTime: o.nextFundingTime,
          });
          return false;
        }
      }
      return true;
    });

    if (filtered.length === 0 && opportunities.length > 0) {
      if (!_lastScheduleDiagAt || now - _lastScheduleDiagAt > 30_000) {
        _lastScheduleDiagAt = now;
        const parts = [];
        if (filterReasons.legConflict > 0) parts.push(`?�그충돌:${filterReasons.legConflict}`);
        if (filterReasons.exchangeDisabled > 0) parts.push(`거래?�비?�성:${filterReasons.exchangeDisabled}`);
        if (filterReasons.tooFarAhead > 0) parts.push(`?�간초과:${filterReasons.tooFarAhead}`);
        if (filterReasons.pastFunding > 0) parts.push(`과거?�간:${filterReasons.pastFunding}`);
        if (filterReasons.lowSpread > 0) parts.push(`?�프?�드미달:${filterReasons.lowSpread}`);
        if (filterReasons.noProfit > 0) parts.push(`?�익?�음:${filterReasons.noProfit}`);
        get().addLog('warning',
          `[?��?�?진단][${modePrefix.toUpperCase()}] 기회 ${opportunities.length}�??��? ?�락`,
          undefined,
          `?�유: ${parts.join(' | ')} | 최소?�프?�드: ${effectiveMinPercent}%`,
        );
      }
      return;
    }

    const { realSpreads: currentRealSpreads, simBalances, balances: realBalances } = get();
    const getLiveNetProfit = (o: ArbitrageOpportunity): number => {
      const plannedInvestmentUSDT = snipeAllocations[mkSnipeKey(isSim, getOpportunityId(o))];
      const n = getEffectiveNotional(o, strategyConfig, simBalances, realBalances, isSim, plannedInvestmentUSDT);
      const rs = getRealSpreadForOpportunity(currentRealSpreads, o);
      const hasRealSpread = rs && Date.now() - rs.updatedAt < 30_000;
      if (hasRealSpread) {
        // ??effectiveSpread???�시???�전마진 미포?? ???��?줄링 ???�전마진 별도 차감
        return n * ((rs.effectiveSpread - SAFETY_MARGIN_PCT) / 100);
      }
      // ?�측 ?�으�??�론 기반 보수??계산 (?�전마진 ?�함)
      const hedgeFeePct = getConfiguredHedgeFees(
        strategyConfig,
        o.shortExchange,
        o.longExchange,
        'taker',
      ) * 100;
      const netPct = calcNetSpreadPercent(o.spreadPercent, 0, hedgeFeePct);
      return n * (netPct / 100);
    };
    const profitable: ArbitrageOpportunity[] = [];
    for (const opportunity of filtered) {
      const liveNetProfit = getLiveNetProfit(opportunity);
      if (liveNetProfit > 0) {
        profitable.push(opportunity);
        continue;
      }
      emitScheduleProbeDecision(opportunity, isSim, {
        status: 'rejected',
        selected: false,
        reason: 'profitability_scan_failed',
        detail: `live_net_non_positive:${fmtNum(liveNetProfit, 4)}`,
        targetFundingTime: opportunity.nextFundingTime,
      });
    }

    if (profitable.length === 0 && filtered.length > 0) {
      if (!_lastScheduleDiagAt || now - _lastScheduleDiagAt > 30_000) {
        _lastScheduleDiagAt = now;
        const sample = filtered[0];
        const rs = getRealSpreadForOpportunity(currentRealSpreads, sample);
        const effSpr = (rs && Date.now() - rs.updatedAt < 30_000) ? rs.effectiveSpread : null;
        get().addLog('warning',
          `[?��?�?진단][${modePrefix.toUpperCase()}] ${filtered.length}�?기회가 ?�효?�프?�드 ?�익 체크?�서 ?��? ?�락`,
          undefined,
          `?�시: ${sample.baseAsset} ?�론:${fmtNum(sample.spreadPercent, 4)}% ?�효:${effSpr !== null ? fmtNum(effSpr, 4) + '%' : '?�음'} netProfit:$${fmtNum(getLiveNetProfit(sample))}`,
        );
      }
      return;
    }

    // ?��??�이??모드: ?�고 체크 ???�분�?먼�? ?�행 (?�고 부�?방�?)
    if (isSim) {
      get().redistributeBalances();
    }
    const latestSimBalances = get().simBalances;
    const latestRealBalances = get().balances;

    // 거래?�별 가???�고 추적 (?�금 초과 ?�약 방�?)
    const availableBalance: Record<string, number> = {};
    for (const ex of currentEnabled) {
      const bal = isSim
        ? (latestSimBalances[ex] ?? 0)
        : (latestRealBalances[ex]?.availableUSDT ?? 0);
      availableBalance[ex] = bal;
    }

    // ?��? ?�약??코인??마진???�차 차감 (복리: ?�전 ?�약??줄인 ?�고 반영)
    // ?�???�각 ???�렬 ???�른 ?�?�이 먼�? ?�금???�용?��?�??�서가 중요
    const reservedKeys = Object.keys(snipeTargets)
      .filter(k => parseSnipeKey(k).isSim === isSim)
      .sort((a, b) => (snipeTargets[a] ?? 0) - (snipeTargets[b] ?? 0));
    for (const tKey of reservedKeys) {
      const opp = findOpportunityById(opportunities, parseSnipeKey(tKey).opportunityId);
      if (!opp) continue;
      const reservePerSide = snipeAllocations[tKey] ?? strategyConfig.investmentUSDT;
      const shortCostFactor = 1 + (strategyConfig.leverage * getConfiguredExchangeFee(strategyConfig, opp.shortExchange, 'taker'));
      const longCostFactor = 1 + (strategyConfig.leverage * getConfiguredExchangeFee(strategyConfig, opp.longExchange, 'taker'));
      availableBalance[opp.shortExchange] = Math.max(
        0,
        (availableBalance[opp.shortExchange] ?? 0) - (reservePerSide * shortCostFactor),
      );
      availableBalance[opp.longExchange] = Math.max(
        0,
        (availableBalance[opp.longExchange] ?? 0) - (reservePerSide * longCostFactor),
      );
      getOpportunityLegKeys(opp).forEach((legKey) => occupiedLegs.add(legKey));
    }

    let balanceSkips = 0;
    let scheduledCount = 0;

    const groupedByWindow = new Map<number, ArbitrageOpportunity[]>();
    for (const opportunity of profitable) {
      const windowKey = Math.round(opportunity.nextFundingTime / 120_000) * 120_000;
      const list = groupedByWindow.get(windowKey) ?? [];
      list.push(opportunity);
      groupedByWindow.set(windowKey, list);
    }

    const orderedWindows = Array.from(groupedByWindow.entries())
      .sort((a, b) => a[0] - b[0]);

    for (const [, group] of orderedWindows) {
      const balancePlan = buildBalanceEqualizationPlan(currentEnabled, availableBalance);
      const planningBalances = getBalanceEqualizationPlanningBalances(balancePlan, isSim);
      const getPlanningScore = (opportunity: ArbitrageOpportunity) => (
        getOpportunityYieldScore(
          opportunity,
          getRealSpreadForOpportunity(currentRealSpreads, opportunity),
          strategyConfig,
        ) * getOpportunityBalanceEqualizationMultiplier(balancePlan, opportunity)
      );
      const groupCandidates = group
        .filter((opportunity) => !opportunityConflictsWithLegs(opportunity, occupiedLegs))
        .sort((a, b) => {
          const scoreDiff = getPlanningScore(b) - getPlanningScore(a);
          if (scoreDiff !== 0) return scoreDiff;
          return getLiveNetProfit(b) - getLiveNetProfit(a);
        });

      const planned = planWindowAllocations(
        groupCandidates,
        availableBalance,
        strategyConfig,
        currentRealSpreads,
        planningBalances,
        balancePlan,
      );

      if (planned.length === 0) {
        balanceSkips += groupCandidates.length;
        for (const candidate of groupCandidates) {
          emitScheduleProbeDecision(candidate, isSim, {
            status: 'rejected',
            selected: false,
            reason: 'allocation_skip',
            detail: 'window_allocation_not_selected',
            targetFundingTime: candidate.nextFundingTime,
          });
        }
        continue;
      }

      const plannedIds = new Set(planned.map((entry) => getOpportunityId(entry.opportunity)));
      for (const candidate of groupCandidates) {
        if (plannedIds.has(getOpportunityId(candidate))) continue;
        emitScheduleProbeDecision(candidate, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'allocation_skip',
          detail: 'capacity_or_balance_limited',
          targetFundingTime: candidate.nextFundingTime,
        });
      }

      for (const plan of planned) {
        const intervalH = Math.round(getOpportunityIntervalHours(plan.opportunity));
        const minsLeft = Math.round((plan.opportunity.nextFundingTime - now) / 60000);
        get().addLog('info',
          `[?��?�??�징][${modePrefix.toUpperCase()}] ${plan.opportunity.baseAsset} ?�택 ??${minsLeft}�????�??,
          undefined,
          `주기:${intervalH}h | ?�자�?$${fmtNum(plan.investmentUSDT, 0)} | ?�프?�드:+${fmtNum(plan.opportunity.spreadPercent, 4)}% | ${plan.opportunity.shortExchange}??{plan.opportunity.longExchange}`,
        );
        get().scheduleSnipeForAsset(plan.opportunity, isSim, plan.investmentUSDT);
        getOpportunityLegKeys(plan.opportunity).forEach((legKey) => occupiedLegs.add(legKey));
        scheduledCount++;
      }
    }

    if (scheduledCount === 0 && profitable.length > 0) {
      if (!_lastScheduleDiagAt || now - _lastScheduleDiagAt > 30_000) {
        _lastScheduleDiagAt = now;
        const balInfo = Object.entries(availableBalance).map(([ex, b]) => `${ex}:$${Math.round(b)}`).join(' ');
        get().addLog('warning',
          `[?��?�?진단][${modePrefix.toUpperCase()}] ${profitable.length}�??�익 기회 ???�고부�?${balanceSkips}`,
          undefined,
          `기�??�자�?$${strategyConfig.investmentUSDT} | 가?�잔�? ${balInfo}`,
        );
      }
    }
  },

  // ?�정 코인 1개에 ?�???�나?�핑 ?�약 (모드�?
  scheduleSnipeForAsset(opportunity, isSim, investmentUSDT) {
    const { _snipeTimers, snipeTargets } = get();
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(opportunity));

    // ?��? ?�약???�면 ?�킵
    if (snipeTargets[snipeKey]) {
      emitScheduleProbeDecision(opportunity, isSim, {
        status: 'selected',
        selected: true,
        reason: 'already_scheduled_or_active',
        detail: 'already_scheduled',
        targetFundingTime: snipeTargets[snipeKey],
      });
      return;
    }

    // 기존 ?�?�머 ?�리
    if (_snipeTimers[snipeKey]) clearTimeout(_snipeTimers[snipeKey]);

    // 과거 ?�간 보정
    const intervalMs = opportunity.fundingIntervalMs ?? 8 * 3600 * 1000;
    let targetTime = opportunity.nextFundingTime;
    const now = Date.now();
    while (targetTime <= now) {
      targetTime += intervalMs;
    }

    const entryLeadMs = getResolvedTimingConfig(get().strategyConfig.timingConfig).entryLeadMs;

    // ?�?�까지 6�?미만 ???�음 ?�이??(ENTRY_BEFORE_MS=5초보???�간 ?�유)
    if (targetTime - now < entryLeadMs + 1_000) {
      targetTime += intervalMs;
    }

    const entryDelay = Math.max(0, targetTime - now - entryLeadMs);

    // ?�?�머 ?�록
    const timer = setTimeout(() => get()._executeSnipeEntry(opportunity, targetTime, isSim), entryDelay);

    set(s => ({
      snipeTargets: { ...s.snipeTargets, [snipeKey]: targetTime },
      snipeAllocations: {
        ...s.snipeAllocations,
        [snipeKey]: investmentUSDT ?? s.strategyConfig.investmentUSDT,
      },
      _snipeTimers: { ...s._snipeTimers, [snipeKey]: timer },
    }));

    const mins = Math.floor(entryDelay / 1000 / 60);
    const secs = Math.floor((entryDelay / 1000) % 60);
    const intervalH = Math.round(intervalMs / 3600000);
    const modeLabel = isSim ? 'SIM' : 'REAL';
    get().addLog('info',
      `[?�나?�핑-?�징][${modeLabel}] ${opportunity.baseAsset} ?�약 ??${mins}�?${secs}�???,
      undefined,
      `?�?�주�? ${intervalH}h | ?�자�?$${fmtNum(investmentUSDT ?? get().strategyConfig.investmentUSDT, 0)} | ?�프?�드: +${fmtNum(opportunity.spreadPercent, 4)}%`,
    );

    emitScheduleProbeDecision(opportunity, isSim, {
      status: 'selected',
      selected: true,
      reason: 'selected',
      detail: `scheduled_in_${mins}m_${secs}s`,
      targetFundingTime: targetTime,
    });
  },

  // ???��?: ?�??직전 진입 ?�행 + ?�령 ???�동�?�� ?�약
  _executeSnipeEntry(opportunity: ArbitrageOpportunity, targetFundingTime: number, isSim: boolean) {
    const modeActive = isSim ? get().simSnipeActive : get().realSnipeActive;
    const modeLabel = isSim ? 'SIM' : 'REAL';
    const asset = opportunity.baseAsset;
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(opportunity));
    // ?�동??비활????진입 차단 (�?�� ?�패 ?�으�??�시?��???경우)
    if (!modeActive) {
      get().addLog('warning', `[?�나?�핑-?�징][${modeLabel}] ${asset} 진입 ?�킵 ???�동??비활???�태`);
      emitScheduleProbeDecision(opportunity, isSim, {
        status: 'rejected',
        selected: false,
        reason: 'scheduler_inactive',
        detail: 'mode_inactive_before_entry',
        targetFundingTime,
      });
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const plannedInvestmentUSDT = get().snipeAllocations[snipeKey] ?? get().strategyConfig.investmentUSDT;

    // ???�행 직전 ?�간 검�????�???�간???��? 지?�거???�무 ?�찍?�면 차단
    const secsUntilFunding = (targetFundingTime - Date.now()) / 1000;
    if (secsUntilFunding < -10) {
      get().addLog('warning', `[?�나?�핑-?�징][${modeLabel}] ${asset} 진입 차단 ???�???�간??${Math.abs(secsUntilFunding).toFixed(0)}�??�에 ?��? 지??);
      emitScheduleProbeDecision(opportunity, isSim, {
        status: 'rejected',
        selected: false,
        reason: 'execution_timing_stale',
        detail: `secs_until_funding:${secsUntilFunding.toFixed(3)}`,
        targetFundingTime,
      });
      get().cancelSnipeForAsset(snipeKey);
      return;
    }
    if (secsUntilFunding > 30) {
      get().addLog('warning', `[?�나?�핑-?�징][${modeLabel}] ${asset} 진입 차단 ???�?�까지 ${secsUntilFunding.toFixed(0)}�??�음 (?�무 ?�름)`);
      emitScheduleProbeDecision(opportunity, isSim, {
        status: 'rejected',
        selected: false,
        reason: 'execution_timing_early',
        detail: `secs_until_funding:${secsUntilFunding.toFixed(3)}`,
        targetFundingTime,
      });
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const { enabledExchanges: currentEnabled } = get();

    // 진입 ?�점???�당 코인??최신 기회 ?�인 (?�수??+ 최소?�프?�드 기�?)
    const { opportunities, strategyConfig, realSpreads: currentRealSpreads, simBalances, balances: realBalances } = get();
    const effectiveMinPercent = getEffectiveMinSpread(strategyConfig);

    const latestOpp = opportunities.find(o =>
      getOpportunityId(o) === getOpportunityId(opportunity) &&
      currentEnabled.includes(o.shortExchange) &&
      currentEnabled.includes(o.longExchange),
    );
    const meetsThreshold = (o: ArbitrageOpportunity) => {
      if (o.spreadPercent < effectiveMinPercent) return false;
      const n = plannedInvestmentUSDT * strategyConfig.leverage;
      const rs = getRealSpreadForOpportunity(currentRealSpreads, o);
      const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
      // realSpread ?�으�?진입 불�? ???�론값만?�로 진입 금�?
      if (!hasRS) return false;
      const effSpreadPct = rs.effectiveSpread; // ?�리?��?+?�수�?모두 반영??
      const liveNet = n * (effSpreadPct / 100);
      return liveNet > 0;
    };
    const finalTarget = latestOpp && meetsThreshold(latestOpp)
      ? latestOpp
      : meetsThreshold(opportunity) ? opportunity : null;

    if (!finalTarget) {
      get().addLog('warning', `[?�나?�핑-?�징][${modeLabel}] ${asset} 기�? 미달 ???�킵`);
      emitScheduleProbeDecision(opportunity, isSim, {
        status: 'rejected',
        selected: false,
        reason: 'live_spread_reverted',
        detail: 'final_target_not_met',
        targetFundingTime,
      });
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const secsToFunding = Math.max(0, (targetFundingTime - Date.now()) / 1000).toFixed(1);
    get().addLog('info',
      `[?�나?�핑-?�징][${modeLabel}] ${asset} 진입 ?�행 ???�?�까지 ${secsToFunding}�?,
      undefined,
      `??${finalTarget.shortExchange.toUpperCase()} �?${finalTarget.longExchange.toUpperCase()} | ?�자�?$${fmtNum(plannedInvestmentUSDT, 0)} | ?�프?�드: +${fmtNum(finalTarget.spreadPercent, 4)}%`,
    );

    // ?�행 직전 최종 ?�인 ???�른 ?�산 �?�� ?�패�?비활?�화?�을 ???�음
    const modeActiveRecheck = isSim ? get().simSnipeActive : get().realSnipeActive;
    if (!modeActiveRecheck) {
      get().addLog('warning', `[?�나?�핑-?�징][${modeLabel}] ${asset} 진입 직전 취소 ???�동??비활???�태`);
      emitScheduleProbeDecision(finalTarget, isSim, {
        status: 'rejected',
        selected: false,
        reason: 'scheduler_inactive',
        detail: 'mode_inactive_before_execute_strategy',
        targetFundingTime,
      });
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const entryTarget = { ...finalTarget, nextFundingTime: targetFundingTime };
    get().executeStrategy(entryTarget, isSim, plannedInvestmentUSDT).then((result) => {
      if (result.success) {
        // 진입 ?�공 ???�동??비활??체크 ???�른 ?�산 �?�� ?�패�??��???경우
        const stillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (!stillActive) {
          get().addLog('warning',
            `[?�나?�핑-?�징][${modeLabel}] ${asset} 진입 ?�공?�으???�동??비활?????�버 체결 ?�량?�로 즉시 ?�리`,
          );
          const cleanupStaleEntry = async () => {
            if (isSim) {
              await get()._executeSnipeClose(finalTarget, isSim);
              return;
            }

            const leverage = get().strategyConfig.leverage;
            const stalePositions: Position[] = [];
            if (result.short?.success && result.short.data) {
              stalePositions.push(makeSyntheticClosePosition(finalTarget, 'short', result.short.data, leverage, result.pairId));
            }
            if (result.long?.success && result.long.data) {
              stalePositions.push(makeSyntheticClosePosition(finalTarget, 'long', result.long.data, leverage, result.pairId));
            }

            if (stalePositions.length === 0) {
              get().addLog('error',
                `[?�나?�핑-?�징][${modeLabel}] ${asset} stale 진입 ?�리 ?�패 ??체결 ?�보 ?�음, ?�동 ?�인 ?�요`,
              );
              get().cancelSnipeForAsset(snipeKey);
              return;
            }

            let pendingClosures = stalePositions;
            let lastCloseErrors: string[] = [];

            for (let attempt = 0; attempt < 2 && pendingClosures.length > 0; attempt++) {
              const closeResults = await Promise.allSettled(
                pendingClosures.map(pos => get().closePosition(pos)),
              );
              const failedPositions: Position[] = [];
              lastCloseErrors = [];

              closeResults.forEach((closeResult, index) => {
                if (closeResult.status === 'rejected') {
                  failedPositions.push(pendingClosures[index]);
                  lastCloseErrors.push(closeResult.reason?.message || 'unknown');
                }
              });

              if (failedPositions.length === 0) {
                pendingClosures = [];
                break;
              }

              pendingClosures = failedPositions;
              if (attempt === 0) {
                get().addLog('warning',
                  `[?�나?�핑-?�징][${modeLabel}] ${asset} stale 진입 ?�동 ?�리 1�??�패 ??1�????�시??,
                  undefined,
                  lastCloseErrors.join('; '),
                );
                await new Promise(r => setTimeout(r, 1_000));
              }
            }

            if (pendingClosures.length > 0) {
              get().addLog('error',
                `[?�나?�핑-?�징][${modeLabel}] ${asset} stale 진입 ?�동 ?�리 ${pendingClosures.length}/${stalePositions.length}�??�패 ???�동 ?�인 ?�요`,
                undefined,
                lastCloseErrors.join('; '),
              );
              queueTrade({
                timestamp: Date.now(), type: 'exit_failed', simulation: !isSim ? false : true,
                baseAsset: asset, shortExchange: finalTarget.shortExchange, longExchange: finalTarget.longExchange,
                detail: `stale_cleanup_failed:${pendingClosures.length}/${stalePositions.length}`,
              });
            } else {
              get().addLog('success',
                `[?�나?�핑-?�징][${modeLabel}] ${asset} stale 진입 ?�동 ?�리 ?�료`,
              );
            }

            get().cancelSnipeForAsset(snipeKey);
          };
          void cleanupStaleEntry().catch((err) => {
            get().addLog('error',
              `[?�나?�핑-?�징][${modeLabel}] ${asset} stale 진입 ?�리 �??�류`,
              undefined,
              (err as Error).message,
            );
            get().cancelSnipeForAsset(snipeKey);
          });
          return;
        }

        get().addLog('success',
          `[?�나?�핑-?�징][${modeLabel}] ${asset} 진입 ?�료`,
          undefined,
          `?�?�까지 ~${secsToFunding}�?,
        );
        const resolvedCloseDelayMs = Math.max(
          0,
          Math.min(getResolvedTimingConfig(get().strategyConfig.timingConfig).closeDelayMs, 1_000),
        );
        const closeDelay = Math.max(0, targetFundingTime - Date.now()) + resolvedCloseDelayMs;
        const closeTimer = setTimeout(() => {
          get()._executeSnipeClose(finalTarget, isSim);
        }, closeDelay);
        set(s => ({
          _snipeCloseTimers: { ...s._snipeCloseTimers, [snipeKey]: closeTimer },
        }));
        get().addLog('info',
          `[?�나?�핑-?�징][${modeLabel}] ${asset} ?�동�?�� ?�약 ??${fmtNum(closeDelay / 1000, 0)}�???,
        );
        // 진입 ???��? ?�금?�로 ?�음 최고 ?�익 기회 ?�동 ?�약
        const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (modeStillActive) {
          get().scheduleAllSnipes();
        }
      } else {
        get().addLog('error', `[?�나?�핑-?�징][${modeLabel}] ${asset} 진입 ?�패`, undefined, result.error);
        emitScheduleProbeDecision(finalTarget, isSim, {
          status: 'rejected',
          selected: false,
          reason: 'route_failure',
          detail: result.error ?? 'execute_strategy_failed',
          targetFundingTime,
        });
        get().cancelSnipeForAsset(snipeKey);
        const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (modeStillActive) {
          get().scheduleAllSnipes();
        }
      }
    });
  },

  // ???��?: ?�???�령 ?�인 + ?��???�?�� + ?�음 ?�이???�예??
  async _executeSnipeClose(target: ArbitrageOpportunity, isSim: boolean) {
    const asset = target.baseAsset;
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(target));
    const modeLabel = isSim ? 'SIM' : 'REAL';
    let closeFailed = false;

    if (isSim) {
      // ?��??�이?? tickSimFunding ?�존 X ??직접 ?�당 코인 ?��???찾아??�?��
      const simPosForAsset = get().simPositions.filter((position) =>
        position.baseAsset === asset
        && position.isSnipe
        && (position.exchange === target.shortExchange || position.exchange === target.longExchange),
      );
      if (simPosForAsset.length === 0) {
        get().addLog('warning', `[?�나?�핑-?�징][${modeLabel}] ${asset} ?��? ?��????�음`);
      } else {
        for (const pos of simPosForAsset) {
          await get().closeSimPosition(pos.simId);
        }
        const totalCollected = simPosForAsset.reduce((s, p) => s + p.fundingCollected, 0);
        get().addLog('success',
          `[?�나?�핑-?�징][${modeLabel}] ${asset} ?��? �?�� ?�료`,
          undefined,
          `${simPosForAsset.length}�??��???| ?�령 ?�?? $${fmtNum(totalCollected, 4)}`,
        );
      }
    } else {
      // ???�거?? 즉시 �?�� (T+2s) ???�??검증�? 비동기로 ?�처�?
      const currentPositions = get().positions;
      const targetPositions = currentPositions.filter(p => {
        if (p.baseAsset !== asset) return false;
        if (p.positionType === 'manual') return false; // ?�용???�동 ?��???보호
        return (p.exchange === target.shortExchange || p.exchange === target.longExchange)
          && (p.positionType === 'hedge_short' || p.positionType === 'hedge_long');
      });

      if (targetPositions.length > 0) {
        get().addLog('info', `[?�나?�핑-?�징][${modeLabel}] ${asset} ${targetPositions.length}�?즉시 �?�� �?..`);
        const closeResults = await Promise.allSettled(
          targetPositions.map(pos => get().closePosition(pos)),
        );
        const failedLegs = closeResults.filter(r => r.status === 'rejected');
        const closedLegs = closeResults
          .filter((r): r is PromiseFulfilledResult<ClosePositionResult> => r.status === 'fulfilled')
          .map(r => r.value);
        const pairId = closedLegs.find(leg => leg.pairId)?.pairId ?? targetPositions.find(pos => pos.pairId)?.pairId;
        if (failedLegs.length > 0) {
          closeFailed = true;
          get().addLog('error',
            `[?�나?�핑-?�징][${modeLabel}] ${asset} �?�� ${failedLegs.length}/${targetPositions.length}�??�패 ???�동???�시?��?, ?�동 ?�인 ?�요`,
            undefined,
            failedLegs.map(r => (r as PromiseRejectedResult).reason?.message || 'unknown').join('; '),
          );
          queueTrade({
            timestamp: Date.now(), type: 'exit_failed', simulation: false,
            baseAsset: asset, shortExchange: target.shortExchange, longExchange: target.longExchange,
            detail: `${failedLegs.length}/${targetPositions.length} legs failed`,
          });
        } else {
          get().addLog('success', `[?�나?�핑-?�징][${modeLabel}] ${asset} �?�� ?�료`);

          // ?�???�령 ?�인?� 비동기로 ??�?��??지?�시?��? ?�음 (?�인 ???�제 ?�손???�정)
          (async () => {
            let fundingVerified = false;
            let verifiedFunding: number | null = null;
            let verifiedPnl: number | null = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await get().fetchFundingHistory();
                const { fundingHistory } = get();
                const recentFundings = fundingHistory.filter(f =>
                  f.symbol.includes(asset) &&
                  (f.exchange === target.shortExchange || f.exchange === target.longExchange) &&
                  f.timestamp > Date.now() - 60_000,
                );
                if (recentFundings.length > 0) {
                  fundingVerified = true;
                  const totalFunding = recentFundings.reduce((sum, funding) => sum + funding.amount, 0);
                  const fundingByLeg = new Map<string, number>();
                  for (const leg of closedLegs) {
                    const legFunding = recentFundings
                      .filter(funding => funding.exchange === leg.exchange && funding.symbol === leg.symbol)
                      .reduce((sum, funding) => sum + funding.amount, 0);
                    fundingByLeg.set(makePositionKey(leg.exchange, leg.symbol, leg.side), legFunding);
                  }
                  verifiedFunding = totalFunding;
                  verifiedPnl = closedLegs.reduce((sum, leg) => {
                    const legFunding = fundingByLeg.get(makePositionKey(leg.exchange, leg.symbol, leg.side)) ?? 0;
                    return sum + leg.pricePnl - leg.entryFee - leg.exitFee + legFunding;
                  }, 0);
                  const fundingBreakdown = recentFundings
                    .map(funding => `${funding.exchange}:$${fmtNum(funding.amount, 4)}`)
                    .join(' | ');
                  get().addLog('success',
                    `[?�나?�핑-?�징][${modeLabel}] ${asset} ?�???�령 ?�인`,
                    undefined,
                    `${recentFundings.length}�?/ ?�계 $${fmtNum(totalFunding, 4)} | 최종 ?�손??${verifiedPnl >= 0 ? '+' : ''}$${fmtNum(verifiedPnl ?? 0, 4)}${fundingBreakdown ? ` | ${fundingBreakdown}` : ''}`,
                  );
                  for (const funding of recentFundings) {
                    queueTrade({
                      timestamp: funding.timestamp,
                      type: 'funding',
                      simulation: false,
                      baseAsset: asset,
                      exchange: funding.exchange,
                      symbol: funding.symbol,
                      side: funding.side,
                      pairId,
                      fundingAmount: funding.amount,
                      fundingRate: funding.rate,
                      detail: 'verified_from_exchange_history',
                    });
                  }
                  break;
                }
              } catch (err) {
                get().addLog(
                  'warning',
                  `[??�굹??�븨-?룹쭠][${modeLabel}] ${asset} ??????�졊 ?뺤씤 ?????${attempt + 1} ??�뙣`,
                  undefined,
                  (err as Error).message,
                );
              }
              if (attempt < 2) await new Promise(r => setTimeout(r, 5_000));
            }
            if (!fundingVerified) {
              verifiedPnl = closedLegs.reduce((sum, leg) => sum + leg.pnl, 0);
              get().addLog(
                'warning',
                `[?�나?�핑-?�징][${modeLabel}] ${asset} ?�???�령 미확????가격손??기�? ?�정 ?�손??${verifiedPnl >= 0 ? '+' : ''}$${fmtNum(verifiedPnl ?? 0, 4)}`,
              );
            }

            void sendTelegramMessage(formatSnipeCompleteAlert({
              baseAsset: asset,
              shortExchange: target.shortExchange,
              longExchange: target.longExchange,
              fundingCollected: verifiedFunding,
              pnl: verifiedPnl,
              simulation: false,
              note: fundingVerified ? undefined : '?�???�령?� 거래???�산 ?�역 추�? ?�인 ?�요',
            }));
            queueTrade({
              timestamp: Date.now(), type: 'snipe_complete', simulation: false,
              baseAsset: asset, shortExchange: target.shortExchange, longExchange: target.longExchange,
              pairId,
              fundingCollected: verifiedFunding,
              pnl: verifiedPnl,
              detail: `fundingVerified:${fundingVerified} | verifiedFunding:${verifiedFunding ?? 'pending'} | verifiedPnl:${verifiedPnl ?? 'pending'} | mode:hedge`,
            });
          })();
        }
      } else {
        get().addLog('warning', `[?�나?�핑-?�징][${modeLabel}] ${asset} �?��???��????�음`);
      }
    }

    // ?�당 ???�?�머 ?�리
    get().cancelSnipeForAsset(snipeKey);

    // �?�� ?�패 ???�동???�시?��? ???�여 ?��??�이 ?�는 ?�태?�서 ???�나?�프 차단
    if (!isSim && closeFailed) {
      // REAL 모드??진입 ?�?�머�??�리 ??�?�� ?�?�머???��? (?�른 ?�산???�린 ?��???보호)
      const { _snipeTimers, snipeTargets: currentTargets } = get();
      const realTimerKeys = Object.keys(_snipeTimers).filter(k => k.startsWith('real:'));
      for (const k of realTimerKeys) clearTimeout(_snipeTimers[k]);
      const newTimers = { ...get()._snipeTimers };
      const newTargets = { ...currentTargets };
      for (const k of realTimerKeys) { delete newTimers[k]; delete newTargets[k]; }
      set({ realSnipeActive: false, snipeTargets: newTargets, _snipeTimers: newTimers });
      // ?�버??비활???�태 ?�??+ ?�버 ?��?줄러 ?��? (?�시???�함)
      void fetch('/api/snipe-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realSnipeActive: false }) }).catch(() => {});
      void stopServerScheduler(get().addLog);
      get().addLog('error',
        `[?�나?�핑-?�징][${modeLabel}] �?�� ?�패�??�동???�시?��? ??진입 ?�약 ?�제 (기존 �?�� ?�?�머 ?��?), ?�여 ?��????�인 ???�동 ?�개 ?�요`,
      );
      return;
    }

    const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
    if (modeStillActive) {
      get().scheduleAllSnipes();
    }
  },

  // ?�정 코인???�나?�핑 ?�?�머�??�리
  cancelSnipeForAsset(
    snipeKey: string,
    decision?: { reason?: string; detail?: string; status?: string; selected?: boolean },
  ) {
    const { _snipeTimers, _snipeCloseTimers, snipeTargets, opportunities } = get();
    if (decision) {
      const parsed = parseSnipeKey(snipeKey);
      const opportunity = findOpportunityById(opportunities, parsed.opportunityId);
      if (opportunity) {
        emitScheduleProbeDecision(opportunity, parsed.isSim, {
          status: decision.status ?? (decision.selected ? 'selected' : 'rejected'),
          selected: decision.selected ?? false,
          reason: decision.reason,
          detail: decision.detail,
          targetFundingTime: snipeTargets[snipeKey],
        });
      }
    }
    if (_snipeTimers[snipeKey]) clearTimeout(_snipeTimers[snipeKey]);
    if (_snipeCloseTimers[snipeKey]) clearTimeout(_snipeCloseTimers[snipeKey]);
    set(s => {
      const newTimers = { ...s._snipeTimers };
      const newCloseTimers = { ...s._snipeCloseTimers };
      const newTargets = { ...s.snipeTargets };
      const newAllocations = { ...s.snipeAllocations };
      delete newTimers[snipeKey];
      delete newCloseTimers[snipeKey];
      delete newTargets[snipeKey];
      delete newAllocations[snipeKey];
      return {
        _snipeTimers: newTimers,
        _snipeCloseTimers: newCloseTimers,
        snipeTargets: newTargets,
        snipeAllocations: newAllocations,
      };
    });
  },

  // ?�나?�핑 중�? (모드�??�는 ?�체)
  cancelSnipe(mode = 'all') {
    const { _snipeTimers, _snipeCloseTimers, snipeTargets: currentTargets } = get();

    if (mode === 'all') {
      for (const t of Object.values(_snipeTimers)) clearTimeout(t);
      for (const t of Object.values(_snipeCloseTimers)) clearTimeout(t);
      set({ simSnipeActive: false, realSnipeActive: false, snipeTargets: {}, snipeAllocations: {}, _snipeTimers: {}, _snipeCloseTimers: {} });
      // ?�버??비활???�태 ?�??+ ?�버 ?��?줄러 ?��? (?�시???�함)
      void fetch('/api/snipe-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ simSnipeActive: false, realSnipeActive: false }) }).catch(() => {});
      void fetch('/api/sim-scheduler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).catch(() => {});
      void stopServerScheduler(get().addLog);
      get().addLog('info', '[?�나?�핑] ?�체 중�???);
    } else {
      const prefix = mode === 'sim' ? 'sim:' : 'real:';
      const newTimers = { ..._snipeTimers };
      const newCloseTimers = { ..._snipeCloseTimers };
      const newTargets = { ...currentTargets };
      const newAllocations = { ...get().snipeAllocations };
      for (const key of Object.keys(newTimers)) {
        if (key.startsWith(prefix)) { clearTimeout(newTimers[key]); delete newTimers[key]; }
      }
      for (const key of Object.keys(newCloseTimers)) {
        if (key.startsWith(prefix)) { clearTimeout(newCloseTimers[key]); delete newCloseTimers[key]; }
      }
      for (const key of Object.keys(newTargets)) {
        if (key.startsWith(prefix)) delete newTargets[key];
      }
      for (const key of Object.keys(newAllocations)) {
        if (key.startsWith(prefix)) delete newAllocations[key];
      }
      const updates: Partial<FundingState> = {
        snipeTargets: newTargets,
        snipeAllocations: newAllocations,
        _snipeTimers: newTimers,
        _snipeCloseTimers: newCloseTimers,
      };
      if (mode === 'sim') updates.simSnipeActive = false;
      else updates.realSnipeActive = false;
      set(updates);
      // REAL 모드 ?��? ???�버 ?��?줄러???�께 ?��? (?�시???�함)
      if (mode === 'real') {
        void stopServerScheduler(get().addLog);
      } else {
        void fetch('/api/sim-scheduler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).catch(() => {});
      }
      get().addLog('info', `[?�나?�핑] ${mode.toUpperCase()} 모드 중�???);
    }
  },

  async fetchFundingHistory() {
    // ?��??�이??모드?�서???�거??API 조회?��? ?�음 (tickSimFunding?�서 ?�체 기록)
    if (get().simulationMode) return;
    set({ isLoadingHistory: true });
    const { apiConfigs, enabledExchanges, fundingHistory: previousHistory } = get();
    const targetExchanges = Array.from(new Set<ExchangeId>([
      ...enabledExchanges,
      ...(Object.keys(apiConfigs) as ExchangeId[]),
    ].filter((exchange) => isExchangeOperable(exchange))));

    const apiHistory: FundingPayment[] = [];
    const failures: string[] = [];
    let apiSuccessCount = 0;

    const fallbackHistory = await loadFundingHistoryFromTradeLog(false).catch((err) => {
      get().addLog('warning', '[??????�졊] 嫄곕??濡쒓??fallback 濡쒕�???�뙣', undefined, (err as Error).message);
      return [] as FundingPayment[];
    });

    await Promise.allSettled(
      targetExchanges.map(async (exchange) => {
        const config = apiConfigs[exchange];
        const res = await fetch(
          `/api/exchanges/${exchange}/funding-history?limit=50`,
          config ? { headers: makeApiHeaders(config) } : undefined,
        );
        const json = await res.json().catch(() => ({})) as { success?: boolean; data?: FundingPayment[]; error?: string };

        if (json.success && json.data) {
          apiHistory.push(...json.data);
          apiSuccessCount++;
          return;
        }

        if (res.status === 401 && !config) return;
        failures.push(`${exchange}:${json.error || `HTTP ${res.status}`}`);
      }),
    );

    const mergedHistory = mergeFundingHistory(apiHistory, fallbackHistory);

    if (failures.length > 0) {
      get().addLog('warning', '[??????�졊] ??? 嫄곕???議고????�뙣', undefined, failures.join(' | '));
    }

    if (apiSuccessCount === 0 && fallbackHistory.length > 0) {
      get().addLog('info', `[??????�졊] 嫄곕??濡쒓??fallback??�줈 ${fallbackHistory.length}�?蹂듭??);
    }

    if (mergedHistory.length > 0) {
      saveFundingHistory(mergedHistory);
      set({ fundingHistory: mergedHistory, isLoadingHistory: false });
      return;
    }

    if (previousHistory.length > 0 && failures.length > 0) {
      set({ isLoadingHistory: false });
      get().addLog('warning', '[??????�졊] ??�뙣�?湲곗????�뿭??留ㅼ?');
      return;
    }

    saveFundingHistory([]);
    set({ fundingHistory: [], isLoadingHistory: false });
  },
}));

