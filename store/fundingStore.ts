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
  getOpportunityHourlyNetProfit,
  getOpportunityId,
  getOpportunityIntervalHours,
  getOpportunityLegKeys,
  makeOpportunityId,
} from '@/lib/opportunities';
import { fmtNum } from '@/lib/format';
import { sendTelegramMessage, formatBalanceWarning, formatSnipeCompleteAlert } from '@/lib/telegram';
import {
  DEFAULT_TIMING_CONFIG,
  getHedgeFeesWithOverrides,
  getExchangeFee,
  calcNetSpreadPercent,
  SAFETY_MARGIN_PCT,
  getResolvedTimingConfig,
  sanitizeFeeOverrides,
  sanitizeTimingConfig,
} from '@/lib/types';

// ?????????????????????????????????????????????
// Fee constants (fallback for contexts without exchange info)
// ?????????????????????????????????????????????
const TAKER_FEE_FALLBACK = 0.0006; // 0.06% worst-case fallback (bitget taker)
let _lastScheduleDiagAt = 0; // 吏꾨떒 濡쒓렇 ?ㅽ뙵 諛⑹?

/** ?쒕쾭 ?ㅼ?以꾨윭 ?뺤? ???ъ떆??2?? ?ㅽ뙣 ??寃쎄퀬 濡쒓렇 */
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
  addLog?.('error', '[?ㅼ?以꾨윭] ?쒕쾭 ?ㅼ?以꾨윭 ?뺤? ?ㅽ뙣 (3???ъ떆?? ???섎룞 ?뺤씤 ?꾩슂');
  return false;
}
let _lastBalanceWarnAt = 0;  // ?붾젅洹몃옩 ?붽퀬 寃쎄퀬 荑⑤떎??(30遺?
// 理쒖냼 ?ㅽ봽?덈뱶???ъ슜???ㅼ젙媛믪쓣 洹몃?濡??곌퀬,
// ?ㅼ젣 ?섏씡???먮떒? 嫄곕옒?뚮퀎 ?섏닔猷?override瑜?諛섏쁺??怨꾩궛?앹쑝濡?泥섎━?쒕떎.
function getEffectiveMinSpread(config: { minSpreadPercent: number }): number {
  return Math.max(0, config.minSpreadPercent);
}

function getConfiguredHedgeFees(
  config: Pick<StrategyConfig, 'feeOverrides'>,
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
  orderType: 'taker' | 'maker' = 'taker',
): number {
  return getHedgeFeesWithOverrides(
    shortExchange,
    longExchange,
    orderType,
    config.feeOverrides,
  );
}

function getConfiguredExchangeFee(
  config: Pick<StrategyConfig, 'feeOverrides'>,
  exchange: ExchangeId,
  orderType: 'taker' | 'maker' = 'taker',
): number {
  return getExchangeFee(exchange, orderType, config.feeOverrides);
}

function getResolvedStrategyConfig(config: StrategyConfig): StrategyConfig {
  return {
    ...config,
    feeOverrides: sanitizeFeeOverrides(config.feeOverrides),
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
  config: Pick<StrategyConfig, 'investmentUSDT' | 'leverage' | 'feeOverrides'>,
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
  );
}

