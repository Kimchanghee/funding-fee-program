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
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { saveApiConfigs, loadApiConfigs, saveEnabledExchanges, loadEnabledExchanges, saveStrategyConfig, loadStrategyConfig, saveLogs, loadLogs, saveFundingHistory, loadFundingHistory, saveSimState, loadSimState, clearSimState, saveSimMode, loadSimMode, saveRealPositionMeta, loadRealPositionMeta } from '@/lib/keyStore';
import {
  estimateProfit,
  findOpportunities,
  getOpportunityId,
  getOpportunityIntervalHours,
  getOpportunityLegKeys,
  makeOpportunityId,
} from '@/lib/opportunities';
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

// ─────────────────────────────────────────────
// Fee constants (fallback for contexts without exchange info)
// ─────────────────────────────────────────────
const TAKER_FEE_FALLBACK = 0.00048; // 0.048% referral-max worst-case fallback (bitget taker)
let _lastScheduleDiagAt = 0; // 진단 로그 스팸 방지

/** 서버 스케줄러 정지 — 재시도 2회, 실패 시 경고 로그 */
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
  addLog?.('error', '[스케줄러] 서버 스케줄러 정지 실패 (3회 재시도) — 수동 확인 필요');
  return false;
}
let _lastBalanceWarnAt = 0;  // 텔레그램 잔고 경고 쿨다운 (30분)
// 최소 스프레드는 사용자 설정값을 그대로 쓰고,
// 실제 수익성 판단은 거래소별 수수료 override를 반영한 계산식으로 처리한다.
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
        0, // 표시용: 안전마진 미포함
      ),
    };
  }

  return next;
}

function buildSchedulerConfig(
  strategyConfig: StrategyConfig,
  enabledExchanges: ExchangeId[],
) {
  return {
    investmentUSDT: strategyConfig.investmentUSDT,
    leverage: strategyConfig.leverage,
    minSpreadPercent: strategyConfig.minSpreadPercent,
    enabledExchanges,
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
      '[스케줄러] 설정 동기화 실패',
      undefined,
      (error as Error).message,
    );
  }
}