function rebuildRealSpreadsForConfig(
  currentSpreads: Record<string, RealSpreadSnapshot>,
  opportunities: ArbitrageOpportunity[],
  strategyConfig: Pick<StrategyConfig, 'feeOverrides'>,
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
      effectiveSpread: calcNetSpreadPercent(
        opportunity.spreadPercent,
        spread.entryGapPct,
        hedgeFeePct,
        0, // ?쒖떆?? ?덉쟾留덉쭊 誘명룷??      ),
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
    timingConfig: getResolvedTimingConfig(strategyConfig.timingConfig),
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
      '[?ㅼ?以꾨윭] ?ㅼ젙 ?숆린???ㅽ뙣',
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
    timingConfig: getResolvedTimingConfig(strategyConfig.timingConfig),
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
      '[SIM Scheduler] ?ㅼ젙 ?숆린???ㅽ뙣',
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

/** ?쒕쾭 state媛 ?ㅼ쭏???곗씠?곕? 媛吏怨??덈뒗吏 ?먮퀎 */
function snapshotHasRealData(state: SimStateSnapshot): boolean {
  return state.simPositions.length > 0
    || state.fundingHistory.length > 0
    || state.simTotalFundingEarned !== 0
    || state.simTotalFees !== 0
    || state.simTotalClosedPnl !== 0;
}

function applyServerSimStateSnapshot(
  setState: (partial: Partial<FundingState>) => void,
  snapshot?: SimStateSnapshot | null,
  options?: { force?: boolean; getState?: () => FundingState },
) {
  if (!snapshot) return; // null/undefined ??鍮?state濡???뼱?곗? ?딆쓬

  // ???대쭅 ??鍮??쒕쾭 state媛 濡쒖뺄 ?곗씠?곕? ??뼱?곕뒗 寃껋쓣 諛⑹?
  // force=true (?섎룞 close/reset ??紐낆떆??mutation ?묐떟)????긽 ?곸슜
  if (!options?.force && options?.getState) {
    const local = options.getState();
    const localHasData = local.simPositions.length > 0
      || local.fundingHistory.length > 0
      || local.simTotalFundingEarned !== 0
      || local.simTotalFees !== 0
      || local.simTotalClosedPnl !== 0;
    if (localHasData && !snapshotHasRealData(snapshot)) {
      // 濡쒖뺄???곗씠?곌? ?덈뒗???쒕쾭媛 鍮?state瑜?蹂대궡硫?臾댁떆
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

/** 蹂듬━/?⑤━???곕Ⅸ ?ㅼ젣 notional 怨꾩궛 */
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
  const maxPerSide = Math.max(0, Math.min(shortBal, longBal) * 0.9);
  const targetPerSide = investmentOverrideUSDT ?? config.investmentUSDT;
  const perSide = maxPerSide > 0
    ? Math.min(targetPerSide, maxPerSide)
    : targetPerSide;
  return Math.max(perSide, 0) * config.leverage;
}

function applySharedSnipeStateSnapshot(
  setState: (partial: Partial<FundingState>) => void,
  snapshot?: SnipeStateSnapshot | null,
) {
  if (!snapshot) return;
  setState({
    simulationMode: snapshot.simulationMode,
    simSnipeActive: snapshot.simSnipeActive,
    realSnipeActive: snapshot.realSnipeActive,
  });
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
  feeOverrides?: StrategyConfig['feeOverrides'],
): number {
  const hedgeFeePct = getHedgeFeesWithOverrides(
    opportunity.shortExchange,
    opportunity.longExchange,
    'taker',
    feeOverrides,
  ) * 100;
  const netSpreadPercent = spread?.effectiveSpread ?? calcNetSpreadPercent(opportunity.spreadPercent, 0, hedgeFeePct);
  return Math.max(0, netSpreadPercent / getOpportunityIntervalHours(opportunity));
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
        strategyConfig.feeOverrides,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return getOpportunityHourlyNetProfit(b.opportunity) - getOpportunityHourlyNetProfit(a.opportunity);
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

// ?????????????????????????????????????????????
// Snipe key helpers (mode-prefixed)
// ?????????????????????????????????????????????
const mkSnipeKey = (sim: boolean, opportunityId: string) => `${sim ? 'sim' : 'real'}:${opportunityId}`;
const parseSnipeKey = (key: string) => ({
  isSim: key.startsWith('sim:'),
  opportunityId: key.slice(key.indexOf(':') + 1),
});

// ?????????????????????????????????????????????
// State shape
// ?????????????????????????????????????????????
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
  strategyRunning: boolean;
  connectedExchanges: ExchangeId[];
  lastRatesUpdate: number | null;
  lastPositionsUpdate: number | null;
  ratesStatus: 'idle' | 'loading' | 'success' | 'error';
  ratesError: string | null;
  consecutiveAllFailCount: number;  // ??嫄곕옒???곗냽 ?ㅽ뙣 ?잛닔

  // Exchange toggle
  enabledExchanges: ExchangeId[];

  // Per-exchange fetch status
  exchangeFetchStatus: Partial<Record<ExchangeId, 'ok' | 'error' | 'loading'>>;
  exchangeFetchErrors: Partial<Record<ExchangeId, string>>;

  // Simulation (?룹쭠 ?꾩슜 ?붽퀬 ?)
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

  // Snipe mode (紐⑤뱶蹂??낅┰ ??sim/real ?숈떆 ?ㅽ뻾 媛??
  simSnipeActive: boolean;           // SIM 紐⑤뱶 ?ㅻ굹?댄봽 ?쒖꽦
  realSnipeActive: boolean;          // REAL 紐⑤뱶 ?ㅻ굹?댄봽 ?쒖꽦
  simSnipeStartCapital: number;      // SIM ?먮룞?ъ옄 ON ?쒖젏??珥??ъ엯 ?먮낯
  realSnipeStartCapital: number;     // REAL ?먮룞?ъ옄 ON ?쒖젏??珥??ъ엯 ?먮낯
  snipeTargets: Record<string, number>;  // mode-prefixed opportunity key ??targetFundingTime
  snipeAllocations: Record<string, number>;
  _snipeTimers: Record<string, ReturnType<typeof setTimeout>>;      // mode-prefixed key ??吏꾩엯 ??대㉧
  _snipeCloseTimers: Record<string, ReturnType<typeof setTimeout>>; // mode-prefixed key ??泥?궛 ??대㉧

  // UI state
  showApiPanel: boolean;
  showStrategyPanel: boolean;
  rateFilter: string;
  exchangeFilter: ExchangeId[];
  positionToClose: Position | null;

  // Real orderbook spreads (keyed by baseAsset) ??effectiveSpread???щ━?쇱?+踰좎씠?쒖뒪+?섏닔猷?紐⑤몢 諛섏쁺
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

  refreshRates: () => Promise<void>;
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

  // Snipe actions (紐⑤뱶蹂??낅┰ ?ㅻ굹?댄븨)
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

// ?????????????????????????????????????????????
// Helpers
// ?????????????????????????????????????????????
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

// ?????????????????????????????????????????????
// File persistence: batch log/trade sending
// ?????????????????????????????????????????????
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
    logFlushTimer = setTimeout(flushLogs, 2000); // 2珥덈쭏??諛곗튂 ?꾩넚
  }
}

function queueTrade(event: PendingTrade) {
  tradeBatch.push(event);
  if (!tradeFlushTimer) {
    tradeFlushTimer = setTimeout(flushTrades, 1000); // 嫄곕옒??1珥덈쭏??利됱떆 ?꾩넚
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
  pairId?: string;
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

  const explicitFundingPayments: FundingPayment[] = [];
  const exitFallbackPayments: FundingPayment[] = [];
  for (const result of results) {
    for (const event of result.events ?? []) {
      if (!!event.simulation !== simulation) continue;
      if (!event.exchange || !event.symbol) continue;
      const amount = event.fundingAmount ?? 0;
      if (Math.abs(amount) <= 0.0000001) continue;

      const payment: FundingPayment = {
        exchange: event.exchange as ExchangeId,
        symbol: event.symbol,
        amount,
        rate: event.fundingRate ?? 0,
        timestamp: event.timestamp,
        side: (event.side === 'short' ? 'short' : 'long'),
      };

      if (event.type === 'funding') {
        explicitFundingPayments.push(payment);
        continue;
      }

      if (event.type === 'exit' || event.type === 'snipe_exit' || event.type === 'auto_exit') {
        exitFallbackPayments.push(payment);
      }
    }
  }

  // fallback: funding ?대깽?멸? ?꾨씫?섍퀬 exit/snipe_exit??fundingAmount留??⑥? 濡쒓렇 蹂듭썝
  const dedupedFallback = exitFallbackPayments.filter((candidate) => {
    return !explicitFundingPayments.some((payment) =>
      payment.exchange === candidate.exchange
      && payment.symbol === candidate.symbol
      && payment.side === candidate.side
      && Math.abs(payment.amount - candidate.amount) <= 0.0000001
      && Math.abs(payment.timestamp - candidate.timestamp) <= 10 * 60 * 1000,
    );
  });

  return mergeFundingHistory([], [...explicitFundingPayments, ...dedupedFallback]);
}

// ?????????????????????????????????????????????
// Store
// ?????????????????????????????????????????????
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
    minSpreadPercent: 0.20,
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

  // ?? Init ??????????????????????????????????????
  init() {
    try {
      // React 18 Strict Mode / HMR?먯꽌 ?곹깭 珥덇린??      set({ isLoadingRates: false, simSnipeActive: false, realSnipeActive: false, snipeTargets: {}, snipeAllocations: {}, _snipeTimers: {}, _snipeCloseTimers: {} });

      // ?? 1?뚯꽦 ?곗씠???뺣━: ?쒕? 珥덇린??(v3 留덉씠洹몃젅?댁뀡) ??
      const MIGRATION_KEY = 'funding_fee_migration_v3';
      if (typeof window !== 'undefined' && !localStorage.getItem(MIGRATION_KEY)) {
        localStorage.removeItem('funding_fee_history');
        localStorage.removeItem('funding_fee_sim_state');
        localStorage.removeItem('funding_fee_logs');
        localStorage.setItem(MIGRATION_KEY, '1');
      }

      // ??λ맂 濡쒓렇 & ????덉뒪?좊━ 蹂듭썝 (HMR/?덈줈怨좎묠?먯꽌???좎?)
      const savedLogs = loadLogs();
      const savedHistory = loadFundingHistory();
      if (savedLogs.length > 0) set({ logs: savedLogs });
      if (savedHistory !== null && savedHistory.length > 0) {
        set({ fundingHistory: savedHistory });
      } else {
        // localStorage key가 없을 때만 거래 로그로 복원 (명시적 초기화 상태는 유지)
        void loadFundingHistoryFromTradeLog(true)
          .then((fundingRecords) => {
            if (fundingRecords.length === 0) return;
            set({ fundingHistory: fundingRecords });
            saveFundingHistory(fundingRecords);
            get().addLog('info', [복원] 로컬 파일에서 펀딩 수령 내역 건 복원);
          })
          .catch(() => { /* silent */ });
      }

      const saved = loadApiConfigs();
      set({ apiConfigs: saved });
      const connected = Object.keys(saved) as ExchangeId[];
      set({ connectedExchanges: connected });

      // ??λ맂 ?꾨왂 ?ㅼ젙 濡쒕뱶
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

      // ??λ맂 嫄곕옒??ON/OFF ?ㅼ젙 濡쒕뱶
      const savedEnabled = loadEnabledExchanges();
      if (savedEnabled && savedEnabled.length > 0) {
        const valid = savedEnabled.filter(e => SUPPORTED_EXCHANGES.includes(e as ExchangeId)) as ExchangeId[];
        if (valid.length >= 2) {
          set({ enabledExchanges: valid });
        }
      }

      // ??λ맂 紐⑤뱶 蹂듭썝 (SIM/REAL)
      const savedMode = loadSimMode();
      if (savedMode !== null) {
        set({ simulationMode: savedMode });
      }

      // ??λ맂 REAL ?ъ???硫뷀? 蹂듭썝
      const savedRealMeta = loadRealPositionMeta();
      if (savedRealMeta) {
        set({ realPositionMeta: savedRealMeta as Record<string, RealPositionMeta> });
      }

      // ?쒕쾭????λ맂 ?먮룞?ъ옄 ?곹깭 蹂듭썝 (PC?붾え諛붿씪 ?숆린??
      fetchSharedSnipeStateSnapshot().then(async (sharedState) => {
        applySharedSnipeStateSnapshot(set, sharedState);
        saveSimMode(sharedState.simulationMode);
        const { realSnipeActive: savedReal } = sharedState;

        // REAL: ?쒕쾭 ?ㅼ?以꾨윭媛 ?ㅼ젣濡??뚭퀬 ?덈뒗吏 ?뺤씤 ?꾩뿉留?UI ?곹깭瑜?ON?쇰줈
        let realConfirmed = false;
        if (savedReal) {
          try {
            const schedulerRes = await fetch('/api/scheduler');
            if (schedulerRes.ok) {
              const schedulerData = await schedulerRes.json() as { active?: boolean };
              realConfirmed = !!schedulerData.active;
            }
          } catch { /* ?뺤씤 遺덇? ??OFF ?좎? */ }
          if (!realConfirmed) {
            // ?쒕쾭 ?ㅼ?以꾨윭媛 ???뚭퀬 ?덉쑝硫?snipe-state???뺤젙
            void updateSharedSnipeStateSnapshot({ realSnipeActive: false }).catch(() => {});
            get().addLog('warning', '[蹂듭썝] REAL ?먮룞?ъ옄 ?곹깭 OFF ???쒕쾭 ?ㅼ?以꾨윭 誘몄떎??);
          }
        }

        if (realConfirmed) {
          set({ realSnipeActive: true });
          void syncServerSchedulerConfig(
            getResolvedStrategyConfig(get().strategyConfig),
            get().enabledExchanges,
            get().addLog,
          );
          get().addLog('info', '[蹂듭썝] ?먮룞?ъ옄 ?곹깭 蹂듭썝 ??REAL');
        }
      }).catch(() => { /* silent */ });

      // ??λ맂 ?쒕??덉씠???곹깭 蹂듭썝 (?붽퀬, ?ъ??? ?꾩쟻 ???
      const savedSim = loadSimState();
      if (savedSim) {
        // ?붽퀬媛 嫄곕옒?뚮떦 湲곗?(?ъ옄湲댠?)蹂대떎 ??쑝硫?蹂댁젙 (??濡??묒そ 李몄뿬 媛?ν븯?꾨줉)
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
        // 理쒖큹 ?ㅽ뻾: ?쒖꽦 嫄곕옒??湲곗??쇰줈 珥덇린 ?붽퀬 ?ㅼ젙 (嫄곕옒?뚮떦 ?ъ옄湲댠? ????濡??묒そ 李몄뿬 媛??
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
          applyServerSimStateSnapshot(set, simScheduler.state, { force: true });
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
      get().addLog('info', '??⑺뵾 ?꾨줈洹몃옩 珥덇린???꾨즺', undefined,
        `?쒖꽦 嫄곕옒?? ${enabled.map(e => e.toUpperCase()).join(', ')} (${enabled.length}媛?`);
      set({ ratesStatus: 'loading' });
      get().refreshRates().catch((err) => {
        console.error('[init] refreshRates failed:', err);
        set({ ratesStatus: 'error', ratesError: (err as Error).message, isLoadingRates: false });
      });
      get().startPolling();
    } catch (err) {
      console.error('[init] 珥덇린???ㅽ뙣:', err);
      set({ ratesStatus: 'error', ratesError: `珥덇린???ㅽ뙣: ${(err as Error).message}`, isLoadingRates: false });
    }
  },

  // ?? API config ????????????????????????????????
  setApiConfig(exchange, config) {
    const prev = get().apiConfigs;
    const next = { ...prev, [exchange]: config };
    set({ apiConfigs: next });
    saveApiConfigs(next);
    // ?쒕쾭 痢??뷀샇????μ냼?먮룄 ???    fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange, config }),
    }).catch(() => {});
    const connected = Object.keys(next) as ExchangeId[];
    set({ connectedExchanges: connected });
    get().addLog('success', `${exchange.toUpperCase()} API ????λ맖 (?쒕쾭 ?뷀샇??`, exchange);
  },

  removeApiConfig(exchange) {
    const prev = get().apiConfigs;
    const next = { ...prev };
    delete next[exchange];
    set({ apiConfigs: next });
    saveApiConfigs(next);
    // ?쒕쾭 痢≪뿉?쒕룄 ??젣
    fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange }),
    }).catch(() => {});
    const connected = Object.keys(next) as ExchangeId[];
    set({ connectedExchanges: connected });
    get().addLog('warning', `${exchange.toUpperCase()} API ????젣??, exchange);
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
      timingConfig: nextTiming,
    });

    const investmentChanged = next.investmentUSDT !== previousConfig.investmentUSDT;
    const leverageChanged = next.leverage !== previousConfig.leverage;
    const minSpreadChanged = next.minSpreadPercent !== previousConfig.minSpreadPercent;
    const feeChanged = JSON.stringify(next.feeOverrides ?? {}) !== JSON.stringify(previousConfig.feeOverrides ?? {});
    const timingChanged = JSON.stringify(next.timingConfig ?? DEFAULT_TIMING_CONFIG) !== JSON.stringify(previousConfig.timingConfig ?? DEFAULT_TIMING_CONFIG);
    const schedulerRelevantChanged = investmentChanged || leverageChanged || minSpreadChanged || feeChanged || timingChanged;

    set((s) => {
      const opportunities = buildOpportunitiesFromRates(s.fundingRates, next, s);
      const nextRealSpreads = feeChanged
        ? rebuildRealSpreadsForConfig(s.realSpreads, opportunities, next)
        : s.realSpreads;

      saveStrategyConfig(next);

      // investmentUSDT 蹂寃????쒕? ?붽퀬 ?숆린??(?ъ????놁쓣 ?뚮쭔)
      if (investmentChanged && s.simulationMode && s.simPositions.length === 0) {
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

    if (investmentChanged || leverageChanged || feeChanged) {
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
          applyServerSimStateSnapshot(set, status.state, { force: true });
          set({
            simSnipeActive: !!status.active,
            snipeTargets: status.snipeTargets ?? {},
            snipeAllocations: status.snipeAllocations ?? {},
          });
        })
        .catch(() => {});
    }
  },

  // ?? Refresh rates (嫄곕옒?뚮퀎 媛쒕퀎 鍮꾨룞湲????묐떟 利됱떆 UI ?낅뜲?댄듃) ??
  async refreshRates() {
    if (get().isLoadingRates) {
      console.log('[refreshRates] skip ??already loading');
      return;
    }
    set({ isLoadingRates: true, ratesStatus: get().lastRatesUpdate ? get().ratesStatus : 'loading', ratesError: null });

    const enabled = get().enabledExchanges;
    console.log('[refreshRates] start:', enabled.join(','));

    // 鍮꾪솢??嫄곕옒???곗씠???쒓굅 (OFF??嫄곕옒?뚭? 湲고쉶 怨꾩궛???⑤뒗 寃?諛⑹?)
    set(s => ({
      fundingRates: s.fundingRates.filter(r => enabled.includes(r.exchange)),
    }));

    // 嫄곕옒?뚮퀎 媛쒕퀎 fetch ??癒쇱? ?묐떟 ?ㅻ뒗 嫄곕옒?뚮???利됱떆 諛섏쁺
    await Promise.allSettled(
      enabled.map(async (exchangeId) => {
        set(s => ({ exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'loading' } }));
        try {
          const res = await fetch(`/api/funding-rates?exchanges=${exchangeId}`, {
            signal: AbortSignal.timeout(45000),
          });
          const json = await res.json() as {
            success: boolean;
            error?: string;
            data: { rates: FundingRate[]; errors: { exchange: ExchangeId; error: string }[] };
            timestamp: number;
          };

          if (json.success && json.data.rates.length > 0) {
            console.log(`[refreshRates] ${exchangeId}: ${json.data.rates.length}媛??섏떊`);
            // ??嫄곕옒???곗씠?곕? 湲곗〈 ?곗씠?곗뿉 癒몄? ??利됱떆 湲고쉶 ?ш퀎??            try {
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
                );

                // ?쒕? ?ъ???留덊겕媛寃??낅뜲?댄듃
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
              console.error(`[refreshRates] ${exchangeId} set() ?ㅽ뙣:`, setErr);
              // set() ?ㅽ뙣?대룄 理쒖냼???곹깭???낅뜲?댄듃
              set({
                lastRatesUpdate: Date.now(),
                ratesStatus: 'success',
                exchangeFetchStatus: { ...get().exchangeFetchStatus, [exchangeId]: 'ok' },
              });
            }

            if (json.data.errors?.length > 0) {
              for (const e of json.data.errors) {
                get().addLog('warning', `${(e.exchange || '?').toUpperCase()} ??⑸쪧 ?ㅻ쪟`, e.exchange, e.error);
              }
            }
          } else {
            // success:false ?먮뒗 ?곗씠??0嫄???5珥????ъ떆??            const errMsg = json.error || '?곗씠???놁쓬';
            console.warn(`[refreshRates] ${exchangeId} 1李??ㅽ뙣(?묐떟): ${errMsg} ??5珥????ъ떆??);
            await new Promise(r => setTimeout(r, 5000));
            const retryRes2 = await fetch(`/api/funding-rates?exchanges=${exchangeId}`, { signal: AbortSignal.timeout(30000) });
            const retryJson2 = await retryRes2.json() as typeof json;
            if (retryJson2.success && retryJson2.data.rates.length > 0) {
              console.log(`[refreshRates] ${exchangeId} ?ъ떆???깃났: ${retryJson2.data.rates.length}媛?);
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
              console.warn(`[refreshRates] ${exchangeId} ?ъ떆?꾨룄 ?ㅽ뙣: ${retryJson2.error || '?곗씠???놁쓬'}`);
              set(s => ({
                exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'error' },
                exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: retryJson2.error || errMsg },
              }));
            }
          }
        } catch (err) {
          // ?ㅽ듃?뚰겕/??꾩븘???먮윭 ??5珥????ъ떆??          console.warn(`[refreshRates] ${exchangeId} 1李??ㅽ뙣(?ㅽ듃?뚰겕) ??5珥????ъ떆??`, (err as Error).message);
          try {
            await new Promise(r => setTimeout(r, 5000));
            const retryRes = await fetch(`/api/funding-rates?exchanges=${exchangeId}`, {
              signal: AbortSignal.timeout(30000),
            });
            const retryJson = await retryRes.json() as {
              success: boolean;
              error?: string;
              data: { rates: FundingRate[]; errors: { exchange: ExchangeId; error: string }[] };
              timestamp: number;
            };
            if (retryJson.success && retryJson.data.rates.length > 0) {
              console.log(`[refreshRates] ${exchangeId} ?ъ떆???깃났: ${retryJson.data.rates.length}媛?);
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
              throw new Error(retryJson.error || '?ъ떆???곗씠???놁쓬');
            }
          } catch (retryErr) {
            console.warn(`[refreshRates] ${exchangeId} ?ъ떆?꾨룄 ?ㅽ뙣:`, (retryErr as Error).message);
            set(s => ({
              exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'error' },
              exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: (retryErr as Error).message },
            }));
          }
        }
      }),
    );

    // 紐⑤뱺 嫄곕옒???꾨즺 ?????대쾲 ?쇱슫?쒖뿉???섎굹???깃났 紐삵뻽?쇰㈃ ?먮윭
    const anyOk = enabled.some(ex => get().exchangeFetchStatus[ex] === 'ok');
    console.log('[refreshRates] done ??anyOk:', anyOk, 'lastUpdate:', get().lastRatesUpdate);
    if (!anyOk) {
      const failCount = get().consecutiveAllFailCount + 1;
      set({ ratesStatus: 'error', ratesError: '紐⑤뱺 嫄곕옒?뚯뿉???곗씠??議고쉶 ?ㅽ뙣', consecutiveAllFailCount: failCount });

      // 5???곗냽 ?꾩껜 ?ㅽ뙣 (~40珥? ??寃쎄퀬 濡쒓렇 + ?붾젅洹몃옩
      if (failCount === 5) {
        const msg = `?좑툘 API ?꾩껜 ?μ븷: 紐⑤뱺 嫄곕옒???곗씠??議고쉶媛 ${failCount}???곗냽 ?ㅽ뙣?덉뒿?덈떎. ?쒕쾭 ?곹깭瑜??뺤씤?섏꽭?? (.next 罹먯떆 ?먯긽 媛?????쒕쾭 ?ъ떆???꾩슂)`;
        get().addLog('warning', msg);
        sendTelegramMessage(msg).catch(() => {});
      }
      // 30???곗냽 (~4遺? ???ㅻ굹?댄봽 ?먮룞 以묐떒
      if (failCount === 30 && (get().simSnipeActive || get().realSnipeActive)) {
        get().addLog('warning', `?썞 API ?μ븷 吏??(${failCount}???곗냽 ?ㅽ뙣) ???ㅻ굹?댄봽 ?먮룞 以묐떒`);
        get().cancelSnipe('all');
        sendTelegramMessage(`?썞 API ?꾩껜 ?μ븷 ${failCount}???곗냽 ???먮룞 ?ъ옄 湲닿툒 以묐떒. ?쒕쾭 ?ъ떆???꾩슂.`).catch(() => {});
      }

      if (!get().lastRatesUpdate) {
        setTimeout(() => get().refreshRates(), 3000);
      }
    } else {
      // ?깃났 ??移댁슫??由ъ뀑
      if (get().consecutiveAllFailCount > 0) {
        set({ consecutiveAllFailCount: 0 });
      }
    }
    set({ isLoadingRates: false });
  },

  // ?? Refresh positions (?쒖꽦 嫄곕옒?뚮쭔) ?????????????
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

    // 湲곗〈 ?ъ??섏쓽 positionType / 硫뷀? 蹂댁〈 (exchange+symbol+side 湲곗? 留ㅼ묶)
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

  // refreshPositions ???덈줈 ?앷릿 ?ъ??섏뿉留?positionType ?명똿
  // (湲곗〈???덈뜕 manual ?ъ??섏? 嫄대뱶由ъ? ?딆쓬)
  async refreshAndStampPositions(baseAsset: string, exchanges: ExchangeId[]) {
    // refresh ??湲곗〈 ?ъ????ㅻ깄??(exchange+symbol+side ??
    const beforeKeys = new Set(
      get().positions.map(p => `${p.exchange}:${p.symbol}:${p.side}`),
    );
    await get().refreshPositions();
    set(s => {
      const updated = s.positions.map(p => {
        if (p.baseAsset !== baseAsset) return p;
        if (!exchanges.includes(p.exchange)) return p;
        if (p.positionType !== 'manual') return p; // ?대? ??낆씠 ?덉쑝硫??좎?
        // refresh ?꾩뿉 ?대? ?덈뜕 ?ъ??섏씠硫??ㅽ궢 (?ъ슜??湲곗〈 ?ъ???
        const key = `${p.exchange}:${p.symbol}:${p.side}`;
        if (beforeKeys.has(key)) return p;
        // hedge: ??濡?援щ텇
        return {
          ...p,
          positionType: (p.side === 'short' ? 'hedge_short' : 'hedge_long') as Position['positionType'],
        };
      });
      return { positions: updated };
    });
  },

  // ?? Refresh balances (?쒖꽦 嫄곕옒?뚮쭔) ??????????????
  async refreshBalances() {
    const configs = get().apiConfigs;
    const enabled = get().enabledExchanges;
    const activeConfigs = (Object.entries(configs) as [ExchangeId, ApiConfig][])
      .filter(([exchange]) => enabled.includes(exchange));
    if (activeConfigs.length === 0) return;

    const next: Partial<Record<ExchangeId, Balance>> = {};

    await Promise.allSettled(
      activeConfigs.map(async ([exchange, config]) => {
        const res = await fetch(`/api/exchanges/${exchange}/balance`, {
          headers: makeApiHeaders(config),
        });
        const json = await res.json() as { success: boolean; data: Balance };
        if (json.success) next[exchange] = json.data;
      }),
    );

    set({ balances: next });
  },

  // ?? Refresh real orderbook spreads for scheduled coins ??
  async refreshRealSpreads() {
    const { snipeTargets, snipeAllocations, opportunities, strategyConfig, realSpreads, simBalances, balances: realBalances, simulationMode } = get();
    const now = Date.now();
    const STALE_MS = 5_000;

    // Collect from scheduled targets + near-term opportunities (route key 湲곗?)
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
    // 5?쒓컙 ?대궡 ???湲고쉶 ?ъ쟾 議고쉶 (?ㅼ?以꾨쭅 ???대줎媛?fallback 諛⑹?)
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
          // ?묒そ 紐⑤뱶 以???notional ?ъ슜 ???щ━?쇱???二쇰Ц ?ш린??鍮꾨??섎?濡?蹂댁닔??異붿젙
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
            // ???듭떖: fillPrice濡?吏꾩엯 媛寃?媛?吏곸젒 怨꾩궛 (?щ━?쇱? + 嫄곕옒??媛?踰좎씠?쒖뒪 紐⑤몢 ?ъ갑)
            // short(sell) fillPrice < midPrice, long(buy) fillPrice > midPrice
            // entryGapPct = (longFill - shortFill) / shortFill * 100 ???묒닔 = 吏꾩엯 ?먯떎
            const entryGapPct = ((longJson.fillPrice - shortJson.fillPrice) / shortJson.fillPrice) * 100;
            const hedgeFeePct = getConfiguredHedgeFees(
              strategyConfig,
              opp.shortExchange,
              opp.longExchange,
              'taker',
            ) * 100;
            // ???쒖떆?? 吏꾩엯媛??.5 + ?섏닔猷?諛섏쁺 (?덉쟾留덉쭊? ?ㅽ뻾 ?쒖젏?먮쭔 蹂꾨룄 ?곸슜)
            const effectiveSpread = calcNetSpreadPercent(opp.spreadPercent, entryGapPct, hedgeFeePct, 0);
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

  // ?? Balance redistribution ????????????????????
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
          `[SIM] ?붽퀬 ?щ텇諛? ${donor.toUpperCase()} ??${target.toUpperCase()} $${fmtNum(transfer, 0)}`,
          target,
          `${donor.toUpperCase()} ?ъ쑀?붽퀬 ??${target.toUpperCase()} (?꾧퀎媛?$${fmtNum(threshold, 0)} 誘몃쭔 媛먯?)`,
        );
      }
    }
  },

  // ?? Polling ???????????????????????????????????
  startPolling() {
    const s = get();
    if (s._ratesInterval) clearInterval(s._ratesInterval);
    if (s._positionsInterval) clearInterval(s._positionsInterval);

    // 泥??곗씠?곌? ?꾩쭅 ?놁쑝硫?1珥???利됱떆 ?ъ떆??(init ?ㅽ뙣 蹂댁셿)
    if (!get().lastRatesUpdate) {
      setTimeout(() => {
        if (!get().lastRatesUpdate) get().refreshRates();
      }, 1000);
    }

    // 5珥?媛꾧꺽 ??⑸쪧 + ?ㅻ뜑遺??대쭅 (湲고쉶 ?먯? ?띾룄 ?μ긽)
    const ratesInterval = setInterval(() => {
      get().refreshRates();
      if (get().simSnipeActive || get().realSnipeActive) {
        get().refreshRealSpreads();
      }
      void fetchSharedSnipeStateSnapshot()
        .then((snapshot) => {
          applySharedSnipeStateSnapshot(set, snapshot);
          saveSimMode(snapshot.simulationMode);
        })
        .catch(() => {});
    }, 3_000);

    // 1珥?媛꾧꺽 ?ш?利?+ ?ㅼ?以꾨쭅 (濡쒖뺄 ?곗씠?곕쭔 ?ъ슜, API ?몄텧 ?놁쓬)
    const snipeCheckInterval = setInterval(() => {
      if (get().realSnipeActive) {
        get().revalidateScheduledSnipes();
        get().scheduleAllSnipes();
      }
    }, 1_000);

    // 3珥?媛꾧꺽 SIM ?쒕쾭 ?곹깭 ?숆린??(API ?몄텧 ??留ㅼ큹??怨쇰룄)
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
    }, 3_000);

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
      // ?붽퀬 ?щ텇諛? ?붽퀬 遺議?嫄곕옒?뚯뿉 ?ъ쑀 嫄곕옒?뚯뿉??洹좊벑 遺꾨같
      if (get().simulationMode && !get().simSnipeActive) {
        get().redistributeBalances();
      }
    }, 10_000);

    set({ _ratesInterval: ratesInterval, _positionsInterval: positionsInterval, _snipeCheckInterval: snipeCheckInterval, _simSyncInterval: simSyncInterval });
  },

  stopPolling() {
    const { _ratesInterval, _positionsInterval, _snipeCheckInterval, _simSyncInterval, _snipeTimers, _snipeCloseTimers } = get();
    if (_ratesInterval) clearInterval(_ratesInterval);
    if (_positionsInterval) clearInterval(_positionsInterval);
    if (_snipeCheckInterval) clearInterval(_snipeCheckInterval);
    if (_simSyncInterval) clearInterval(_simSyncInterval);
    // 紐⑤뱺 肄붿씤蹂??ㅻ굹?댄븨 ??대㉧ ?뺣━
    for (const t of Object.values(_snipeTimers)) clearTimeout(t);
    for (const t of Object.values(_snipeCloseTimers)) clearTimeout(t);
    set({ _ratesInterval: null, _positionsInterval: null, _snipeCheckInterval: null, _simSyncInterval: null, _snipeTimers: {}, _snipeCloseTimers: {}, snipeTargets: {}, snipeAllocations: {} });
    flushLogs();
    flushTrades();
  },

  // ?? Execute strategy (hedge only) ?????????????
  async executeStrategy(opportunity, simModeOverride?, investmentOverrideUSDT?) {
    const { apiConfigs, strategyConfig, simBalances, balances } = get();
    const simulationMode = simModeOverride ?? get().simulationMode;
    const plannedInvestmentUSDT = investmentOverrideUSDT ?? strategyConfig.investmentUSDT;

    // Guard: spread check
    const effectiveMinSpread = getEffectiveMinSpread(strategyConfig);
    if (opportunity.spreadPercent < effectiveMinSpread) {
      get().addLog('warning',
        `?ㅽ봽?덈뱶 ${fmtNum(opportunity.spreadPercent, 4)}%媛 理쒖냼 湲곗? ${effectiveMinSpread}% 誘몃쭔 ??吏꾩엯 ?ㅽ궢`,
        undefined,
        `${opportunity.baseAsset} ${opportunity.shortExchange}??{opportunity.longExchange}`,
      );
      queueTrade({
        timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
        baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
        spreadPercent: opportunity.spreadPercent, reason: `?ㅽ봽?덈뱶 ${opportunity.spreadPercent.toFixed(4)}% < 理쒖냼 ${effectiveMinSpread}%`,
      });
      return { success: false };
    }

    // Guard: ?쒖닔??寃利?    const notionalEst = (() => {
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
    // ?ㅼ륫 ?ㅽ봽?덈뱶 湲곕컲 ?섏씡??寃利?(effectiveSpread???쒖떆?????덉쟾留덉쭊 蹂꾨룄 ?곸슜)
    const rs = getRealSpreadForOpportunity(get().realSpreads, opportunity);
    const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
    if (hasRS) {
      // ??effectiveSpread?먮뒗 ?덉쟾留덉쭊 誘명룷?????ㅽ뻾 ??蹂꾨룄 李④컧
      const realNetProfit = notionalEst * ((rs.effectiveSpread - SAFETY_MARGIN_PCT) / 100);
      if (realNetProfit <= 0) {
        get().addLog('warning',
          `[?ㅼ륫 ?섏씡???ㅽ뙣] ${opportunity.baseAsset} ?ㅼ륫 ?쒖뒪?꾨젅??${fmtNum(rs.effectiveSpread, 4)}% ??0 ??吏꾩엯 ?ㅽ궢`,
          undefined,
          `吏꾩엯媛? ${fmtNum(rs.entryGapPct, 4)}% | ?щ━?쇱?: ??{fmtNum(rs.shortSlippage, 3)}% 濡?{fmtNum(rs.longSlippage, 3)}%`,
        );
        queueTrade({
          timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
          baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
          spreadPercent: opportunity.spreadPercent, reason: `?ㅼ륫 ?섏씡???ㅽ뙣: ?쒖뒪?꾨젅??${rs.effectiveSpread.toFixed(4)}% ??0 (?덉쟾留덉쭊 ?ы븿)`,
        });
        return { success: false };
      }
    } else {
      // realSpread ?놁쑝硫??대줎媛?湲곕컲 蹂댁닔??寃利?(湲곗〈 濡쒖쭅)
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
          `[?섏씡??寃利??ㅽ뙣] ${opportunity.baseAsset} ??⑹닔??$${fmtNum(estFundingRevenue)} ???섏닔猷?$${fmtNum(estTotalFees)} ??吏꾩엯 ?ㅽ궢`,
          undefined,
          `?ㅽ봽?덈뱶: ${fmtNum(opportunity.spreadPercent, 4)}% | ?꾩슂 理쒖냼: ${(estRoundTripFee * 100).toFixed(3)}%`,
        );
        queueTrade({
          timestamp: Date.now(), type: 'guard_block', simulation: simulationMode,
          baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
          spreadPercent: opportunity.spreadPercent, reason: `?섏씡???ㅽ뙣: ???$${estFundingRevenue.toFixed(2)} ???섏닔猷?$${estTotalFees.toFixed(2)}`,
        });
        return { success: false };
      }
    }

    // Guard: duplicate position ??媛숈? 肄붿씤 以묐났 吏꾩엯 諛⑹?
    if (simulationMode) {
      const opportunityLegs = new Set(getOpportunityLegKeys(opportunity));
      const existingPair = get().simPositions.find((position) =>
        getPositionLegKeys(position).some((legKey) => opportunityLegs.has(legKey)),
      );
      if (existingPair) {
        get().addLog('warning',
          `[SIM] ${opportunity.baseAsset} ?대? ?룹쭠 ?ъ???蹂댁쑀 以???以묐났 吏꾩엯 ?ㅽ궢`,
          undefined,
          `湲곗〈 ?ъ??? ${existingPair.side.toUpperCase()} @ ${existingPair.exchange.toUpperCase()}`,
        );
        return { success: false };
      }
    }

    // ?? Simulation branch ??????????????????????
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
          get().addLog('warning', `[SIM] ${opportunity.baseAsset} ?쒕쾭 ?쒕? 吏꾩엯 ?ㅽ뙣`, undefined, errorMessage);
          return { success: false, error: errorMessage };
        }

        applyServerSimStateSnapshot(set, payload.state, { force: true });
        return { success: true };
      } catch (error) {
        const errorMessage = (error as Error).message;
        get().addLog('error', `[SIM] ${opportunity.baseAsset} ?쒕쾭 ?쒕? 吏꾩엯 ?ㅻ쪟`, undefined, errorMessage);
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
          `[SIM] ${opportunity.baseAsset} 吏꾩엯 ?ㅽ궢: ?좏슚?섏? ?딆? 留덊겕媛寃?,
          undefined,
          `??${opportunity.shortExchange.toUpperCase()}: ${opportunity.shortMarkPrice}, 濡?${opportunity.longExchange.toUpperCase()}: ${opportunity.longMarkPrice}`,
        );
        return { success: false };
      }
      const { shortExchange, longExchange } = opportunity;
      const notional = margin * leverage;
      const shortEntryFee = notional * getConfiguredExchangeFee(strategyConfig, shortExchange, 'taker');
      const shortCostPerSide = margin + shortEntryFee;

      // ?? ?붽퀬 遺議????ъ쑀 嫄곕옒?뚯뿉???대? ?댁껜 (理쒖냼 $1,400 ?좎?) ??
      const MIN_BALANCE = plannedInvestmentUSDT; // 嫄곕옒?뚮떦 理쒖냼 ?좎? ?붽퀬
      const needsTransfer: { target: ExchangeId; needed: number }[] = [];
      for (const ex of [shortExchange, longExchange]) {
        const bal = simBalances[ex] ?? 0;
        if (bal < shortCostPerSide) {
          // 理쒖냼 ?좎? ?붽퀬 + 嫄곕옒 鍮꾩슜 ?뺣낫 (吏꾩엯 ?꾩씠誘濡?蹂댁닔?곸쑝濡?short 湲곗? ?ъ슜)
          const needed = Math.max(shortCostPerSide - bal, MIN_BALANCE - bal);
          needsTransfer.push({ target: ex, needed });
        }
      }
      for (const { target, needed } of needsTransfer) {
        // ?ъ쑀 嫄곕옒??李얘린: ?꾩옱 ?ъ???留덉쭊 ?쒖쇅????媛?⑹옍怨좉? 理쒖냼?붽퀬 ?댁긽??嫄곕옒??        const currentBalances = get().simBalances;
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
            `[SIM] ?대? ?댁껜: ${donor.exId.toUpperCase()} ??${(target as string).toUpperCase()} $${fmtNum(transfer, 0)}`,
            target,
            `${donor.exId.toUpperCase()} ?ъ쑀: $${fmtNum(donor.surplus, 0)} ???댁껜 ??${(target as string).toUpperCase()} ?붽퀬 ?뺣낫`,
          );
          remaining -= transfer;
        }

        // ?댁껜 ?꾩뿉???ъ쟾??遺議깊븯硫?吏꾩엯 ?ㅽ궢
        if (remaining > 0) {
          get().addLog('warning',
            `[SIM] ${opportunity.baseAsset} 吏꾩엯 ?ㅽ궢: ${(target as string).toUpperCase()} ?붽퀬 遺議?,
            target,
            `?꾩슂: $${fmtNum(shortCostPerSide, 0)} | 媛?? $${fmtNum((get().simBalances[target] ?? 0), 0)} | ?댁껜 媛?ν븳 ?ъ쑀 嫄곕옒???놁쓬`,
          );
          return { success: false };
        }
      }

      // ?? ?ㅼ젣 ?멸?李?湲곕컲 泥닿껐媛 怨꾩궛 (?щ━?쇱? 諛섏쁺) ??
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
          get().addLog('info', `[SIM] ${opportunity.baseAsset} ??泥닿껐媛: $${fmtNum(shortFillPrice, 2)} (?щ━?쇱?: ${fmtNum(shortOB.slippagePercent, 4)}%)`, shortExchange);
        }
        if (longOB.success) {
          longFillPrice = longOB.fillPrice;
          get().addLog('info', `[SIM] ${opportunity.baseAsset} 濡?泥닿껐媛: $${fmtNum(longFillPrice, 2)} (?щ━?쇱?: ${fmtNum(longOB.slippagePercent, 4)}%)`, longExchange);
        }
      } catch (err) {
        get().addLog('warning', `[SIM] ${opportunity.baseAsset} ?멸?李?議고쉶 ?ㅽ뙣 ??留덊겕媛寃??ъ슜`, undefined, (err as Error).message);
      }

      // ?? 吏꾩엯 媛?怨꾩궛 諛?濡??몄뀛??議곗젙 ??
      const entryGapPercent = ((shortFillPrice - longFillPrice) / ((shortFillPrice + longFillPrice) / 2)) * 100;
      get().addLog('info', `[SIM] ${opportunity.baseAsset} 吏꾩엯 媛? ${entryGapPercent.toFixed(4)}% (??$${fmtNum(shortFillPrice, 2)} 濡?$${fmtNum(longFillPrice, 2)})`);
      // Gap > 0.1% ??濡??몄뀛??議곗젙?쇰줈 ?묒そ ?섎웾(怨꾩빟 ?? ?쇱튂 ???명? 以묐┰
      let adjustedLongNotional = notional;
      if (Math.abs(entryGapPercent) > 0.1) {
        adjustedLongNotional = notional * (longFillPrice / shortFillPrice);
        get().addLog('info', `[SIM] ${opportunity.baseAsset} 濡??몄뀛??議곗젙: $${fmtNum(notional, 2)} ??$${fmtNum(adjustedLongNotional, 2)} (?섎웾 洹좊벑??`);
      }

      // ?? ?묒そ 蹂꾨룄 ?섏닔猷?留덉쭊/鍮꾩슜 怨꾩궛 ??
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

      // ????섏씡: 媛??ㅻ━???ㅼ젣 ?몄뀛??湲곗??쇰줈 怨꾩궛
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
        + adjustedLongNotional * getConfiguredExchangeFee(strategyConfig, longExchange, 'taker') * 2; // 吏꾩엯+泥?궛 蹂댁닔??異붿젙
      const netProfit = perFunding - totalRoundTripFees;
      get().addLog('success',
        `[SIM] ${opportunity.baseAsset} ?룹쭠 吏꾩엯 ?꾨즺 (${isSnipe ? '?ㅻ굹?댄봽' : '???})`,
        undefined,
        `??${shortExchange.toUpperCase()} 濡?${longExchange.toUpperCase()} | isSnipe:${isSnipe} | pairId:${pairId} | 留덉쭊:$${fmtNum(margin)} | ?덈쾭由ъ?:${leverage}x | ?ㅽ봽?덈뱶:${fmtNum(opportunity.spreadPercent, 4)}% | ?ㅼ쓬???${new Date(opportunity.nextFundingTime).toLocaleTimeString('ko-KR')} | 8h?쒖닔?? $${fmtNum(netProfit)} (??? $${fmtNum(perFunding)} - ?섏닔猷? $${fmtNum(totalRoundTripFees)})`,
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

    // ?? Real trading branch ????????????????????
    const shortConfig = apiConfigs[opportunity.shortExchange];
    const longConfig = apiConfigs[opportunity.longExchange];

    if (!shortConfig) {
      get().addLog('error', `${opportunity.shortExchange.toUpperCase()} API ???놁쓬`, opportunity.shortExchange);
      return { success: false, error: `${opportunity.shortExchange.toUpperCase()} API ???놁쓬` };
    }
    if (!longConfig) {
      get().addLog('error', `${opportunity.longExchange.toUpperCase()} API ???놁쓬`, opportunity.longExchange);
      return { success: false, error: `${opportunity.longExchange.toUpperCase()} API ???놁쓬` };
    }

    let realInvestment = plannedInvestmentUSDT;
    if (strategyConfig.compoundInvesting && investmentOverrideUSDT == null) {
      const shortBal = balances[opportunity.shortExchange]?.availableUSDT ?? 0;
      const longBal = balances[opportunity.longExchange]?.availableUSDT ?? 0;
      realInvestment = Math.min(shortBal, longBal) * 0.9;
      if (realInvestment < plannedInvestmentUSDT) {
        // ?붽퀬 遺議???吏꾩엯 ?ㅽ궢 (?대갚 ?놁쓬 ???붽퀬 ?щ텇諛곕줈 ?닿껐?댁빞 ??
        get().addLog('warning', `[蹂듬━] ?ㅼ옍怨?遺議???吏꾩엯 ?ㅽ궢`,
          undefined,
          `??${opportunity.shortExchange.toUpperCase()}): $${fmtNum(shortBal, 0)} | 濡?${opportunity.longExchange.toUpperCase()}): $${fmtNum(longBal, 0)} | ?꾩슂: $${fmtNum(plannedInvestmentUSDT, 0)}`);
        return { success: false, error: '?ㅼ옍怨?遺議???嫄곕옒??媛??붽퀬 ?щ텇諛??꾩슂' };
      }
    }

    const previewProfit = estimateProfit(opportunity, realInvestment, strategyConfig.leverage, {
      feeOverrides: strategyConfig.feeOverrides,
    });
    get().addLog('info',
      `?꾨왂 ?ㅽ뻾 ?쒖옉: ${opportunity.baseAsset} | ??${opportunity.shortExchange.toUpperCase()} 濡?${opportunity.longExchange.toUpperCase()}`,
      undefined,
      `?ъ옄湲? $${fmtNum(realInvestment, 0)} | ?덉긽 8h?쒖닔?? $${fmtNum(previewProfit.netPerFunding)} (?섏닔猷? -$${fmtNum(previewProfit.totalFees)})`,
    );

    const pairId = `pair-${Date.now()}-${opportunity.baseAsset}`;
    set({ strategyRunning: true });

    try {
      // ?? ?룹쭠 ?ㅺ굅?? ??濡??숈떆 吏꾩엯 ??
      const res = await fetch('/api/strategy/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunity,
          investmentUSDT: realInvestment,
          leverage: strategyConfig.leverage,
          pairId,
          feeOverrides: strategyConfig.feeOverrides,
          // apiConfigs???쒕쾭 痢??뷀샇????μ냼?먯꽌 濡쒕뱶 (?대씪?댁뼵???꾩넚 X)
        }),
      });

      const json = await res.json() as ExecuteStrategyResult;
      const result: ExecuteStrategyResult = { ...json, pairId: json.pairId ?? pairId };

      // Guard 李⑤떒 ?묐떟 泥섎━ (?щ━?쇱? 珥덇낵, ?섏씡??誘몃떖 ??
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
          `${opportunity.baseAsset} 吏꾩엯 李⑤떒: ${errorMsg || '?ъ쟾 寃利??ㅽ뙣'}`,
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
          `${opportunity.shortExchange.toUpperCase()} ???ъ???吏꾩엯 ?깃났`,
          opportunity.shortExchange,
          `${opportunity.baseAsset} Short @${fmtNum(result.short.data?.price ?? opportunity.shortMarkPrice, 4)} | fee -$${fmtNum(result.short.data?.estimatedFee ?? 0, 4)} | ${result.short.data?.liquidity ?? 'unknown'}`,
        );
      } else {
        get().addLog('error',
          `${opportunity.shortExchange.toUpperCase()} ???ъ???吏꾩엯 ?ㅽ뙣`,
          opportunity.shortExchange,
          result.short?.error,
        );
      }

      if (result.long?.success) {
        get().addLog('success',
          `${opportunity.longExchange.toUpperCase()} 濡??ъ???吏꾩엯 ?깃났`,
          opportunity.longExchange,
          `${opportunity.baseAsset} Long @${fmtNum(result.long.data?.price ?? opportunity.longMarkPrice, 4)} | fee -$${fmtNum(result.long.data?.estimatedFee ?? 0, 4)} | ${result.long.data?.liquidity ?? 'unknown'}`,
        );
      } else {
        get().addLog('error',
          `${opportunity.longExchange.toUpperCase()} 濡??ъ???吏꾩엯 ?ㅽ뙣`,
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
      get().addLog('error', '?꾨왂 ?ㅽ뻾 以??ㅻ쪟 諛쒖깮', undefined, (err as Error).message);
      queueTrade({
        timestamp: Date.now(), type: 'error', simulation: false,
        baseAsset: opportunity.baseAsset, reason: (err as Error).message,
      });
      return { success: false, error: (err as Error).message };
    } finally {
      set({ strategyRunning: false });
    }
  },

  // ?? Close position ????????????????????????????
  async closePosition(position) {
    const { apiConfigs } = get();
    const config = apiConfigs[position.exchange];
    if (!config) {
      get().addLog('error', `${position.exchange.toUpperCase()} API ???놁쓬`, position.exchange);
      throw new Error(`${position.exchange.toUpperCase()} API ???놁쓬`);
    }

    get().addLog('info', `?ъ???泥?궛 ?쒕룄: ${position.displaySymbol} ${position.side}`, position.exchange);

    try {
      const res = await fetch(`/api/exchanges/${position.exchange}/close`, {
        method: 'POST',
        headers: makeApiHeaders(config),
        body: JSON.stringify({
          symbol: position.symbol,
          side: position.side,
          amount: position.size,
          feeOverrides: get().strategyConfig.feeOverrides,
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
          `${position.displaySymbol} ${position.side.toUpperCase()} 泥?궛 ?꾨즺`,
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
        get().addLog('error', `泥?궛 ?ㅽ뙣: ${json.error}`, position.exchange);
        throw new Error(`泥?궛 ?ㅽ뙣: ${json.error}`);
      }
    } catch (err) {
      get().addLog('error', '泥?궛 以??ㅻ쪟', position.exchange, (err as Error).message);
      throw err;
    }
  },

  // ?? Test connection ???????????????????????????
  async testConnection(exchange) {
    const config = get().apiConfigs[exchange];
    if (!config) return false;

    get().addLog('info', `${exchange.toUpperCase()} ?곌껐 ?뚯뒪??以?..`, exchange);

    try {
      const res = await fetch(`/api/exchanges/${exchange}/test`, {
        method: 'POST',
        headers: makeApiHeaders(config),
      });
      const json = await res.json() as { success: boolean; error?: string };

      if (json.success) {
        get().addLog('success', `${exchange.toUpperCase()} ?곌껐 ?깃났`, exchange);
      } else {
        get().addLog('error', `${exchange.toUpperCase()} ?곌껐 ?ㅽ뙣`, exchange, json.error);
      }
      return json.success;
    } catch (err) {
      get().addLog('error', `${exchange.toUpperCase()} ?곌껐 ?ㅻ쪟`, exchange, (err as Error).message);
      return false;
    }
  },

  // ?? Logs ??????????????????????????????????????
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

  // ?? Simulation ????????????????????????????????
  async toggleSimulationMode() {
    const current = get().simulationMode;
    const next = !current;
    // 紐⑤뱶 ?꾪솚 ???ㅻ굹?댄봽瑜?痍⑥냼?섏? ?딆쓬 ??媛?紐⑤뱶媛 ?낅┰?곸쑝濡??숈떆 ?ㅽ뻾
    set({ simulationMode: next });
    // 紐⑤뱶 ?곹깭 ?곸냽??    saveSimMode(next);
    try {
      const sharedState = await updateSharedSnipeStateSnapshot({ simulationMode: next });
      applySharedSnipeStateSnapshot(set, sharedState);
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
    const perExchange = get().strategyConfig.investmentUSDT * 2; // 嫄곕옒?뚮떦 ?ъ옄湲댠? (??濡??묒そ)
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
    // ?쒕쾭 痢?嫄곕옒?댁뿭 + 濡쒓렇??珥덇린??    fetch('/api/trades/clear', { method: 'DELETE' }).catch(() => {});
    fetch('/api/logs/clear', { method: 'DELETE' }).catch(() => {});
    get().addLog('info', `[SIM] 珥덇린???꾨즺 ??媛?嫄곕옒??$${perExchange} 由ъ뀑`);
  },

  clearSimFundingHistory() {
    set({ fundingHistory: [] });
    saveFundingHistory([]);
    void fetch('/api/sim-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clearFundingHistory' }),
    }).catch(() => {});
    get().addLog('info', '[SIM] ????섎졊 ?댁뿭 珥덇린???꾨즺');
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

    // ?? ?ㅼ젣 ?멸?李?湲곕컲 泥?궛 泥닿껐媛 (?щ━?쇱? 諛섏쁺) ??
    let exitPrice = pos.markPrice;
    try {
      const exitSide = pos.side === 'short' ? 'buy' : 'sell';
      const res = await fetch(`/api/exchanges/${pos.exchange}/orderbook?symbol=${encodeURIComponent(pos.symbol)}&side=${exitSide}&notional=${pos.sizeUSD}`).then(r => r.json());
      if (res.success) {
        exitPrice = res.fillPrice;
        get().addLog('info', `[SIM] ${pos.baseAsset} ${pos.side} 泥?궛 泥닿껐媛: $${fmtNum(exitPrice, 2)} (?щ━?쇱?: ${fmtNum(res.slippagePercent, 4)}%)`, pos.exchange);
      }
    } catch {
      // ?멸?李?議고쉶 ?ㅽ뙣 ??markPrice ?ъ슜
    }

    const exitNotional = pos.size * exitPrice; // ?꾩옱 媛寃?湲곕컲 ?ㅼ젣 泥?궛 ?몄뀛??    const exitFee = exitNotional * getConfiguredExchangeFee(get().strategyConfig, pos.exchange, 'taker');
    const pricePnl = pos.side === 'short'
      ? (pos.entryPrice - exitPrice) * pos.size
      : (exitPrice - pos.entryPrice) * pos.size;

    // ?? ?ㅻ굹?댄봽 ???吏곸젒 怨꾩궛 (tickSimFunding ?섏〈 X) ??
    let actualFunding = pos.fundingCollected;
    if (pos.isSnipe && actualFunding === 0) {
      // tickSimFunding?먯꽌 泥섎━ 紐???寃쎌슦 吏곸젒 怨꾩궛
      // ??吏꾩엯 ?쒖젏 fundingRate ?ъ슜 ??泥?궛 ?쒖젏 liveRate???대? ?ㅼ쓬 二쇨린濡?媛깆떊?먯쓣 ???덉쓬
      const currentRate = pos.fundingRate;
      actualFunding = pos.side === 'short'
        ? pos.sizeUSD * currentRate
        : pos.sizeUSD * (-currentRate);
      // ?붽퀬?먮룄 諛섏쁺
      set(s => ({
        simBalances: { ...s.simBalances, [pos.exchange]: (s.simBalances[pos.exchange] ?? 0) + actualFunding },
        simTotalFundingEarned: s.simTotalFundingEarned + actualFunding,
      }));
      get().addLog('info',
        `[SIM] ???吏곸젒 怨꾩궛: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        pos.exchange,
        `$${fmtNum(Math.abs(actualFunding), 4)} (rate: ${fmtNum(currentRate * 100, 4)}%)`,
      );
    }

    const returnAmount = pos.margin + pricePnl - exitFee;
    const netPnl = pricePnl + actualFunding - (pos.entryFee ?? 0) - exitFee;

    // ?? ????섎졊 ?댁뿭 湲곕줉: tickSimFunding???대? 湲곕줉??寃쎌슦 ?ㅽ궢 (fallback 吏곸젒怨꾩궛??寃쎌슦留?湲곕줉) ??
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
      `[SIM] ?ъ???泥?궛: ${pos.displaySymbol} ${pos.side.toUpperCase()}`,
      pos.exchange,
      `?쒖넀?? ${netPnl >= 0 ? '+' : ''}$${fmtNum(netPnl)} (??? $${fmtNum(actualFunding, 4)}, 媛寃⑹넀?? $${fmtNum(pricePnl)}, ?섏닔猷? -$${fmtNum((pos.entryFee ?? 0) + exitFee)})`,
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
        message: `[SIM] ???${funding >= 0 ? '?섎졊' : '吏遺?}: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        exchange: pos.exchange,
        detail: `$${fmtNum(Math.abs(funding), 4)} (${fmtNum(currentRate * 100, 4)}%${liveRate ? '' : ' [吏꾩엯?쐒ate]'})`,
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

    // ?붾쾭洹? ?ㅻ굹?댄봽 ?먮룞泥?궛 ?먮떒 濡쒓렇
    if (updated.some(p => p.isSnipe)) {
      const snipePositions = updated.filter(p => p.isSnipe);
      for (const p of snipePositions) {
        if ((p.fundingReceived ?? 0) >= 1) {
          pendingLogs.push({
            level: 'info',
            message: `[?ㅻ굹?댄봽 泥?궛?湲? ${p.baseAsset} ${p.side} ??fundingReceived:${p.fundingReceived} ???먮룞泥?궛 ?덉젙`,
            exchange: p.exchange,
            detail: `simId:${p.simId} | pairId:${p.pairId} | ?섎졊???$${fmtNum(p.fundingCollected, 4)}`,
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

    // ?붾젅洹몃옩: ????섏씡 ?뚮┝ (?⑹궛 硫붿떆吏)
    if (simFundingPayments.length > 0 && totalNewFunding !== 0) {
      const lines = simFundingPayments.map(p =>
        `  ${p.exchange.toUpperCase()} ${p.symbol} (${p.side}): ${p.amount >= 0 ? '+' : ''}$${p.amount.toFixed(4)}`
      );
      const icon = totalNewFunding >= 0 ? '?뮥' : '?뮯';
      void sendTelegramMessage([
        `${icon} <b>[SIM] ????섎졊: ${simFundingPayments.length}嫄?/b>`,
        ...lines,
        `\n?⑷퀎: ${totalNewFunding >= 0 ? '+' : ''}$${totalNewFunding.toFixed(4)}`,
      ].join('\n'));
    }

    // ?붾젅洹몃옩: ?붽퀬 遺議?寃쎄퀬 (?됯퇏 ?鍮?50% ?댄븯, 30遺?荑⑤떎??
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
              simulation: true, // tickSimFunding? ??긽 SIM ?꾩슜
            }));
            break;
          }
        }
      }
    }

    // ?ㅻ굹?댄븨: ????섎졊 ?꾨즺 ??利됱떆 泥?궛 ???ㅼ쓬 ?ъ씠???ъ삁??    if (snipeToClose.length > 0) {
      queueMicrotask(async () => {
        // ?ъ????リ린 ?꾩뿉 pair ?뺣낫 罹≪쿂 (?レ? ?꾩뿉??simPositions?먯꽌 ?щ씪吏?
        const positionsSnapshot = [...get().simPositions];

        // 泥?궛 ???ㅼ젣 寃곌낵瑜??섏쭛
        const closeResults: { pos: typeof snipeToClose[0]; result: { netPnl: number; funding: number } | null }[] = [];
        for (const pos of snipeToClose) {
          const result = await get().closeSimPosition(pos.simId);
          closeResults.push({ pos, result });
        }
        const totalCollected = snipeToClose.reduce((s, p) => s + p.fundingCollected, 0);
        get().addLog('success',
          `[?ㅻ굹?댄븨] ????섎졊 ?꾨즺 ??${snipeToClose.length}媛??ъ????먮룞 泥?궛`,
          undefined,
          `珥??섎졊: $${fmtNum(totalCollected, 4)}`,
        );

        // ?붾젅洹몃옩: ?ㅻ굹?댄봽 ?꾨즺 ?뚮┝ ???ㅼ젣 泥?궛 寃곌낵(fillPrice 湲곕컲 netPnl) ?ъ슜
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
            simulation: true, // tickSimFunding? SIM ?꾩슜
          }));
        }

        // 泥?궛??肄붿씤????대㉧ ?뺣━ + ?ㅼ쓬 ?ъ씠???먮룞 ?ъ삁??        const closedKeys = [...new Set(
          snipeToClose.map((position) => getSimPositionOpportunityKey(position, positionsSnapshot)),
        )];
        for (const key of closedKeys) {
          get().cancelSnipeForAsset(mkSnipeKey(true, key)); // tickSimFunding? SIM ?꾩슜
        }
        if (get().simSnipeActive || get().realSnipeActive) {
          get().scheduleAllSnipes();
        }
      });
    }

    // ??? ?ㅽ봽?덈뱶 ??쟾 媛먯? ???먮룞 泥?궛
  },

  // ?? Exchange Toggle ?????????????????????????
  toggleExchange(exchange) {
    const { enabledExchanges, simPositions } = get();

    // ?대떦 嫄곕옒?뚯뿉 ?대┛ ?ъ??섏씠 ?덉쑝硫?OFF 遺덇? (?쒕? + ?ㅺ굅??紐⑤몢 泥댄겕)
    if (enabledExchanges.includes(exchange)) {
      const hasSimPositions = simPositions.some(p => p.exchange === exchange);
      const hasRealPositions = get().positions.some(p => p.exchange === exchange);
      if (hasSimPositions || hasRealPositions) {
        get().addLog('warning',
          `${exchange.toUpperCase()} OFF 遺덇? ???대┛ ?ъ??섏씠 ?덉뒿?덈떎`,
          exchange,
          '?ъ??섏쓣 癒쇱? 泥?궛?섏꽭??,
        );
        return;
      }
    }

    let next: ExchangeId[];
    if (enabledExchanges.includes(exchange)) {
      // OFF: 理쒖냼 2媛쒕뒗 ?좎??댁빞 ?룹쭠 媛??      if (enabledExchanges.length <= 2) {
        get().addLog('warning', '理쒖냼 2媛?嫄곕옒?뚭? ?꾩슂?⑸땲????鍮꾪솢?깊솕 遺덇?');
        return;
      }
      next = enabledExchanges.filter(e => e !== exchange);
    } else {
      // ON
      next = [...enabledExchanges, exchange];
    }

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
      `${exchange.toUpperCase()} ${action} ???쒖꽦 ${next.length}媛?嫄곕옒??,
      exchange,
      `?쒕? 珥??먯궛: $${fmtNum(totalSim, 0)} (?ъ???留덉쭊 蹂댁〈??`,
    );

    // 利됱떆 ???ㅼ젙?쇰줈 ??⑸쪧 媛깆떊
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

  // ?? UI ????????????????????????????????????????
  setShowApiPanel: (v) => set({ showApiPanel: v }),
  setShowStrategyPanel: (v) => set({ showStrategyPanel: v }),
  setRateFilter: (v) => set({ rateFilter: v }),
  setExchangeFilter: (v) => set({ exchangeFilter: v }),
  setPositionToClose: (v) => set({ positionToClose: v }),

  // ?? ?덉빟 肄붿씤 ?ㅼ떆媛??ш?利? 8珥덈쭏????netProfit ??0 利됱떆 ?댁젣 + ??醫뗭? 湲고쉶濡?援먯껜 ??
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

    // ?ㅼ뒳由ы뵾吏+?섏닔猷?諛섏쁺 ?쒖닔??怨꾩궛 ?ы띁 (蹂듬━ ???ㅼ옍怨?湲곕컲 notional)
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
      // realSpread ?놁쑝硫?蹂댁닔?곸쑝濡?-1 諛섑솚 (?대줎媛?吏꾩엯 湲덉?)
      if (!hasRS) return -1;
      // effectiveSpread???щ━?쇱?+?섏닔猷?紐⑤몢 諛섏쁺??      return notional * (rs.effectiveSpread / 100);
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

      // ?대떦 紐⑤뱶媛 鍮꾪솢?깆씠硫??뺣━
      if (isSim && !get().simSnipeActive) { get().cancelSnipeForAsset(key); continue; }
      if (!isSim && !get().realSnipeActive) { get().cancelSnipeForAsset(key); continue; }

      // ???15珥??꾩씠硫?lock-in ???ш?利??ㅽ궢 (?덉씠??而⑤뵒??諛⑹?)
      const targetTime = snipeTargets[key];
      if (targetTime && targetTime - Date.now() < 15_000) continue;

      if (!currentOpp) {
        get().addLog('warning', `[?ш?利? ${asset} 湲고쉶 ?뚮㈇ ???덉빟 ?댁젣`);
        get().cancelSnipeForAsset(key);
        continue;
      }

      // ?ㅽ슚?ㅽ봽?덈뱶(?ㅻ뜑遺??щ━?쇱? 諛섏쁺) 湲곗? ?쒖닔???ш퀎??      const realSpreadData = getRealSpreadForOpportunity(currentRealSpreads, currentOpp);
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
      // effectiveSpread???쒖떆???덉쟾留덉쭊 誘명룷?? ???ㅽ뻾 ?먮떒 ???덉쟾留덉쭊 蹂꾨룄 李④컧
      const liveNetProfit = oppNotional * ((effectiveSpreadPercent - SAFETY_MARGIN_PCT) / 100);

      // ?쒖닔????0 ???댁젣 ??吏꾩엯 湲곗?(3bps)怨??숈씪???덉쟾留덉쭊 ?곸슜
      if (liveNetProfit <= 0) {
        get().addLog('warning',
          `[?ш?利? ${asset} ?쒖닔??湲곗? 誘몃떖 ???덉빟 ?댁젣`,
          undefined,
          `?ㅽ슚?ㅽ봽?덈뱶: ${fmtNum(effectiveSpreadPercent, 4)}% | ?쒖닔?? $${fmtNum(liveNetProfit)}`,
        );
        get().cancelSnipeForAsset(key);
        continue;
      }

      // 10%+ ??醫뗭? 湲고쉶 諛쒓껄 ??援먯껜 (?ㅼ뒳由ы뵾吏 諛섏쁺 ?쒖닔??湲곗?)
      // ?? ????? ????쒖젏?쇰줈 媛덉븘?吏 ?딄쾶 ?쒗븳?쒕떎.
      // ???꾨낫??realSpread媛 ?놁쑝硫??대줎媛?怨쇰??됯? ??援먯껜?믫빐??猷⑦봽 諛⑹?
      const MAX_REPLACEMENT_DELAY_MS = 10 * 60 * 1000;
      const betterOpp = opportunities.find(o => {
        if (getOpportunityId(o) === opportunityId) return false;
        // 媛숈? 紐⑤뱶?먯꽌 ?대? ?덉빟??        if (snipeTargets[mkSnipeKey(isSim, getOpportunityId(o))]) return false;
        if (opportunityConflictsWithLegs(o, occupiedLegs)) return false;
        if (o.spreadPercent < effectiveMinPercent) return false;
        if ((o.nextFundingTime - targetTime) > MAX_REPLACEMENT_DELAY_MS) return false;
        // ??realSpread ?녿뒗 ?꾨낫??援먯껜 ??곸뿉???쒖쇅 (?대줎媛?怨쇰??됯? 諛⑹?)
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
          `[援먯껜] ${asset}($${fmtNum(liveNetProfit)}) ??${betterOpp.baseAsset}($${fmtNum(betterLiveNet)}) +${improvePct}%`,
          undefined,
          `?ㅽ슚?ㅽ봽?덈뱶 ?뺤씤??,
        );
        get().cancelSnipeForAsset(key);
        get().scheduleSnipeForAsset(betterOpp, isSim);
      }
    }
  },

  // ?? ?몃（ ?ㅻ굹?댄븨: 肄붿씤蹂??낅┰ ??대㉧ ?????7珥???吏꾩엯 ???섎졊 ?뺤씤 ??利됱떆 泥?궛 ??

  // ???二쇨린蹂?1h/4h/8h) 踰꾪궥 ?쇱슫?쒕줈鍮???吏㏃? 二쇨린 ?곗꽑 蹂댁옣
  // 媛??쒖꽦 紐⑤뱶(sim/real)??????낅┰?곸쑝濡??ㅼ?以꾨쭅
  scheduleAllSnipes() {
    // SIM: ?대씪?댁뼵????대㉧濡??ㅼ?以꾨쭅
    // REAL: ?쒕쾭 ?ㅼ?以꾨윭媛 ?꾨떞 ???대씪?댁뼵?몄뿉??以묐났 ??대㉧ ?앹꽦?섏? ?딆쓬
    if (get().simSnipeActive) {
      void fetchServerSimSchedulerStatus()
        .then((status) => {
          applyServerSimStateSnapshot(set, status.state, { force: true });
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

  // ?대?: ?뱀젙 紐⑤뱶??????ㅼ?以꾨쭅
  _scheduleSnipesForMode(isSim: boolean) {
    const {
      opportunities,
      enabledExchanges: currentEnabled,
      snipeTargets,
      snipeAllocations,
      simPositions,
      positions,
      strategyConfig,
    } = get();
    const effectiveMinPercent = getEffectiveMinSpread(strategyConfig);
    const modePrefix = isSim ? 'sim' : 'real';

    // ?대? ?덉빟?섏뿀嫄곕굹 ?쒖꽦 ?ъ??섏씠 ?≫엺 ?덇렇???ㅼ떆 ?쒖슦吏 ?딅뒗??
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
      // 怨쇨굅 ????쒓컙留?李⑤떒 (normalizeFr?먯꽌 ?대? 蹂댁젙?섏?留??덉쟾?μ튂)
      if (o.nextFundingTime < now) { filterReasons.pastFunding++; return false; }
      // ?덉빟 ?④퀎: realSpread ?덉쑝硫??섏씡?깆? getLiveNetProfit(3bps ?ы븿)?먯꽌 寃利???minSpread???대줎媛믪뿉留??곸슜
      // effectiveSpread???대? ?섏닔猷??щ━?쇱? 李④컧 ?꾨즺媛믪씠誘濡?minSpread(?섏닔猷??ы븿)? 鍮꾧탳?섎㈃ ?댁쨷 ?꾪꽣
      const rs = getRealSpreadForOpportunity(preFilterRealSpreads, o);
      const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
      // ???좊룞???꾪꽣: ?щ━?쇱?媛 maxSlippagePercent ?댁긽?대㈃ 李⑤떒
      const maxSlip = strategyConfig.maxSlippagePercent ?? 1.5;
      if (hasRS && (rs.shortSlippage > maxSlip || rs.longSlippage > maxSlip)) { filterReasons.noProfit++; return false; }
      if (!hasRS && o.spreadPercent < effectiveMinPercent) { filterReasons.lowSpread++; return false; }
      if (o.netProfit <= 0) { filterReasons.noProfit++; return false; }
      return true;
    });

    if (filtered.length === 0 && opportunities.length > 0) {
      if (!_lastScheduleDiagAt || now - _lastScheduleDiagAt > 30_000) {
        _lastScheduleDiagAt = now;
        const parts = [];
        if (filterReasons.legConflict > 0) parts.push(`?덇렇異⑸룎:${filterReasons.legConflict}`);
        if (filterReasons.exchangeDisabled > 0) parts.push(`嫄곕옒?뚮퉬?쒖꽦:${filterReasons.exchangeDisabled}`);
        if (filterReasons.tooFarAhead > 0) parts.push(`?쒓컙珥덇낵:${filterReasons.tooFarAhead}`);
        if (filterReasons.pastFunding > 0) parts.push(`怨쇨굅?쒓컙:${filterReasons.pastFunding}`);
        if (filterReasons.lowSpread > 0) parts.push(`?ㅽ봽?덈뱶誘몃떖:${filterReasons.lowSpread}`);
        if (filterReasons.noProfit > 0) parts.push(`?섏씡?놁쓬:${filterReasons.noProfit}`);
        get().addLog('warning',
          `[?ㅼ?以?吏꾨떒][${modePrefix.toUpperCase()}] 湲고쉶 ${opportunities.length}媛??꾨? ?덈씫`,
          undefined,
          `?ъ쑀: ${parts.join(' | ')} | 理쒖냼?ㅽ봽?덈뱶: ${effectiveMinPercent}%`,
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
        // ??effectiveSpread???쒖떆???덉쟾留덉쭊 誘명룷?? ???ㅼ?以꾨쭅 ???덉쟾留덉쭊 蹂꾨룄 李④컧
        return n * ((rs.effectiveSpread - SAFETY_MARGIN_PCT) / 100);
      }
      // ?ㅼ륫 ?놁쑝硫??대줎 湲곕컲 蹂댁닔??怨꾩궛 (?덉쟾留덉쭊 ?ы븿)
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
          `[?ㅼ?以?吏꾨떒][${modePrefix.toUpperCase()}] ${filtered.length}媛?湲고쉶媛 ?ㅽ슚?ㅽ봽?덈뱶 ?섏씡 泥댄겕?먯꽌 ?꾨? ?덈씫`,
          undefined,
          `?덉떆: ${sample.baseAsset} ?대줎:${fmtNum(sample.spreadPercent, 4)}% ?ㅽ슚:${effSpr !== null ? fmtNum(effSpr, 4) + '%' : '?놁쓬'} netProfit:$${fmtNum(getLiveNetProfit(sample))}`,
        );
      }
      return;
    }

    // ?쒕??덉씠??紐⑤뱶: ?붽퀬 泥댄겕 ???щ텇諛?癒쇱? ?ㅽ뻾 (?붽퀬 遺議?諛⑹?)
    if (isSim) {
      get().redistributeBalances();
    }
    const latestSimBalances = get().simBalances;
    const latestRealBalances = get().balances;

    // 嫄곕옒?뚮퀎 媛???붽퀬 異붿쟻 (?먭툑 珥덇낵 ?덉빟 諛⑹?)
    const availableBalance: Record<string, number> = {};
    for (const ex of currentEnabled) {
      const bal = isSim
        ? (latestSimBalances[ex] ?? 0)
        : (latestRealBalances[ex]?.availableUSDT ?? 0);
      availableBalance[ex] = bal;
    }

    // ?대? ?덉빟??肄붿씤??留덉쭊???쒖감 李④컧 (蹂듬━: ?댁쟾 ?덉빟??以꾩씤 ?붽퀬 諛섏쁺)
    // ????쒓컖 ???뺣젹 ???대Ⅸ ??⑹씠 癒쇱? ?먭툑???ъ슜?섎?濡??쒖꽌媛 以묒슂
    const reservedKeys = Object.keys(snipeTargets)
      .filter(k => parseSnipeKey(k).isSim === isSim)
      .sort((a, b) => (snipeTargets[a] ?? 0) - (snipeTargets[b] ?? 0));
    for (const tKey of reservedKeys) {
      const opp = findOpportunityById(opportunities, parseSnipeKey(tKey).opportunityId);
      if (!opp) continue;
      const reservePerSide = snipeAllocations[tKey] ?? strategyConfig.investmentUSDT;
      availableBalance[opp.shortExchange] = Math.max(0, (availableBalance[opp.shortExchange] ?? 0) - reservePerSide);
      availableBalance[opp.longExchange] = Math.max(0, (availableBalance[opp.longExchange] ?? 0) - reservePerSide);
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
            strategyConfig.feeOverrides,
          ) - getOpportunityYieldScore(
            a,
            getRealSpreadForOpportunity(currentRealSpreads, a),
            strategyConfig.feeOverrides,
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
          `[?ㅼ?以??룹쭠][${modePrefix.toUpperCase()}] ${plan.opportunity.baseAsset} ?좏깮 ??${minsLeft}遺??????,
          undefined,
          `二쇨린:${intervalH}h | ?ъ옄湲?$${fmtNum(plan.investmentUSDT, 0)} | ?ㅽ봽?덈뱶:+${fmtNum(plan.opportunity.spreadPercent, 4)}% | ${plan.opportunity.shortExchange}??{plan.opportunity.longExchange}`,
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
          `[?ㅼ?以?吏꾨떒][${modePrefix.toUpperCase()}] ${profitable.length}媛??섏씡 湲고쉶 ???붽퀬遺議?${balanceSkips}`,
          undefined,
          `湲곗??ъ옄湲?$${strategyConfig.investmentUSDT} | 媛?⑹옍怨? ${balInfo}`,
        );
      }
    }
  },

  // ?뱀젙 肄붿씤 1媛쒖뿉 ????ㅻ굹?댄븨 ?덉빟 (紐⑤뱶蹂?
  scheduleSnipeForAsset(opportunity, isSim, investmentUSDT) {
    const { _snipeTimers, snipeTargets } = get();
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(opportunity));

    // ?대? ?덉빟???ㅻ㈃ ?ㅽ궢
    if (snipeTargets[snipeKey]) return;

    // 湲곗〈 ??대㉧ ?뺣━
    if (_snipeTimers[snipeKey]) clearTimeout(_snipeTimers[snipeKey]);

    // 怨쇨굅 ?쒓컙 蹂댁젙
    const intervalMs = opportunity.fundingIntervalMs ?? 8 * 3600 * 1000;
    let targetTime = opportunity.nextFundingTime;
    const now = Date.now();
    while (targetTime <= now) {
      targetTime += intervalMs;
    }

    const entryLeadMs = getResolvedTimingConfig(get().strategyConfig.timingConfig).entryLeadMs;

    // ??⑷퉴吏 6珥?誘몃쭔 ???ㅼ쓬 ?ъ씠??(ENTRY_BEFORE_MS=5珥덈낫???쎄컙 ?ъ쑀)
    if (targetTime - now < entryLeadMs + 1_000) {
      targetTime += intervalMs;
    }

    const entryDelay = Math.max(0, targetTime - now - entryLeadMs);

    // ??대㉧ ?깅줉
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
      `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${opportunity.baseAsset} ?덉빟 ??${mins}遺?${secs}珥???,
      undefined,
      `??⑹＜湲? ${intervalH}h | ?ъ옄湲?$${fmtNum(investmentUSDT ?? get().strategyConfig.investmentUSDT, 0)} | ?ㅽ봽?덈뱶: +${fmtNum(opportunity.spreadPercent, 4)}%`,
    );
  },

  // ???대?: ???吏곸쟾 吏꾩엯 ?ㅽ뻾 + ?섎졊 ???먮룞泥?궛 ?덉빟
  _executeSnipeEntry(opportunity: ArbitrageOpportunity, targetFundingTime: number, isSim: boolean) {
    const modeActive = isSim ? get().simSnipeActive : get().realSnipeActive;
    const modeLabel = isSim ? 'SIM' : 'REAL';
    // ?먮룞??鍮꾪솢????吏꾩엯 李⑤떒 (泥?궛 ?ㅽ뙣 ?깆쑝濡??쇱떆?뺤???寃쎌슦)
    if (!modeActive) {
      get().addLog('warning', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${opportunity.baseAsset} 吏꾩엯 ?ㅽ궢 ???먮룞??鍮꾪솢???곹깭`);
      return;
    }

    const asset = opportunity.baseAsset;
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(opportunity));
    const plannedInvestmentUSDT = get().snipeAllocations[snipeKey] ?? get().strategyConfig.investmentUSDT;

    // ???ㅽ뻾 吏곸쟾 ?쒓컙 寃利???????쒓컙???대? 吏?ш굅???덈Т ?쇱컢?대㈃ 李⑤떒
    const secsUntilFunding = (targetFundingTime - Date.now()) / 1000;
    if (secsUntilFunding < -10) {
      get().addLog('warning', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 吏꾩엯 李⑤떒 ??????쒓컙??${Math.abs(secsUntilFunding).toFixed(0)}珥??꾩뿉 ?대? 吏??);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }
    if (secsUntilFunding > 30) {
      get().addLog('warning', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 吏꾩엯 李⑤떒 ????⑷퉴吏 ${secsUntilFunding.toFixed(0)}珥??⑥쓬 (?덈Т ?대쫫)`);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const { enabledExchanges: currentEnabled } = get();

    // 吏꾩엯 ?쒖젏???대떦 肄붿씤??理쒖떊 湲고쉶 ?뺤씤 (?쒖닔??+ 理쒖냼?ㅽ봽?덈뱶 湲곗?)
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
      // realSpread ?놁쑝硫?吏꾩엯 遺덇? ???대줎媛믩쭔?쇰줈 吏꾩엯 湲덉?
      if (!hasRS) return false;
      const effSpreadPct = rs.effectiveSpread; // ?щ━?쇱?+?섏닔猷?紐⑤몢 諛섏쁺??      const liveNet = n * (effSpreadPct / 100);
      return liveNet > 0;
    };
    const finalTarget = latestOpp && meetsThreshold(latestOpp)
      ? latestOpp
      : meetsThreshold(opportunity) ? opportunity : null;

    if (!finalTarget) {
      get().addLog('warning', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 湲곗? 誘몃떖 ???ㅽ궢`);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const secsToFunding = Math.max(0, (targetFundingTime - Date.now()) / 1000).toFixed(1);
    get().addLog('info',
      `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 吏꾩엯 ?ㅽ뻾 ????⑷퉴吏 ${secsToFunding}珥?,
      undefined,
      `??${finalTarget.shortExchange.toUpperCase()} 濡?${finalTarget.longExchange.toUpperCase()} | ?ъ옄湲?$${fmtNum(plannedInvestmentUSDT, 0)} | ?ㅽ봽?덈뱶: +${fmtNum(finalTarget.spreadPercent, 4)}%`,
    );

    // ?ㅽ뻾 吏곸쟾 理쒖쥌 ?뺤씤 ???ㅻⅨ ?먯궛 泥?궛 ?ㅽ뙣濡?鍮꾪솢?깊솕?먯쓣 ???덉쓬
    const modeActiveRecheck = isSim ? get().simSnipeActive : get().realSnipeActive;
    if (!modeActiveRecheck) {
      get().addLog('warning', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 吏꾩엯 吏곸쟾 痍⑥냼 ???먮룞??鍮꾪솢???곹깭`);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const entryTarget = { ...finalTarget, nextFundingTime: targetFundingTime };
    get().executeStrategy(entryTarget, isSim, plannedInvestmentUSDT).then((result) => {
      if (result.success) {
        // 吏꾩엯 ?깃났 ???먮룞??鍮꾪솢??泥댄겕 ???ㅻⅨ ?먯궛 泥?궛 ?ㅽ뙣濡??뺤???寃쎌슦
        const stillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (!stillActive) {
          get().addLog('warning',
            `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 吏꾩엯 ?깃났?덉쑝???먮룞??鍮꾪솢?????쒕쾭 泥닿껐 ?섎웾?쇰줈 利됱떆 ?뺣━`,
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
                `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} stale 吏꾩엯 ?뺣━ ?ㅽ뙣 ??泥닿껐 ?뺣낫 ?놁쓬, ?섎룞 ?뺤씤 ?꾩슂`,
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
                  `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} stale 吏꾩엯 ?먮룞 ?뺣━ 1李??ㅽ뙣 ??1珥????ъ떆??,
                  undefined,
                  lastCloseErrors.join('; '),
                );
                await new Promise(r => setTimeout(r, 1_000));
              }
            }

            if (pendingClosures.length > 0) {
              get().addLog('error',
                `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} stale 吏꾩엯 ?먮룞 ?뺣━ ${pendingClosures.length}/${stalePositions.length}媛??ㅽ뙣 ???섎룞 ?뺤씤 ?꾩슂`,
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
                `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} stale 吏꾩엯 ?먮룞 ?뺣━ ?꾨즺`,
              );
            }

            get().cancelSnipeForAsset(snipeKey);
          };
          void cleanupStaleEntry().catch((err) => {
            get().addLog('error',
              `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} stale 吏꾩엯 ?뺣━ 以??ㅻ쪟`,
              undefined,
              (err as Error).message,
            );
            get().cancelSnipeForAsset(snipeKey);
          });
          return;
        }

        get().addLog('success',
          `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 吏꾩엯 ?꾨즺`,
          undefined,
          `??⑷퉴吏 ~${secsToFunding}珥?,
        );
        const closeDelay = Math.max(0, targetFundingTime - Date.now()) + getResolvedTimingConfig(get().strategyConfig.timingConfig).closeDelayMs;
        const closeTimer = setTimeout(() => {
          get()._executeSnipeClose(finalTarget, isSim);
        }, closeDelay);
        set(s => ({
          _snipeCloseTimers: { ...s._snipeCloseTimers, [snipeKey]: closeTimer },
        }));
        get().addLog('info',
          `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} ?먮룞泥?궛 ?덉빟 ??${fmtNum(closeDelay / 1000, 0)}珥???,
        );
        // 吏꾩엯 ???⑥? ?먭툑?쇰줈 ?ㅼ쓬 理쒓퀬 ?섏씡 湲고쉶 ?먮룞 ?덉빟
        const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (modeStillActive) {
          get().scheduleAllSnipes();
        }
      } else {
        get().addLog('error', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 吏꾩엯 ?ㅽ뙣`, undefined, result.error);
        get().cancelSnipeForAsset(snipeKey);
        const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
        if (modeStillActive) {
          get().scheduleAllSnipes();
        }
      }
    });
  },

  // ???대?: ????섎졊 ?뺤씤 + ?ъ???泥?궛 + ?ㅼ쓬 ?ъ씠???ъ삁??  async _executeSnipeClose(target: ArbitrageOpportunity, isSim: boolean) {
    const asset = target.baseAsset;
    const snipeKey = mkSnipeKey(isSim, getOpportunityId(target));
    const modeLabel = isSim ? 'SIM' : 'REAL';
    let closeFailed = false;

    if (isSim) {
      // ?쒕??덉씠?? tickSimFunding ?섏〈 X ??吏곸젒 ?대떦 肄붿씤 ?ъ???李얠븘??泥?궛
      const simPosForAsset = get().simPositions.filter((position) =>
        position.baseAsset === asset
        && position.isSnipe
        && (position.exchange === target.shortExchange || position.exchange === target.longExchange),
      );
      if (simPosForAsset.length === 0) {
        get().addLog('warning', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} ?쒕? ?ъ????놁쓬`);
      } else {
        for (const pos of simPosForAsset) {
          await get().closeSimPosition(pos.simId);
        }
        const totalCollected = simPosForAsset.reduce((s, p) => s + p.fundingCollected, 0);
        get().addLog('success',
          `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} ?쒕? 泥?궛 ?꾨즺`,
          undefined,
          `${simPosForAsset.length}媛??ъ???| ?섎졊 ??? $${fmtNum(totalCollected, 4)}`,
        );
      }
    } else {
      // ???ㅺ굅?? 利됱떆 泥?궛 (T+2s) ?????寃利앹? 鍮꾨룞湲곕줈 ?꾩쿂由?      const currentPositions = get().positions;
      const targetPositions = currentPositions.filter(p => {
        if (p.baseAsset !== asset) return false;
        if (p.positionType === 'manual') return false; // ?ъ슜???섎룞 ?ъ???蹂댄샇
        return (p.exchange === target.shortExchange || p.exchange === target.longExchange)
          && (p.positionType === 'hedge_short' || p.positionType === 'hedge_long');
      });

      if (targetPositions.length > 0) {
        get().addLog('info', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} ${targetPositions.length}媛?利됱떆 泥?궛 以?..`);
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
            `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 泥?궛 ${failedLegs.length}/${targetPositions.length}媛??ㅽ뙣 ???먮룞???쇱떆?뺤?, ?섎룞 ?뺤씤 ?꾩슂`,
            undefined,
            failedLegs.map(r => (r as PromiseRejectedResult).reason?.message || 'unknown').join('; '),
          );
          queueTrade({
            timestamp: Date.now(), type: 'exit_failed', simulation: false,
            baseAsset: asset, shortExchange: target.shortExchange, longExchange: target.longExchange,
            detail: `${failedLegs.length}/${targetPositions.length} legs failed`,
          });
        } else {
          get().addLog('success', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 泥?궛 ?꾨즺`);

          // ????섎졊 ?뺤씤? 鍮꾨룞湲곕줈 ??泥?궛??吏?곗떆?ㅼ? ?딆쓬 (?뺤씤 ???ㅼ젣 ?쒖넀???뺤젙)
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
                    `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} ????섎졊 ?뺤씤`,
                    undefined,
                    `${recentFundings.length}嫄?/ ?⑷퀎 $${fmtNum(totalFunding, 4)} | 理쒖쥌 ?쒖넀??${verifiedPnl >= 0 ? '+' : ''}$${fmtNum(verifiedPnl ?? 0, 4)}${fundingBreakdown ? ` | ${fundingBreakdown}` : ''}`,
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
                  `[??산돌??꾨릅-?猷뱀췅][${modeLabel}] ${asset} ??????롮죯 ?類ㅼ뵥 ?????${attempt + 1} ??쎈솭`,
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
                `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} ????섎졊 誘명솗????媛寃⑹넀??湲곗? ?좎젙 ?쒖넀??${verifiedPnl >= 0 ? '+' : ''}$${fmtNum(verifiedPnl ?? 0, 4)}`,
              );
            }

            void sendTelegramMessage(formatSnipeCompleteAlert({
              baseAsset: asset,
              shortExchange: target.shortExchange,
              longExchange: target.longExchange,
              fundingCollected: verifiedFunding,
              pnl: verifiedPnl,
              simulation: false,
              note: fundingVerified ? undefined : '????섎졊? 嫄곕옒???뺤궛 ?댁뿭 異붽? ?뺤씤 ?꾩슂',
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
        get().addLog('warning', `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] ${asset} 泥?궛???ъ????놁쓬`);
      }
    }

    // ?대떦 ????대㉧ ?뺣━
    get().cancelSnipeForAsset(snipeKey);

    // 泥?궛 ?ㅽ뙣 ???먮룞???쇱떆?뺤? ???붿뿬 ?ъ??섏씠 ?덈뒗 ?곹깭?먯꽌 ???ㅻ굹?댄봽 李⑤떒
    if (!isSim && closeFailed) {
      // REAL 紐⑤뱶??吏꾩엯 ??대㉧留??뺣━ ??泥?궛 ??대㉧???좎? (?ㅻⅨ ?먯궛???대┛ ?ъ???蹂댄샇)
      const { _snipeTimers, snipeTargets: currentTargets } = get();
      const realTimerKeys = Object.keys(_snipeTimers).filter(k => k.startsWith('real:'));
      for (const k of realTimerKeys) clearTimeout(_snipeTimers[k]);
      const newTimers = { ...get()._snipeTimers };
      const newTargets = { ...currentTargets };
      for (const k of realTimerKeys) { delete newTimers[k]; delete newTargets[k]; }
      set({ realSnipeActive: false, snipeTargets: newTargets, _snipeTimers: newTimers });
      // ?쒕쾭??鍮꾪솢???곹깭 ???+ ?쒕쾭 ?ㅼ?以꾨윭 ?뺤? (?ъ떆???ы븿)
      void fetch('/api/snipe-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realSnipeActive: false }) }).catch(() => {});
      void stopServerScheduler(get().addLog);
      get().addLog('error',
        `[?ㅻ굹?댄븨-?룹쭠][${modeLabel}] 泥?궛 ?ㅽ뙣濡??먮룞???쇱떆?뺤? ??吏꾩엯 ?덉빟 ?댁젣 (湲곗〈 泥?궛 ??대㉧ ?좎?), ?붿뿬 ?ъ????뺤씤 ???섎룞 ?ш컻 ?꾩슂`,
      );
      return;
    }

    const modeStillActive = isSim ? get().simSnipeActive : get().realSnipeActive;
    if (modeStillActive) {
      get().scheduleAllSnipes();
    }
  },

  // ?뱀젙 肄붿씤???ㅻ굹?댄븨 ??대㉧留??뺣━
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

  // ?ㅻ굹?댄븨 以묒? (紐⑤뱶蹂??먮뒗 ?꾩껜)
  cancelSnipe(mode = 'all') {
    const { _snipeTimers, _snipeCloseTimers, snipeTargets: currentTargets } = get();

    if (mode === 'all') {
      for (const t of Object.values(_snipeTimers)) clearTimeout(t);
      for (const t of Object.values(_snipeCloseTimers)) clearTimeout(t);
      set({ simSnipeActive: false, realSnipeActive: false, snipeTargets: {}, snipeAllocations: {}, _snipeTimers: {}, _snipeCloseTimers: {} });
      // ?쒕쾭??鍮꾪솢???곹깭 ???+ ?쒕쾭 ?ㅼ?以꾨윭 ?뺤? (?ъ떆???ы븿)
      void fetch('/api/snipe-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ simSnipeActive: false, realSnipeActive: false }) }).catch(() => {});
      void fetch('/api/sim-scheduler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).catch(() => {});
      void stopServerScheduler(get().addLog);
      get().addLog('info', '[?ㅻ굹?댄븨] ?꾩껜 以묒???);
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
      // REAL 紐⑤뱶 ?뺤? ???쒕쾭 ?ㅼ?以꾨윭???④퍡 ?뺤? (?ъ떆???ы븿)
      if (mode === 'real') {
        void stopServerScheduler(get().addLog);
      } else {
        void fetch('/api/sim-scheduler', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).catch(() => {});
      }
      get().addLog('info', `[?ㅻ굹?댄븨] ${mode.toUpperCase()} 紐⑤뱶 以묒???);
    }
  },

  async fetchFundingHistory() {
    // ?쒕??덉씠??紐⑤뱶?먯꽌???ㅺ굅??API 議고쉶?섏? ?딆쓬 (tickSimFunding?먯꽌 ?먯껜 湲곕줉)
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
      get().addLog('warning', '[??????롮죯] 椰꾧퀡??嚥≪뮄??fallback 嚥≪뮆諭???쎈솭', undefined, (err as Error).message);
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
      get().addLog('warning', '[??????롮죯] ??? 椰꾧퀡???鈺곌퀬????쎈솭', undefined, failures.join(' | '));
    }

    if (apiSuccessCount === 0 && fallbackHistory.length > 0) {
      get().addLog('info', `[??????롮죯] 椰꾧퀡??嚥≪뮄??fallback??곗쨮 ${fallbackHistory.length}椰?癰귣벊??);
    }

    if (mergedHistory.length > 0) {
      saveFundingHistory(mergedHistory);
      set({ fundingHistory: mergedHistory, isLoadingHistory: false });
      return;
    }

    if (previousHistory.length > 0 && failures.length > 0) {
      set({ isLoadingHistory: false });
      get().addLog('warning', '[??????롮죯] ??쎈솭嚥?疫꿸퀣????곷열??筌띲끉?');
      return;
    }

    saveFundingHistory([]);
    set({ fundingHistory: [], isLoadingHistory: false });
  },
}));