function buildServerSimSchedulerConfig(
  strategyConfig: StrategyConfig,
  enabledExchanges: ExchangeId[],
) {
  return {
    investmentUSDT: strategyConfig.investmentUSDT,
    leverage: strategyConfig.leverage,
    minSpreadPercent: strategyConfig.minSpreadPercent,
    compoundInvesting: strategyConfig.compoundInvesting,
    enabledExchanges,
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
      '[SIM Scheduler] 설정 동기화 실패',
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

/** 복리/단리에 따른 실제 notional 계산 */
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
): PlannedSnipeAllocation[] {
  const candidates = opportunities
    .map((opportunity) => ({
        opportunity,
        score: getOpportunityYieldScore(
          opportunity,
          getRealSpreadForOpportunity(realSpreads, opportunity),
          strategyConfig,
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

// ─────────────────────────────────────────────
// Snipe key helpers (mode-prefixed)
// ─────────────────────────────────────────────
const mkSnipeKey = (sim: boolean, opportunityId: string) => `${sim ? 'sim' : 'real'}:${opportunityId}`;
const parseSnipeKey = (key: string) => ({
  isSim: key.startsWith('sim:'),
  opportunityId: key.slice(key.indexOf(':') + 1),
});

// ─────────────────────────────────────────────
// State shape
// ─────────────────────────────────────────────
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
  consecutiveAllFailCount: number;  // 전 거래소 연속 실패 횟수

  // Exchange toggle
  enabledExchanges: ExchangeId[];

  // Per-exchange fetch status
  exchangeFetchStatus: Partial<Record<ExchangeId, 'ok' | 'error' | 'loading'>>;
  exchangeFetchErrors: Partial<Record<ExchangeId, string>>;

  // Simulation (헷징 전용 잔고 풀)
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

  // Snipe mode (모드별 독립 — sim/real 동시 실행 가능)
  simSnipeActive: boolean;           // SIM 모드 스나이프 활성
  realSnipeActive: boolean;          // REAL 모드 스나이프 활성
  simSnipeStartCapital: number;      // SIM 자동투자 ON 시점의 총 투입 자본
  realSnipeStartCapital: number;     // REAL 자동투자 ON 시점의 총 투입 자본
  snipeTargets: Record<string, number>;  // mode-prefixed opportunity key → targetFundingTime
  snipeAllocations: Record<string, number>;
  _snipeTimers: Record<string, ReturnType<typeof setTimeout>>;      // mode-prefixed key → 진입 타이머
  _snipeCloseTimers: Record<string, ReturnType<typeof setTimeout>>; // mode-prefixed key → 청산 타이머

  // UI state
  showApiPanel: boolean;
  showStrategyPanel: boolean;
  rateFilter: string;
  exchangeFilter: ExchangeId[];
  positionToClose: Position | null;

  // Real orderbook spreads (keyed by baseAsset) — effectiveSpread에 슬리피지+베이시스+수수료 모두 반영
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

  // Snipe actions (모드별 독립 스나이핑)
  scheduleAllSnipes: () => void;
  _scheduleSnipesForMode: (isSim: boolean) => void;
  scheduleSnipeForAsset: (
    opportunity: ArbitrageOpportunity,
    isSim: boolean,
    investmentUSDT?: number,
  ) => void;
  cancelSnipe: (mode?: 'sim' | 'real' | 'all') => void;
  cancelSnipeForAsset: (snipeKey: string) => void;
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

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
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
const RATE_FETCH_TIMEOUT_MS = 20_000;
const RATE_RETRY_DELAY_MS = 1_500;
const RATE_RETRY_TIMEOUT_MS = 15_000;
const EXCHANGE_STATUS_STALE_OK_MS = 90_000;

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

// ─────────────────────────────────────────────
// File persistence: batch log/trade sending
// ─────────────────────────────────────────────
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

function queueLog(level: string, message: string, exchange?: string, detail?: string) {
  logBatch.push({ timestamp: Date.now(), level, message, exchange, detail });
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogs, 2000); // 2초마다 배치 전송
  }
}

function queueTrade(event: PendingTrade) {
  tradeBatch.push(event);
  if (!tradeFlushTimer) {
    tradeFlushTimer = setTimeout(flushTrades, 1000); // 거래는 1초마다 즉시 전송
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
  }).catch(() => { /* silent — don't break UI for log persistence */ });
}

function flushTrades() {
  tradeFlushTimer = null;
  if (tradeBatch.length === 0) return;
  const events = [...tradeBatch];
  tradeBatch = [];
  fetch('/api/trades/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  }).catch(() => { /* silent */ });
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

// ─────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────
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
  simBalances: { binance: 2000, bybit: 2000, okx: 2000, bitget: 2000, gate: 2000, bingx: 2000 },
  simInitialBalances: { binance: 2000, bybit: 2000, okx: 2000, bitget: 2000, gate: 2000, bingx: 2000 },
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
  enabledExchanges: [...SUPPORTED_EXCHANGES],
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

  // ── Init ──────────────────────────────────────
  init() {
    try {
      // React 18 Strict Mode / HMR에서 상태 초기화 (snipeActive는 서버 상태가 source of truth → 여기서 리셋하지 않음)
      set({ isLoadingRates: false, _snipeTimers: {}, _snipeCloseTimers: {} });

      // ── 1회성 데이터 정리: 시뮬 초기화 (v3 마이그레이션) ──
      const MIGRATION_KEY = 'funding_fee_migration_v3';
      if (typeof window !== 'undefined' && !localStorage.getItem(MIGRATION_KEY)) {
        localStorage.removeItem('funding_fee_history');
        localStorage.removeItem('funding_fee_sim_state');
        localStorage.removeItem('funding_fee_logs');
        localStorage.setItem(MIGRATION_KEY, '1');
      }

      // 저장된 로그 & 펀딩 히스토리 복원 (HMR/새로고침에서도 유지)
      const savedLogs = loadLogs();
      const savedHistory = loadFundingHistory();
      if (savedLogs.length > 0) set({ logs: savedLogs });
      if (savedHistory !== null && savedHistory.length > 0) {
        set({ fundingHistory: savedHistory });
      } else if (savedHistory === null) {
        // localStorage에 키 자체가 없을 때만 서버에서 복원 (명시적 초기화 후엔 스킵)
        fetch('/api/trades/list?list=true').then(r => r.json()).then((res: { dates?: string[] }) => {
          if (!res.dates || res.dates.length === 0) return;
          // 최근 7일치 펀딩 기록 복원
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
              get().addLog('info', `[복원] 로컬 파일에서 펀딩 수령 내역 ${fundingRecords.length}건 복원`);
            }
          });
        }).catch(() => { /* silent */ });
      }

      const saved = loadApiConfigs();
      set({ apiConfigs: saved });
      const connected = Object.keys(saved) as ExchangeId[];
      set({ connectedExchanges: connected });

      // 저장된 전략 설정 로드
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

      // 저장된 거래소 ON/OFF 설정 로드
      const savedEnabled = loadEnabledExchanges();
      if (savedEnabled && savedEnabled.length > 0) {
        const valid = savedEnabled.filter(e => SUPPORTED_EXCHANGES.includes(e as ExchangeId)) as ExchangeId[];
        if (valid.length >= 2) {
          set({ enabledExchanges: valid });
        }
      }

      // 저장된 모드 복원 (SIM/REAL)
      const savedMode = loadSimMode();
      if (savedMode !== null) {
        set({ simulationMode: savedMode });
      }

      // 저장된 REAL 포지션 메타 복원
      const savedRealMeta = loadRealPositionMeta();
      if (savedRealMeta) {
        set({ realPositionMeta: savedRealMeta as Record<string, RealPositionMeta> });
      }

      // 서버에 저장된 자동투자 상태 복원 (PC↔모바일 동기화)
      fetchSharedSnipeStateSnapshot().then(async (sharedState) => {
        applySharedSnipeStateSnapshot(set, sharedState, { includeActives: false });
        saveSimMode(sharedState.simulationMode);

        // REAL: 서버 스케줄러가 실제로 돌고 있는지 확인 후에만 UI 상태를 ON으로
        let realConfirmed = false;
        {
          try {
            const schedulerRes = await fetch('/api/scheduler');
            if (schedulerRes.ok) {
              const schedulerData = await schedulerRes.json() as { active?: boolean };
              realConfirmed = !!schedulerData.active;
            }
          } catch { /* 확인 불가 → OFF 유지 */ }
          if (!realConfirmed && sharedState.realSnipeActive) {
            // 서버 스케줄러가 안 돌고 있으면 snipe-state도 정정
            void updateSharedSnipeStateSnapshot({ realSnipeActive: false }).catch(() => {});
            get().addLog('warning', '[복원] REAL 자동투자 상태 OFF — 서버 스케줄러 미실행');
          }
        }

        set({ realSnipeActive: realConfirmed });
        if (realConfirmed) {
          void syncServerSchedulerConfig(
            getResolvedStrategyConfig(get().strategyConfig),
            get().enabledExchanges,
            get().addLog,
          );
          get().addLog('info', '[복원] 자동투자 상태 복원 — REAL');
        }
      }).catch(() => { /* silent */ });

      // 저장된 시뮬레이션 상태 복원 (잔고, 포지션, 누적 펀딩)
      const savedSim = loadSimState();
      if (savedSim) {
        // 잔고가 거래소당 기준(투자금×2)보다 낮으면 보정 (숏/롱 양쪽 참여 가능하도록)
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
        // 최초 실행: 활성 거래소 기준으로 초기 잔고 설정 (거래소당 투자금×2 — 숏/롱 양쪽 참여 가능)
        const enabled = get().enabledExchanges;
        const perExchange = get().strategyConfig.investmentUSDT * 2;
        const newBal = {} as Record<ExchangeId, number>;
        for (const ex of SUPPORTED_EXCHANGES) {
          newBal[ex] = enabled.includes(ex) ? perExchange : 0;
        }
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
      get().addLog('info', '펀딩피 프로그램 초기화 완료', undefined,
        `활성 거래소: ${enabled.map(e => e.toUpperCase()).join(', ')} (${enabled.length}개)`);
      set({ ratesStatus: 'loading' });
      get().refreshRates().catch((err) => {
        console.error('[init] refreshRates failed:', err);
        set({ ratesStatus: 'error', ratesError: (err as Error).message, isLoadingRates: false });
      });
      get().startPolling();
    } catch (err) {
      console.error('[init] 초기화 실패:', err);
      set({ ratesStatus: 'error', ratesError: `초기화 실패: ${(err as Error).message}`, isLoadingRates: false });
    }
  },

  // ── API config ────────────────────────────────
  setApiConfig(exchange, config) {
    const prev = get().apiConfigs;
    const next = { ...prev, [exchange]: config };
    set({ apiConfigs: next });
    saveApiConfigs(next);
    // 서버 측 암호화 저장소에도 저장
    fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange, config }),
    }).catch(() => {});
    const connected = Object.keys(next) as ExchangeId[];
    set({ connectedExchanges: connected });
    get().addLog('success', `${exchange.toUpperCase()} API 키 저장됨 (서버 암호화)`, exchange);
  },

  removeApiConfig(exchange) {
    const prev = get().apiConfigs;
    const next = { ...prev };
    delete next[exchange];
    set({ apiConfigs: next });
    saveApiConfigs(next);
    // 서버 측에서도 삭제
    fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange }),
    }).catch(() => {});
    const connected = Object.keys(next) as ExchangeId[];
    set({ connectedExchanges: connected });
    get().addLog('warning', `${exchange.toUpperCase()} API 키 삭제됨`, exchange);
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
    const feeChanged = JSON.stringify(next.feeOverrides ?? {}) !== JSON.stringify(previousConfig.feeOverrides ?? {});
    const paybackChanged = JSON.stringify(next.paybackOverrides ?? {}) !== JSON.stringify(previousConfig.paybackOverrides ?? {});
    const maxSlippageChanged = next.maxSlippagePercent !== previousConfig.maxSlippagePercent;
    const minVolumeChanged = next.minVolume24hUSD !== previousConfig.minVolume24hUSD;
    const timingChanged = JSON.stringify(next.timingConfig ?? DEFAULT_TIMING_CONFIG) !== JSON.stringify(previousConfig.timingConfig ?? DEFAULT_TIMING_CONFIG);
    const schedulerRelevantChanged = investmentChanged
      || leverageChanged
      || minSpreadChanged
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

      // investmentUSDT 변경 시 시뮬 잔고 동기화 (포지션 없을 때만)
      if (investmentChanged && s.simPositions.length === 0) {
        const newBal = {} as Record<ExchangeId, number>;
        for (const ex of SUPPORTED_EXCHANGES) {
          newBal[ex] = s.enabledExchanges.includes(ex) ? next.investmentUSDT * 2 : 0;
        }
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

  // ── Refresh rates (거래소별 개별 비동기 — 응답 즉시 UI 업데이트) ──
  async refreshRates(options) {
    if (ratesRefreshInFlight) {
      console.log('[refreshRates] skip — already loading');
      return;
    }
    ratesRefreshInFlight = true;
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

    // 비활성 거래소 데이터 제거 (OFF한 거래소가 기회 계산에 남는 것 방지)
    set(s => ({
      fundingRates: s.fundingRates.filter(r => enabled.includes(r.exchange)),
    }));

    // 거래소별 개별 fetch — 먼저 응답 오는 거래소부터 즉시 반영
    await Promise.allSettled(
      enabled.map(async (exchangeId) => {
        const current = get();
        const hasExistingRates = current.fundingRates.some(r => r.exchange === exchangeId);
        if (!hasExistingRates || current.exchangeFetchStatus[exchangeId] === 'error') {
          set(s => ({ exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'loading' } }));
        }
        try {
          const res = await fetch(`/api/funding-rates?exchanges=${exchangeId}`, {
            signal: AbortSignal.timeout(RATE_FETCH_TIMEOUT_MS),
          });
          const json = await res.json() as {
            success: boolean;
            error?: string;
            data: { rates: FundingRate[]; errors: { exchange: ExchangeId; error: string }[] };
            timestamp: number;
          };

          if (json.success && json.data.rates.length > 0) {
            console.log(`[refreshRates] ${exchangeId}: ${json.data.rates.length}개 수신`);
            // 이 거래소 데이터를 기존 데이터에 머지 → 즉시 기회 재계산
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

                // 시뮬 포지션 마크가격 업데이트
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
              console.error(`[refreshRates] ${exchangeId} set() 실패:`, setErr);
              // set() 실패해도 최소한 상태는 업데이트
              set({
                lastRatesUpdate: Date.now(),
                ratesStatus: 'success',
                exchangeFetchStatus: { ...get().exchangeFetchStatus, [exchangeId]: 'ok' },
              });
            }

            if (json.data.errors?.length > 0) {
              for (const e of json.data.errors) {
                get().addLog('warning', `${(e.exchange || '?').toUpperCase()} 펀딩률 오류`, e.exchange, e.error);
              }
            }
          } else {
            // success:false 또는 데이터 0건 → 짧은 대기 후 재시도
            const errMsg = json.error || '데이터 없음';
            console.warn(`[refreshRates] ${exchangeId} 1차 실패(응답): ${errMsg} — ${RATE_RETRY_DELAY_MS / 1000}초 후 재시도`);
            await new Promise(r => setTimeout(r, RATE_RETRY_DELAY_MS));
            const retryRes2 = await fetch(`/api/funding-rates?exchanges=${exchangeId}`, { signal: AbortSignal.timeout(RATE_RETRY_TIMEOUT_MS) });
            const retryJson2 = await retryRes2.json() as typeof json;
            if (retryJson2.success && retryJson2.data.rates.length > 0) {
              console.log(`[refreshRates] ${exchangeId} 재시도 성공: ${retryJson2.data.rates.length}개`);
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
              console.warn(`[refreshRates] ${exchangeId} 재시도도 실패: ${retryJson2.error || '데이터 없음'}`);
              markExchangeFetchFailure(exchangeId, retryJson2.error || errMsg);
            }
          }
        } catch (err) {
          // 네트워크/타임아웃 에러 → 짧은 대기 후 재시도
          console.warn(`[refreshRates] ${exchangeId} 1차 실패(네트워크) — ${RATE_RETRY_DELAY_MS / 1000}초 후 재시도:`, (err as Error).message);
          try {
            await new Promise(r => setTimeout(r, RATE_RETRY_DELAY_MS));
            const retryRes = await fetch(`/api/funding-rates?exchanges=${exchangeId}`, {
              signal: AbortSignal.timeout(RATE_RETRY_TIMEOUT_MS),
            });
            const retryJson = await retryRes.json() as {
              success: boolean;
              error?: string;
              data: { rates: FundingRate[]; errors: { exchange: ExchangeId; error: string }[] };
              timestamp: number;
            };
            if (retryJson.success && retryJson.data.rates.length > 0) {
              console.log(`[refreshRates] ${exchangeId} 재시도 성공: ${retryJson.data.rates.length}개`);
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
              throw new Error(retryJson.error || '재시도 데이터 없음');
            }
          } catch (retryErr) {
            console.warn(`[refreshRates] ${exchangeId} 재시도도 실패:`, (retryErr as Error).message);
            markExchangeFetchFailure(exchangeId, (retryErr as Error).message);
          }
        }
      }),
    );

    // 모든 거래소 완료 후 — 이번 라운드에서 하나도 성공 못했으면 에러
    const anyOk = enabled.some(ex => get().exchangeFetchStatus[ex] === 'ok');
    console.log('[refreshRates] done — anyOk:', anyOk, 'lastUpdate:', get().lastRatesUpdate);
    if (!anyOk) {
      const failCount = get().consecutiveAllFailCount + 1;
      set({ ratesStatus: 'error', ratesError: '모든 거래소에서 데이터 조회 실패', consecutiveAllFailCount: failCount });

      // 5회 연속 전체 실패 (~40초) → 경고 로그 + 텔레그램
      if (failCount === 5) {
        const msg = `⚠️ API 전체 장애: 모든 거래소 데이터 조회가 ${failCount}회 연속 실패했습니다. 서버 상태를 확인하세요. (.next 캐시 손상 가능 → 서버 재시작 필요)`;
        get().addLog('warning', msg);
        sendTelegramMessage(msg).catch(() => {});
      }
      // 30회 연속 (~4분) → 경고만 발생 (서버 자동투자는 강제 중단하지 않음)
      if (failCount === 30 && (get().simSnipeActive || get().realSnipeActive)) {
        get().addLog('warning', `⚠️ API 장애 지속 (${failCount}회 연속 실패) — 자동 중단은 하지 않고 감시 유지`);
        sendTelegramMessage(`⚠️ API 전체 장애 ${failCount}회 연속 감지. 자동 투자는 유지하며 상태 점검 필요.`).catch(() => {});
      }

      if (!get().lastRatesUpdate) {
        setTimeout(() => get().refreshRates(), 3000);
      }
    } else {
      // 성공 시 카운터 리셋
      if (get().consecutiveAllFailCount > 0) {
        set({ consecutiveAllFailCount: 0 });
      }
    }
    } finally {
      ratesRefreshInFlight = false;
      if (showLoading) set({ isLoadingRates: false });
    }
  },

  // ── Refresh positions (활성 거래소만) ─────────────
  async refreshPositions() {
    const configs = get().apiConfigs;
    const enabled = get().enabledExchanges;
    const activeConfigs = (Object.entries(configs) as [ExchangeId, ApiConfig][])
      .filter(([exchange]) => enabled.includes(exchange));
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

    // 기존 포지션의 positionType / 메타 보존 (exchange+symbol+side 기준 매칭)
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

  // refreshPositions 후 새로 생긴 포지션에만 positionType 세팅
  // (기존에 있던 manual 포지션은 건드리지 않음)
  async refreshAndStampPositions(baseAsset: string, exchanges: ExchangeId[]) {
    // refresh 전 기존 포지션 스냅샷 (exchange+symbol+side 키)
    const beforeKeys = new Set(
      get().positions.map(p => `${p.exchange}:${p.symbol}:${p.side}`),
    );
    await get().refreshPositions();
    set(s => {
      const updated = s.positions.map(p => {
        if (p.baseAsset !== baseAsset) return p;
        if (!exchanges.includes(p.exchange)) return p;
        if (p.positionType !== 'manual') return p; // 이미 타입이 있으면 유지
        // refresh 전에 이미 있던 포지션이면 스킵 (사용자 기존 포지션)
        const key = `${p.exchange}:${p.symbol}:${p.side}`;
        if (beforeKeys.has(key)) return p;
        // hedge: 숏/롱 구분
        return {
          ...p,
          positionType: (p.side === 'short' ? 'hedge_short' : 'hedge_long') as Position['positionType'],
        };
      });
      return { positions: updated };
    });
  },

  // ── Refresh balances (활성 거래소만) ──────────────
  async refreshBalances() {
    const configs = get().apiConfigs;
    const enabled = get().enabledExchanges;
    const activeConfigs = (Object.entries(configs) as [ExchangeId, ApiConfig][])
      .filter(([exchange]) => enabled.includes(exchange));
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

  // ── Refresh real orderbook spreads for scheduled coins ──
  async refreshRealSpreads() {
    const { snipeTargets, snipeAllocations, opportunities, strategyConfig, realSpreads, simBalances, balances: realBalances, simulationMode } = get();
    const now = Date.now();
    const STALE_MS = 5_000;

    // Collect from scheduled targets + near-term opportunities (route key 기준)
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
    // 5시간 이내 펀딩 기회 사전 조회 (스케줄링 시 이론값 fallback 방지)
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
          // 양쪽 모드 중 큰 notional 사용 — 슬리피지는 주문 크기에 비례하므로 보수적 추정
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
            // ★ 핵심: fillPrice로 진입 가격 갭 직접 계산 (슬리피지 + 거래소 간 베이시스 모두 포착)
            // short(sell) fillPrice < midPrice, long(buy) fillPrice > midPrice
            // entryGapPct = (longFill - shortFill) / shortFill * 100 → 양수 = 진입 손실
            const entryGapPct = ((longJson.fillPrice - shortJson.fillPrice) / shortJson.fillPrice) * 100;
            const hedgeFeePct = getConfiguredHedgeFees(
              strategyConfig,
              opp.shortExchange,
              opp.longExchange,
              'taker',
            ) * 100;
            // ★ equal-notional 스나이프: 가격 괴리 무관, 슬리피지+수수료만 차감
            const effectiveSpread = calcHedgedNetSpreadPercent(
              opp.spreadPercent,
              shortSlippage,
              longSlippage,
              hedgeFeePct,
              0, // 안전마진은 실행 시점에만 별도 적용
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
          // Silent — real spread just won't be shown
        }
      }),
    );
  },

  // ── Balance redistribution ────────────────────
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
          `[SIM] 잔고 재분배: ${donor.toUpperCase()} → ${target.toUpperCase()} $${fmtNum(transfer, 0)}`,
          target,
          `${donor.toUpperCase()} 여유잔고 → ${target.toUpperCase()} (임계값 $${fmtNum(threshold, 0)} 미만 감지)`,
        );
      }
    }
  },

  // ── Polling ───────────────────────────────────
  startPolling() {
    const s = get();
    if (s._ratesInterval) clearInterval(s._ratesInterval);
    if (s._positionsInterval) clearInterval(s._positionsInterval);

    // 첫 데이터가 아직 없으면 1초 후 즉시 재시도 (init 실패 보완)
    if (!get().lastRatesUpdate) {
      setTimeout(() => {
        if (!get().lastRatesUpdate) get().refreshRates();
      }, 1000);
    }

    // 5초 간격 펀딩률 + 오더북 폴링 (기회 탐지 속도 향상)
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

    // 1초 간격 재검증 + 스케줄링 (로컬 데이터만 사용, API 호출 없음)
    const snipeCheckInterval = setInterval(() => {
      if (get().realSnipeActive) {
        get().revalidateScheduledSnipes();
        get().scheduleAllSnipes();
      }
    }, SNIPE_CHECK_INTERVAL_MS);

    // 3초 간격 SIM 서버 상태 동기화 (API 호출 — 매초는 과도)
    const simSyncInterval = setInterval(() => {
      if (get().simSnipeActive || get().simulationMode) {
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
    }, SIM_SYNC_INTERVAL_MS);

    const positionsInterval = setInterval(() => {
      get().refreshPositions();
      get().refreshBalances();
      get().fetchFundingHistory();
      if (get().simulationMode || get().simSnipeActive) {
        void fetchServerSimStateSnapshot()
          .then((snapshot) => applyServerSimStateSnapshot(set, snapshot, { getState: get }))
          .catch(() => {});
      } else {
        get().tickSimFunding();
      }
      // 잔고 재분배: 잔고 부족 거래소에 여유 거래소에서 균등 분배
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
    // 모든 코인별 스나이핑 타이머 정리
    for (const t of Object.values(_snipeTimers)) clearTimeout(t);
    for (const t of Object.values(_snipeCloseTimers)) clearTimeout(t);
    set({ _ratesInterval: null, _positionsInterval: null, _snipeCheckInterval: null, _simSyncInterval: null, _snipeTimers: {}, _snipeCloseTimers: {}, snipeTargets: {}, snipeAllocations: {} });
    flushLogs();
    flushTrades();
  },

  // ── Execute strategy (hedge only) ─────────────
  async executeStrategy(opportunity, simModeOverride?, investmentOverrideUSDT?) {
    const { apiConfigs, strategyConfig, simBalances, balances } = get();
    const simulationMode = simModeOverride ?? get().simulationMode;
    const plannedInvestmentUSDT = investmentOverrideUSDT ?? strategyConfig.investmentUSDT;

    // Guard: spread check
    const effectiveMinSpread = getEffectiveMinSpread(strategyConfig);
    if (opportunity.spreadPercent < effectiveMinSpread) {
      get().addLog('warning',
        `스프레드 ${fmtNum(opportunity.spreadPercent, 4)}%가 최소 기준 ${effectiveMinSpread}% 미만 — 진입 스킵`,
        undefined,
        `${opportunity.baseAsset} ${opportunity.shortExchange}↔${opportunity.longExchange}`,
      );
      queueTrade({
        timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
        baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
        spreadPercent: opportunity.spreadPercent, reason: `스프레드 ${opportunity.spreadPercent.toFixed(4)}% < 최소 ${effectiveMinSpread}%`,
      });
      return { success: false };
    }

    // Guard: 순수익 검증
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
    // 실측 스프레드 기반 수익성 검증 (effectiveSpread는 표시용 — 안전마진 별도 적용)
    const rs = getRealSpreadForOpportunity(get().realSpreads, opportunity);
    const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
    if (hasRS) {
      // ★ effectiveSpread에는 안전마진 미포함 → 실행 시 별도 차감
      const realNetProfit = notionalEst * ((rs.effectiveSpread - SAFETY_MARGIN_PCT) / 100);
      if (realNetProfit <= 0) {
        get().addLog('warning',
          `[실측 수익성 실패] ${opportunity.baseAsset} 실측 순스프레드 ${fmtNum(rs.effectiveSpread, 4)}% ≤ 0 — 진입 스킵`,
          undefined,
          `진입갭: ${fmtNum(rs.entryGapPct, 4)}% | 슬리피지: 숏${fmtNum(rs.shortSlippage, 3)}% 롱${fmtNum(rs.longSlippage, 3)}%`,
        );
        queueTrade({
          timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
          baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
          spreadPercent: opportunity.spreadPercent, reason: `실측 수익성 실패: 순스프레드 ${rs.effectiveSpread.toFixed(4)}% ≤ 0 (안전마진 포함)`,
        });
        return { success: false };
      }
    } else {
      // realSpread 없으면 이론값 기반 보수적 검증 (기존 로직)
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
          `[수익성 검증 실패] ${opportunity.baseAsset} 펀딩수익 $${fmtNum(estFundingRevenue)} ≤ 수수료 $${fmtNum(estTotalFees)} — 진입 스킵`,
          undefined,
          `스프레드: ${fmtNum(opportunity.spreadPercent, 4)}% | 필요 최소: ${(estRoundTripFee * 100).toFixed(3)}%`,
        );
        queueTrade({
          timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
          baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
          spreadPercent: opportunity.spreadPercent, reason: `수익성 실패: 펀딩 $${estFundingRevenue.toFixed(2)} ≤ 수수료 $${estTotalFees.toFixed(2)}`,
        });
        return { success: false };
      }
    }

    // Guard: duplicate position — 같은 코인 중복 진입 방지
    if (simulationMode) {
      const opportunityLegs = new Set(getOpportunityLegKeys(opportunity));
      const existingPair = get().simPositions.find((position) =>
        getPositionLegKeys(position).some((legKey) => opportunityLegs.has(legKey)),
      );
      if (existingPair) {
        get().addLog('warning',
          `[SIM] ${opportunity.baseAsset} 이미 헷징 포지션 보유 중 — 중복 진입 스킵`,
          undefined,
          `기존 포지션: ${existingPair.side.toUpperCase()} @ ${existingPair.exchange.toUpperCase()}`,
        );
        return { success: false };
      }
    }

    // ── Simulation branch ──────────────────────
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
          get().addLog('warning', `[SIM] ${opportunity.baseAsset} 서버 시뮬 진입 실패`, undefined, errorMessage);
          return { success: false, error: errorMessage };
        }

        applyServerSimStateSnapshot(set, payload.state, { force: true });
        return { success: true };
      } catch (error) {
        const errorMessage = (error as Error).message;
        get().addLog('error', `[SIM] ${opportunity.baseAsset} 서버 시뮬 진입 오류`, undefined, errorMessage);
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
          `[SIM] ${opportunity.baseAsset} 진입 스킵: 유효하지 않은 마크가격`,
          undefined,
          `숏 ${opportunity.shortExchange.toUpperCase()}: ${opportunity.shortMarkPrice}, 롱 ${opportunity.longExchange.toUpperCase()}: ${opportunity.longMarkPrice}`,
        );
        return { success: false };
      }
      const { shortExchange, longExchange } = opportunity;
      const notional = margin * leverage;
      const shortEntryFee = notional * getConfiguredExchangeFee(strategyConfig, shortExchange, 'taker');
      const shortCostPerSide = margin + shortEntryFee;

      // ── 잔고 부족 시 여유 거래소에서 내부 이체 (최소 $1,400 유지) ──
      const MIN_BALANCE = plannedInvestmentUSDT; // 거래소당 최소 유지 잔고
      const needsTransfer: { target: ExchangeId; needed: number }[] = [];
      for (const ex of [shortExchange, longExchange]) {
        const bal = simBalances[ex] ?? 0;
        if (bal < shortCostPerSide) {
          // 최소 유지 잔고 + 거래 비용 확보 (진입 전이므로 보수적으로 short 기준 사용)
          const needed = Math.max(shortCostPerSide - bal, MIN_BALANCE - bal);
          needsTransfer.push({ target: ex, needed });
        }
      }
      for (const { target, needed } of needsTransfer) {
        // 여유 거래소 찾기: 현재 포지션 마진 제외한 실 가용잔고가 최소잔고 이상인 거래소
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
            `[SIM] 내부 이체: ${donor.exId.toUpperCase()} → ${(target as string).toUpperCase()} $${fmtNum(transfer, 0)}`,
            target,
            `${donor.exId.toUpperCase()} 여유: $${fmtNum(donor.surplus, 0)} → 이체 후 ${(target as string).toUpperCase()} 잔고 확보`,
          );
          remaining -= transfer;
        }

        // 이체 후에도 여전히 부족하면 진입 스킵
        if (remaining > 0) {
          get().addLog('warning',
            `[SIM] ${opportunity.baseAsset} 진입 스킵: ${(target as string).toUpperCase()} 잔고 부족`,
            target,
            `필요: $${fmtNum(shortCostPerSide, 0)} | 가용: $${fmtNum((get().simBalances[target] ?? 0), 0)} | 이체 가능한 여유 거래소 없음`,
          );
          return { success: false };
        }
      }

      // ── 실제 호가창 기반 체결가 계산 (슬리피지 반영) ──
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
          get().addLog('info', `[SIM] ${opportunity.baseAsset} 숏 체결가: $${fmtNum(shortFillPrice, 2)} (슬리피지: ${fmtNum(shortOB.slippagePercent, 4)}%)`, shortExchange);
        }
        if (longOB.success) {
          longFillPrice = longOB.fillPrice;
          get().addLog('info', `[SIM] ${opportunity.baseAsset} 롱 체결가: $${fmtNum(longFillPrice, 2)} (슬리피지: ${fmtNum(longOB.slippagePercent, 4)}%)`, longExchange);
        }
      } catch (err) {
        get().addLog('warning', `[SIM] ${opportunity.baseAsset} 호가창 조회 실패 — 마크가격 사용`, undefined, (err as Error).message);
      }

      // ── 진입 갭 계산 및 롱 노셔널 조정 ──
      const entryGapPercent = ((shortFillPrice - longFillPrice) / ((shortFillPrice + longFillPrice) / 2)) * 100;
      get().addLog('info', `[SIM] ${opportunity.baseAsset} 진입 갭: ${entryGapPercent.toFixed(4)}% (숏:$${fmtNum(shortFillPrice, 2)} 롱:$${fmtNum(longFillPrice, 2)})`);
      // Gap > 0.1% → 롱 노셔널 조정으로 양쪽 수량(계약 수) 일치 → 델타 중립
      let adjustedLongNotional = notional;
      if (Math.abs(entryGapPercent) > 0.1) {
        adjustedLongNotional = notional * (longFillPrice / shortFillPrice);
        get().addLog('info', `[SIM] ${opportunity.baseAsset} 롱 노셔널 조정: $${fmtNum(notional, 2)} → $${fmtNum(adjustedLongNotional, 2)} (수량 균등화)`);
      }

      // ── 양쪽 별도 수수료/마진/비용 계산 ──
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

      // 펀딩 수익: 각 다리의 실제 노셔널 기준으로 계산
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
        + adjustedLongNotional * getConfiguredExchangeFee(strategyConfig, longExchange, 'taker') * 2; // 진입+청산 보수적 추정
      const netProfit = perFunding - totalRoundTripFees;
      get().addLog('success',
        `[SIM] ${opportunity.baseAsset} 헷징 진입 완료 (${isSnipe ? '스나이프' : '홀딩'})`,
        undefined,
        `숏:${shortExchange.toUpperCase()} 롱:${longExchange.toUpperCase()} | isSnipe:${isSnipe} | pairId:${pairId} | 마진:$${fmtNum(margin)} | 레버리지:${leverage}x | 스프레드:${fmtNum(opportunity.spreadPercent, 4)}% | 다음펀딩:${new Date(opportunity.nextFundingTime).toLocaleTimeString('ko-KR')} | 8h순수익: $${fmtNum(netProfit)} (펀딩: $${fmtNum(perFunding)} - 수수료: $${fmtNum(totalRoundTripFees)})`,
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

    // ── Real trading branch ────────────────────
    const shortConfig = apiConfigs[opportunity.shortExchange];
    const longConfig = apiConfigs[opportunity.longExchange];

    if (!shortConfig) {
      get().addLog('error', `${opportunity.shortExchange.toUpperCase()} API 키 없음`, opportunity.shortExchange);
      return { success: false, error: `${opportunity.shortExchange.toUpperCase()} API 키 없음` };
    }
    if (!longConfig) {
      get().addLog('error', `${opportunity.longExchange.toUpperCase()} API 키 없음`, opportunity.longExchange);
      return { success: false, error: `${opportunity.longExchange.toUpperCase()} API 키 없음` };
    }

    let realInvestment = plannedInvestmentUSDT;
    if (strategyConfig.compoundInvesting && investmentOverrideUSDT == null) {
      const shortBal = balances[opportunity.shortExchange]?.availableUSDT ?? 0;
      const longBal = balances[opportunity.longExchange]?.availableUSDT ?? 0;
      realInvestment = Math.min(shortBal, longBal) * 0.9;
      if (realInvestment < plannedInvestmentUSDT) {
        // 잔고 부족 시 진입 스킵 (폴백 없음 — 잔고 재분배로 해결해야 함)
        get().addLog('warning', `[복리] 실잔고 부족 — 진입 스킵`,
          undefined,
          `숏(${opportunity.shortExchange.toUpperCase()}): $${fmtNum(shortBal, 0)} | 롱(${opportunity.longExchange.toUpperCase()}): $${fmtNum(longBal, 0)} | 필요: $${fmtNum(plannedInvestmentUSDT, 0)}`);
        return { success: false, error: '실잔고 부족 — 거래소 간 잔고 재분배 필요' };
      }
    }

    const previewProfit = estimateProfit(opportunity, realInvestment, strategyConfig.leverage, {
      feeOverrides: strategyConfig.feeOverrides,
      paybackOverrides: strategyConfig.paybackOverrides,
      useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
    });
    get().addLog('info',
      `전략 실행 시작: ${opportunity.baseAsset} | 숏:${opportunity.shortExchange.toUpperCase()} 롱:${opportunity.longExchange.toUpperCase()}`,
      undefined,
      `투자금: $${fmtNum(realInvestment, 0)} | 예상 8h순수익: $${fmtNum(previewProfit.netPerFunding)} (수수료: -$${fmtNum(previewProfit.totalFees)})`,
    );

    const pairId = `pair-${Date.now()}-${opportunity.baseAsset}`;
    set({ strategyRunning: true });

    try {
      // ── 헷징 실거래: 숏+롱 동시 진입 ──
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
          // apiConfigs는 서버 측 암호화 저장소에서 로드 (클라이언트 전송 X)
        }),
      });

      const json = await res.json() as ExecuteStrategyResult;
      const result: ExecuteStrategyResult = { ...json, pairId: json.pairId ?? pairId };

      // Guard 차단 응답 처리 (슬리피지 초과, 수익성 미달 등)
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
          `${opportunity.baseAsset} 진입 차단: ${errorMsg || '사전 검증 실패'}`,
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
          `${opportunity.shortExchange.toUpperCase()} 숏 포지션 진입 성공`,
          opportunity.shortExchange,
          `${opportunity.baseAsset} Short @${fmtNum(result.short.data?.price ?? opportunity.shortMarkPrice, 4)} | fee -$${fmtNum(result.short.data?.estimatedFee ?? 0, 4)} | ${result.short.data?.liquidity ?? 'unknown'}`,
        );
      } else {
        get().addLog('error',
          `${opportunity.shortExchange.toUpperCase()} 숏 포지션 진입 실패`,
          opportunity.shortExchange,
          result.short?.error,
        );
      }

      if (result.long?.success) {
        get().addLog('success',
          `${opportunity.longExchange.toUpperCase()} 롱 포지션 진입 성공`,
          opportunity.longExchange,
          `${opportunity.baseAsset} Long @${fmtNum(result.long.data?.price ?? opportunity.longMarkPrice, 4)} | fee -$${fmtNum(result.long.data?.estimatedFee ?? 0, 4)} | ${result.long.data?.liquidity ?? 'unknown'}`,
        );
      } else {
        get().addLog('error',
          `${opportunity.longExchange.toUpperCase()} 롱 포지션 진입 실패`,
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
      get().addLog('error', '전략 실행 중 오류 발생', undefined, (err as Error).message);
      queueTrade({
        timestamp: Date.now(), type: 'error', simulation: false,
        baseAsset: opportunity.baseAsset, reason: (err as Error).message,
      });
      return { success: false, error: (err as Error).message };
    } finally {
      set({ strategyRunning: false });
    }
  },

  // ── Close position ────────────────────────────
  async closePosition(position) {
    const { apiConfigs } = get();
    const config = apiConfigs[position.exchange];
    if (!config) {
      get().addLog('error', `${position.exchange.toUpperCase()} API 키 없음`, position.exchange);
      throw new Error(`${position.exchange.toUpperCase()} API 키 없음`);
    }

    get().addLog('info', `포지션 청산 시도: ${position.displaySymbol} ${position.side}`, position.exchange);

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
          `${position.displaySymbol} ${position.side.toUpperCase()} 청산 완료`,
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
        get().addLog('error', `청산 실패: ${json.error}`, position.exchange);
        throw new Error(`청산 실패: ${json.error}`);
      }
    } catch (err) {
      get().addLog('error', '청산 중 오류', position.exchange, (err as Error).message);
      throw err;
    }
  },

  // ── Test connection ───────────────────────────
  async testConnection(exchange) {
    const config = get().apiConfigs[exchange];
    if (!config) return false;

    get().addLog('info', `${exchange.toUpperCase()} 연결 테스트 중...`, exchange);

    try {
      const res = await fetch(`/api/exchanges/${exchange}/test`, {
        method: 'POST',
        headers: makeApiHeaders(config),
      });
      const json = await res.json() as { success: boolean; error?: string };

      if (json.success) {
        get().addLog('success', `${exchange.toUpperCase()} 연결 성공`, exchange);
      } else {
        get().addLog('error', `${exchange.toUpperCase()} 연결 실패`, exchange, json.error);
      }
      return json.success;
    } catch (err) {
      get().addLog('error', `${exchange.toUpperCase()} 연결 오류`, exchange, (err as Error).message);
      return false;
    }
  },

  // ── Logs ──────────────────────────────────────
  addLog(level, message, exchange, detail) {
    set((s) => {
      const newLogs = [makeLog(level, message, exchange, detail), ...s.logs].slice(0, 500);
      saveLogs(newLogs);
      return { logs: newLogs };
    });
    // Auto-persist to file
    queueLog(level, message, exchange, detail);
  },

  clearLogs() {
    set({ logs: [] });
    saveLogs([]);
  },

  // ── Simulation ────────────────────────────────
  async toggleSimulationMode() {
    const current = get().simulationMode;
    const next = !current;
    // 모드 전환 시 스나이프를 취소하지 않음 — 각 모드가 독립적으로 동시 실행
    set({ simulationMode: next });
    // 모드 상태 영속화
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
      saveSimMode(sharedState.simulationMode);
      get().addLog(
        'info',
        sharedState.simulationMode
          ? `[SIM] shared mode ON ($${get().strategyConfig.investmentUSDT * 2} virtual balance per exchange)`
          : '[REAL] shared mode ON',
      );
    } catch (err) {
      set({ simulationMode: current });
      saveSimMode(current);
      get().addLog('error', '[shared-state] failed to sync SIM/REAL mode', undefined, (err as Error).message);
    }
  },

  resetSimulation() {
    const perExchange = get().strategyConfig.investmentUSDT * 2; // 거래소당 투자금×2 (숏/롱 양쪽)
    const enabled = get().enabledExchanges;
    const newBal = {} as Record<ExchangeId, number>;
    for (const ex of SUPPORTED_EXCHANGES) {
      newBal[ex] = enabled.includes(ex) ? perExchange : 0;
    }
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
    });
    clearSimState();
    saveFundingHistory([]);
    void fetch('/api/sim-state', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabledExchanges: enabled,
        investmentUSDT: get().strategyConfig.investmentUSDT,
      }),
    }).then(r => r.json()).then((res: { success?: boolean; data?: SimStateSnapshot }) => {
      if (res.success && res.data) {
        applyServerSimStateSnapshot(set, res.data, { force: true });
      }
    }).catch(() => {});
    // 서버 측 거래내역 + 로그도 초기화
    fetch('/api/trades/clear', { method: 'DELETE' })
      .then(() => set({ tradesClearedAt: Date.now() }))
      .catch(() => set({ tradesClearedAt: Date.now() }));
    fetch('/api/logs/clear', { method: 'DELETE' }).catch(() => {});
    get().addLog('info', `[SIM] 초기화 완료 — 각 거래소 $${perExchange} 리셋`);
  },

  clearSimFundingHistory() {
    set({ fundingHistory: [] });
    saveFundingHistory([]);
    void fetch('/api/sim-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clearFundingHistory' }),
    }).catch(() => {});
    get().addLog('info', '[SIM] 펀딩 수령 내역 초기화 완료');
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

    // ── 실제 호가창 기반 청산 체결가 (슬리피지 반영) ──
    let exitPrice = pos.markPrice;
    try {
      const exitSide = pos.side === 'short' ? 'buy' : 'sell';
      const res = await fetch(`/api/exchanges/${pos.exchange}/orderbook?symbol=${encodeURIComponent(pos.symbol)}&side=${exitSide}&notional=${pos.sizeUSD}`).then(r => r.json());
      if (res.success) {
        exitPrice = res.fillPrice;
        get().addLog('info', `[SIM] ${pos.baseAsset} ${pos.side} 청산 체결가: $${fmtNum(exitPrice, 2)} (슬리피지: ${fmtNum(res.slippagePercent, 4)}%)`, pos.exchange);
      }
    } catch {
      // 호가창 조회 실패 시 markPrice 사용
    }

    const exitNotional = pos.size * exitPrice; // 현재 가격 기반 실제 청산 노셔널
    const exitFee = exitNotional * getConfiguredExchangeFee(get().strategyConfig, pos.exchange, 'taker');
    const pricePnl = pos.side === 'short'
      ? (pos.entryPrice - exitPrice) * pos.size
      : (exitPrice - pos.entryPrice) * pos.size;

    // ── 스나이프 펀딩 직접 계산 (tickSimFunding 의존 X) ──
    let actualFunding = pos.fundingCollected;
    if (pos.isSnipe && actualFunding === 0) {
      // tickSimFunding에서 처리 못 한 경우 직접 계산
      // ★ 진입 시점 fundingRate 사용 — 청산 시점 liveRate는 이미 다음 주기로 갱신됐을 수 있음
      const currentRate = pos.fundingRate;
      actualFunding = pos.side === 'short'
        ? pos.sizeUSD * currentRate
        : pos.sizeUSD * (-currentRate);
      // 잔고에도 반영
      set(s => ({
        simBalances: { ...s.simBalances, [pos.exchange]: (s.simBalances[pos.exchange] ?? 0) + actualFunding },
        simTotalFundingEarned: s.simTotalFundingEarned + actualFunding,
      }));
      get().addLog('info',
        `[SIM] 펀딩 직접 계산: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        pos.exchange,
        `$${fmtNum(Math.abs(actualFunding), 4)} (rate: ${fmtNum(currentRate * 100, 4)}%)`,
      );
    }

    const returnAmount = pos.margin + pricePnl - exitFee;
    const netPnl = pricePnl + actualFunding - (pos.entryFee ?? 0) - exitFee;

    // ── 펀딩 수령 내역 기록: tickSimFunding이 이미 기록한 경우 스킵 (fallback 직접계산인 경우만 기록) ──
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
      `[SIM] 포지션 청산: ${pos.displaySymbol} ${pos.side.toUpperCase()}`,
      pos.exchange,
      `순손익: ${netPnl >= 0 ? '+' : ''}$${fmtNum(netPnl)} (펀딩: $${fmtNum(actualFunding, 4)}, 가격손익: $${fmtNum(pricePnl)}, 수수료: -$${fmtNum((pos.entryFee ?? 0) + exitFee)})`,
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
        message: `[SIM] 펀딩 ${funding >= 0 ? '수령' : '지불'}: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        exchange: pos.exchange,
        detail: `$${fmtNum(Math.abs(funding), 4)} (${fmtNum(currentRate * 100, 4)}%${liveRate ? '' : ' [진입시rate]'})`,
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

    // 디버그: 스나이프 자동청산 판단 로그
    if (updated.some(p => p.isSnipe)) {
      const snipePositions = updated.filter(p => p.isSnipe);
      for (const p of snipePositions) {
        if ((p.fundingReceived ?? 0) >= 1) {
          pendingLogs.push({
            level: 'info',
            message: `[스나이프 청산대기] ${p.baseAsset} ${p.side} — fundingReceived:${p.fundingReceived} → 자동청산 예정`,
            exchange: p.exchange,
            detail: `simId:${p.simId} | pairId:${p.pairId} | 수령펀딩:$${fmtNum(p.fundingCollected, 4)}`,
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

    // 텔레그램: 펀딩 수익 알림 (합산 메시지)
    if (simFundingPayments.length > 0 && totalNewFunding !== 0) {
      const lines = simFundingPayments.map(p =>
        `  ${p.exchange.toUpperCase()} ${p.symbol} (${p.side}): ${p.amount >= 0 ? '+' : ''}$${p.amount.toFixed(4)}`
      );
      const icon = totalNewFunding >= 0 ? '💰' : '💸';
      void sendTelegramMessage([
        `${icon} <b>[SIM] 펀딩 수령: ${simFundingPayments.length}건</b>`,
        ...lines,
        `\n합계: ${totalNewFunding >= 0 ? '+' : ''}$${totalNewFunding.toFixed(4)}`,
      ].join('\n'));
    }

    // 텔레그램: 잔고 부족 경고 (평균 대비 50% 이하, 30분 쿨다운)
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
              simulation: true, // tickSimFunding은 항상 SIM 전용
            }));
            break;
          }
        }
      }
    }

    // 스나이핑: 펀딩 수령 완료 → 즉시 청산 → 다음 사이클 재예약
    if (snipeToClose.length > 0) {
      queueMicrotask(async () => {
        // 포지션 닫기 전에 pair 정보 캡처 (닫은 후에는 simPositions에서 사라짐)
        const positionsSnapshot = [...get().simPositions];

        // 청산 후 실제 결과를 수집
        const closeResults: { pos: typeof snipeToClose[0]; result: { netPnl: number; funding: number } | null }[] = [];
        for (const pos of snipeToClose) {
          const result = await get().closeSimPosition(pos.simId);
          closeResults.push({ pos, result });
        }
        const totalCollected = snipeToClose.reduce((s, p) => s + p.fundingCollected, 0);
        get().addLog('success',
          `[스나이핑] 펀딩 수령 완료 → ${snipeToClose.length}개 포지션 자동 청산`,
          undefined,
          `총 수령: $${fmtNum(totalCollected, 4)}`,
        );

        // 텔레그램: 스나이프 완료 알림 — 실제 청산 결과(fillPrice 기반 netPnl) 사용
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
            simulation: true, // tickSimFunding은 SIM 전용
          }));
        }

        // 청산된 코인들 타이머 정리 + 다음 사이클 자동 재예약
        const closedKeys = [...new Set(
          snipeToClose.map((position) => getSimPositionOpportunityKey(position, positionsSnapshot)),
        )];
        for (const key of closedKeys) {
          get().cancelSnipeForAsset(mkSnipeKey(true, key)); // tickSimFunding은 SIM 전용
        }
        if (get().simSnipeActive || get().realSnipeActive) {
          get().scheduleAllSnipes();
        }
      });
    }

    // 홀딩: 스프레드 역전 감지 → 자동 청산
  },

  // ── Exchange Toggle ─────────────────────────
  toggleExchange(exchange) {
    const { enabledExchanges, simPositions } = get();

    // 해당 거래소에 열린 포지션이 있으면 OFF 불가 (시뮬 + 실거래 모두 체크)
    if (enabledExchanges.includes(exchange)) {
      const hasSimPositions = simPositions.some(p => p.exchange === exchange);
      const hasRealPositions = get().positions.some(p => p.exchange === exchange);
      if (hasSimPositions || hasRealPositions) {
        get().addLog('warning',
          `${exchange.toUpperCase()} OFF 불가 — 열린 포지션이 있습니다`,
          exchange,
          '포지션을 먼저 청산하세요',
        );
        return;
      }
    }

    let next: ExchangeId[];
    if (enabledExchanges.includes(exchange)) {
      // OFF: 최소 2개는 유지해야 헷징 가능
      if (enabledExchanges.length <= 2) {
        get().addLog('warning', '최소 2개 거래소가 필요합니다 — 비활성화 불가');
        return;
      }
      next = enabledExchanges.filter(e => e !== exchange);
    } else {
      // ON
      next = [...enabledExchanges, exchange];
    }

    // Smart sim balance redistribution — preserve position margins
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
      `${exchange.toUpperCase()} ${action} — 활성 ${next.length}개 거래소`,
      exchange,
      `시뮬 총 자산: $${fmtNum(totalSim, 0)} (포지션 마진 보존됨)`,
    );

    // 즉시 새 설정으로 펀딩률 갱신
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

  // ── UI ────────────────────────────────────────
  setShowApiPanel: (v) => set({ showApiPanel: v }),
  setShowStrategyPanel: (v) => set({ showStrategyPanel: v }),
  setRateFilter: (v) => set({ rateFilter: v }),
  setExchangeFilter: (v) => set({ exchangeFilter: v }),
  setPositionToClose: (v) => set({ positionToClose: v }),

  // ── 예약 코인 실시간 재검증: 1초 간격 체크 — netProfit ≤ 0 즉시 해제 + 더 좋은 기회로 교체 ──
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

    // 실슬리피지+수수료 반영 순수익 계산 헬퍼 (복리 시 실잔고 기반 notional)
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
      // realSpread 없으면 보수적으로 -1 반환 (이론값 진입 금지)
      if (!hasRS) return -1;
      // effectiveSpread에 슬리피지+수수료 모두 반영됨
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

      // 해당 모드가 비활성이면 정리
      if (isSim && !get().simSnipeActive) { get().cancelSnipeForAsset(key); continue; }
      if (!isSim && !get().realSnipeActive) { get().cancelSnipeForAsset(key); continue; }

      // 펀딩 15초 전이면 lock-in — 재검증 스킵 (레이스 컨디션 방지)
      const targetTime = snipeTargets[key];
      if (targetTime && targetTime - Date.now() < 15_000) continue;

      if (!currentOpp) {
        get().addLog('warning', `[재검증] ${asset} 기회 소멸 — 예약 해제`);
        get().cancelSnipeForAsset(key);
        continue;
      }

      // 실효스프레드(오더북 슬리피지 반영) 기준 순수익 재계산
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
      // effectiveSpread는 표시용(안전마진 미포함) → 실행 판단 시 안전마진 별도 차감
      const liveNetProfit = oppNotional * ((effectiveSpreadPercent - SAFETY_MARGIN_PCT) / 100);

      // 순수익 ≤ 0 시 해제 — 진입 기준(3bps)과 동일한 안전마진 적용
      if (liveNetProfit <= 0) {
        get().addLog('warning',
          `[재검증] ${asset} 순수익 기준 미달 — 예약 해제`,
          undefined,
          `실효스프레드: ${fmtNum(effectiveSpreadPercent, 4)}% | 순수익: $${fmtNum(liveNetProfit)}`,
        );
        get().cancelSnipeForAsset(key);
        continue;
      }

      // 10%+ 더 좋은 기회 발견 시 교체 (실슬리피지 반영 순수익 기준)
      // 단, 더 늦은 펀딩 시점으로 갈아타지 않게 제한한다.
      // ★ 후보에 realSpread가 없으면 이론값 과대평가 → 교체→해제 루프 방지
      const MAX_REPLACEMENT_DELAY_MS = 10 * 60 * 1000;
      const betterOpp = opportunities.find(o => {
        if (getOpportunityId(o) === opportunityId) return false;
        // 같은 모드에서 이미 예약됨
        if (snipeTargets[mkSnipeKey(isSim, getOpportunityId(o))]) return false;
        if (opportunityConflictsWithLegs(o, occupiedLegs)) return false;
        if (o.spreadPercent < effectiveMinPercent) return false;
        if ((o.nextFundingTime - targetTime) > MAX_REPLACEMENT_DELAY_MS) return false;
        // ★ realSpread 없는 후보는 교체 대상에서 제외 (이론값 과대평가 방지)
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
          `[교체] ${asset}($${fmtNum(liveNetProfit)}) → ${betterOpp.baseAsset}($${fmtNum(betterLiveNet)}) +${improvePct}%`,
          undefined,
          `실효스프레드 확인됨`,
        );
        get().cancelSnipeForAsset(key);
        get().scheduleSnipeForAsset(betterOpp, isSim);
      }
    }
  },

  // ── 트루 스나이핑: 코인별 독립 타이머 — 펀딩 7초 전 진입 → 수령 확인 → 즉시 청산 ──

  // 펀딩 주기별(1h/4h/8h) 버킷 라운드로빈 → 짧은 주기 우선 보장
  // 각 활성 모드(sim/real)에 대해 독립적으로 스케줄링
  scheduleAllSnipes() {
    // SIM: 클라이언트 타이머로 스케줄링
    // REAL: 서버 스케줄러가 전담 → 클라이언트에서 중복 타이머 생성하지 않음
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

  // 내부: 특정 모드에 대한 스케줄링
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

    // 이미 예약되었거나 활성 포지션이 잡힌 레그는 다시 태우지 않는다.
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
      if (opportunityConflictsWithLegs(o, occupiedLegs)) { filterReasons.legConflict++; return false; }
      if (!currentEnabled.includes(o.shortExchange) || !currentEnabled.includes(o.longExchange)) { filterReasons.exchangeDisabled++; return false; }
      if (o.nextFundingTime - now > getScheduleAheadWindowMs(o)) { filterReasons.tooFarAhead++; return false; }
      // 과거 펀딩 시간만 차단 (normalizeFr에서 이미 보정하지만 안전장치)
      if (o.nextFundingTime < now) { filterReasons.pastFunding++; return false; }
      // 예약 단계: realSpread 있으면 수익성은 getLiveNetProfit(3bps 포함)에서 검증 → minSpread는 이론값에만 적용
      // effectiveSpread는 이미 수수료/슬리피지 차감 완료값이므로 minSpread(수수료 포함)와 비교하면 이중 필터
      const rs = getRealSpreadForOpportunity(preFilterRealSpreads, o);
      const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
      // ★ 유동성 필터: 개별 슬리피지 또는 거래소 간 가격 괴리가 maxSlippagePercent 이상이면 차단
      const maxSlip = strategyConfig.maxSlippagePercent ?? 1.5;
      if (hasRS && (rs.shortSlippage > maxSlip || rs.longSlippage > maxSlip)) { filterReasons.noProfit++; return false; }
      // effectiveSpread ≤ 0이면 슬리피지+수수료 > 펀딩 수익
      if (hasRS && rs.effectiveSpread <= 0) { filterReasons.noProfit++; return false; }
      // ★ 거래량 필터: 양쪽 거래소 중 하나라도 최소 거래량 미달이면 제외
      const minVol = strategyConfig.minVolume24hUSD ?? 7_500_000;
      if (minVol > 0) {
        const shortVol = fundingRates.find(r => r.exchange === o.shortExchange && r.baseAsset === o.baseAsset)?.quoteVolume24h;
        const longVol = fundingRates.find(r => r.exchange === o.longExchange && r.baseAsset === o.baseAsset)?.quoteVolume24h;
        if ((typeof shortVol === 'number' && shortVol < minVol) || (typeof longVol === 'number' && longVol < minVol)) {
          filterReasons.noProfit++; return false;
        }
      }
      if (!hasRS && o.spreadPercent < effectiveMinPercent) { filterReasons.lowSpread++; return false; }
      if (!hasRS) {
        const evProfit = estimateProfit(o, strategyConfig.investmentUSDT, strategyConfig.leverage, {
          feeOverrides: strategyConfig.feeOverrides,
          paybackOverrides: strategyConfig.paybackOverrides,
          useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
        });
        if (evProfit.netPerFunding <= 0 || !evProfit.conservativeEV.passesMinProfit || !evProfit.conservativeEV.passesEVRatio) {
          filterReasons.noProfit++; return false;
        }
      }
      return true;
    });

    if (filtered.length === 0 && opportunities.length > 0) {
      if (!_lastScheduleDiagAt || now - _lastScheduleDiagAt > 30_000) {
        _lastScheduleDiagAt = now;
        const parts = [];
        if (filterReasons.legConflict > 0) parts.push(`레그충돌:${filterReasons.legConflict}`);
        if (filterReasons.exchangeDisabled > 0) parts.push(`거래소비활성:${filterReasons.exchangeDisabled}`);
        if (filterReasons.tooFarAhead > 0) parts.push(`시간초과:${filterReasons.tooFarAhead}`);
        if (filterReasons.pastFunding > 0) parts.push(`과거시간:${filterReasons.pastFunding}`);
        if (filterReasons.lowSpread > 0) parts.push(`스프레드미달:${filterReasons.lowSpread}`);
        if (filterReasons.noProfit > 0) parts.push(`수익없음:${filterReasons.noProfit}`);
        get().addLog('warning',
          `[스케줄-진단][${modePrefix.toUpperCase()}] 기회 ${opportunities.length}개 전부 탈락`,
          undefined,
          `사유: ${parts.join(' | ')} | 최소스프레드: ${effectiveMinPercent}%`,
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
        // ★ effectiveSpread는 표시용(안전마진 미포함) → 스케줄링 시 안전마진 별도 차감
        return n * ((rs.effectiveSpread - SAFETY_MARGIN_PCT) / 100);
      }
      // 실측 없으면 이론 기반 보수적 계산 (안전마진 포함)
      const hedgeFeePct = getConfiguredHedgeFees(
        strategyConfig,
        o.shortExchange,
        o.longExchange,
        'taker',
      ) * 100;
      const netPct = calcNetSpreadPercent(o.spreadPercent, 0, hedgeFeePct);
      return n * (netPct / 100);
    };
    const profitable = filtered.filter(o => getLiveNetProfit(o) > 0);

    if (profitable.length === 0 && filtered.length > 0) {
      if (!_lastScheduleDiagAt || now - _lastScheduleDiagAt > 30_000) {
        _lastScheduleDiagAt = now;
        const sample = filtered[0];
        const rs = getRealSpreadForOpportunity(currentRealSpreads, sample);
        const effSpr = (rs && Date.now() - rs.updatedAt < 30_000) ? rs.effectiveSpread : null;
        get().addLog('warning',
          `[스케줄-진단][${modePrefix.toUpperCase()}] ${filtered.length}개 기회가 실효스프레드 수익 체크에서 전부 탈락`,
          undefined,
          `예시: ${sample.baseAsset} 이론:${fmtNum(sample.spreadPercent, 4)}% 실효:${effSpr !== null ? fmtNum(effSpr, 4) + '%' : '없음'} netProfit:$${fmtNum(getLiveNetProfit(sample))}`,
        );
      }
      return;
    }

    // 시뮬레이션 모드: 잔고 체크 전 재분배 먼저 실행 (잔고 부족 방지)
    if (isSim) {
      get().redistributeBalances();
    }
    const latestSimBalances = get().simBalances;
    const latestRealBalances = get().balances;

    // 거래소별 가용 잔고 추적 (자금 초과 예약 방지)
    const availableBalance: Record<string, number> = {};
    for (const ex of currentEnabled) {
      const bal = isSim
        ? (latestSimBalances[ex] ?? 0)
        : (latestRealBalances[ex]?.availableUSDT ?? 0);
      availableBalance[ex] = bal;
    }

    // 이미 예약된 코인의 마진을 순차 차감 (복리: 이전 예약이 줄인 잔고 반영)
    // 펀딩 시각 순 정렬 — 이른 펀딩이 먼저 자금을 사용하므로 순서가 중요
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
      const groupCandidates = group
        .filter((opportunity) => !opportunityConflictsWithLegs(opportunity, occupiedLegs))
        .sort((a, b) => {
          const scoreDiff = getOpportunityYieldScore(
            b,
            getRealSpreadForOpportunity(currentRealSpreads, b),
            strategyConfig,
          ) - getOpportunityYieldScore(
            a,
            getRealSpreadForOpportunity(currentRealSpreads, a),
            strategyConfig,
          );
          if (scoreDiff !== 0) return scoreDiff;
          return getLiveNetProfit(b) - getLiveNetProfit(a);
        });

      const planned = planWindowAllocations(
        groupCandidates,
        availableBalance,
        strategyConfig,
        currentRealSpreads,
      );

      if (planned.length === 0) {
        balanceSkips += groupCandidates.length;
        continue;
      }

      for (const plan of planned) {
        const intervalH = Math.round(getOpportunityIntervalHours(plan.opportunity));
        const minsLeft = Math.round((plan.opportunity.nextFundingTime - now) / 60000);
        get().addLog('info',
          `[스케줄-헷징][${modePrefix.toUpperCase()}] ${plan.opportunity.baseAsset} 선택 — ${minsLeft}분 후 펀딩`,
          undefined,
          `주기:${intervalH}h | 투자금:$${fmtNum(plan.investmentUSDT, 0)} | 스프레드:+${fmtNum(plan.opportunity.spreadPercent, 4)}% | ${plan.opportunity.shortExchange}↔${plan.opportunity.longExchange}`,
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
          `[스케줄-진단][${modePrefix.toUpperCase()}] ${profitable.length}개 수익 기회 → 잔고부족:${balanceSkips}`,
          undefined,
          `기준투자금:$${strategyConfig.investmentUSDT} | 가용잔고: ${balInfo}`,
        );
      }
    }
  },

  // 특정 코인 1개에 대한 스나이핑 예약 (모드별)
  scheduleSnipeForAsset(opportunity, isSim, investmentUSDT) {
    const { _snipeTimers, snipeTargets } = get();
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(opportunity));

    // 이미 예약된 키면 스킵
    if (snipeTargets[snipeKey]) return;

    // 기존 타이머 정리
    if (_snipeTimers[snipeKey]) clearTimeout(_snipeTimers[snipeKey]);

    // 과거 시간 보정
    const intervalMs = opportunity.fundingIntervalMs ?? 8 * 3600 * 1000;
    let targetTime = opportunity.nextFundingTime;
    const now = Date.now();
    while (targetTime <= now) {
      targetTime += intervalMs;
    }

    const entryLeadMs = getResolvedTimingConfig(get().strategyConfig.timingConfig).entryLeadMs;

    // 펀딩까지 6초 미만 → 다음 사이클 (ENTRY_BEFORE_MS=5초보다 약간 여유)
    if (targetTime - now < entryLeadMs + 1_000) {
      targetTime += intervalMs;
    }

    const entryDelay = Math.max(0, targetTime - now - entryLeadMs);

    // 타이머 등록
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
      `[스나이핑-헷징][${modeLabel}] ${opportunity.baseAsset} 예약 — ${mins}분 ${secs}초 후`,
      undefined,
      `펀딩주기: ${intervalH}h | 투자금:$${fmtNum(investmentUSDT ?? get().strategyConfig.investmentUSDT, 0)} | 스프레드: +${fmtNum(opportunity.spreadPercent, 4)}%`,
    );
  },

  // ★ 내부: 펀딩 직전 진입 실행 + 수령 후 자동청산 예약
  _executeSnipeEntry(opportunity: ArbitrageOpportunity, targetFundingTime: number, isSim: boolean) {
    const modeActive = isSim ? get().simSnipeActive : get().realSnipeActive;
    const modeLabel = isSim ? 'SIM' : 'REAL';
    // 자동화 비활성 시 진입 차단 (청산 실패 등으로 일시정지된 경우)
    if (!modeActive) {
      get().addLog('warning', `[스나이핑-헷징][${modeLabel}] ${opportunity.baseAsset} 진입 스킵 — 자동화 비활성 상태`);
      return;
    }

    const asset = opportunity.baseAsset;
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(opportunity));
    const plannedInvestmentUSDT = get().snipeAllocations[snipeKey] ?? get().strategyConfig.investmentUSDT;

    // ★ 실행 직전 시간 검증 — 펀딩 시간이 이미 지났거나 너무 일찍이면 차단
    const secsUntilFunding = (targetFundingTime - Date.now()) / 1000;
    if (secsUntilFunding < -10) {
      get().addLog('warning', `[스나이핑-헷징][${modeLabel}] ${asset} 진입 차단 — 펀딩 시간이 ${Math.abs(secsUntilFunding).toFixed(0)}초 전에 이미 지남`);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }
    if (secsUntilFunding > 30) {
      get().addLog('warning', `[스나이핑-헷징][${modeLabel}] ${asset} 진입 차단 — 펀딩까지 ${secsUntilFunding.toFixed(0)}초 남음 (너무 이름)`);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const { enabledExchanges: currentEnabled } = get();

    // 진입 시점에 해당 코인의 최신 기회 확인 (순수익 + 최소스프레드 기준)
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
      // realSpread 없으면 진입 불가 — 이론값만으로 진입 금지
      if (!hasRS) return false;
      const effSpreadPct = rs.effectiveSpread; // 슬리피지+수수료 모두 반영됨
      const liveNet = n * (effSpreadPct / 100);
      return liveNet > 0;
    };
    const finalTarget = latestOpp && meetsThreshold(latestOpp)
      ? latestOpp
      : meetsThreshold(opportunity) ? opportunity : null;

    if (!finalTarget) {
      get().addLog('warning', `[스나이핑-헷징][${modeLabel}] ${asset} 기준 미달 — 스킵`);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const secsToFunding = Math.max(0, (targetFundingTime - Date.now()) / 1000).toFixed(1);
    get().addLog('info',
      `[스나이핑-헷징][${modeLabel}] ${asset} 진입 실행 — 펀딩까지 ${secsToFunding}초`,
      undefined,
      `숏:${finalTarget.shortExchange.toUpperCase()} 롱:${finalTarget.longExchange.toUpperCase()} | 투자금:$${fmtNum(plannedInvestmentUSDT, 0)} | 스프레드: +${fmtNum(finalTarget.spreadPercent, 4)}%`,
    );

    // 실행 직전 최종 확인 — 다른 자산 청산 실패로 비활성화됐을 수 있음
    const modeActiveRecheck = isSim ? get().simSnipeActive : get().realSnipeActive;
    if (!modeActiveRecheck) {
      get().addLog('warning', `[스나이핑-헷징][${modeLabel}] ${asset} 진입 직전 취소 — 자동화 비활성 상태`);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const entryTarget = { ...finalTarget, nextFundingTime: targetFundingTime };
    get().executeStrategy(entryTarget, isSim, plannedInvestmentUSDT).then((result) => {
      if (result.success) {
        // 진입 성공 후 자동화 비활성 체크 — 다른 자산 청산 실패로 정지된 경우
        const stillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (!stillActive) {
          get().addLog('warning',
            `[스나이핑-헷징][${modeLabel}] ${asset} 진입 성공했으나 자동화 비활성 — 서버 체결 수량으로 즉시 정리`,
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
                `[스나이핑-헷징][${modeLabel}] ${asset} stale 진입 정리 실패 — 체결 정보 없음, 수동 확인 필요`,
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
                  `[스나이핑-헷징][${modeLabel}] ${asset} stale 진입 자동 정리 1차 실패 — 1초 후 재시도`,
                  undefined,
                  lastCloseErrors.join('; '),
                );
                await new Promise(r => setTimeout(r, 1_000));
              }
            }

            if (pendingClosures.length > 0) {
              get().addLog('error',
                `[스나이핑-헷징][${modeLabel}] ${asset} stale 진입 자동 정리 ${pendingClosures.length}/${stalePositions.length}개 실패 — 수동 확인 필요`,
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
                `[스나이핑-헷징][${modeLabel}] ${asset} stale 진입 자동 정리 완료`,
              );
            }

            get().cancelSnipeForAsset(snipeKey);
          };
          void cleanupStaleEntry().catch((err) => {
            get().addLog('error',
              `[스나이핑-헷징][${modeLabel}] ${asset} stale 진입 정리 중 오류`,
              undefined,
              (err as Error).message,
            );
            get().cancelSnipeForAsset(snipeKey);
          });
          return;
        }

        get().addLog('success',
          `[스나이핑-헷징][${modeLabel}] ${asset} 진입 완료`,
          undefined,
          `펀딩까지 ~${secsToFunding}초`,
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
          `[스나이핑-헷징][${modeLabel}] ${asset} 자동청산 예약 — ${fmtNum(closeDelay / 1000, 0)}초 후`,
        );
        // 진입 후 남은 자금으로 다음 최고 수익 기회 자동 예약
        const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (modeStillActive) {
          get().scheduleAllSnipes();
        }
      } else {
        get().addLog('error', `[스나이핑-헷징][${modeLabel}] ${asset} 진입 실패`, undefined, result.error);
        get().cancelSnipeForAsset(snipeKey);
        const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (modeStillActive) {
          get().scheduleAllSnipes();
        }
      }
    });
  },

  // ★ 내부: 펀딩 수령 확인 + 포지션 청산 + 다음 사이클 재예약
  async _executeSnipeClose(target: ArbitrageOpportunity, isSim: boolean) {
    const asset = target.baseAsset;
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(target));
    const modeLabel = isSim ? 'SIM' : 'REAL';
    let closeFailed = false;

    if (isSim) {
      // 시뮬레이션: tickSimFunding 의존 X → 직접 해당 코인 포지션 찾아서 청산
      const simPosForAsset = get().simPositions.filter((position) =>
        position.baseAsset === asset
        && position.isSnipe
        && (position.exchange === target.shortExchange || position.exchange === target.longExchange),
      );
      if (simPosForAsset.length === 0) {
        get().addLog('warning', `[스나이핑-헷징][${modeLabel}] ${asset} 시뮬 포지션 없음`);
      } else {
        for (const pos of simPosForAsset) {
          await get().closeSimPosition(pos.simId);
        }
        const totalCollected = simPosForAsset.reduce((s, p) => s + p.fundingCollected, 0);
        get().addLog('success',
          `[스나이핑-헷징][${modeLabel}] ${asset} 시뮬 청산 완료`,
          undefined,
          `${simPosForAsset.length}개 포지션 | 수령 펀딩: $${fmtNum(totalCollected, 4)}`,
        );
      }
    } else {
      // ★ 실거래: 즉시 청산 (T+2s) → 펀딩 검증은 비동기로 후처리
      const currentPositions = get().positions;
      const targetPositions = currentPositions.filter(p => {
        if (p.baseAsset !== asset) return false;
        if (p.positionType === 'manual') return false; // 사용자 수동 포지션 보호
        return (p.exchange === target.shortExchange || p.exchange === target.longExchange)
          && (p.positionType === 'hedge_short' || p.positionType === 'hedge_long');
      });

      if (targetPositions.length > 0) {
        get().addLog('info', `[스나이핑-헷징][${modeLabel}] ${asset} ${targetPositions.length}개 즉시 청산 중...`);
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
            `[스나이핑-헷징][${modeLabel}] ${asset} 청산 ${failedLegs.length}/${targetPositions.length}개 실패 — 자동화 일시정지, 수동 확인 필요`,
            undefined,
            failedLegs.map(r => (r as PromiseRejectedResult).reason?.message || 'unknown').join('; '),
          );
          queueTrade({
            timestamp: Date.now(), type: 'exit_failed', simulation: false,
            baseAsset: asset, shortExchange: target.shortExchange, longExchange: target.longExchange,
            detail: `${failedLegs.length}/${targetPositions.length} legs failed`,
          });
        } else {
          get().addLog('success', `[스나이핑-헷징][${modeLabel}] ${asset} 청산 완료`);

          // 펀딩 수령 확인은 비동기로 — 청산을 지연시키지 않음 (확인 후 실제 순손익 확정)
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
                    `[스나이핑-헷징][${modeLabel}] ${asset} 펀딩 수령 확인`,
                    undefined,
                    `${recentFundings.length}건 / 합계 $${fmtNum(totalFunding, 4)} | 최종 순손익 ${verifiedPnl >= 0 ? '+' : ''}$${fmtNum(verifiedPnl ?? 0, 4)}${fundingBreakdown ? ` | ${fundingBreakdown}` : ''}`,
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
                  `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} ????섎졊 ?뺤씤 ?ъ떆??${attempt + 1} ?ㅽ뙣`,
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
                `[스나이핑-헷징][${modeLabel}] ${asset} 펀딩 수령 미확인 — 가격손익 기준 잠정 순손익 ${verifiedPnl >= 0 ? '+' : ''}$${fmtNum(verifiedPnl ?? 0, 4)}`,
              );
            }

            void sendTelegramMessage(formatSnipeCompleteAlert({
              baseAsset: asset,
              shortExchange: target.shortExchange,
              longExchange: target.longExchange,
              fundingCollected: verifiedFunding,
              pnl: verifiedPnl,
              simulation: false,
              note: fundingVerified ? undefined : '펀딩 수령은 거래소 정산 내역 추가 확인 필요',
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
        get().addLog('warning', `[스나이핑-헷징][${modeLabel}] ${asset} 청산할 포지션 없음`);
      }
    }

    // 해당 키 타이머 정리
    get().cancelSnipeForAsset(snipeKey);

    // 청산 실패 시 자동화 일시정지 — 잔여 포지션이 있는 상태에서 새 스나이프 차단
    if (!isSim && closeFailed) {
      // REAL 모드의 진입 타이머만 정리 — 청산 타이머는 유지 (다른 자산의 열린 포지션 보호)
      const { _snipeTimers, snipeTargets: currentTargets } = get();
      const realTimerKeys = Object.keys(_snipeTimers).filter(k => k.startsWith('real:'));
      for (const k of realTimerKeys) clearTimeout(_snipeTimers[k]);
      const newTimers = { ...get()._snipeTimers };
      const newTargets = { ...currentTargets };
      for (const k of realTimerKeys) { delete newTimers[k]; delete newTargets[k]; }
      set({ realSnipeActive: false, snipeTargets: newTargets, _snipeTimers: newTimers });
      // 서버에 비활성 상태 저장 + 서버 스케줄러 정지 (재시도 포함)
      void fetch('/api/snipe-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realSnipeActive: false }) }).catch(() => {});
      void stopServerScheduler(get().addLog);
      get().addLog('error',
        `[스나이핑-헷징][${modeLabel}] 청산 실패로 자동화 일시정지 — 진입 예약 해제 (기존 청산 타이머 유지), 잔여 포지션 확인 후 수동 재개 필요`,
      );
      return;
    }

    const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
    if (modeStillActive) {
      get().scheduleAllSnipes();
    }
  },

  // 특정 코인의 스나이핑 타이머만 정리
  cancelSnipeForAsset(snipeKey: string) {
    const { _snipeTimers, _snipeCloseTimers } = get();
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

  // 스나이핑 중지 (모드별 또는 전체)
  cancelSnipe(mode = 'all') {
    const { _snipeTimers, _snipeCloseTimers, snipeTargets: currentTargets } = get();

    if (mode === 'all') {
      for (const t of Object.values(_snipeTimers)) clearTimeout(t);
      for (const t of Object.values(_snipeCloseTimers)) clearTimeout(t);
      set({ simSnipeActive: false, realSnipeActive: false, snipeTargets: {}, snipeAllocations: {}, _snipeTimers: {}, _snipeCloseTimers: {} });
      // 서버에 비활성 상태 저장 + 서버 스케줄러 정지 (재시도 포함)
      void fetch('/api/snipe-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ simSnipeActive: false, realSnipeActive: false }) }).catch(() => {});
      void fetch('/api/sim-scheduler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).catch(() => {});
      void stopServerScheduler(get().addLog);
      get().addLog('info', '[스나이핑] 전체 중지됨');
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
      // REAL 모드 정지 시 서버 스케줄러도 함께 정지 (재시도 포함)
      if (mode === 'real') {
        void stopServerScheduler(get().addLog);
      } else {
        void fetch('/api/sim-scheduler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).catch(() => {});
      }
      get().addLog('info', `[스나이핑] ${mode.toUpperCase()} 모드 중지됨`);
    }
  },

  async fetchFundingHistory() {
    // 시뮬레이션 모드에서는 실거래 API 조회하지 않음 (tickSimFunding에서 자체 기록)
    if (get().simulationMode) return;
    set({ isLoadingHistory: true });
    const { apiConfigs, enabledExchanges, fundingHistory: previousHistory } = get();
    const targetExchanges = Array.from(new Set<ExchangeId>([
      ...enabledExchanges,
      ...(Object.keys(apiConfigs) as ExchangeId[]),
    ]));

    const apiHistory: FundingPayment[] = [];
    const failures: string[] = [];
    let apiSuccessCount = 0;

    const fallbackHistory = await loadFundingHistoryFromTradeLog(false).catch((err) => {
      get().addLog('warning', '[????섎졊] 嫄곕옒 濡쒓렇 fallback 濡쒕뱶 ?ㅽ뙣', undefined, (err as Error).message);
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
      get().addLog('warning', '[????섎졊] ?쇰? 嫄곕옒??議고쉶 ?ㅽ뙣', undefined, failures.join(' | '));
    }

    if (apiSuccessCount === 0 && fallbackHistory.length > 0) {
      get().addLog('info', `[????섎졊] 嫄곕옒 濡쒓렇 fallback?쇰줈 ${fallbackHistory.length}嫄?蹂듭썝`);
    }

    if (mergedHistory.length > 0) {
      saveFundingHistory(mergedHistory);
      set({ fundingHistory: mergedHistory, isLoadingHistory: false });
      return;
    }

    if (previousHistory.length > 0 && failures.length > 0) {
      set({ isLoadingHistory: false });
      get().addLog('warning', '[????섎졊] ?ㅽ뙣濡?湲곗〈 ?댁뿭??留ㅼ?');
      return;
    }

    saveFundingHistory([]);
    set({ fundingHistory: [], isLoadingHistory: false });
  },
}));
