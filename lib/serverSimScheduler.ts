import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { analyzeOrderbook, fetchFundingRates, fetchMarketFillPrice, fetchOrderbook, calcOrderbookImpactBps } from './exchanges';
import { warmFundingRatesWs, warmOrderbookWs } from './exchanges/wsPublicData';
import { pairUsesInstantaneousRate, hasTierCExchange, getPairEntryLeadMs, getPairMaxSettlementWaitMs } from './exchangeProfiles';
import { getEntryGapMetrics } from './entryGapGuard';
import { getFundingExchangeSnapshot } from './publicMarketDataCache';
import { refreshAllFeeCaches, resolveRuntimeFee, resolveRuntimeFeeDetailed } from './runtimeFeeCache';
import {
  buildBalanceEqualizationPlan,
  getBalanceEqualizationPlanningBalances,
  getOpportunityBalanceEqualizationMultiplier,
  type BalanceEqualizationPlan,
} from './balanceEqualization';
import {
  appendLogs,
  appendTrades,
  type FileLogEntry,
  listTradeHistoryDates,
  readTradeHistory,
  readTrades,
  type TradeEvent,
} from './fileLogger';
import { RouteFailureMemory, makeRouteFailureKey } from './routeFailureMemory';
import { sendTelegramMessage } from './telegramServer';
import { buildTradePairsFromEvents, formatTradePairTelegramMessage } from './tradeEvents';
import {
  findOpportunities,
  getOpportunityId,
  getOpportunityIntervalHours,
  getOpportunityTimeGroupKey,
  getOpportunityLegKeys,
  makeOpportunityId,
  calcConservativeEV,
  calcDriftBuffer,
  type ConservativeEVResult,
} from './opportunities';
import { saveOpportunityHourlySnapshot } from './analysisLogger';
import {
  calcNetSpreadPercent,
  DEFAULT_CONFIRMED_SNIPE_CONFIG,
  MAX_ROUND_TRIP_IMPACT_BPS,
  TARGET_IMPACT_BPS,
  MAX_FUNDING_TIMESTAMP_DIFF_MS,
  MIN_FREE_MARGIN_PCT,
  SUPPORTED_EXCHANGES,
  HEDGE_RATIO_MIN,
  HEDGE_RATIO_MAX,
  getResolvedTimingConfig,
  sanitizeEnabledExchanges,
  sanitizeFeeOverrides,
  sanitizePaybackOverrides,
  sanitizeTimingConfig,
  MIN_PROFIT_USD,
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
import { getSchedulerRuntimeIdentity, getTradeWindowDiagnostics } from './runtimeDiagnostics';
import {
  getActiveLiveFundingTimeDriftMs,
  getRelaxGuardsFlags,
  isAcceptableFundingShift,
  MAX_DEFERRALS_PER_ENTRY,
  ORDERBOOK_BACKOFF_DELAYS_MS,
} from './relaxGuardsConfig';

const DATA_DIR = getDataDir();
const STATE_FILE = join(DATA_DIR, 'sim-scheduler-state.json');
const LOOP_INTERVAL_MS = 1_000;
const RATES_REFRESH_INTERVAL_MS = 3_000;
const TICK_STATE_PERSIST_INTERVAL_MS = 3_000;
const BASE_REVALIDATE_BATCH_SIZE = 3;
const URGENT_REVALIDATE_BATCH_SIZE = 12;
const URGENT_REVALIDATE_WINDOW_MS = 15_000;
const FINAL_REVALIDATE_GUARD_MS = 1_000;
/** Grace window to protect near-due entries from being dropped by rebuildSchedules */
const NEAR_DUE_GRACE_MS = 5_000;
/** Freeze near-due schedules to prevent profitable entries from being churn-canceled by frequent replans. */
const SCHEDULE_REPLAN_FREEZE_MS = 10 * 60 * 1000;
/** Preserve entries that became due while a refresh/rebuild tick was running. */
const OVERDUE_EXECUTION_KEEP_MS = 90_000;
/** Keep previously profitable schedules alive until execution-time guards can revalidate them. */
const SCHEDULE_STICKY_KEEP_MS = 8 * 60 * 60 * 1000;
/** Keep scheduled entries alive until their target time; final execution guards decide. */
const EXECUTABLE_REVALIDATE_CANCEL_WINDOW_MS = 0;
/** Tiny tolerance for boundary noise on entry-gap drift checks. */
const ENTRY_GAP_TOLERANCE_PCT = 0.05;
const FULL_REVALIDATE_CAP = 20;
const PROBE_STATE_RETENTION_MS = 2 * 60 * 60 * 1000;
const FUNDING_UNIVERSE_CACHE_TTL_MS = 60 * 60 * 1000;
const FULL_FUNDING_REFRESH_INTERVAL_MS = 30 * 1000;
const LIVE_FUNDING_TIME_DRIFT_MS = 60_000;
const FAST_SYMBOL_CAP_PER_EXCHANGE = 240;
const FAST_SYMBOL_MIN_PER_EXCHANGE = 80;
const FAST_SYMBOL_CAP_BY_EXCHANGE: Partial<Record<ExchangeId, number>> = {
  bitget: 80,
};
const FAST_SYMBOL_MIN_BY_EXCHANGE: Partial<Record<ExchangeId, number>> = {
  bitget: 30,
};
const FAST_OPPORTUNITY_SEED_COUNT = 160;
const MAX_FUNDING_HISTORY = 500;
const TRANSIENT_FETCH_RETRY_ATTEMPTS = 2;
const TRANSIENT_FETCH_RETRY_DELAY_MS = 120;
const WS_WARM_INTERVAL_MS = 15_000;
const MIN_EV_ALLOCATION_USDT = 1;
const MIN_EV_ALLOCATION_FRACTION = 0.002;
const MIN_EXECUTABLE_NOTIONAL_USDT = 10;
const EXECUTION_EMERGENCY_MIN_ALLOCATION_USDT = 1;
const EMERGENCY_FALLBACK_SCALE_MIN = 0.5;
const LIVE_SPREAD_NEGATIVE_TOLERANCE_PCT = -0.03;
const SIM_LIVE_SPREAD_NEGATIVE_TOLERANCE_PCT = -0.2;
const SIM_EXECUTION_MIN_EV_FLOOR_USD = -0.2;
const MAX_NEGATIVE_EV_RATIO = 0.03;
const MAX_NEGATIVE_EV_USD = 0.5;
const MIN_NEGATIVE_EV_USD = 0.01;
const LIQUIDITY_SIZING_CANDIDATE_CAP = 200;
const PROFITABLE_SIZING_SEARCH_STEPS = 16;
const FUNDING_REVALIDATE_CACHE_MAX_AGE_MS = 15_000;
const FUNDING_REVALIDATE_STALE_FALLBACK_MS = 60_000;
const FUNDING_REVALIDATE_ATTEMPTS = 4;
const FUNDING_REVALIDATE_RETRY_DELAY_MS = 350;
const TRANSIENT_DATA_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /network/i,
  /socket/i,
  /fetch failed/i,
  /temporar/i,
  /429/,
  /rate limit/i,
  /too many requests/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /5\d{2}/,
];

function getFastSymbolCap(exchange: ExchangeId): number {
  return FAST_SYMBOL_CAP_BY_EXCHANGE[exchange] ?? FAST_SYMBOL_CAP_PER_EXCHANGE;
}

function getFastSymbolMin(exchange: ExchangeId): number {
  return FAST_SYMBOL_MIN_BY_EXCHANGE[exchange] ?? FAST_SYMBOL_MIN_PER_EXCHANGE;
}

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

const POST_FUNDING_PROBE_POINTS = [
  { key: 'post_funding_1s', thresholdMs: 1_000 },
  { key: 'post_funding_5s', thresholdMs: 5_000 },
  { key: 'post_funding_7s', thresholdMs: 7_000 },
  { key: 'post_funding_10s', thresholdMs: 10_000 },
  { key: 'post_funding_15s', thresholdMs: 15_000 },
  { key: 'post_funding_20s', thresholdMs: 20_000 },
  { key: 'post_funding_25s', thresholdMs: 25_000 },
  { key: 'post_funding_30s', thresholdMs: 30_000 },
] as const;
const PROBE_ORDERBOOK_DEPTH = 5;
const ANALYTICS_BASE_INTERVAL_MS = 5 * 60 * 1000;
const ANALYTICS_NEAR_DUE_INTERVAL_MS = 60 * 1000;
const ANALYTICS_NEAR_DUE_WINDOW_MS = 30 * 60 * 1000;
const ANALYTICS_MAX_CANDIDATES = 800;
const MIN_BASIS_CONVERGENCE_RESERVE_BPS = 1;
const MAX_BASIS_CONVERGENCE_RESERVE_BPS = 200;
const UNKNOWN_VOLUME_RESERVE_BPS = 1;
const MAX_VOLUME_LIQUIDITY_RESERVE_BPS = 30;
const STALE_DATA_PENALTY_BPS = 2;

function formatSignedUsd(value: number, digits = 4): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(digits)}`;
}

function formatSignedPercent(value: number, digits = 4): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

function formatPersistenceTelegramNote(events: TradeEvent[], pairId?: string): string | undefined {
  const event = events.find((candidate) => (
    pairId ? candidate.pairId === pairId : candidate.eventId
  )) ?? events[0];
  if (!event) return undefined;
  return [
    event.eventId ? `eventId: ${event.eventId}` : null,
    event.engineId ? `engineId: ${event.engineId}` : null,
    event.persistedTradeFile ? `tradeFile: ${event.persistedTradeFile}` : null,
    event.persistedExecutedFile ? `executedFile: ${event.persistedExecutedFile}` : null,
    event.persistedFundingReceiptFile ? `fundingReceiptFile: ${event.persistedFundingReceiptFile}` : null,
  ].filter(Boolean).join('\n') || undefined;
}

function sumDepthUsd(levels: number[][] | undefined, depth: number): number {
  if (!levels?.length || depth <= 0) return 0;
  return levels.slice(0, depth).reduce((sum, [price, qty]) => {
    const levelPrice = Number(price);
    const levelQty = Number(qty);
    if (!Number.isFinite(levelPrice) || !Number.isFinite(levelQty)) return sum;
    return sum + (levelPrice * levelQty);
  }, 0);
}

function calcBookSpreadBps(bid: number, ask: number): number {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return 0;
  const mid = (bid + ask) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return 0;
  return ((ask - bid) / mid) * 10000;
}

function getMinExecutableAllocationUSDT(
  investmentUSDT: number,
  leverage: number,
): number {
  const leverageFloor = Math.max(1, leverage);
  return Math.min(
    Math.max(
      MIN_EV_ALLOCATION_USDT,
      MIN_EXECUTABLE_NOTIONAL_USDT / leverageFloor,
      investmentUSDT * MIN_EV_ALLOCATION_FRACTION,
    ),
    Math.max(MIN_EV_ALLOCATION_USDT, investmentUSDT),
  );
}

function getAcceptableNetEvFloor(investmentUSDT: number): number {
  const scaledFloor = Math.abs(investmentUSDT) * MAX_NEGATIVE_EV_RATIO;
  return -Math.max(
    MIN_NEGATIVE_EV_USD,
    Math.min(scaledFloor, MAX_NEGATIVE_EV_USD),
  );
}

function getSpreadAcceptanceThreshold(minSpreadPercent: number): number {
  if (!Number.isFinite(minSpreadPercent) || minSpreadPercent <= 0) {
    return LIVE_SPREAD_NEGATIVE_TOLERANCE_PCT;
  }
  return minSpreadPercent;
}

function calcBasisBps(shortMid: number, longMid: number): number {
  if (!Number.isFinite(shortMid) || !Number.isFinite(longMid) || shortMid <= 0 || longMid <= 0) return 0;
  const reference = (shortMid + longMid) / 2;
  if (!Number.isFinite(reference) || reference <= 0) return 0;
  return ((shortMid - longMid) / reference) * 10000;
}

function clampBps(value: number, minBps: number, maxBps: number): number {
  if (!Number.isFinite(value)) return minBps;
  return Math.max(minBps, Math.min(maxBps, value));
}

function basisReservePctFromBasisRisk(params: {
  entryGapDriftPercent?: number;
  entryGapPercent?: number;
  basisMoveBps?: number;
  basisBps?: number;
}): number {
  const bpsCandidates = [
    MIN_BASIS_CONVERGENCE_RESERVE_BPS,
    Number.isFinite(params.entryGapDriftPercent ?? Number.NaN)
      ? Math.abs(params.entryGapDriftPercent as number) * 100
      : 0,
    Number.isFinite(params.entryGapPercent ?? Number.NaN)
      ? Math.abs(params.entryGapPercent as number) * 100
      : 0,
    Number.isFinite(params.basisMoveBps ?? Number.NaN)
      ? Math.abs(params.basisMoveBps as number)
      : 0,
    Number.isFinite(params.basisBps ?? Number.NaN)
      ? Math.abs(params.basisBps as number)
      : 0,
  ];

  return clampBps(
    Math.max(...bpsCandidates),
    MIN_BASIS_CONVERGENCE_RESERVE_BPS,
    MAX_BASIS_CONVERGENCE_RESERVE_BPS,
  ) / 10000;
}

function basisReservePctFromEntryGap(entryGapDriftPercent: number, entryGapPercent = 0, basisBps?: number): number {
  return basisReservePctFromBasisRisk({ entryGapDriftPercent, entryGapPercent, basisBps });
}

function volumeLiquidityReservePct(params: {
  notionalUSDT: number;
  shortQuoteVolume24h?: number;
  longQuoteVolume24h?: number;
  marketSnapshot?: ProbeMarketSnapshot;
}): number {
  const { notionalUSDT, shortQuoteVolume24h, longQuoteVolume24h, marketSnapshot } = params;
  if (!Number.isFinite(notionalUSDT) || notionalUSDT <= 0) return 0;

  let reserveBps = 0;
  const knownVolumes = [shortQuoteVolume24h, longQuoteVolume24h]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (knownVolumes.length < 2) {
    reserveBps += UNKNOWN_VOLUME_RESERVE_BPS;
  } else {
    const minVolume = Math.min(...knownVolumes);
    const participation = notionalUSDT / minVolume;
    reserveBps += Math.min(40, participation * 20_000);
  }

  if (marketSnapshot) {
    const minCapacity = Math.min(marketSnapshot.entryCapacityUsd5, marketSnapshot.exitCapacityUsd5);
    if (Number.isFinite(minCapacity) && minCapacity > 0) {
      const capacityRatio = minCapacity / notionalUSDT;
      if (capacityRatio < 2) {
        reserveBps += (2 - capacityRatio) * 12;
      }
    } else {
      reserveBps += 20;
    }
  }

  return Math.min(MAX_VOLUME_LIQUIDITY_RESERVE_BPS, Math.max(0, reserveBps)) / 10000;
}

function calcMoveBps(current: number, baseline: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || current <= 0 || baseline <= 0) return 0;
  return ((current - baseline) / baseline) * 10000;
}

function calcDepthImbalance(bidDepthUsd: number, askDepthUsd: number): number {
  if (!Number.isFinite(bidDepthUsd) || !Number.isFinite(askDepthUsd)) return 0;
  const total = bidDepthUsd + askDepthUsd;
  if (total <= 0) return 0;
  return (bidDepthUsd - askDepthUsd) / total;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown';
}

function isLikelyTransientDataError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return TRANSIENT_DATA_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

async function retryTransientFetch<T>(
  task: () => Promise<T>,
  attempts = TRANSIENT_FETCH_RETRY_ATTEMPTS,
  delayMs = TRANSIENT_FETCH_RETRY_DELAY_MS,
): Promise<T> {
  let lastError: unknown;
  const safeAttempts = Math.max(1, attempts);
  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const hasNext = attempt < safeAttempts - 1;
      if (!hasNext || !isLikelyTransientDataError(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs * (attempt + 1));
      });
    }
  }
  throw lastError ?? new Error('transient fetch retry exhausted');
}

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
    maxSlippagePercent: config.maxSlippagePercent,
    minVolume24hUSD: config.minVolume24hUSD,
    confirmedSnipeConfig: config.confirmedSnipeConfig,
  };
}

function mapSimEntryErrorToGuardReason(error?: string): string {
  const normalized = (error ?? '').toLowerCase();
  if (normalized.includes('funding revalidate missing')) return 'funding_revalidate_missing';
  if (normalized.includes('live spread revalidate')) return 'live_spread_reverted';
  if (normalized.includes('funding window shift')) return 'funding_window_shifted';
  if (normalized.includes('funding timestamp mismatch')) return 'funding_timestamp_mismatch';
  if (normalized.includes('runtime fee unavailable')) return 'fee_cache_unavailable';
  if (normalized.includes('funding revalidate error')) return 'funding_revalidate_failed';
  if (normalized.includes('no profitable executable size')) return 'orderbook_ev_negative';
  if (normalized.includes('no acceptable executable size')) return 'orderbook_ev_negative';
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

function getFallbackImpactPercent(config: Pick<StrategyConfig, 'maxSlippagePercent' | 'confirmedSnipeConfig'>): number {
  const snipeConfig = config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
  if (snipeConfig.useImpactGuards) {
    const maxRoundTripImpactBps = snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS;
    // round-trip bps -> per-event (entry/exit) percent
    return maxRoundTripImpactBps / 200;
  }
  // When impact guards are off, use target impact (expected), not max slippage cap.
  // bps -> percent (1bps = 0.01%)
  return (snipeConfig.targetImpactBps ?? TARGET_IMPACT_BPS) / 100;
}

function estimatePreEntryConservativeEV(
  opportunity: ArbitrageOpportunity,
  config: Pick<
    StrategyConfig,
    'investmentUSDT' | 'leverage' | 'feeOverrides' | 'paybackOverrides' | 'maxSlippagePercent' | 'confirmedSnipeConfig'
  >,
  investmentUSDT = config.investmentUSDT,
) {
  const notional = investmentUSDT * config.leverage;
  if (!Number.isFinite(notional) || notional <= 0) return null;

  const shortFeeRate = resolveRuntimeFee(
    opportunity.shortExchange,
    'taker',
    config.feeOverrides,
    config.paybackOverrides,
  );
  const longFeeRate = resolveRuntimeFee(
    opportunity.longExchange,
    'taker',
    config.feeOverrides,
    config.paybackOverrides,
  );
  const roundTripFeeDec = (shortFeeRate + longFeeRate) * 2;

  const snipeConfig = config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
  const usesInstantRate = pairUsesInstantaneousRate(opportunity.shortExchange, opportunity.longExchange);
  const shortDrift = snipeConfig.useDriftBuffer
    ? calcDriftBuffer(opportunity.shortRate, undefined, usesInstantRate)
    : 0;
  const longDrift = snipeConfig.useDriftBuffer
    ? calcDriftBuffer(opportunity.longRate, undefined, usesInstantRate)
    : 0;
  const impactDec = getFallbackImpactPercent(config) / 100;
  const markGap = getEntryGapMetrics({
    shortPrice: opportunity.shortMarkPrice,
    longPrice: opportunity.longMarkPrice,
  });

  return calcConservativeEV(
    notional,
    opportunity.shortRate,
    opportunity.longRate,
    shortDrift,
    longDrift,
    roundTripFeeDec,
    impactDec,
    impactDec,
    {
      basisConvergenceReservePct: basisReservePctFromEntryGap(0, markGap.liveGapPercent),
      volumeLiquidityReservePct: UNKNOWN_VOLUME_RESERVE_BPS / 10000,
    },
  );
}

function calcExpectedRoiPercent(expectedNetProfit: number, investmentUSDT: number, leverage: number): number {
  if (!Number.isFinite(expectedNetProfit) || investmentUSDT <= 0 || leverage <= 0) return 0;
  return (expectedNetProfit / (investmentUSDT * leverage)) * 100;
}

type OrderbookSnapshot = { bids: number[][]; asks: number[][] };

type ProfitableOrderbookSizing = {
  investmentUSDT: number;
  notionalUSDT: number;
  expectedNetUSD: number;
  expectedRoiPercent: number;
  evRatio: number;
  shortEntrySlippagePercent: number;
  longEntrySlippagePercent: number;
  shortExitSlippagePercent: number;
  longExitSlippagePercent: number;
  entryGapLivePercent: number;
  entryGapDriftPercent: number;
  marketSnapshot?: ProbeMarketSnapshot;
  ev: ConservativeEVResult;
};

type LiquiditySizedCandidate = {
  opportunity: ArbitrageOpportunity;
  shortBook: OrderbookSnapshot;
  longBook: OrderbookSnapshot;
  sizing: ProfitableOrderbookSizing;
  score: number;
};

function getOrderbookMid(book: OrderbookSnapshot): number | null {
  const findFirstPositivePrice = (levels?: number[][]): number | null => {
    if (!levels?.length) return null;
    for (const level of levels) {
      const price = Number(level?.[0]);
      if (Number.isFinite(price) && price > 0) return price;
    }
    return null;
  };

  const bid = findFirstPositivePrice(book.bids);
  const ask = findFirstPositivePrice(book.asks);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || (bid as number) <= 0 || (ask as number) <= 0) return null;
  return ((bid as number) + (ask as number)) / 2;
}

function getOrderbookFill(
  book: OrderbookSnapshot,
  side: 'buy' | 'sell',
  notionalUSDT: number,
) {
  const midPrice = getOrderbookMid(book);
  if (!midPrice || !Number.isFinite(notionalUSDT) || notionalUSDT <= 0) return null;
  const analysis = analyzeOrderbook(side === 'buy' ? book.asks : book.bids, notionalUSDT, side);
  const rawSlippage = side === 'buy'
    ? (analysis.fillPrice - midPrice) / midPrice
    : (midPrice - analysis.fillPrice) / midPrice;
  return {
    fillPrice: analysis.fillPrice,
    worstPrice: analysis.worstPrice,
    midPrice,
    slippagePercent: Math.max(0, rawSlippage * 100),
  };
}

function buildMarketSnapshotFromOrderbooks(
  shortBook: OrderbookSnapshot,
  longBook: OrderbookSnapshot,
  notionalUSDT: number,
): ProbeMarketSnapshot | undefined {
  const shortBid = shortBook.bids?.[0]?.[0];
  const shortAsk = shortBook.asks?.[0]?.[0];
  const longBid = longBook.bids?.[0]?.[0];
  const longAsk = longBook.asks?.[0]?.[0];
  if (
    !Number.isFinite(shortBid)
    || !Number.isFinite(shortAsk)
    || !Number.isFinite(longBid)
    || !Number.isFinite(longAsk)
  ) {
    return undefined;
  }

  const shortMid = ((shortBid as number) + (shortAsk as number)) / 2;
  const longMid = ((longBid as number) + (longAsk as number)) / 2;
  const shortBidDepthUsd5 = sumDepthUsd(shortBook.bids, PROBE_ORDERBOOK_DEPTH);
  const shortAskDepthUsd5 = sumDepthUsd(shortBook.asks, PROBE_ORDERBOOK_DEPTH);
  const longBidDepthUsd5 = sumDepthUsd(longBook.bids, PROBE_ORDERBOOK_DEPTH);
  const longAskDepthUsd5 = sumDepthUsd(longBook.asks, PROBE_ORDERBOOK_DEPTH);
  const shortImpactBps = notionalUSDT > 0
    ? calcOrderbookImpactBps(shortBook.bids, shortBook.asks, notionalUSDT, 'sell').impactBps
    : 0;
  const longImpactBps = notionalUSDT > 0
    ? calcOrderbookImpactBps(longBook.bids, longBook.asks, notionalUSDT, 'buy').impactBps
    : 0;

  return {
    shortBid: shortBid as number,
    shortAsk: shortAsk as number,
    shortMid,
    shortSpreadBps: calcBookSpreadBps(shortBid as number, shortAsk as number),
    shortBidDepthUsd5,
    shortAskDepthUsd5,
    shortImbalance: calcDepthImbalance(shortBidDepthUsd5, shortAskDepthUsd5),
    shortImpactBps,
    longBid: longBid as number,
    longAsk: longAsk as number,
    longMid,
    longSpreadBps: calcBookSpreadBps(longBid as number, longAsk as number),
    longBidDepthUsd5,
    longAskDepthUsd5,
    longImbalance: calcDepthImbalance(longBidDepthUsd5, longAskDepthUsd5),
    longImpactBps,
    basisBps: calcBasisBps(shortMid, longMid),
    entryCapacityUsd5: Math.min(shortBidDepthUsd5, longAskDepthUsd5),
    exitCapacityUsd5: Math.min(shortAskDepthUsd5, longBidDepthUsd5),
  };
}

function evaluateOrderbookSizing(
  opportunity: ArbitrageOpportunity,
  strategyConfig: Pick<
    StrategyConfig,
    'investmentUSDT' | 'leverage' | 'feeOverrides' | 'paybackOverrides' | 'maxSlippagePercent' | 'confirmedSnipeConfig'
  >,
  investmentUSDT: number,
  shortBook: OrderbookSnapshot,
  longBook: OrderbookSnapshot,
  rates?: { shortRate?: number; longRate?: number },
): ProfitableOrderbookSizing | null {
  const notionalUSDT = investmentUSDT * strategyConfig.leverage;
  if (!Number.isFinite(notionalUSDT) || notionalUSDT <= 0) return null;

  const shortEntry = getOrderbookFill(shortBook, 'sell', notionalUSDT);
  const longEntry = getOrderbookFill(longBook, 'buy', notionalUSDT);
  const shortExit = getOrderbookFill(shortBook, 'buy', notionalUSDT);
  const longExit = getOrderbookFill(longBook, 'sell', notionalUSDT);
  if (!shortEntry || !longEntry || !shortExit || !longExit) return null;

  const entryGap = getEntryGapMetrics({
    shortPrice: shortEntry.fillPrice,
    longPrice: longEntry.fillPrice,
    baselineShortPrice: opportunity.shortMarkPrice,
    baselineLongPrice: opportunity.longMarkPrice,
  });
  const marketSnapshot = buildMarketSnapshotFromOrderbooks(shortBook, longBook, notionalUSDT);
  const snipeConfig = strategyConfig.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
  const usesInstantRate = pairUsesInstantaneousRate(
    opportunity.shortExchange,
    opportunity.longExchange,
  );
  const shortRate = rates?.shortRate ?? opportunity.shortRate;
  const longRate = rates?.longRate ?? opportunity.longRate;
  const shortDrift = snipeConfig.useDriftBuffer
    ? calcDriftBuffer(shortRate, undefined, usesInstantRate)
    : 0;
  const longDrift = snipeConfig.useDriftBuffer
    ? calcDriftBuffer(longRate, undefined, usesInstantRate)
    : 0;
  const shortFeeRate = resolveRuntimeFee(
    opportunity.shortExchange,
    'taker',
    strategyConfig.feeOverrides,
    strategyConfig.paybackOverrides,
  );
  const longFeeRate = resolveRuntimeFee(
    opportunity.longExchange,
    'taker',
    strategyConfig.feeOverrides,
    strategyConfig.paybackOverrides,
  );
  const ev = calcConservativeEV(
    notionalUSDT,
    shortRate,
    longRate,
    shortDrift,
    longDrift,
    (shortFeeRate + longFeeRate) * 2,
    (shortEntry.slippagePercent + longEntry.slippagePercent) / 100,
    (shortExit.slippagePercent + longExit.slippagePercent) / 100,
    {
      basisConvergenceReservePct: basisReservePctFromEntryGap(
        entryGap.driftPercent,
        entryGap.liveGapPercent,
        marketSnapshot?.basisBps,
      ),
      volumeLiquidityReservePct: volumeLiquidityReservePct({
        notionalUSDT,
        marketSnapshot,
      }),
    },
  );

  return {
    investmentUSDT,
    notionalUSDT,
    expectedNetUSD: ev.expectedNetUSD,
    expectedRoiPercent: calcExpectedRoiPercent(ev.expectedNetUSD, investmentUSDT, strategyConfig.leverage),
    evRatio: ev.evRatio,
    shortEntrySlippagePercent: shortEntry.slippagePercent,
    longEntrySlippagePercent: longEntry.slippagePercent,
    shortExitSlippagePercent: shortExit.slippagePercent,
    longExitSlippagePercent: longExit.slippagePercent,
    entryGapLivePercent: entryGap.liveGapPercent,
    entryGapDriftPercent: entryGap.driftPercent,
    marketSnapshot,
    ev,
  };
}

function findMaxProfitableOrderbookSizing(
  opportunity: ArbitrageOpportunity,
  strategyConfig: Pick<
    StrategyConfig,
    'investmentUSDT' | 'leverage' | 'feeOverrides' | 'paybackOverrides' | 'maxSlippagePercent' | 'confirmedSnipeConfig'
  >,
  maxInvestmentUSDT: number,
  minInvestmentUSDT: number,
  shortBook: OrderbookSnapshot,
  longBook: OrderbookSnapshot,
  rates?: { shortRate?: number; longRate?: number },
  minExpectedNetUSD = 0,
): ProfitableOrderbookSizing | null {
  const maxInvestment = Math.max(0, maxInvestmentUSDT);
  const minInvestment = Math.max(0, Math.min(minInvestmentUSDT, maxInvestment));
  if (maxInvestment <= 0 || minInvestment <= 0) return null;

  const minSizing = evaluateOrderbookSizing(
    opportunity,
    strategyConfig,
    minInvestment,
    shortBook,
    longBook,
    rates,
  );
  const maxSizing = evaluateOrderbookSizing(
    opportunity,
    strategyConfig,
    maxInvestment,
    shortBook,
    longBook,
    rates,
  );
  const maxSizingPass = maxSizing && maxSizing.expectedNetUSD >= minExpectedNetUSD;
  if (maxSizingPass) return maxSizing;

  let best: ProfitableOrderbookSizing | null = maxSizingPass ? maxSizing : (minSizing ?? null);
  let low = minInvestment;
  let high = maxInvestment;
  for (let attempt = 0; attempt < PROFITABLE_SIZING_SEARCH_STEPS; attempt += 1) {
    const mid = (low + high) / 2;
    const sizing = evaluateOrderbookSizing(
      opportunity,
      strategyConfig,
      mid,
      shortBook,
      longBook,
      rates,
    );
    if (sizing && sizing.expectedNetUSD >= minExpectedNetUSD) {
      best = sizing;
      low = mid;
    } else {
      high = mid;
    }
  }
  if (!best || best.expectedNetUSD < minExpectedNetUSD) return null;
  return best;
}

function findMaxProfitableOrderbookSizingSafe(
  opportunity: ArbitrageOpportunity,
  strategyConfig: Pick<
    StrategyConfig,
    'investmentUSDT' | 'leverage' | 'feeOverrides' | 'paybackOverrides' | 'maxSlippagePercent' | 'confirmedSnipeConfig'
  >,
  maxInvestmentUSDT: number,
  minInvestmentUSDT: number,
  shortBook: OrderbookSnapshot,
  longBook: OrderbookSnapshot,
  rates?: { shortRate?: number; longRate?: number },
  minExpectedNetUSD = 0,
) {
  const safeMax = Math.max(0, maxInvestmentUSDT);
  const safeMin = Math.max(0, Math.min(minInvestmentUSDT, safeMax));
  if (safeMin <= 0 || safeMax <= 0) return null;
  return findMaxProfitableOrderbookSizing(
    opportunity,
    strategyConfig,
    safeMax,
    safeMin,
    shortBook,
    longBook,
    rates,
    minExpectedNetUSD ?? getAcceptableNetEvFloor(safeMax),
  );
}

function getDynamicSizingEmergencyStart(
  requestedMargin: number,
  leverage: number,
  maxDynamicInvestment: number,
): number {
  const safeLeverage = Math.max(1, leverage);
  const emergencyMinByNotional = MIN_EXECUTABLE_NOTIONAL_USDT / safeLeverage;
  const emergencyFloor = Math.max(
    EXECUTION_EMERGENCY_MIN_ALLOCATION_USDT,
    Math.min(
      maxDynamicInvestment,
      Math.max(EMERGENCY_FALLBACK_SCALE_MIN, emergencyMinByNotional),
    ),
  );
  if (maxDynamicInvestment <= 0) return 0;
  return Math.min(emergencyFloor, maxDynamicInvestment);
}

function buildVolumeByExchangeAsset(rates: FundingRate[]): Map<string, number> {
  const volumeByExchangeAsset = new Map<string, number>();
  for (const rate of rates) {
    if (typeof rate.quoteVolume24h !== 'number' || !Number.isFinite(rate.quoteVolume24h)) continue;
    volumeByExchangeAsset.set(`${rate.exchange}:${rate.baseAsset}`, rate.quoteVolume24h);
  }
  return volumeByExchangeAsset;
}

function resolveOpportunityVolumeStatus(
  opportunity: ArbitrageOpportunity,
  minVolume24hUSD: number,
  volumeByExchangeAsset: Map<string, number>,
) {
  const shortQuoteVolume24h = volumeByExchangeAsset.get(`${opportunity.shortExchange}:${opportunity.baseAsset}`);
  const longQuoteVolume24h = volumeByExchangeAsset.get(`${opportunity.longExchange}:${opportunity.baseAsset}`);
  const belowMin = minVolume24hUSD > 0 && (
    (shortQuoteVolume24h !== undefined && shortQuoteVolume24h < minVolume24hUSD)
    || (longQuoteVolume24h !== undefined && longQuoteVolume24h < minVolume24hUSD)
  );
  return {
    shortQuoteVolume24h,
    longQuoteVolume24h,
    belowMin,
  };
}

function getOpportunityYieldScore(
  opportunity: ArbitrageOpportunity,
  strategyConfig: StrategyConfig,
  investmentUSDT?: number,
): number {
  const evaluationInvestment = Math.max(0, Math.min(strategyConfig.investmentUSDT, investmentUSDT ?? strategyConfig.investmentUSDT));
  const ev = estimatePreEntryConservativeEV(opportunity, strategyConfig, evaluationInvestment);
  if (!ev) return 0;
  const intervalHours = Math.max(1, getOpportunityIntervalHours(opportunity));
  if (ev.expectedNetUSD <= 0) return 0;
  const roiPerMargin = ev.expectedNetUSD / Math.max(1, evaluationInvestment);
  return Math.max(0, (ev.expectedNetUSD * Math.max(0.01, ev.evRatio) * (1 + roiPerMargin)) / intervalHours);
}

function passesPreEntryEVAtAllocation(
  opportunity: ArbitrageOpportunity,
  strategyConfig: StrategyConfig,
  investmentUSDT: number,
): ConservativeEVResult | null {
  const ev = estimatePreEntryConservativeEV(opportunity, strategyConfig, investmentUSDT);
  if (!ev) return null;
  return ev;
}

async function planWindowAllocations(
  opportunities: ArbitrageOpportunity[],
  availableBalance: Record<string, number>,
  strategyConfig: StrategyConfig,
  planningBalance?: Record<string, number>,
  balancePlan?: BalanceEqualizationPlan,
): Promise<Array<{ opportunity: ArbitrageOpportunity; investmentUSDT: number; sizing?: ProfitableOrderbookSizing }>> {
  const effectiveBalance = planningBalance ? { ...planningBalance } : availableBalance;
  const probeAllocation = getMinExecutableAllocationUSDT(strategyConfig.investmentUSDT, strategyConfig.leverage);
  const baseCandidates = opportunities
    .map((opportunity) => ({
      opportunity,
      preScore: getOpportunityYieldScore(opportunity, strategyConfig, probeAllocation)
        * getOpportunityBalanceEqualizationMultiplier(balancePlan, opportunity),
    }))
    .filter((candidate) => candidate.preScore > 0)
    .sort((a, b) => {
      if (b.preScore !== a.preScore) return b.preScore - a.preScore;
      return a.opportunity.nextFundingTime - b.opportunity.nextFundingTime;
    });

  const selectedForSizing = baseCandidates.slice(0, LIQUIDITY_SIZING_CANDIDATE_CAP);

  const minAllocation = probeAllocation;
  const getCostFactor = (exchange: ExchangeId) => (
    1 + (strategyConfig.leverage * resolveRuntimeFee(
      exchange,
      'taker',
      strategyConfig.feeOverrides,
      strategyConfig.paybackOverrides,
    ))
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

  const sizedCandidateResults: Array<LiquiditySizedCandidate | null> = await Promise.all(
    selectedForSizing.map(async (candidate): Promise<LiquiditySizedCandidate | null> => {
    const maxInvestment = Math.min(getCap(candidate.opportunity), strategyConfig.investmentUSDT);
    if (maxInvestment < minAllocation) return null;
    try {
      const [shortBook, longBook] = await retryTransientFetch(() => Promise.all([
        fetchOrderbook(candidate.opportunity.shortExchange, candidate.opportunity.shortSymbol, 50),
        fetchOrderbook(candidate.opportunity.longExchange, candidate.opportunity.longSymbol, 50),
      ]));
      const sizing = findMaxProfitableOrderbookSizing(
        candidate.opportunity,
        strategyConfig,
        maxInvestment,
        minAllocation,
        shortBook,
        longBook,
        undefined,
        getAcceptableNetEvFloor(minAllocation),
      );
      if (!sizing || sizing.notionalUSDT < probeAllocation * strategyConfig.leverage) return null;
      const intervalHours = Math.max(1, getOpportunityIntervalHours(candidate.opportunity));
      const roiBoost = 1 + Math.max(0, sizing.expectedNetUSD / Math.max(1, sizing.investmentUSDT));
      const scoringFloor = getAcceptableNetEvFloor(sizing.investmentUSDT);
      const scoringEv = Math.max(0, sizing.expectedNetUSD - scoringFloor);
      return {
        opportunity: candidate.opportunity,
        shortBook,
        longBook,
        sizing,
        score: (scoringEv
          * Math.max(0.01, sizing.evRatio) * roiBoost / intervalHours)
          * getOpportunityBalanceEqualizationMultiplier(balancePlan, candidate.opportunity),
      };
    } catch {
      return null;
    }
    }),
  );
  const sizedCandidatesRaw = sizedCandidateResults
    .filter((candidate): candidate is LiquiditySizedCandidate => (
      !!candidate && candidate.score >= 0 && candidate.sizing.investmentUSDT >= minAllocation
    ))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.opportunity.nextFundingTime - b.opportunity.nextFundingTime;
    });

  const sizedOccupiedLegs = new Set<string>();
  const sizedCandidates = sizedCandidatesRaw.filter((candidate) => {
    const legKeys = getOpportunityLegKeys(candidate.opportunity);
    if (legKeys.some((legKey) => sizedOccupiedLegs.has(legKey))) return false;
    legKeys.forEach((legKey) => sizedOccupiedLegs.add(legKey));
    return true;
  });

  if (sizedCandidates.length === 0) return [];

  const allocations = new Map<string, number>();
  const assetWindowAllocations = new Map<string, number>();
  const allocationStep = Math.max(
    minAllocation,
    1,
  );
  const assetWindowCap = Math.max(minAllocation, strategyConfig.investmentUSDT);
  const getAssetWindowKey = (opportunity: ArbitrageOpportunity) =>
    `${opportunity.baseAsset}:${getOpportunityTimeGroupKey(opportunity.nextFundingTime)}`;

  let totalAllocated = 0;
  while (true) {
    const eligible = sizedCandidates.filter((candidate) => {
      const opportunity = candidate.opportunity;
      const allocated = allocations.get(getOpportunityId(opportunity)) ?? 0;
      const groupAllocated = assetWindowAllocations.get(getAssetWindowKey(opportunity)) ?? 0;
      const remainingCap = Math.min(
        getCap(opportunity) - allocated,
        candidate.sizing.investmentUSDT - allocated,
        assetWindowCap - groupAllocated,
      );
      if (remainingCap < minAllocation) return false;
      const nextInvestment = allocated + Math.min(allocationStep, remainingCap);
      const acceptableEvFloor = getAcceptableNetEvFloor(nextInvestment);
      return (evaluateOrderbookSizing(
        opportunity,
        strategyConfig,
        nextInvestment,
        candidate.shortBook,
        candidate.longBook,
      )?.expectedNetUSD ?? 0) >= acceptableEvFloor;
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
    const assetWindowKey = getAssetWindowKey(opportunity);
    const allocated = allocations.get(opportunityId) ?? 0;
    const groupAllocated = assetWindowAllocations.get(assetWindowKey) ?? 0;
    const shortAvail = availableBalance[opportunity.shortExchange] ?? 0;
    const longAvail = availableBalance[opportunity.longExchange] ?? 0;
    const effectiveShortAvail = effectiveBalance[opportunity.shortExchange] ?? 0;
    const effectiveLongAvail = effectiveBalance[opportunity.longExchange] ?? 0;
    const shortFactor = getCostFactor(opportunity.shortExchange);
    const longFactor = getCostFactor(opportunity.longExchange);
    const chunk = Math.min(
      allocationStep,
      getCap(opportunity) - allocated,
      bestCandidate.sizing.investmentUSDT - allocated,
      assetWindowCap - groupAllocated,
    );

    if (chunk < minAllocation) break;

    const shortCost = chunk * shortFactor;
    const longCost = chunk * longFactor;
    allocations.set(opportunityId, allocated + chunk);
    assetWindowAllocations.set(assetWindowKey, groupAllocated + chunk);
    availableBalance[opportunity.shortExchange] = Math.max(0, shortAvail - shortCost);
    availableBalance[opportunity.longExchange] = Math.max(0, longAvail - longCost);
    effectiveBalance[opportunity.shortExchange] = Math.max(0, effectiveShortAvail - shortCost);
    effectiveBalance[opportunity.longExchange] = Math.max(0, effectiveLongAvail - longCost);
    totalAllocated += chunk;
  }

  return sizedCandidates
    .map((candidate) => ({
      opportunity: candidate.opportunity,
      investmentUSDT: allocations.get(getOpportunityId(candidate.opportunity)) ?? 0,
      sizing: candidate.sizing,
    }))
    .filter((candidate) => (
      candidate.investmentUSDT >= minAllocation
      && candidate.sizing.expectedNetUSD >= getAcceptableNetEvFloor(candidate.investmentUSDT)
      && candidate.investmentUSDT <= candidate.sizing.investmentUSDT + 0.0001
    ));
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
  maxSlippagePercent?: number; // maximum slippage percent (default 10%)
  minVolume24hUSD?: number; // minimum 24h volume in USD
  confirmedSnipeConfig?: ConfirmedSnipeConfig; // v2.1; undefined = all toggles OFF (profile timing & Tier C still apply)
}

interface ScheduledSimEntry {
  opportunityId: string;
  probeId: string;
  asset: string;
  opportunity: ArbitrageOpportunity;
  targetTime: number;
  investmentUSDT: number;
  /**
   * How many times this entry has been deferred to a future funding cycle by
   * the scenario-C orderbook fallback. Capped at MAX_DEFERRALS_PER_ENTRY so a
   * persistently broken symbol cannot loop forever. Optional for backwards
   * compat with persisted state from before the feature flag.
   */
  deferralCount?: number;
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
  postFundingMilestones: string[];
  executeCaptured: boolean;
  executeResultCaptured: boolean;
  status: 'scheduled' | 'executed' | 'failed' | 'canceled';
  executedAt?: number;
  fundingCapturedAt?: number;
  fundingBaseShortMid?: number;
  fundingBaseLongMid?: number;
  fundingBaseBasisBps?: number;
  finalizedAt?: number;
  pairId?: string;
  executedNotional?: number;
  lastReason?: string;
  lastShortRate?: number;
  lastLongRate?: number;
  lastShortSlippagePercent?: number;
  lastLongSlippagePercent?: number;
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

interface FundingUniverseCacheEntry {
  symbols: string[];
  updatedAt: number;
}

type SimTradeResult = {
  success: boolean;
  error?: string;
  state?: SimStateSnapshot;
  pairId?: string;
  executedNotional?: number;
  shortSlippagePercent?: number;
  longSlippagePercent?: number;
  analysis?: Record<string, unknown>;
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

type ProbeMarketSnapshot = {
  shortBid: number;
  shortAsk: number;
  shortMid: number;
  shortSpreadBps: number;
  shortBidDepthUsd5: number;
  shortAskDepthUsd5: number;
  shortImbalance: number;
  shortImpactBps: number;
  longBid: number;
  longAsk: number;
  longMid: number;
  longSpreadBps: number;
  longBidDepthUsd5: number;
  longAskDepthUsd5: number;
  longImbalance: number;
  longImpactBps: number;
  basisBps: number;
  entryCapacityUsd5: number;
  exitCapacityUsd5: number;
};

type PreparedSimCloseLeg = {
  position: SimPosition;
  exitPrice: number;
  exitMidPrice: number;
  exitWorstPrice: number;
  exitSlippagePercent: number;
  exitFee: number;
  pricePnl: number;
  actualFunding: number;
  fundingBalanceCredit: number;
  fundingPayment?: FundingPayment;
  fillSource: 'orderbook';
  fillCapturedAt: number;
};

type ExecutionFundingRateLookup = {
  rate: FundingRate;
  source: 'latest_rates_cache' | 'targeted_fetch' | 'targeted_cache' | 'latest_rates_stale_after_fetch_error' | 'targeted_cache_stale_after_fetch_error';
  ageMs?: number;
  fetchError?: string;
};

class ServerSimScheduler {
  private static instance: ServerSimScheduler | null = null;

  private active = false;
  // Aggressive SIM profile for broader funding-capture testing.
  private config: ServerSimSchedulerConfig = {
    investmentUSDT: 250,
    leverage: 17,
    minSpreadPercent: 0,
    compoundInvesting: true,
    enabledExchanges: [],
    timingConfig: getResolvedTimingConfig(),
    maxSlippagePercent: 4,
    minVolume24hUSD: 0,
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
  private fundingUniverseCache = new Map<ExchangeId, FundingUniverseCacheEntry>();
  private fundingRevalidateCache = new Map<string, { rate: FundingRate; fetchedAt: number }>();
  private lastFullFundingRefreshAt = 0;
  private lastStatePersistAt = 0;
  private lastAnalyticsSnapshotAt = 0;
  private lastWsWarmAt = 0;
  private lastFeeCacheRefresh = 0;

  private static FEE_CACHE_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

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

  private queueRefreshRatesAndPlans() {
    void this.enqueue(async () => {
      if (!this.active) return;
      await this.refreshRatesAndPlans();
    }).catch(() => {});
  }

  private normalizeConfig(config: ServerSimSchedulerConfig): ServerSimSchedulerConfig {
    return {
      ...config,
      enabledExchanges: sanitizeEnabledExchanges(config.enabledExchanges),
      feeOverrides: sanitizeFeeOverrides(config.feeOverrides),
      paybackOverrides: sanitizePaybackOverrides(config.paybackOverrides),
      timingConfig: getResolvedTimingConfig(sanitizeTimingConfig(config.timingConfig)),
      maxSlippagePercent: config.maxSlippagePercent ?? 1.5,
      minVolume24hUSD: config.minVolume24hUSD ?? 0,
      confirmedSnipeConfig: config.confirmedSnipeConfig,
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
    this.lastStatePersistAt = Date.now();
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
                postFundingMilestones: Array.isArray(state.postFundingMilestones) ? state.postFundingMilestones : [],
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

  private simBalancesChangedFromInitial(state: SimStateSnapshot): boolean {
    return SUPPORTED_EXCHANGES.some((exchange) => (
      Math.abs((state.simBalances[exchange] ?? 0) - (state.simInitialBalances[exchange] ?? 0)) > 0.0000001
    ));
  }

  private stateHasSessionData(state: SimStateSnapshot): boolean {
    return state.simPositions.length > 0
      || state.fundingHistory.length > 0
      || state.simTotalFundingEarned !== 0
      || state.simTotalTopUps !== 0
      || state.simTotalFees !== 0
      || state.simTotalClosedPnl !== 0
      || this.simBalancesChangedFromInitial(state);
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

  private getCurrentSimBalanceTotal(state: SimStateSnapshot): number {
    return Object.values(state.simBalances).reduce((sum, balance) => (
      sum + (Number.isFinite(balance) ? balance : 0)
    ), 0);
  }

  private notifySimTradeSuccess(args: {
    phase: '진입' | '청산' | '수동청산';
    baseAsset: string;
    investmentUSDT: number;
    netProfitUSD: number;
    roiPercent: number;
    currentTotalBalanceUSDT: number;
    pairId?: string;
    route?: string;
    fundingUSD?: number;
    pricePnlUSD?: number;
    feesUSD?: number;
    extraLine?: string;
  }) {
    const realized = args.phase !== '진입';
    let title = `[SIM]실체결 거래 청산[실현] ${args.baseAsset}`;
    if (args.phase === '진입') title = `[SIM]실체결 거래 진입[예상] ${args.baseAsset}`;
    if (args.phase === '수동청산') title = `[SIM]실체결 수동청산[실현] ${args.baseAsset}`;
    const lines = [
      title,
      `투자금(총 마진): $${args.investmentUSDT.toFixed(2)}`,
      `순수익(${realized ? '실현' : '예상'}): ${formatSignedUsd(args.netProfitUSD)}`,
      `수익률(${realized ? '실현' : '예상'}): ${formatSignedPercent(args.roiPercent)}`,
      `현재 전체 잔액: $${args.currentTotalBalanceUSDT.toFixed(2)}`,
    ];
    if (args.fundingUSD != null) lines.push(`펀딩 정산: ${formatSignedUsd(args.fundingUSD)}`);
    if (args.pricePnlUSD != null) lines.push(`가격PnL: ${formatSignedUsd(args.pricePnlUSD)}`);
    if (args.feesUSD != null) lines.push(`수수료: -$${Math.abs(args.feesUSD).toFixed(4)}`);
    if (args.pairId) lines.push(`pairId: ${args.pairId}`);
    if (args.route) lines.push(`route: ${args.route}`);
    if (args.extraLine) lines.push(args.extraLine);
    void sendTelegramMessage(lines.join('\n'), {
      kind: realized ? 'exit' : 'entry',
      pairId: args.pairId,
      symbol: args.baseAsset,
      exchanges: args.route,
      structured: {
        margin: args.investmentUSDT / 2,
        ...(realized
          ? {
            realPnl: args.netProfitUSD,
            realizedRoiPercent: args.roiPercent,
            totalFunding: args.fundingUSD,
            totalPricePnl: args.pricePnlUSD,
            totalFees: args.feesUSD,
          }
          : {
            expNet: args.netProfitUSD,
            expectedRoiPercent: args.roiPercent,
          }),
      },
    });
  }

  getStatus() {
    const state = this.getState();
    const balanceEqualization = buildBalanceEqualizationPlan(
      this.config.enabledExchanges,
      state.simBalances,
    );
    return {
      active: this.active,
      config: this.config,
      startedAt: this.startedAt,
      runtime: getSchedulerRuntimeIdentity('sim'),
      diagnostics: getTradeWindowDiagnostics({ simulation: true, windowHours: 6 }),
      lastRatesUpdate: this.lastRatesUpdate,
      scheduledEntries: Array.from(this.scheduledEntries.values()).sort((a, b) => a.targetTime - b.targetTime),
      snipeTargets: Object.fromEntries(
        Array.from(this.scheduledEntries.values()).map((entry) => [`sim:${entry.opportunityId}`, entry.targetTime]),
      ),
      snipeAllocations: Object.fromEntries(
        Array.from(this.scheduledEntries.values()).map((entry) => [`sim:${entry.opportunityId}`, entry.investmentUSDT]),
      ),
      state,
      balanceEqualization,
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
      // rates 濡쒕뵫? 諛깃렇?쇱슫????API 利됱떆 ?묐떟
      void this.refreshRatesAndPlans();
      return this.getStatus();
    });
  }

  updateConfig(config: ServerSimSchedulerConfig) {
    return this.enqueue(async () => {
      this.config = this.normalizeConfig(config);
      this.pruneFundingUniverseCache();
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

  resetState(enabledExchanges: ExchangeId[], investmentUSDT: number, tradesClearedAt = 0) {
    return this.enqueue(async () => {
      const sanitizedEnabledExchanges = sanitizeEnabledExchanges(enabledExchanges);
      const nextState = resetServerSimState(sanitizedEnabledExchanges, investmentUSDT, tradesClearedAt);
      this.scheduledEntries.clear();
      this.scheduleProbeStates.clear();
      this.pendingAutoCloses.clear();
      this.saveState();
      if (this.active) {
        this.queueRefreshRatesAndPlans();
      }
      return nextState;
    });
  }

  reconfigureState(enabledExchanges: ExchangeId[], investmentUSDT: number) {
    return this.enqueue(async () => {
      const sanitizedEnabledExchanges = sanitizeEnabledExchanges(enabledExchanges);
      const current = loadServerSimState() ?? createDefaultSimState(sanitizedEnabledExchanges, investmentUSDT);
      if (this.stateHasSessionData(current)) {
        return current;
      }

      const perExchange = Math.max(0, investmentUSDT * 2);
      const simBalances = { ...current.simBalances };
      const simInitialBalances = { ...current.simInitialBalances };
      for (const exchange of Object.keys(simBalances) as ExchangeId[]) {
        simBalances[exchange] = sanitizedEnabledExchanges.includes(exchange) ? perExchange : 0;
        simInitialBalances[exchange] = sanitizedEnabledExchanges.includes(exchange) ? perExchange : 0;
      }
      for (const exchange of sanitizedEnabledExchanges) {
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
    if (events.length === 0) return appendTrades([], {
      engineId: 'server-sim-scheduler',
      eventSource: 'server-sim-scheduler',
    });
    const persisted = appendTrades(events, {
      engineId: 'server-sim-scheduler',
      eventSource: 'server-sim-scheduler',
    });
    const persistedEvents = persisted.events;
    const logs = this.mapEventsToSchedulerLogs(persistedEvents);
    if (logs.length > 0) {
      appendLogs(logs);
    }
    this.routeFailureMemory.ingestEvents(persistedEvents, { simulation: true });
    return persisted;
  }

  private mapEventsToSchedulerLogs(events: TradeEvent[]): FileLogEntry[] {
    const logs: FileLogEntry[] = [];

    for (const event of events) {
      const analysisStatus = typeof event.analysis?.status === 'string'
        ? event.analysis.status
        : undefined;
      const status = analysisStatus ?? event.reason;
      if (event.type === 'guard_block') {
        logs.push({
          timestamp: event.timestamp,
          level: 'warning',
          message: `[SIM] ${event.baseAsset ?? 'UNKNOWN'} entry blocked`,
          exchange: event.shortExchange ?? event.exchange,
          detail: [
            event.reason ? `reason=${event.reason}` : '',
            event.detail,
          ].filter(Boolean).join(' | '),
        });
        continue;
      }

      if (event.type === 'error') {
        logs.push({
          timestamp: event.timestamp,
          level: 'error',
          message: `[SIM] ${event.baseAsset ?? 'UNKNOWN'} execution error`,
          exchange: event.shortExchange ?? event.exchange,
          detail: [event.reason, event.detail].filter((value) => Boolean(value)).join(' | '),
        });
        continue;
      }

      if (event.type === 'schedule_probe') {
        const rejectReasons = Array.isArray(event.analysis?.rejectReasons)
          ? event.analysis.rejectReasons
          : [];
        const shouldLog = status === 'analysis_summary'
          || status === 'failed'
          || status === 'canceled'
          || status === 'rejected'
          || (status === 'unselected' && rejectReasons.length > 0);
        if (!shouldLog) continue;
        if (status === 'analysis_summary' || status === 'failed' || status === 'canceled' || status === 'rejected' || status === 'unselected') {
          logs.push({
            timestamp: event.timestamp,
            level: 'warning',
            message: `[SIM] ${event.baseAsset ?? 'UNKNOWN'} schedule_probe ${status}`,
            exchange: event.shortExchange ?? event.exchange,
            detail: [
              status === 'failed' ? `reason=${event.reason ?? 'unknown'}` : `reason=${event.reason ?? 'schedule_replanned'}`,
              event.analysis?.selected !== undefined ? `selected=${event.analysis.selected}` : '',
              event.analysis?.timeToFundingMs !== undefined ? `ttfMs=${event.analysis.timeToFundingMs}` : '',
              rejectReasons.length > 0 ? `reject=${rejectReasons.join('|')}` : '',
              `milestone=${event.milestone ?? 'N/A'}`,
              event.detail,
            ].filter((value) => Boolean(value)).join(' | '),
          });
        }
      }
    }

    return logs;
  }

  private pruneFundingUniverseCache() {
    const enabled = new Set(this.config.enabledExchanges);
    for (const exchange of Array.from(this.fundingUniverseCache.keys())) {
      if (!enabled.has(exchange)) {
        this.fundingUniverseCache.delete(exchange);
      }
    }
  }

  private updateFundingUniverseCacheFromRates(rates: FundingRate[], now: number) {
    const grouped = new Map<ExchangeId, Set<string>>();
    for (const rate of rates) {
      if (!this.config.enabledExchanges.includes(rate.exchange)) continue;
      if (!rate.symbol || !Number.isFinite(rate.nextFundingTime)) continue;
      let set = grouped.get(rate.exchange);
      if (!set) {
        set = new Set<string>();
        grouped.set(rate.exchange, set);
      }
      set.add(rate.symbol);
    }

    for (const exchange of this.config.enabledExchanges) {
      const symbols = Array.from(grouped.get(exchange) ?? []);
      if (symbols.length === 0) continue;
      this.fundingUniverseCache.set(exchange, {
        symbols,
        updatedAt: now,
      });
    }
  }

  private getFreshUniverseSymbols(exchange: ExchangeId, now: number): string[] | null {
    const cached = this.fundingUniverseCache.get(exchange);
    if (!cached) return null;
    if (now - cached.updatedAt >= FUNDING_UNIVERSE_CACHE_TTL_MS) return null;
    return cached.symbols;
  }

  private shouldRunFullFundingRefresh(now: number): boolean {
    if (this.lastFullFundingRefreshAt === 0) return true;
    if (now - this.lastFullFundingRefreshAt >= FULL_FUNDING_REFRESH_INTERVAL_MS) return true;
    for (const exchange of this.config.enabledExchanges) {
      if (!this.getFreshUniverseSymbols(exchange, now)) return true;
    }
    return false;
  }

  private buildFastFundingSymbols(now: number): Map<ExchangeId, string[]> {
    const byExchange = new Map<ExchangeId, Set<string>>();
    const add = (exchange: ExchangeId, symbol?: string) => {
      if (!symbol) return;
      if (!this.config.enabledExchanges.includes(exchange)) return;
      let set = byExchange.get(exchange);
      if (!set) {
        set = new Set<string>();
        byExchange.set(exchange, set);
      }
      if (set.size >= getFastSymbolCap(exchange)) return;
      set.add(symbol);
    };

    const state = this.getState();
    for (const position of state.simPositions) {
      add(position.exchange, position.symbol);
    }

    for (const entry of this.scheduledEntries.values()) {
      add(entry.opportunity.shortExchange, entry.opportunity.shortSymbol);
      add(entry.opportunity.longExchange, entry.opportunity.longSymbol);
    }

    for (const opportunity of this.opportunities.slice(0, FAST_OPPORTUNITY_SEED_COUNT)) {
      add(opportunity.shortExchange, opportunity.shortSymbol);
      add(opportunity.longExchange, opportunity.longSymbol);
    }

    for (const exchange of this.config.enabledExchanges) {
      let set = byExchange.get(exchange);
      if (!set) {
        set = new Set<string>();
        byExchange.set(exchange, set);
      }
      const universe = this.getFreshUniverseSymbols(exchange, now);
      if (!universe) continue;
      const minTarget = Math.min(getFastSymbolMin(exchange), getFastSymbolCap(exchange));
      for (const symbol of universe) {
        if (set.size >= minTarget) break;
        set.add(symbol);
      }
    }

    const output = new Map<ExchangeId, string[]>();
    for (const exchange of this.config.enabledExchanges) {
      const symbols = Array.from(byExchange.get(exchange) ?? []);
      if (symbols.length === 0) continue;
      output.set(exchange, symbols.slice(0, getFastSymbolCap(exchange)));
    }
    return output;
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
      postFundingMilestones: [],
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
      existing.fundingCapturedAt = undefined;
      existing.fundingBaseShortMid = undefined;
      existing.fundingBaseLongMid = undefined;
      existing.fundingBaseBasisBps = undefined;
      existing.postFundingMilestones = [];
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
      existing.fundingBaseShortMid = undefined;
      existing.fundingBaseLongMid = undefined;
      existing.fundingBaseBasisBps = undefined;
    }

    this.scheduleProbeStates.set(entry.probeId, existing);
    return existing;
  }

  private resolveProbeRoute(state: ScheduleProbeState): ProbeRoute {
    const live = this.scheduledEntries.get(state.opportunityId)?.opportunity
      ?? this.opportunities.find((candidate) => getOpportunityId(candidate) === state.opportunityId);
    if (live) {
      // Cache rates so post-execution probes don't fall back to zero
      state.lastShortRate = live.shortRate;
      state.lastLongRate = live.longRate;
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

    // Fallback: use last known rates from probe state instead of zeroes
    return {
      baseAsset: state.asset,
      shortExchange: state.shortExchange,
      longExchange: state.longExchange,
      shortSymbol: state.shortSymbol,
      longSymbol: state.longSymbol,
      shortRate: state.lastShortRate ?? 0,
      longRate: state.lastLongRate ?? 0,
      fundingIntervalMs: 8 * 3600000,
      nextFundingTime: state.targetTime,
    };
  }

  private getAnalyticsSnapshotIntervalMs(now: number): number {
    const hasNearDue = this.opportunities.some((opportunity) => (
      opportunity.nextFundingTime >= now
      && opportunity.nextFundingTime - now <= ANALYTICS_NEAR_DUE_WINDOW_MS
    ));
    return hasNearDue ? ANALYTICS_NEAR_DUE_INTERVAL_MS : ANALYTICS_BASE_INTERVAL_MS;
  }

  private shouldCaptureAnalyticsSnapshot(now: number): boolean {
    if (this.lastAnalyticsSnapshotAt === 0) return true;
    const intervalMs = this.getAnalyticsSnapshotIntervalMs(now);
    return now - this.lastAnalyticsSnapshotAt >= intervalMs;
  }

  private captureSchedulingAnalyticsSnapshot(params: {
    now: number;
    state: SimStateSnapshot;
    prePlanBalances: Record<string, number>;
    occupiedLegs: Set<string>;
    previousEntries: Map<string, ScheduledSimEntry>;
    candidates: ArbitrageOpportunity[];
    plans: Array<{ opportunity: ArbitrageOpportunity; investmentUSDT: number }>;
    timing: TimingConfig;
  }) {
    const {
      now,
      state,
      prePlanBalances,
      occupiedLegs,
      previousEntries,
      candidates,
      plans,
      timing,
    } = params;
    if (!this.shouldCaptureAnalyticsSnapshot(now)) return;

    const events: TradeEvent[] = [];
    const strategyConfig = buildStrategyLikeConfig(this.config);
    const selectedById = new Map<string, number>(
      plans.map((plan) => [getOpportunityId(plan.opportunity), plan.investmentUSDT]),
    );
    const candidateIds = new Set(candidates.map((opportunity) => getOpportunityId(opportunity)));
    const initialBalances = state.simInitialBalances as Record<string, number>;
    const opportunities = this.opportunities.slice(0, ANALYTICS_MAX_CANDIDATES);
    const minVolume24hUSD = Math.max(0, this.config.minVolume24hUSD ?? 0);
    const volumeByExchangeAsset = buildVolumeByExchangeAsset(this.latestRates);

    for (const exchange of this.config.enabledExchanges) {
      const balance = prePlanBalances[exchange] ?? 0;
      const initial = initialBalances[exchange] ?? 0;
      const freeRatio = initial > 0 ? (balance / initial) * 100 : 0;
      const openNotional = state.simPositions
        .filter((position) => position.exchange === exchange)
        .reduce((sum, position) => sum + (position.sizeUSD ?? 0), 0);
      const scheduledMargin = plans
        .filter((plan) => (
          plan.opportunity.shortExchange === exchange || plan.opportunity.longExchange === exchange
        ))
        .reduce((sum, plan) => sum + plan.investmentUSDT, 0);
      events.push({
        timestamp: now,
        type: 'schedule_probe',
        simulation: true,
        exchange,
        milestone: 'analysis_balance',
        reason: 'analysis_balance_snapshot',
        analysis: {
          exchange,
          balanceUSDT: balance,
          initialBalanceUSDT: initial,
          freeMarginPct: freeRatio,
          openNotionalUSDT: openNotional,
          scheduledMarginUSDT: scheduledMargin,
          activePositions: state.simPositions.filter((position) => position.exchange === exchange).length,
        },
        detail: `exchange=${exchange} bal=${balance.toFixed(4)} free=${freeRatio.toFixed(2)}% openNotional=${openNotional.toFixed(2)} scheduled=${scheduledMargin.toFixed(2)}`,
      });
    }

    let selectedCount = 0;
    for (const opportunity of opportunities) {
      const opportunityId = getOpportunityId(opportunity);
      const selectedAllocation = selectedById.get(opportunityId) ?? 0;
      const isSelected = selectedAllocation > 0;

      const routeFailureKey = makeRouteFailureKey(
        opportunity.baseAsset,
        opportunity.shortExchange,
        opportunity.longExchange,
      );
      const profileLeadMs = getPairEntryLeadMs(opportunity.shortExchange, opportunity.longExchange);
      const entryLeadMs = Math.max(profileLeadMs, timing.entryLeadMs);
      const targetTime = opportunity.nextFundingTime - entryLeadMs;
      const inReplanFreeze = targetTime <= now + SCHEDULE_REPLAN_FREEZE_MS;
      const previousExists = previousEntries.has(opportunityId);
      const withinGrace = targetTime > now + NEAR_DUE_GRACE_MS;
      const inAheadWindow = targetTime <= now + getScheduleAheadWindowMs(opportunity);
      const shortBalance = prePlanBalances[opportunity.shortExchange] ?? 0;
      const longBalance = prePlanBalances[opportunity.longExchange] ?? 0;
      const shortInitial = initialBalances[opportunity.shortExchange] ?? 0;
      const longInitial = initialBalances[opportunity.longExchange] ?? 0;
      const shortFreeRatio = shortInitial > 0 ? (shortBalance / shortInitial) * 100 : 0;
      const longFreeRatio = longInitial > 0 ? (longBalance / longInitial) * 100 : 0;
      const volumeStatus = resolveOpportunityVolumeStatus(opportunity, minVolume24hUSD, volumeByExchangeAsset);
      const fundingTsDiffMs = (() => {
        const shortRate = this.latestRates.find((rate) => (
          rate.exchange === opportunity.shortExchange && rate.symbol === opportunity.shortSymbol
        ));
        const longRate = this.latestRates.find((rate) => (
          rate.exchange === opportunity.longExchange && rate.symbol === opportunity.longSymbol
        ));
        if (!shortRate || !longRate) return null;
        return Math.abs(shortRate.nextFundingTime - longRate.nextFundingTime);
      })();
    const analysisInvestmentUSDT = selectedAllocation > 0
      ? selectedAllocation
      : getMinExecutableAllocationUSDT(strategyConfig.investmentUSDT, strategyConfig.leverage);
    const preEntryEv = estimatePreEntryConservativeEV(
      opportunity,
      strategyConfig,
      analysisInvestmentUSDT,
    );
    const spreadAcceptanceThreshold = getSpreadAcceptanceThreshold(this.config.minSpreadPercent);
    const preEntryEvFloor = getAcceptableNetEvFloor(analysisInvestmentUSDT);
    const fallbackPreEntryEv = preEntryEv ?? (Number.isFinite(opportunity.netProfit)
      ? {
        expectedNetUSD: opportunity.netProfit,
        passesMinProfit: opportunity.netProfit >= MIN_PROFIT_USD,
        passesEVRatio: opportunity.netProfit > 0,
        evRatio: 0,
      }
      : null);
      const rejectReasons: string[] = [];
      if (!this.config.enabledExchanges.includes(opportunity.shortExchange)
        || !this.config.enabledExchanges.includes(opportunity.longExchange)) {
        rejectReasons.push('disabled_exchange');
      }
      if (hasTierCExchange(opportunity.shortExchange, opportunity.longExchange)) {
        const tierCEx = opportunity.shortExchange === 'bingx' ? opportunity.shortExchange : opportunity.longExchange;
        if (!this.config.enabledExchanges.includes(tierCEx)) {
          rejectReasons.push('tier_c_disabled');
        }
      }
      if (opportunity.spreadPercent < spreadAcceptanceThreshold) {
        rejectReasons.push('spread_below_threshold');
      }
      if (volumeStatus.belowMin) {
        rejectReasons.push('volume_below_min');
      }
      if (this.routeFailureMemory.isBlocked(routeFailureKey, now)) {
        rejectReasons.push('route_failure_blocked');
      }
      if (getOpportunityLegKeys(opportunity).some((legKey) => occupiedLegs.has(legKey))) {
        rejectReasons.push('leg_occupied');
      }
      if (
        (this.config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG).useConfirmedClose
        && fundingTsDiffMs != null
        && fundingTsDiffMs > MAX_FUNDING_TIMESTAMP_DIFF_MS
      ) {
        rejectReasons.push('funding_timestamp_mismatch');
      }
      if (inReplanFreeze && !previousExists && !withinGrace) {
        rejectReasons.push('near_due_grace_block');
      }
      if (!inReplanFreeze && !inAheadWindow) {
        rejectReasons.push('outside_schedule_window');
      }
      if (!fallbackPreEntryEv) {
        rejectReasons.push('profitability_calculation_failed');
      } else if (fallbackPreEntryEv.expectedNetUSD < preEntryEvFloor && !isSelected) {
        rejectReasons.push('profitability_negative_preview');
      }
      if (rejectReasons.length === 0 && !candidateIds.has(opportunityId)) {
        rejectReasons.push('not_in_candidates');
      }
      if (rejectReasons.length === 0 && !isSelected) {
        rejectReasons.push('allocation_skip');
      }

      const score = getOpportunityYieldScore(
        opportunity,
        strategyConfig,
        analysisInvestmentUSDT,
      );
      const isExecutableSelected = isSelected && rejectReasons.length === 0;
      if (isExecutableSelected) selectedCount += 1;
      const status = isExecutableSelected
        ? 'selected'
        : isSelected
          ? 'allocated_rejected'
        : rejectReasons.length === 0
          ? 'unselected'
          : 'rejected';
      const expectedNetProfit = fallbackPreEntryEv?.expectedNetUSD ?? opportunity.netProfit;
      const expectedRoiPercent = calcExpectedRoiPercent(
        expectedNetProfit,
        analysisInvestmentUSDT,
        strategyConfig.leverage,
      );
      events.push({
        timestamp: now,
        type: 'schedule_probe',
        simulation: true,
        baseAsset: opportunity.baseAsset,
        shortExchange: opportunity.shortExchange,
        longExchange: opportunity.longExchange,
        spread: opportunity.spread,
        spreadPercent: opportunity.spreadPercent,
        margin: selectedAllocation > 0 ? selectedAllocation : strategyConfig.investmentUSDT,
        leverage: strategyConfig.leverage,
        notional: (selectedAllocation > 0 ? selectedAllocation : strategyConfig.investmentUSDT) * strategyConfig.leverage,
        shortRate: opportunity.shortRate,
        longRate: opportunity.longRate,
        expectedNetProfit,
        expectedRoiPercent,
        milestone: 'analysis_candidate',
        reason: status,
        analysis: {
          opportunityId,
          status,
          selected: isExecutableSelected,
          allocated: isSelected,
          selectedAllocationUSDT: selectedAllocation,
          candidateIncluded: candidateIds.has(opportunityId),
          scorePerHourUSD: score,
          rejectReasons,
          timeToFundingMs: opportunity.nextFundingTime - now,
          targetTimeMs: targetTime,
          targetTimeInMs: targetTime - now,
          entryLeadMs,
          routeFailureBlocked: this.routeFailureMemory.isBlocked(routeFailureKey, now),
          shortBalanceUSDT: shortBalance,
          longBalanceUSDT: longBalance,
          shortFreeMarginPct: shortFreeRatio,
          longFreeMarginPct: longFreeRatio,
          shortQuoteVolume24h: volumeStatus.shortQuoteVolume24h ?? null,
          longQuoteVolume24h: volumeStatus.longQuoteVolume24h ?? null,
          minVolume24hUSD,
          fundingTimestampDiffMs: fundingTsDiffMs,
          inReplanFreeze,
          previousScheduleExists: previousExists,
          withinNearDueGrace: withinGrace,
          inScheduleAheadWindow: inAheadWindow,
          expectedNetProfit,
          expectedRoiPercent,
          passesMinProfit: fallbackPreEntryEv?.passesMinProfit ?? null,
          passesEVRatio: fallbackPreEntryEv?.passesEVRatio ?? null,
          evRatio: fallbackPreEntryEv?.evRatio ?? null,
        },
        detail: `status=${status} alloc=${selectedAllocation.toFixed(4)} score=${score.toFixed(6)} expNet=${expectedNetProfit.toFixed(6)} expRoi=${expectedRoiPercent.toFixed(4)}% reasons=${rejectReasons.join(',') || 'none'} ttfMs=${Math.round(opportunity.nextFundingTime - now)}`,
      });
    }

    events.push({
      timestamp: now,
      type: 'schedule_probe',
      simulation: true,
      milestone: 'analysis_summary',
      reason: 'analysis_summary',
      analysis: {
        totalOpportunities: this.opportunities.length,
        analyzedOpportunities: opportunities.length,
        candidateCount: candidates.length,
        selectedCount,
        scheduledEntriesCount: this.scheduledEntries.size,
        activePositionsCount: state.simPositions.length,
        intervalMs: this.getAnalyticsSnapshotIntervalMs(now),
      },
      detail: `opps=${this.opportunities.length} analyzed=${opportunities.length} candidates=${candidates.length} selected=${selectedCount} scheduled=${this.scheduledEntries.size}`,
    });

    this.lastAnalyticsSnapshotAt = now;
    this.recordTrades(events);
  }

  private async captureProbeMarketSnapshot(
    route: ProbeRoute,
    notional: number,
  ): Promise<ProbeMarketSnapshot | undefined> {
    try {
      const [shortBook, longBook] = await Promise.all([
        fetchOrderbook(route.shortExchange, route.shortSymbol, PROBE_ORDERBOOK_DEPTH),
        fetchOrderbook(route.longExchange, route.longSymbol, PROBE_ORDERBOOK_DEPTH),
      ]);

      const shortBid = shortBook.bids?.[0]?.[0];
      const shortAsk = shortBook.asks?.[0]?.[0];
      const longBid = longBook.bids?.[0]?.[0];
      const longAsk = longBook.asks?.[0]?.[0];
      if (
        !Number.isFinite(shortBid)
        || !Number.isFinite(shortAsk)
        || !Number.isFinite(longBid)
        || !Number.isFinite(longAsk)
      ) {
        return undefined;
      }

      const shortMid = ((shortBid as number) + (shortAsk as number)) / 2;
      const longMid = ((longBid as number) + (longAsk as number)) / 2;
      const shortBidDepthUsd5 = sumDepthUsd(shortBook.bids, PROBE_ORDERBOOK_DEPTH);
      const shortAskDepthUsd5 = sumDepthUsd(shortBook.asks, PROBE_ORDERBOOK_DEPTH);
      const longBidDepthUsd5 = sumDepthUsd(longBook.bids, PROBE_ORDERBOOK_DEPTH);
      const longAskDepthUsd5 = sumDepthUsd(longBook.asks, PROBE_ORDERBOOK_DEPTH);

      let shortImpactBps = 0;
      let longImpactBps = 0;
      const impactNotional = Math.max(0, notional);
      if (impactNotional > 0) {
        shortImpactBps = calcOrderbookImpactBps(
          shortBook.bids,
          shortBook.asks,
          impactNotional,
          'sell',
        ).impactBps;
        longImpactBps = calcOrderbookImpactBps(
          longBook.bids,
          longBook.asks,
          impactNotional,
          'buy',
        ).impactBps;
      }

      return {
        shortBid: shortBid as number,
        shortAsk: shortAsk as number,
        shortMid,
        shortSpreadBps: calcBookSpreadBps(shortBid as number, shortAsk as number),
        shortBidDepthUsd5,
        shortAskDepthUsd5,
        shortImbalance: calcDepthImbalance(shortBidDepthUsd5, shortAskDepthUsd5),
        shortImpactBps,
        longBid: longBid as number,
        longAsk: longAsk as number,
        longMid,
        longSpreadBps: calcBookSpreadBps(longBid as number, longAsk as number),
        longBidDepthUsd5,
        longAskDepthUsd5,
        longImbalance: calcDepthImbalance(longBidDepthUsd5, longAskDepthUsd5),
        longImpactBps,
        basisBps: calcBasisBps(shortMid, longMid),
        entryCapacityUsd5: Math.min(shortBidDepthUsd5, longAskDepthUsd5),
        exitCapacityUsd5: Math.min(shortAskDepthUsd5, longBidDepthUsd5),
      };
    } catch {
      return undefined;
    }
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
      timeFromFundingMs?: number;
      reason?: string;
      executedNotional?: number;
      shortSlippagePercent?: number;
      longSlippagePercent?: number;
      marketSnapshot?: ProbeMarketSnapshot;
      shortMidMoveBps?: number;
      longMidMoveBps?: number;
      basisMoveBps?: number;
      analysis?: Record<string, unknown>;
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
    const roundTripFeePct = (shortFeeRate + longFeeRate) * 2;
    const totalRoundTripFees = notional * roundTripFeePct;
    const perFunding = notional * spread;

    // Conservative EV ??same formula used by actual execution guard
    const usesInstantRate = pairUsesInstantaneousRate(
      route.shortExchange, route.longExchange,
    );
    const snipeConfig = this.config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
    const shortDrift = snipeConfig.useDriftBuffer
      ? calcDriftBuffer(shortRate, undefined, usesInstantRate)
      : 0;
    const longDrift = snipeConfig.useDriftBuffer
      ? calcDriftBuffer(longRate, undefined, usesInstantRate)
      : 0;
    // Prefer measured slippage when available; otherwise fall back to configured cap.
    const impactCapDec = snipeConfig.useImpactGuards
      ? (snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 10000 / 2
      : (snipeConfig.targetImpactBps ?? 4) / 10000;
    const hasMeasuredImpact = Number.isFinite(options?.shortSlippagePercent)
      && Number.isFinite(options?.longSlippagePercent);
    const measuredImpactDec = hasMeasuredImpact
      ? (((options?.shortSlippagePercent ?? 0) + (options?.longSlippagePercent ?? 0)) / 100)
      : null;
    const entryImpactDec = measuredImpactDec ?? impactCapDec;
    const timeToExecutionMs = options?.timeToExecutionMs;
    const timeFromFundingMs = options?.timeFromFundingMs;
    const marketSnapshot = options?.marketSnapshot;
    const shortMidMoveBps = options?.shortMidMoveBps;
    const longMidMoveBps = options?.longMidMoveBps;
    const basisMoveBps = options?.basisMoveBps;
    const analysis = options?.analysis;
    const basisConvergenceReservePct = basisReservePctFromBasisRisk({
      basisMoveBps,
      basisBps: marketSnapshot?.basisBps,
    });
    const volumeReservePct = volumeLiquidityReservePct({
      notionalUSDT: notional,
      shortQuoteVolume24h: shortLive?.quoteVolume24h,
      longQuoteVolume24h: longLive?.quoteVolume24h,
      marketSnapshot,
    });
    const dataHealthPenaltyUSD = now - this.lastRatesUpdate > RATES_REFRESH_INTERVAL_MS * 3
      ? notional * (STALE_DATA_PENALTY_BPS / 10000)
      : 0;
    const ev = calcConservativeEV(
      notional, shortRate, longRate,
      shortDrift, longDrift, roundTripFeePct, entryImpactDec, entryImpactDec,
      {
        basisConvergenceReservePct,
        volumeLiquidityReservePct: volumeReservePct,
        dataHealthPenaltyUSD,
      },
    );
    const expectedNetProfit = ev.expectedNetUSD;
    const hedgedNetSpreadPercent = calcNetSpreadPercent(
      spreadPercent,
      0,
      roundTripFeePct * 100,
    );
    const expectedRoiPercent = calcExpectedRoiPercent(
      expectedNetProfit,
      investmentUSDT,
      this.config.leverage,
    );
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
      probeShortBid: marketSnapshot?.shortBid,
      probeShortAsk: marketSnapshot?.shortAsk,
      probeLongBid: marketSnapshot?.longBid,
      probeLongAsk: marketSnapshot?.longAsk,
      probeShortMid: marketSnapshot?.shortMid,
      probeLongMid: marketSnapshot?.longMid,
      probeBasisBps: marketSnapshot?.basisBps,
      probeShortSpreadBps: marketSnapshot?.shortSpreadBps,
      probeLongSpreadBps: marketSnapshot?.longSpreadBps,
      probeShortBidDepthUsd5: marketSnapshot?.shortBidDepthUsd5,
      probeShortAskDepthUsd5: marketSnapshot?.shortAskDepthUsd5,
      probeLongBidDepthUsd5: marketSnapshot?.longBidDepthUsd5,
      probeLongAskDepthUsd5: marketSnapshot?.longAskDepthUsd5,
      probeShortImbalance: marketSnapshot?.shortImbalance,
      probeLongImbalance: marketSnapshot?.longImbalance,
      probeShortImpactBps: marketSnapshot?.shortImpactBps,
      probeLongImpactBps: marketSnapshot?.longImpactBps,
      probeEntryCapacityUsd5: marketSnapshot?.entryCapacityUsd5,
      probeExitCapacityUsd5: marketSnapshot?.exitCapacityUsd5,
      probeShortMidMoveBps: shortMidMoveBps,
      probeLongMidMoveBps: longMidMoveBps,
      probeBasisMoveBps: basisMoveBps,
      analysis,
      detail: [
        `status=${options?.status ?? 'scheduled'}`,
        timeToExecutionMs == null ? null : `tteMs=${Math.round(timeToExecutionMs)}`,
        timeFromFundingMs == null ? null : `tfMs=${Math.round(timeFromFundingMs)}`,
        `shortRate=${shortRate.toFixed(8)}`,
        `longRate=${longRate.toFixed(8)}`,
        `netSpread=${hedgedNetSpreadPercent.toFixed(4)}%`,
        `expNet=${expectedNetProfit.toFixed(6)}`,
        `expRoi=${expectedRoiPercent.toFixed(4)}%`,
        `evRatio=${ev.evRatio.toFixed(3)}`,
        `passEV=${ev.passesMinProfit && ev.passesEVRatio}`,
        `impactSrc=${hasMeasuredImpact ? 'measured' : 'cap'}`,
        `impactUsed=${(entryImpactDec * 100).toFixed(4)}%`,
        `basisReserve=${(basisConvergenceReservePct * 100).toFixed(4)}%`,
        `liqReserve=${(volumeReservePct * 100).toFixed(4)}%`,
        dataHealthPenaltyUSD > 0 ? `dataPenalty=${dataHealthPenaltyUSD.toFixed(4)}` : null,
        marketSnapshot == null ? null : `basis=${marketSnapshot.basisBps.toFixed(2)}bps`,
        marketSnapshot == null ? null : `liqIn=${marketSnapshot.entryCapacityUsd5.toFixed(2)}`,
        marketSnapshot == null ? null : `liqOut=${marketSnapshot.exitCapacityUsd5.toFixed(2)}`,
        marketSnapshot == null
          ? null
          : `impactNow=${(marketSnapshot.shortImpactBps + marketSnapshot.longImpactBps).toFixed(2)}bps`,
        shortMidMoveBps == null ? null : `shortMove=${shortMidMoveBps.toFixed(2)}bps`,
        longMidMoveBps == null ? null : `longMove=${longMidMoveBps.toFixed(2)}bps`,
        basisMoveBps == null ? null : `basisMove=${basisMoveBps.toFixed(2)}bps`,
      ].filter(Boolean).join(' '),
    };
  }

  private async captureScheduledProbeMilestones(now: number) {
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

      // Fetch real orderbook slippage if not yet measured
      if (state.lastShortSlippagePercent == null || state.lastLongSlippagePercent == null) {
        try {
          const notional = entry.investmentUSDT * this.config.leverage;
          if (notional > 0) {
            const [shortFill, longFill] = await Promise.all([
              fetchMarketFillPrice(entry.opportunity.shortExchange, entry.opportunity.shortSymbol, 'sell', notional),
              fetchMarketFillPrice(entry.opportunity.longExchange, entry.opportunity.longSymbol, 'buy', notional),
            ]);
            state.lastShortSlippagePercent = shortFill.slippagePercent;
            state.lastLongSlippagePercent = longFill.slippagePercent;
          }
        } catch {
          // Leave as undefined ??buildScheduleProbeEvent will fall back to cap
        }
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
            shortSlippagePercent: state.lastShortSlippagePercent,
            longSlippagePercent: state.lastLongSlippagePercent,
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
              shortSlippagePercent: state.lastShortSlippagePercent,
              longSlippagePercent: state.lastLongSlippagePercent,
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

  private async capturePostFundingProbeMilestones(now: number) {
    if (this.scheduleProbeStates.size === 0) return;
    const events: TradeEvent[] = [];

    for (const state of this.scheduleProbeStates.values()) {
      if (state.status !== 'executed' || !state.fundingCapturedAt) continue;
      const elapsedMs = now - state.fundingCapturedAt;
      if (elapsedMs < 0) continue;
      const route = this.resolveProbeRoute(state);
      const pendingPoints = POST_FUNDING_PROBE_POINTS.filter((point) => (
        !state.postFundingMilestones.includes(point.key) && elapsedMs >= point.thresholdMs
      ));
      if (pendingPoints.length === 0) {
        this.scheduleProbeStates.set(state.probeId, state);
        continue;
      }

      const notional = Math.max(0, state.executedNotional ?? state.investmentUSDT * this.config.leverage);
      const marketSnapshot = await this.captureProbeMarketSnapshot(route, notional);
      if (marketSnapshot) {
        if (!Number.isFinite(state.fundingBaseShortMid ?? Number.NaN)) {
          state.fundingBaseShortMid = marketSnapshot.shortMid;
        }
        if (!Number.isFinite(state.fundingBaseLongMid ?? Number.NaN)) {
          state.fundingBaseLongMid = marketSnapshot.longMid;
        }
        if (!Number.isFinite(state.fundingBaseBasisBps ?? Number.NaN)) {
          state.fundingBaseBasisBps = marketSnapshot.basisBps;
        }
      }

      const shortMidMoveBps = marketSnapshot && Number.isFinite(state.fundingBaseShortMid ?? Number.NaN)
        ? calcMoveBps(marketSnapshot.shortMid, state.fundingBaseShortMid as number)
        : undefined;
      const longMidMoveBps = marketSnapshot && Number.isFinite(state.fundingBaseLongMid ?? Number.NaN)
        ? calcMoveBps(marketSnapshot.longMid, state.fundingBaseLongMid as number)
        : undefined;
      const basisMoveBps = marketSnapshot && Number.isFinite(state.fundingBaseBasisBps ?? Number.NaN)
        ? (marketSnapshot.basisBps - (state.fundingBaseBasisBps as number))
        : undefined;

      for (const point of pendingPoints) {
        events.push(this.buildScheduleProbeEvent(
          point.key,
          route,
          state.investmentUSDT,
          now,
          {
            pairId: state.pairId,
            status: 'executed',
            reason: point.key,
            timeToExecutionMs: state.targetTime - now,
            timeFromFundingMs: elapsedMs,
            executedNotional: state.executedNotional,
            shortSlippagePercent: state.lastShortSlippagePercent,
            longSlippagePercent: state.lastLongSlippagePercent,
            marketSnapshot,
            shortMidMoveBps,
            longMidMoveBps,
            basisMoveBps,
          },
        ));
        state.postFundingMilestones.push(point.key);
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
        // Process funding/auto-close before heavy refresh calls to minimize post-funding exposure.
        await this.processFunding();
        await this.capturePostFundingProbeMilestones(Date.now());
        await this.processPendingAutoCloses();
        if (this.lastRatesUpdate === 0 || Date.now() - this.lastRatesUpdate >= RATES_REFRESH_INTERVAL_MS) {
          await this.refreshRatesAndPlans();
        } else {
          const markedState = this.updatePositionMarks(this.getState());
          this.setState(markedState);
        }
        await this.revalidateScheduledByOrderbook();
        await this.captureScheduledProbeMilestones(Date.now());
        await this.executeDueEntries();
        this.capturePostExecutionProbeMilestones(Date.now());
        await this.processFunding();
        await this.capturePostFundingProbeMilestones(Date.now());
        await this.processPendingAutoCloses();
        this.pruneProbeStates(Date.now());
        if (Date.now() - this.lastStatePersistAt >= TICK_STATE_PERSIST_INTERVAL_MS) {
          this.saveState();
        }
      });
    } finally {
      this.ticking = false;
    }
  }

  private prewarmWsMarketData(now: number, fundingSymbols: Map<ExchangeId, string[]>) {
    if (now - this.lastWsWarmAt < WS_WARM_INTERVAL_MS) return;
    this.lastWsWarmAt = now;

    const orderbookTargets = new Map<string, { exchange: ExchangeId; symbol: string }>();
    const addOrderbookTarget = (exchange: ExchangeId, symbol?: string) => {
      if (!symbol) return;
      const key = `${exchange}:${symbol}`;
      if (!orderbookTargets.has(key)) {
        orderbookTargets.set(key, { exchange, symbol });
      }
    };

    for (const entry of this.scheduledEntries.values()) {
      addOrderbookTarget(entry.opportunity.shortExchange, entry.opportunity.shortSymbol);
      addOrderbookTarget(entry.opportunity.longExchange, entry.opportunity.longSymbol);
    }

    for (const position of this.getState().simPositions) {
      addOrderbookTarget(position.exchange, position.symbol);
    }

    void Promise.allSettled([
      ...Array.from(fundingSymbols.entries()).map(([exchange, symbols]) => warmFundingRatesWs(exchange, symbols)),
      ...Array.from(orderbookTargets.values()).map(async ({ exchange, symbol }) => {
        warmOrderbookWs(exchange, symbol, 50);
      }),
    ]);
  }

  /** Orderbook-based schedule revalidation for scheduled route telemetry. */
  private async revalidateScheduledByOrderbook() {
    if (this.scheduledEntries.size === 0) return;

    const now = Date.now();

    // ????60????곴맒 ??? ??됰튋筌????筌?(筌욊낯??? executeDueEntries?癒?퐣 筌ｌ꼶??
    const candidates = Array.from(this.scheduledEntries.entries())
      .filter(([, entry]) => entry.targetTime - now > FINAL_REVALIDATE_GUARD_MS)
      .sort((a, b) => a[1].targetTime - b[1].targetTime);
    if (candidates.length === 0) return;

    // 筌ㅼ뮆? 3揶쏆뮇逾?獄쏄퀣?귝에???삳쐭??鈺곌퀬??(API ?봔????쀫립)
    // ?⑥쥙??slice(0,3) ????round-robin??곗쨮 ??쀬넎 ?癒???곴퐣 ?袁⑥뵭??獄쎻뫗???뺣뼄.
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

    const minProbeAllocation = getMinExecutableAllocationUSDT(this.config.investmentUSDT, this.config.leverage);

    const revalidationResults = await Promise.allSettled(batch.map(async ([, entry]) => {
      try {
        const maxInvestment = Math.max(0, entry.investmentUSDT);
        if (maxInvestment <= 0) return { entry, sizing: null };

        const [shortBook, longBook] = await retryTransientFetch(() => Promise.all([
          fetchOrderbook(entry.opportunity.shortExchange, entry.opportunity.shortSymbol, 50),
          fetchOrderbook(entry.opportunity.longExchange, entry.opportunity.longSymbol, 50),
        ]));
        const minInvestment = Math.min(
          maxInvestment,
          minProbeAllocation,
        );
        const shortLiveRate = this.findLatestFundingRate(
          entry.opportunity.shortExchange,
          entry.opportunity.shortSymbol,
          entry.opportunity.baseAsset,
        );
        const longLiveRate = this.findLatestFundingRate(
          entry.opportunity.longExchange,
          entry.opportunity.longSymbol,
          entry.opportunity.baseAsset,
        );
        const sizing = findMaxProfitableOrderbookSizing(
          entry.opportunity,
          buildStrategyLikeConfig(this.config),
          maxInvestment,
          minInvestment,
          shortBook,
          longBook,
          {
            shortRate: shortLiveRate?.rate,
            longRate: longLiveRate?.rate,
          },
          getAcceptableNetEvFloor(maxInvestment),
        );
        return { entry, sizing };

      } catch {
        return { entry, sizing: undefined };
      }
    }));

    const events: TradeEvent[] = [];
    for (const result of revalidationResults) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const { entry, sizing } = result.value;
      const liveEntry = this.scheduledEntries.get(entry.opportunityId);
      if (!liveEntry || liveEntry.probeId !== entry.probeId) continue;

      const probeState = this.ensureProbeState(liveEntry, now);
      if (sizing) {
        if (probeState.status === 'scheduled') {
          probeState.lastShortSlippagePercent = sizing.shortEntrySlippagePercent;
          probeState.lastLongSlippagePercent = sizing.longEntrySlippagePercent;
          this.scheduleProbeStates.set(probeState.probeId, probeState);
        }
        if (
          sizing.notionalUSDT >= minProbeAllocation * this.config.leverage
          && sizing.investmentUSDT > 0
          && sizing.investmentUSDT < liveEntry.investmentUSDT - 0.0001
        ) {
          this.scheduledEntries.set(liveEntry.opportunityId, {
            ...liveEntry,
            investmentUSDT: sizing.investmentUSDT,
          });
        }
        continue;
      }

      const timeToExecutionMs = liveEntry.targetTime - now;
      if (sizing === undefined || timeToExecutionMs > EXECUTABLE_REVALIDATE_CANCEL_WINDOW_MS) {
        continue;
      }
      // Keep the schedule alive and let executeDueEntries run the final
      // decision path. This preserves the dynamic execution fallback logic
      // instead of hard-canceling right before the entry window.
      events.push(
        this.buildScheduleProbeEvent(
          'pre_execution_ev_soft_fail',
          liveEntry.opportunity,
          liveEntry.investmentUSDT,
          now,
          {
            status: probeState.status,
            reason: 'orderbook_ev_negative_soft',
            timeToExecutionMs,
            analysis: {
              opportunityId: liveEntry.opportunityId,
              probeId: liveEntry.probeId,
              revalidationGate: 'pre_execution_orderbook_ev',
              cancelWindowMs: EXECUTABLE_REVALIDATE_CANCEL_WINDOW_MS,
              minExecutableNotionalUSDT: MIN_EXECUTABLE_NOTIONAL_USDT,
            },
          },
        ),
      );
    }
    if (events.length > 0) {
      this.recordTrades(events);
    }
  }

  private getFundingRevalidateCacheKey(exchange: ExchangeId, symbol: string) {
    return `${exchange}:${symbol}`;
  }

  private findLatestFundingRate(exchange: ExchangeId, symbol: string, baseAsset: string): FundingRate | undefined {
    return this.latestRates.find((rate) => rate.exchange === exchange && rate.symbol === symbol)
      ?? this.latestRates.find((rate) => rate.exchange === exchange && rate.baseAsset === baseAsset);
  }

  private async resolveExecutionFundingRate(
    exchange: ExchangeId,
    symbol: string,
    baseAsset: string,
  ): Promise<ExecutionFundingRateLookup> {
    const now = Date.now();
    const latest = this.findLatestFundingRate(exchange, symbol, baseAsset);
    const latestAgeMs = now - this.lastRatesUpdate;
    if (latest && latestAgeMs <= FUNDING_REVALIDATE_CACHE_MAX_AGE_MS) {
      return { rate: latest, source: 'latest_rates_cache', ageMs: latestAgeMs };
    }

    const cacheKey = this.getFundingRevalidateCacheKey(exchange, symbol);
    const cached = this.fundingRevalidateCache.get(cacheKey);
    const cachedAgeMs = cached ? now - cached.fetchedAt : Number.POSITIVE_INFINITY;
    if (cached && cachedAgeMs <= FUNDING_REVALIDATE_CACHE_MAX_AGE_MS) {
      return { rate: cached.rate, source: 'targeted_cache', ageMs: cachedAgeMs };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < FUNDING_REVALIDATE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, FUNDING_REVALIDATE_RETRY_DELAY_MS * attempt));
      }
      try {
        const rates = await fetchFundingRates(exchange, undefined, [symbol]);
        const rate = rates.find((candidate) => candidate.symbol === symbol)
          ?? rates.find((candidate) => candidate.baseAsset === baseAsset);
        if (rate) {
          this.fundingRevalidateCache.set(cacheKey, { rate, fetchedAt: Date.now() });
          return { rate, source: 'targeted_fetch', ageMs: 0 };
        }
        lastError = new Error(`[${exchange}] funding revalidate missing for ${symbol}`);
      } catch (error) {
        lastError = error;
      }
    }

    const errorMessage = getErrorMessage(lastError);
    const fallbackLatestAgeMs = Date.now() - this.lastRatesUpdate;
    if (latest && fallbackLatestAgeMs <= FUNDING_REVALIDATE_STALE_FALLBACK_MS) {
      return {
        rate: latest,
        source: 'latest_rates_stale_after_fetch_error',
        ageMs: fallbackLatestAgeMs,
        fetchError: errorMessage,
      };
    }
    if (cached && cachedAgeMs <= FUNDING_REVALIDATE_STALE_FALLBACK_MS) {
      return {
        rate: cached.rate,
        source: 'targeted_cache_stale_after_fetch_error',
        ageMs: cachedAgeMs,
        fetchError: errorMessage,
      };
    }

    throw lastError ?? new Error(`[${exchange}] funding revalidate failed for ${symbol}`);
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

    this.pruneFundingUniverseCache();
    const now = Date.now();
    if (now - this.lastFeeCacheRefresh > ServerSimScheduler.FEE_CACHE_REFRESH_INTERVAL_MS) {
      this.lastFeeCacheRefresh = now;
      refreshAllFeeCaches({}).catch(() => {});
    }

    const fullRefresh = this.shouldRunFullFundingRefresh(now);
    const wsWarmSymbols = this.buildFastFundingSymbols(now);
    this.prewarmWsMarketData(now, wsWarmSymbols);
    const fastSymbols = fullRefresh ? new Map<ExchangeId, string[]>() : wsWarmSymbols;

    let results = await Promise.allSettled(
      this.config.enabledExchanges.map((exchange) => {
        const symbols = fullRefresh ? undefined : fastSymbols.get(exchange);
        if (symbols && symbols.length > 0) {
          return fetchFundingRates(exchange, undefined, symbols);
        }
        return getFundingExchangeSnapshot(exchange).then((snapshot) => snapshot.rates);
      }),
    );

    let allRates: FundingRate[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allRates.push(...result.value);
      }
    }

    let effectiveFullRefresh = fullRefresh;
    if (allRates.length === 0 && !fullRefresh) {
      results = await Promise.allSettled(
        this.config.enabledExchanges.map((exchange) =>
          getFundingExchangeSnapshot(exchange).then((snapshot) => snapshot.rates),
        ),
      );
      allRates = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allRates.push(...result.value);
        }
      }
      effectiveFullRefresh = true;
    }

    if (effectiveFullRefresh && allRates.length > 0) {
      this.updateFundingUniverseCacheFromRates(allRates, now);
      this.lastFullFundingRefreshAt = now;
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
    try {
      saveOpportunityHourlySnapshot({
        source: 'server_sim_scheduler',
        exchanges: this.config.enabledExchanges,
        rates: allRates,
        opportunities: this.opportunities,
        capturedAt: now,
      });
    } catch {
      // Ignore snapshot persistence failures.
    }
    this.lastRatesUpdate = Date.now();

    const markedState = this.updatePositionMarks(this.getState());
    this.setState(markedState);
    await this.rebuildSchedules(markedState, { fullRefresh: effectiveFullRefresh });
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

  private async rebuildSchedules(
    state: SimStateSnapshot,
    options: { fullRefresh?: boolean } = {},
  ) {
    if (!this.active) {
      this.scheduledEntries.clear();
      return;
    }

    const now = Date.now();
    const previousEntries = this.scheduledEntries;
    const timing = this.getTimingConfig();
    const availableBalance = { ...state.simBalances } as Record<string, number>;
    const prePlanBalances = { ...availableBalance } as Record<string, number>;
    const balancePlan = buildBalanceEqualizationPlan(this.config.enabledExchanges, availableBalance);
    const planningBalances = getBalanceEqualizationPlanningBalances(balancePlan, true);
    const minVolume24hUSD = Math.max(0, this.config.minVolume24hUSD ?? 0);
    const volumeByExchangeAsset = buildVolumeByExchangeAsset(this.latestRates);
    const strategyConfig = buildStrategyLikeConfig(this.config);
    const snipeConfig = this.config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
    const occupiedLegs = new Set<string>();
    const planProbeAllocation = getMinExecutableAllocationUSDT(this.config.investmentUSDT, this.config.leverage);

    for (const position of state.simPositions) {
      occupiedLegs.add(makePositionLegKey(position.exchange, position.symbol));
    }

    const candidates = this.opportunities.filter((opportunity) => {
      if (!this.config.enabledExchanges.includes(opportunity.shortExchange) || !this.config.enabledExchanges.includes(opportunity.longExchange)) {
        return false;
      }
      // v2: Tier C filter
      if (hasTierCExchange(opportunity.shortExchange, opportunity.longExchange)) {
        const tierCEx = opportunity.shortExchange === 'bingx' ? opportunity.shortExchange : opportunity.longExchange;
        if (!this.config.enabledExchanges.includes(tierCEx)) return false;
      }
      const volumeStatus = resolveOpportunityVolumeStatus(opportunity, minVolume24hUSD, volumeByExchangeAsset);
      if (volumeStatus.belowMin) {
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
      const preEntryProbeInvestment = planProbeAllocation;
      const preEntryEv = passesPreEntryEVAtAllocation(
        opportunity,
        strategyConfig,
        preEntryProbeInvestment,
      );
      if (!preEntryEv || preEntryEv.expectedNetUSD <= 0) {
        return false;
      }
      const shortRate = this.latestRates.find(r => r.exchange === opportunity.shortExchange && r.symbol === opportunity.shortSymbol);
      const longRate = this.latestRates.find(r => r.exchange === opportunity.longExchange && r.symbol === opportunity.longSymbol);
      if (snipeConfig.useConfirmedClose && shortRate && longRate) {
        const tsDiff = Math.abs(shortRate.nextFundingTime - longRate.nextFundingTime);
        if (tsDiff > MAX_FUNDING_TIMESTAMP_DIFF_MS) return false;
      }
      const profileLeadMs = getPairEntryLeadMs(opportunity.shortExchange, opportunity.longExchange);
      const entryLeadMs = Math.max(profileLeadMs, timing.entryLeadMs);
      const targetTime = opportunity.nextFundingTime - entryLeadMs;
      if (targetTime <= now + SCHEDULE_REPLAN_FREEZE_MS) {
        // Keep near-due schedules stable to avoid cancel/replan churn right before funding.
        const oppId = getOpportunityId(opportunity);
        if (previousEntries.has(oppId)) {
          return true;
        }
        // Still allow newly discovered entries as long as they are not already due this tick.
        return targetTime > now + NEAR_DUE_GRACE_MS;
      }
      return targetTime <= now + getScheduleAheadWindowMs(opportunity);
    });

    const plans = await planWindowAllocations(
      candidates,
      availableBalance,
      strategyConfig,
      planningBalances,
      balancePlan,
    );
    this.captureSchedulingAnalyticsSnapshot({
      now,
      state,
      prePlanBalances,
      occupiedLegs,
      previousEntries,
      candidates,
      plans,
      timing,
    });

    const nextEntries = new Map<string, ScheduledSimEntry>();
    const scheduledProbeEvents: TradeEvent[] = [];
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
      const scheduleChanged = !previousEntry
        || Math.abs(previousEntry.targetTime - targetTime) > 60_000
        || Math.abs(previousEntry.investmentUSDT - plan.investmentUSDT) > 0.0001;
      if (scheduleChanged) {
        scheduledProbeEvents.push(this.buildScheduleProbeEvent(
          'scheduled',
          plan.opportunity,
          plan.investmentUSDT,
          now,
          {
            status: 'scheduled',
            reason: 'scheduled',
            timeToExecutionMs: targetTime - now,
            analysis: {
              opportunityId,
              probeId,
              scheduleAction: previousEntry ? 'updated' : 'created',
              targetTimeMs: targetTime,
              targetTimeInMs: targetTime - now,
              fundingTimeMs: plan.opportunity.nextFundingTime,
              entryLeadMs: entryLead,
              selectedAllocationUSDT: plan.investmentUSDT,
            },
          },
        ));
      }
    }

    const getReserveCost = (entry: ScheduledSimEntry, exchange: ExchangeId) => {
      const feeRate = resolveRuntimeFee(
        exchange,
        'taker',
        strategyConfig.feeOverrides,
        strategyConfig.paybackOverrides,
      );
      return entry.investmentUSDT * (1 + (strategyConfig.leverage * feeRate));
    };
    const reservedCostByExchange = new Map<ExchangeId, number>();
    const reservedLegs = new Set<string>();
    const reserveEntry = (entry: ScheduledSimEntry) => {
      for (const legKey of getOpportunityLegKeys(entry.opportunity)) {
        reservedLegs.add(legKey);
      }
      for (const exchange of [entry.opportunity.shortExchange, entry.opportunity.longExchange]) {
        reservedCostByExchange.set(
          exchange,
          (reservedCostByExchange.get(exchange) ?? 0) + getReserveCost(entry, exchange),
        );
      }
    };
    for (const entry of nextEntries.values()) {
      reserveEntry(entry);
    }
    const canRetainPreviousEntry = (entry: ScheduledSimEntry) => {
      if (entry.targetTime <= now + NEAR_DUE_GRACE_MS) return false;
      if (entry.targetTime > now + SCHEDULE_STICKY_KEEP_MS) return false;
      if (getOpportunityLegKeys(entry.opportunity).some((legKey) => reservedLegs.has(legKey) || occupiedLegs.has(legKey))) {
        return false;
      }
      for (const exchange of [entry.opportunity.shortExchange, entry.opportunity.longExchange]) {
        const reserved = reservedCostByExchange.get(exchange) ?? 0;
        const balance = prePlanBalances[exchange] ?? 0;
        if (reserved + getReserveCost(entry, exchange) > balance + 0.0001) {
          return false;
        }
      }
      return true;
    };

    // Keep previous schedules alive until their target time. The final
    // executeDueEntries path performs the orderbook EV check at the actual
    // entry moment, so interim EV flips should not cancel the route early.
    for (const [opportunityId, previousEntry] of previousEntries.entries()) {
      if (nextEntries.has(opportunityId)) continue;
      if (previousEntry.targetTime <= now && now - previousEntry.targetTime <= OVERDUE_EXECUTION_KEEP_MS) {
        nextEntries.set(opportunityId, previousEntry);
        reserveEntry(previousEntry);
        continue;
      }
      if (previousEntry.targetTime > now && previousEntry.targetTime <= now + NEAR_DUE_GRACE_MS) {
        nextEntries.set(opportunityId, previousEntry);
        reserveEntry(previousEntry);
        continue;
      }
      if (
        previousEntry.targetTime > now + EXECUTABLE_REVALIDATE_CANCEL_WINDOW_MS
        && (
          (!options.fullRefresh && previousEntry.targetTime > now + NEAR_DUE_GRACE_MS)
          || canRetainPreviousEntry(previousEntry)
        )
      ) {
        nextEntries.set(opportunityId, previousEntry);
        reserveEntry(previousEntry);
      }
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
      canceledProbeEvents.push(this.buildScheduleProbeEvent(
        'canceled_before_execute',
        previousEntry.opportunity,
        previousEntry.investmentUSDT,
        now,
        {
          status: 'canceled',
          reason: 'schedule_replanned',
          timeToExecutionMs,
          shortSlippagePercent: probeState.lastShortSlippagePercent,
          longSlippagePercent: probeState.lastLongSlippagePercent,
        },
      ));
    }

    this.scheduledEntries = nextEntries;
    const lifecycleEvents = [...scheduledProbeEvents, ...canceledProbeEvents];
    if (lifecycleEvents.length > 0) {
      this.recordTrades(lifecycleEvents);
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
      const scheduledFundingTime = entry.opportunity.nextFundingTime;
      const scheduledIntervalMs = entry.opportunity.fundingIntervalMs && entry.opportunity.fundingIntervalMs > 0
        ? entry.opportunity.fundingIntervalMs
        : 8 * 3600000;
      const latestCycleAdvanced = !!latestById
        && Number.isFinite(latestById.nextFundingTime)
        && latestById.nextFundingTime - scheduledFundingTime >= scheduledIntervalMs / 2;
      const primaryOpportunity = isRouteOverridden || latestCycleAdvanced
        ? entry.opportunity
        : (latestById ?? entry.opportunity);
      if (!probeState.executeCaptured) {
        this.recordTrades([this.buildScheduleProbeEvent(
          'execute',
          primaryOpportunity,
          entry.investmentUSDT,
          now,
          {
            status: probeState.status,
            timeToExecutionMs: entry.targetTime - now,
            shortSlippagePercent: probeState.lastShortSlippagePercent,
            longSlippagePercent: probeState.lastLongSlippagePercent,
          },
        )]);
        probeState.executeCaptured = true;
        this.scheduleProbeStates.set(probeState.probeId, probeState);
      }

      const primaryResult = await this.executeOpportunity(primaryOpportunity, entry.investmentUSDT, true, scheduledFundingTime);
      if (primaryResult.success) {
        const executedAt = Date.now();
        if (Number.isFinite(primaryResult.shortSlippagePercent)) {
          probeState.lastShortSlippagePercent = primaryResult.shortSlippagePercent;
        }
        if (Number.isFinite(primaryResult.longSlippagePercent)) {
          probeState.lastLongSlippagePercent = primaryResult.longSlippagePercent;
        }
        probeState.executeResultCaptured = true;
        probeState.status = 'executed';
        probeState.executedAt = executedAt;
        probeState.fundingCapturedAt = undefined;
        probeState.fundingBaseShortMid = undefined;
        probeState.fundingBaseLongMid = undefined;
        probeState.fundingBaseBasisBps = undefined;
        probeState.pairId = primaryResult.pairId;
        probeState.executedNotional = primaryResult.executedNotional;
        probeState.postMilestones = [];
        probeState.postFundingMilestones = [];
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
            shortSlippagePercent: probeState.lastShortSlippagePercent,
            longSlippagePercent: probeState.lastLongSlippagePercent,
          },
        )]);
        continue;
      }

      const failedAt = Date.now();
      const failureReason = mapSimEntryErrorToGuardReason(primaryResult.error);

      // Scenario C (ORDERBOOK_DEFER_ENABLED=true): when the failure is purely
      // an orderbook-availability problem, requeue the entry for the next
      // funding cycle instead of recording a terminal failure. Cap by
      // deferralCount so a permanently broken symbol cannot loop. Default OFF
      // preserves the existing immediate-fail behaviour.
      const deferFlags = getRelaxGuardsFlags();
      const deferralCount = entry.deferralCount ?? 0;
      const canDefer = deferFlags.orderbookDeferEnabled
        && failureReason === 'orderbook_unavailable'
        && deferralCount < MAX_DEFERRALS_PER_ENTRY;
      if (canDefer) {
        const baseFundingMs = primaryOpportunity.fundingIntervalMs && primaryOpportunity.fundingIntervalMs > 0
          ? primaryOpportunity.fundingIntervalMs
          : 8 * 3600000;
        const nextFundingTime = scheduledFundingTime + baseFundingMs;
        const lead = Math.max(0, this.config.timingConfig?.entryLeadMs ?? 7000);
        const newTargetTime = nextFundingTime - lead;
        const newProbeId = `${entry.opportunityId}@${nextFundingTime}`;
        const deferredOpportunity: ArbitrageOpportunity = {
          ...primaryOpportunity,
          nextFundingTime,
        };
        const deferredEntry: ScheduledSimEntry = {
          opportunityId: entry.opportunityId,
          probeId: newProbeId,
          asset: entry.asset,
          opportunity: deferredOpportunity,
          targetTime: newTargetTime,
          investmentUSDT: entry.investmentUSDT,
          deferralCount: deferralCount + 1,
        };
        this.scheduledEntries.set(entry.opportunityId, deferredEntry);
        probeState.lastReason = 'deferred_to_next_cycle';
        this.scheduleProbeStates.set(probeState.probeId, probeState);
        this.recordTrades([
          this.buildScheduleProbeEvent(
            'deferred_to_next_cycle',
            primaryOpportunity,
            entry.investmentUSDT,
            failedAt,
            {
              status: 'scheduled',
              reason: 'orderbook_unavailable_deferred',
              timeToExecutionMs: newTargetTime - failedAt,
              analysis: {
                failureReason,
                primaryAnalysis: primaryResult.analysis ?? null,
                primaryError: primaryResult.error ?? null,
                deferralCount: deferralCount + 1,
                nextFundingTime,
                newProbeId,
              },
            },
          ),
        ]);
        continue;
      }

      if (Number.isFinite(primaryResult.shortSlippagePercent)) {
        probeState.lastShortSlippagePercent = primaryResult.shortSlippagePercent;
      }
      if (Number.isFinite(primaryResult.longSlippagePercent)) {
        probeState.lastLongSlippagePercent = primaryResult.longSlippagePercent;
      }
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
            shortSlippagePercent: probeState.lastShortSlippagePercent,
            longSlippagePercent: probeState.lastLongSlippagePercent,
            analysis: {
              failureReason,
              primaryAnalysis: primaryResult.analysis ?? null,
              primaryError: primaryResult.error ?? null,
            },
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
          analysis: {
            failureReason,
            primaryAnalysis: primaryResult.analysis ?? null,
          },
          detail: primaryResult.error ?? 'unknown',
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
    const fundedPairIds = new Set<string>();
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
      if (position.pairId) {
        fundedPairIds.add(position.pairId);
      }
      changed = true;

      const updatedFundingReceived = (position.fundingReceived ?? 0) + 1;
      if (position.isSnipe && position.pairId && updatedFundingReceived >= 1) {
        // v2: confirmed close ??model settlement wait window for realistic SIM KPI
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
    if (fundedPairIds.size > 0) {
      for (const probeState of this.scheduleProbeStates.values()) {
        if (
          probeState.status === 'executed'
          && probeState.pairId
          && fundedPairIds.has(probeState.pairId)
          && probeState.fundingCapturedAt == null
        ) {
          probeState.fundingCapturedAt = now;
          this.scheduleProbeStates.set(probeState.probeId, probeState);
        }
      }
    }
    const persisted = tradeEvents.length > 0 ? this.recordTrades(tradeEvents) : null;
    if (fundingEvents.length > 0) {
      const totalFunding = fundingEvents.reduce((sum, payment) => sum + payment.amount, 0);
      const lines = fundingEvents.map((payment) =>
        `  ${payment.exchange.toUpperCase()} ${payment.symbol} (${payment.side}): ${payment.amount >= 0 ? '+' : ''}$${payment.amount.toFixed(4)}`,
      );
      const persistenceNote = persisted ? formatPersistenceTelegramNote(persisted.events) : undefined;
      void sendTelegramMessage(
        [
          `${totalFunding >= 0 ? '💰' : '💸'} <b>[SIM] 펀딩 수령: ${fundingEvents.length}건</b>`,
          ...lines,
          ...(persistenceNote ? [persistenceNote] : []),
          `합계: ${totalFunding >= 0 ? '+' : ''}$${totalFunding.toFixed(4)}`,
        ].join('\n'),
        {
          kind: 'funding',
          structured: { totalFunding, fundingEvents: fundingEvents.length },
        },
      );
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
    if (pairPositions.length === 0) return;
    const closeInvestmentUSDT = pairPositions.reduce((sum, position) => sum + Math.max(0, position.margin), 0);

    const closeStartedAt = Date.now();
    let preparedLegs: PreparedSimCloseLeg[];
    try {
      preparedLegs = await Promise.all(
        pairPositions.map((position) => this.prepareCloseLeg(position)),
      );
    } catch (err) {
      const failedAt = Date.now();
      this.pendingAutoCloses.set(pairId, failedAt + 5_000);
      this.recordTrades([{
        timestamp: failedAt,
        type: 'exit_failed',
        simulation: true,
        baseAsset: pairPositions[0]?.baseAsset ?? 'UNKNOWN',
        shortExchange: pairPositions.find((position) => position.side === 'short')?.exchange,
        longExchange: pairPositions.find((position) => position.side === 'long')?.exchange,
        pairId,
        reason: 'close_orderbook_unavailable',
        detail: getErrorMessage(err),
      }]);
      return;
    }
    const closeFinishedAt = Date.now();
    const fillCapturedAts = preparedLegs.map((leg) => leg.fillCapturedAt);
    const pairCloseGapMs = fillCapturedAts.length > 1
      ? Math.max(...fillCapturedAts) - Math.min(...fillCapturedAts)
      : 0;
    const closeWindowMs = closeFinishedAt - closeStartedAt;

    const fundingEvents: FundingPayment[] = [];
    const tradeEvents: TradeEvent[] = [];
    const fundedPairIds = new Set<string>();

    for (const leg of preparedLegs) {
      const returnAmount = leg.position.margin + leg.pricePnl - leg.exitFee;
      const netPnl = leg.pricePnl + leg.actualFunding - (leg.position.entryFee ?? 0) - leg.exitFee;

      state.simPositions = state.simPositions.filter((candidate) => candidate.simId !== leg.position.simId);
      state.simBalances[leg.position.exchange] = (state.simBalances[leg.position.exchange] ?? 0)
        + returnAmount
        + leg.fundingBalanceCredit;
      state.simTotalFees += leg.exitFee;
      state.simTotalClosedPnl += leg.pricePnl;
      state.simClosedPnlPerExchange = {
        ...state.simClosedPnlPerExchange,
        [leg.position.exchange]: (state.simClosedPnlPerExchange[leg.position.exchange] ?? 0) + leg.pricePnl,
      };
      state.simClosedFeesPerExchange = {
        ...state.simClosedFeesPerExchange,
        [leg.position.exchange]: (state.simClosedFeesPerExchange[leg.position.exchange] ?? 0)
          + (leg.position.entryFee ?? 0)
          + leg.exitFee,
      };

      if (leg.fundingPayment) {
        fundingEvents.push(leg.fundingPayment);
        state.simTotalFundingEarned += leg.actualFunding;
        if (leg.position.pairId) {
          fundedPairIds.add(leg.position.pairId);
        }
        tradeEvents.push({
          timestamp: leg.fillCapturedAt,
          type: 'funding',
          simulation: true,
          baseAsset: leg.position.baseAsset,
          exchange: leg.position.exchange,
          side: leg.position.side,
          symbol: leg.position.symbol,
          pairId: leg.position.pairId,
          fundingAmount: leg.actualFunding,
          fundingRate: leg.position.fundingRate,
          detail: `pairCloseGapMs:${pairCloseGapMs} closeWindowMs:${closeWindowMs}`,
        });
      }

      tradeEvents.push({
        timestamp: leg.fillCapturedAt,
        type: leg.position.isSnipe ? 'snipe_exit' : 'exit',
        simulation: true,
        baseAsset: leg.position.baseAsset,
        exchange: leg.position.exchange,
        side: leg.position.side,
        symbol: leg.position.symbol,
        pairId: leg.position.pairId,
        pnl: netPnl,
        fundingAmount: leg.actualFunding,
        exitFee: leg.exitFee,
        entryFee: leg.position.entryFee ?? 0,
        pricePnl: leg.pricePnl,
        exitPrice: leg.exitPrice,
        analysis: {
          exitMidPrice: leg.exitMidPrice,
          exitWorstPrice: leg.exitWorstPrice,
          exitSlippagePercent: leg.exitSlippagePercent,
          fillSource: leg.fillSource,
        },
        detail: `fill:${leg.fillSource} exitSlip:${leg.exitSlippagePercent.toFixed(6)}% pairCloseGapMs:${pairCloseGapMs} closeWindowMs:${closeWindowMs}`,
      });
    }
    const closeNetProfitUSD = preparedLegs.reduce((sum, leg) => (
      sum + leg.pricePnl + leg.actualFunding - (leg.position.entryFee ?? 0) - leg.exitFee
    ), 0);
    const closeFundingUSD = preparedLegs.reduce((sum, leg) => sum + leg.actualFunding, 0);
    const closePricePnlUSD = preparedLegs.reduce((sum, leg) => sum + leg.pricePnl, 0);
    const closeEntryFeesUSD = preparedLegs.reduce((sum, leg) => sum + (leg.position.entryFee ?? 0), 0);
    const closeExitFeesUSD = preparedLegs.reduce((sum, leg) => sum + leg.exitFee, 0);
    const closeFeesUSD = closeEntryFeesUSD + closeExitFeesUSD;
    const closeImpactPercent = preparedLegs.reduce((sum, leg) => sum + leg.exitSlippagePercent, 0);
    const shortLeg = pairPositions.find((position) => position.side === 'short');
    const longLeg = pairPositions.find((position) => position.side === 'long');
    const closeNotionals = preparedLegs.map((leg) => leg.position.sizeUSD).filter((value) => value > 0);
    const closeNotionalUSDT = closeNotionals.length > 0 ? Math.min(...closeNotionals) : 0;

    if (pairPositions.some((position) => position.isSnipe)) {
      tradeEvents.push({
        timestamp: closeFinishedAt,
        type: 'snipe_complete',
        simulation: true,
        baseAsset: pairPositions[0]?.baseAsset ?? 'UNKNOWN',
        shortExchange: shortLeg?.exchange,
        longExchange: longLeg?.exchange,
        pairId,
        margin: closeInvestmentUSDT > 0 ? closeInvestmentUSDT / 2 : 0,
        leverage: pairPositions[0]?.leverage ?? this.config.leverage,
        notional: closeNotionalUSDT,
        fundingCollected: closeFundingUSD,
        pnl: closeNetProfitUSD,
        pricePnl: closePricePnlUSD,
        entryFee: closeEntryFeesUSD,
        exitFee: closeExitFeesUSD,
        analysis: {
          closeImpactPercent,
          legs: preparedLegs.map((leg) => ({
            exchange: leg.position.exchange,
            side: leg.position.side,
            exitSlippagePercent: leg.exitSlippagePercent,
            exitMidPrice: leg.exitMidPrice,
            exitWorstPrice: leg.exitWorstPrice,
            exitPrice: leg.exitPrice,
          })),
        },
        detail: `fundingVerified:true fundingEvents:${fundingEvents.length} pricePnl:${closePricePnlUSD.toFixed(6)} fees:${closeFeesUSD.toFixed(6)} closeImpact:${closeImpactPercent.toFixed(6)}% pairCloseGapMs:${pairCloseGapMs} closeWindowMs:${closeWindowMs}`,
      });
    }

    if (fundingEvents.length > 0) {
      state.fundingHistory = [...fundingEvents, ...state.fundingHistory]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_FUNDING_HISTORY);
    }

    this.setState(state);
    if (fundedPairIds.size > 0) {
      for (const probeState of this.scheduleProbeStates.values()) {
        if (
          probeState.status === 'executed'
          && probeState.pairId
          && fundedPairIds.has(probeState.pairId)
          && probeState.fundingCapturedAt == null
        ) {
          probeState.fundingCapturedAt = closeFinishedAt;
          this.scheduleProbeStates.set(probeState.probeId, probeState);
        }
      }
    }
    this.pendingAutoCloses.delete(pairId);
    const persisted = tradeEvents.length > 0 ? this.recordTrades(tradeEvents) : null;
    const persistedEvents = persisted?.events ?? tradeEvents;
    const pairEventsForTelegram = listTradeHistoryDates('sim')
      .flatMap((date) => readTradeHistory('sim', date))
      .filter((event) => event.pairId === pairId);
    const completedPair = buildTradePairsFromEvents(
      pairEventsForTelegram.length > 0 ? pairEventsForTelegram : persistedEvents,
    ).find((pair) => pair.pairId === pairId);
    if (completedPair) {
      void sendTelegramMessage(
        formatTradePairTelegramMessage(completedPair, 'close', {
          currentTotalBalanceUSDT: this.getCurrentSimBalanceTotal(state),
          note: formatPersistenceTelegramNote(persistedEvents, pairId),
        }),
        {
          kind: 'exit',
          pairId,
          symbol: completedPair.baseAsset,
          exchanges: `${completedPair.shortExchange}/${completedPair.longExchange}`,
          structured: {
            realPnl: completedPair.totalPnl,
            totalFunding: completedPair.totalFunding,
            totalPricePnl: completedPair.totalPricePnl,
            totalFees: completedPair.totalFees,
            margin: completedPair.margin,
            notional: completedPair.notional,
            leverage: completedPair.leverage,
            spreadPercent: completedPair.spreadPercent,
            expNet: completedPair.expectedProfit,
            expectedRoiPercent: completedPair.expectedRoiPercent,
            realizedRoiPercent: completedPair.realizedRoiPercent,
          },
        },
      );
    }
  }

  private async prepareCloseLeg(position: SimPosition): Promise<PreparedSimCloseLeg> {
    let exitPrice = position.markPrice;
    let exitMidPrice = position.markPrice;
    let exitWorstPrice = position.markPrice;
    let exitSlippagePercent = 0;
    const fillSource = 'orderbook' as const;
    try {
      const fill = await fetchMarketFillPrice(
        position.exchange,
        position.symbol,
        position.side === 'short' ? 'buy' : 'sell',
        position.sizeUSD,
      );
      exitPrice = fill.fillPrice;
      exitMidPrice = fill.midPrice;
      exitWorstPrice = fill.worstPrice;
      exitSlippagePercent = fill.slippagePercent;
    } catch (err) {
      throw new Error(`close orderbook unavailable for ${position.exchange} ${position.symbol} ${position.side}: ${getErrorMessage(err)}`);
    }
    const fillCapturedAt = Date.now();

    const exitNotional = position.size * exitPrice;
    const exitFee = exitNotional * resolveRuntimeFee(
      position.exchange,
      'taker',
      this.config.feeOverrides,
      this.config.paybackOverrides,
    );
    const pricePnl = position.side === 'short'
      ? (position.entryPrice - exitPrice) * position.size
      : (exitPrice - position.entryPrice) * position.size;

    let actualFunding = position.fundingCollected;
    let fundingBalanceCredit = 0;
    let fundingPayment: FundingPayment | undefined;

    if (position.isSnipe && actualFunding === 0) {
      actualFunding = position.side === 'short'
        ? position.sizeUSD * position.fundingRate
        : position.sizeUSD * (-position.fundingRate);
      fundingBalanceCredit = actualFunding;
      fundingPayment = {
        exchange: position.exchange,
        symbol: position.symbol,
        amount: actualFunding,
        rate: position.fundingRate,
        timestamp: fillCapturedAt,
        side: position.side,
      };
    }

    return {
      position,
      exitPrice,
      exitMidPrice,
      exitWorstPrice,
      exitSlippagePercent,
      exitFee,
      pricePnl,
      actualFunding,
      fundingBalanceCredit,
      fundingPayment,
      fillSource,
      fillCapturedAt,
    };
  }

  private async closePositionInternal(simId: string): Promise<{ netPnl: number; funding: number; pairId?: string } | null> {
    const state = this.getState();
    const position = state.simPositions.find((candidate) => candidate.simId === simId);
    if (!position) return null;

    let exitPrice = position.markPrice;
    let exitSlippagePercent = 0;
    try {
      const fill = await fetchMarketFillPrice(
        position.exchange,
        position.symbol,
        position.side === 'short' ? 'buy' : 'sell',
        position.sizeUSD,
      );
      exitPrice = fill.fillPrice;
      exitSlippagePercent = fill.slippagePercent;
    } catch (err) {
      this.recordTrades([{
        timestamp: Date.now(),
        type: 'exit_failed',
        simulation: true,
        baseAsset: position.baseAsset,
        exchange: position.exchange,
        side: position.side,
        symbol: position.symbol,
        pairId: position.pairId,
        reason: 'close_orderbook_unavailable',
        detail: getErrorMessage(err),
      }]);
      return null;
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
      fundingHistory = [payment, ...fundingHistory].sort((a, b) => b.timestamp - a.timestamp);
      fundingHistory = fundingHistory.slice(0, MAX_FUNDING_HISTORY);
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
    if (position.pairId && actualFunding !== 0) {
      for (const probeState of this.scheduleProbeStates.values()) {
        if (
          probeState.status === 'executed'
          && probeState.pairId === position.pairId
          && probeState.fundingCapturedAt == null
        ) {
          probeState.fundingCapturedAt = Date.now();
          this.scheduleProbeStates.set(probeState.probeId, probeState);
        }
      }
    }
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
        detail: `fill:orderbook exitSlip:${exitSlippagePercent.toFixed(6)}%`,
      },
    ]);
    const manualCloseInvestmentUSDT = Math.max(0, position.margin);
    const manualCloseRoiPercent = manualCloseInvestmentUSDT > 0
      ? (netPnl / manualCloseInvestmentUSDT) * 100
      : 0;
    this.notifySimTradeSuccess({
      phase: '수동청산',
      baseAsset: position.baseAsset,
      investmentUSDT: manualCloseInvestmentUSDT,
      netProfitUSD: netPnl,
      roiPercent: manualCloseRoiPercent,
      currentTotalBalanceUSDT: this.getCurrentSimBalanceTotal(state),
      fundingUSD: actualFunding,
      pricePnlUSD: pricePnl,
      feesUSD: (position.entryFee ?? 0) + exitFee,
      pairId: position.pairId,
      route: `${position.exchange.toUpperCase()} ${position.side.toUpperCase()} ${position.symbol}`,
    });

    return { netPnl, funding: actualFunding, pairId: position.pairId };
  }

  private async executeOpportunity(
    opportunity: ArbitrageOpportunity,
    investmentUSDT: number,
    isSnipe: boolean,
    targetFundingTime = opportunity.nextFundingTime,
  ): Promise<SimTradeResult> {
    const spreadAcceptanceThreshold = getSpreadAcceptanceThreshold(this.config.minSpreadPercent);
    if (!isSnipe && opportunity.spreadPercent < spreadAcceptanceThreshold) {
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

    // v2: Tier C filter ??skip unless explicitly enabled
    if (hasTierCExchange(opportunity.shortExchange, opportunity.longExchange)) {
      const tierCEx = opportunity.shortExchange === 'bingx' ? opportunity.shortExchange : opportunity.longExchange;
      if (!this.config.enabledExchanges.includes(tierCEx)) {
        return { success: false, error: `Tier C exchange ${tierCEx} not enabled` };
      }
    }

    const requestedMargin = Math.max(0, investmentUSDT);
    let margin = requestedMargin;
    const leverage = this.config.leverage;
    const baseNotional = requestedMargin * leverage;
    if (baseNotional <= 0) {
      return { success: false, error: 'invalid notional' };
    }

    const snipeConfig = this.config.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
    let shortRateForDecision = opportunity.shortRate;
    let longRateForDecision = opportunity.longRate;
    let spreadForDecision = opportunity.spread;
    let spreadPercentForDecision = opportunity.spreadPercent;
    const shortBal = state.simBalances[opportunity.shortExchange] ?? 0;
    const longBal = state.simBalances[opportunity.longExchange] ?? 0;
    const shortInitial = state.simInitialBalances[opportunity.shortExchange] ?? 1;
    const longInitial = state.simInitialBalances[opportunity.longExchange] ?? 1;
    const shortFreeRatio = shortInitial > 0 ? (shortBal / shortInitial) * 100 : 0;
    const longFreeRatio = longInitial > 0 ? (longBal / longInitial) * 100 : 0;
    const shortFeeInfo = resolveRuntimeFeeDetailed(
      opportunity.shortExchange,
      'taker',
      this.config.feeOverrides,
      this.config.paybackOverrides,
    );
    const longFeeInfo = resolveRuntimeFeeDetailed(
      opportunity.longExchange,
      'taker',
      this.config.feeOverrides,
      this.config.paybackOverrides,
    );
    const shortFeeRate = shortFeeInfo.fee;
    const longFeeRate = longFeeInfo.fee;
    const shortCostFactor = 1 + (leverage * shortFeeRate);
    const longCostFactor = 1 + (leverage * longFeeRate);
    const maxFeasibleMarginByBalance = Math.max(0, Math.min(
      shortCostFactor > 0 ? shortBal / shortCostFactor : 0,
      longCostFactor > 0 ? longBal / longCostFactor : 0,
    ));
    const baselineEntryGap = getEntryGapMetrics({
      shortPrice: opportunity.shortMarkPrice,
      longPrice: opportunity.longMarkPrice,
    });
    const buildCounterfactualEv = (
      notionalRef: number,
      shortImpactPct?: number,
      longImpactPct?: number,
    ) => {
      if (!Number.isFinite(notionalRef) || notionalRef <= 0) return null;
      const usesInstantRate = pairUsesInstantaneousRate(
        opportunity.shortExchange,
        opportunity.longExchange,
      );
      const shortDrift = snipeConfig.useDriftBuffer
        ? calcDriftBuffer(shortRateForDecision, undefined, usesInstantRate)
        : 0;
      const longDrift = snipeConfig.useDriftBuffer
        ? calcDriftBuffer(longRateForDecision, undefined, usesInstantRate)
        : 0;
      const fallbackImpactDec = snipeConfig.useImpactGuards
        ? (snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 10000 / 2
        : (snipeConfig.targetImpactBps ?? 4) / 10000;
      const shortImpactDec = Number.isFinite(shortImpactPct) ? (shortImpactPct as number) / 100 : fallbackImpactDec;
      const longImpactDec = Number.isFinite(longImpactPct) ? (longImpactPct as number) / 100 : fallbackImpactDec;
      const roundTripFeeDec = (shortFeeRate + longFeeRate) * 2;
      const factors = [0.25, 0.5, 0.75, 1];
      const out: Record<string, number> = {};
      for (const factor of factors) {
        const scaledNotional = notionalRef * factor;
        const ev = calcConservativeEV(
          scaledNotional,
          shortRateForDecision,
          longRateForDecision,
          shortDrift,
          longDrift,
          roundTripFeeDec,
          shortImpactDec,
          longImpactDec,
          {
            basisConvergenceReservePct: basisReservePctFromEntryGap(0, baselineEntryGap.liveGapPercent),
            volumeLiquidityReservePct: UNKNOWN_VOLUME_RESERVE_BPS / 10000,
          },
        );
        out[`evNetUSD_${Math.round(factor * 100)}pct`] = ev.expectedNetUSD;
        out[`evRatio_${Math.round(factor * 100)}pct`] = ev.evRatio;
      }
      return out;
    };
    const buildFailureAnalysis = (args?: {
      attemptedNotionalUSDT?: number;
      effectiveNotionalUSDT?: number;
      shortSlippagePercent?: number;
      longSlippagePercent?: number;
      extra?: Record<string, unknown>;
    }): Record<string, unknown> => {
      const attemptedNotionalUSDT = Number.isFinite(args?.attemptedNotionalUSDT)
        ? (args?.attemptedNotionalUSDT as number)
        : baseNotional;
      const effectiveNotionalUSDT = Number.isFinite(args?.effectiveNotionalUSDT)
        ? (args?.effectiveNotionalUSDT as number)
        : attemptedNotionalUSDT;
      return {
        attemptedMarginUSDT: requestedMargin,
        attemptedNotionalUSDT,
        effectiveMarginUSDT: leverage > 0 ? effectiveNotionalUSDT / leverage : 0,
        effectiveNotionalUSDT,
        shortBalanceUSDT: shortBal,
        longBalanceUSDT: longBal,
        shortFreeMarginPct: shortFreeRatio,
        longFreeMarginPct: longFreeRatio,
        minFreeMarginPct: MIN_FREE_MARGIN_PCT,
        maxFeasibleMarginByBalanceUSDT: maxFeasibleMarginByBalance,
        maxFeasibleNotionalByBalanceUSDT: maxFeasibleMarginByBalance * leverage,
        shortSlippagePercent: args?.shortSlippagePercent,
        longSlippagePercent: args?.longSlippagePercent,
        counterfactualEV: buildCounterfactualEv(
          effectiveNotionalUSDT,
          args?.shortSlippagePercent,
          args?.longSlippagePercent,
        ),
        ...(args?.extra ?? {}),
      };
    };

    let liveSpreadBelowConfiguredMin = false;
    try {
      // Live spread revalidation with one re-measurement on failure.
      // Rationale (2026-04-28 review): out of 14 live_spread_reverted blocks in 24h,
      // a handful (~2-3) showed -0.001% ~ -0.01% which is within rate-feed measurement noise.
      // A single 200ms re-fetch gives those a chance to settle to a real positive spread
      // before we discard the opportunity. Clearly inverted spreads (e.g. -0.7%) will fail
      // the same way on retry and remain blocked — this is intentional.
      const LIVE_SPREAD_RECHECK_DELAY_MS = 200;
      const LIVE_SPREAD_RECHECK_ATTEMPTS = 2;
      let shortLiveRate: FundingRate | undefined;
      let longLiveRate: FundingRate | undefined;
      let shortRatesCount = 0;
      let longRatesCount = 0;
      let liveSpread = 0;
      let liveSpreadPercent = 0;
      let liveSpreadAttempts = 0;
      let shortRevalidateSource: ExecutionFundingRateLookup['source'] | undefined;
      let longRevalidateSource: ExecutionFundingRateLookup['source'] | undefined;
      let shortRevalidateAgeMs: number | undefined;
      let longRevalidateAgeMs: number | undefined;
      let shortRevalidateFetchError: string | undefined;
      let longRevalidateFetchError: string | undefined;
      for (let attempt = 0; attempt < LIVE_SPREAD_RECHECK_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, LIVE_SPREAD_RECHECK_DELAY_MS));
        }
        liveSpreadAttempts = attempt + 1;
        const [shortLookup, longLookup] = await Promise.all([
          this.resolveExecutionFundingRate(
            opportunity.shortExchange,
            opportunity.shortSymbol,
            opportunity.baseAsset,
          ),
          this.resolveExecutionFundingRate(
            opportunity.longExchange,
            opportunity.longSymbol,
            opportunity.baseAsset,
          ),
        ]);
        shortRatesCount = 1;
        longRatesCount = 1;
        shortLiveRate = shortLookup.rate;
        longLiveRate = longLookup.rate;
        shortRevalidateSource = shortLookup.source;
        longRevalidateSource = longLookup.source;
        shortRevalidateAgeMs = shortLookup.ageMs;
        longRevalidateAgeMs = longLookup.ageMs;
        shortRevalidateFetchError = shortLookup.fetchError;
        longRevalidateFetchError = longLookup.fetchError;
        if (!shortLiveRate || !longLiveRate) {
          // Missing rate is not a noise condition — fail immediately, no retry.
          break;
        }
        liveSpread = shortLiveRate.rate - longLiveRate.rate;
        liveSpreadPercent = liveSpread * 100;
        if (liveSpreadPercent >= spreadAcceptanceThreshold) break;
      }
      if (!shortLiveRate || !longLiveRate) {
        return {
          success: false,
          error: `funding revalidate missing: short=${shortRatesCount} long=${longRatesCount}`,
          analysis: buildFailureAnalysis({
            attemptedNotionalUSDT: baseNotional,
            extra: {
              shortRevalidateCount: shortRatesCount,
              longRevalidateCount: longRatesCount,
              liveSpreadAttempts,
              shortRevalidateSource,
              longRevalidateSource,
              shortRevalidateAgeMs,
              longRevalidateAgeMs,
              shortRevalidateFetchError,
              longRevalidateFetchError,
            },
          }),
        };
      }

      const liveSpreadNegativeTolerance = isSnipe
        ? SIM_LIVE_SPREAD_NEGATIVE_TOLERANCE_PCT
        : LIVE_SPREAD_NEGATIVE_TOLERANCE_PCT;
      if (liveSpreadPercent < liveSpreadNegativeTolerance) {
        return {
          success: false,
              error: `live spread revalidate failed: ${liveSpreadPercent.toFixed(4)}% < ${liveSpreadNegativeTolerance.toFixed(2)}% (after ${liveSpreadAttempts} attempt${liveSpreadAttempts === 1 ? '' : 's'})`,
          analysis: buildFailureAnalysis({
            attemptedNotionalUSDT: baseNotional,
            extra: {
              liveSpreadPercent,
              minSpreadPercent: spreadAcceptanceThreshold,
              liveSpreadNegativeTolerancePercent: liveSpreadNegativeTolerance,
              executionGate: 'positive_or_small_negative_spread_then_ev',
              liveSpreadAttempts,
              shortRevalidateSource,
              longRevalidateSource,
              shortRevalidateAgeMs,
              longRevalidateAgeMs,
              shortRevalidateFetchError,
              longRevalidateFetchError,
            },
          }),
        };
      }

    liveSpreadBelowConfiguredMin = liveSpreadPercent < spreadAcceptanceThreshold;
      const shortFundingShiftMs = Math.abs(shortLiveRate.nextFundingTime - targetFundingTime);
      const longFundingShiftMs = Math.abs(longLiveRate.nextFundingTime - targetFundingTime);
      const fundingIntervalMs = opportunity.fundingIntervalMs && opportunity.fundingIntervalMs > 0
        ? opportunity.fundingIntervalMs
        : 8 * 3600000;
      // Scenario B (RELAX_FUNDING_WINDOW=true): bumps drift tolerance from 1m
      // to 10m and also accepts shifts that match any of {1h, 4h, 8h} cycles
      // (not only the opportunity's own interval). Default OFF preserves
      // current strict behaviour exactly.
      const relaxFlags = getRelaxGuardsFlags();
      const liveFundingDriftMs = getActiveLiveFundingTimeDriftMs(LIVE_FUNDING_TIME_DRIFT_MS);
      const shortIsRollover = isAcceptableFundingShift(
        shortFundingShiftMs,
        fundingIntervalMs,
        liveFundingDriftMs,
        { allowMultiCycle: relaxFlags.relaxFundingWindow },
      );
      const longIsRollover = isAcceptableFundingShift(
        longFundingShiftMs,
        fundingIntervalMs,
        liveFundingDriftMs,
        { allowMultiCycle: relaxFlags.relaxFundingWindow },
      );
      const shortWithinWindow = shortFundingShiftMs <= liveFundingDriftMs || shortIsRollover;
      const longWithinWindow = longFundingShiftMs <= liveFundingDriftMs || longIsRollover;
      if (!shortWithinWindow || !longWithinWindow) {
        return {
          success: false,
          error: `funding window shift: short=${shortFundingShiftMs}ms long=${longFundingShiftMs}ms`,
          analysis: buildFailureAnalysis({
            attemptedNotionalUSDT: baseNotional,
            extra: {
              shortFundingShiftMs,
              longFundingShiftMs,
              liveFundingTimeDriftMs: liveFundingDriftMs,
              fundingIntervalMs,
              shortIsRollover,
              longIsRollover,
              shortWithinWindow,
              longWithinWindow,
              relaxFundingWindow: relaxFlags.relaxFundingWindow,
              shortRevalidateSource,
              longRevalidateSource,
              shortRevalidateAgeMs,
              longRevalidateAgeMs,
              shortRevalidateFetchError,
              longRevalidateFetchError,
            },
          }),
        };
      }

      if (snipeConfig.useConfirmedClose) {
        const tsDiff = Math.abs(shortLiveRate.nextFundingTime - longLiveRate.nextFundingTime);
        if (tsDiff > MAX_FUNDING_TIMESTAMP_DIFF_MS) {
          return {
            success: false,
            error: `funding timestamp mismatch: ${tsDiff}ms > ${MAX_FUNDING_TIMESTAMP_DIFF_MS}ms`,
            analysis: buildFailureAnalysis({
              attemptedNotionalUSDT: baseNotional,
              extra: {
                fundingTimestampDiffMs: tsDiff,
                maxFundingTimestampDiffMs: MAX_FUNDING_TIMESTAMP_DIFF_MS,
              },
            }),
          };
        }
      }

      shortRateForDecision = shortLiveRate.rate;
      longRateForDecision = longLiveRate.rate;
      spreadForDecision = liveSpread;
      spreadPercentForDecision = liveSpreadPercent;
    } catch (revalidateErr) {
      return {
        success: false,
        error: `funding revalidate error: ${getErrorMessage(revalidateErr)}`,
        analysis: buildFailureAnalysis({
          attemptedNotionalUSDT: baseNotional,
          extra: {
            fundingRevalidateError: getErrorMessage(revalidateErr),
          },
        }),
      };
    }

    if (
      !Number.isFinite(shortFeeInfo.fee)
      || !Number.isFinite(longFeeInfo.fee)
      || shortFeeInfo.fee < 0
      || longFeeInfo.fee < 0
    ) {
      return {
        success: false,
        error: `runtime fee unavailable: ${opportunity.shortExchange}=${shortFeeInfo.fee}(${shortFeeInfo.source}) ${opportunity.longExchange}=${longFeeInfo.fee}(${longFeeInfo.source})`,
        analysis: buildFailureAnalysis({
          attemptedNotionalUSDT: baseNotional,
          extra: {
            shortFeeSource: shortFeeInfo.source,
            longFeeSource: longFeeInfo.source,
            shortFeeRate: shortFeeInfo.fee,
            longFeeRate: longFeeInfo.fee,
          },
        }),
      };
    }

      // Dynamic sizing: choose the largest margin that still has acceptable EV.
      // under the current orderbook. This lets the scheduler use $200 of a
      // $1,000-per-trade budget when only $200 is actually profitable.
      let notional = baseNotional;
      let dynamicSizingFallbackReason: 'none' | 'orderbook_model_unavailable' | 'orderbook_model_below_floor' = 'none';
      if (snipeConfig.useDynamicNotional) {
        try {
        const [shortOb, longOb] = await retryTransientFetch(() => Promise.all([
          fetchOrderbook(opportunity.shortExchange, opportunity.shortSymbol, 50),
          fetchOrderbook(opportunity.longExchange, opportunity.longSymbol, 50),
        ]));
        const maxDynamicInvestment = Math.min(
          requestedMargin,
          snipeConfig.dynamicNotionalCap > 0
            ? snipeConfig.dynamicNotionalCap / Math.max(1, leverage)
            : requestedMargin,
        );
        const minDynamicAllocation = getMinExecutableAllocationUSDT(requestedMargin, leverage);
        const minDynamicInvestment = Math.min(maxDynamicInvestment, minDynamicAllocation);
        const dynamicProfitFloor = getAcceptableNetEvFloor(maxDynamicInvestment);
        const emergencyMinDynamicInvestment = getDynamicSizingEmergencyStart(
          requestedMargin,
          leverage,
          maxDynamicInvestment,
        );
        const findBestSizing = (
          lowerBound: number,
          upperBound: number,
        ) => findMaxProfitableOrderbookSizingSafe(
          opportunity,
          buildStrategyLikeConfig(this.config),
          upperBound,
          lowerBound,
          shortOb,
          longOb,
          {
            shortRate: shortRateForDecision,
            longRate: longRateForDecision,
          },
          dynamicProfitFloor,
        );
        let sizing = findBestSizing(minDynamicInvestment, maxDynamicInvestment);
        let sizingMode: 'primary' | 'emergency' = 'primary';
        if (!sizing && emergencyMinDynamicInvestment > 0 && emergencyMinDynamicInvestment < minDynamicInvestment) {
          const emergencySizing = findBestSizing(
            emergencyMinDynamicInvestment,
            maxDynamicInvestment,
          );
          if (emergencySizing && emergencySizing.expectedNetUSD >= dynamicProfitFloor) {
            sizing = emergencySizing;
            sizingMode = 'emergency';
          }
        }
        if (!sizing || sizing.expectedNetUSD < dynamicProfitFloor) {
          const fallbackMargin = Math.min(
            maxDynamicInvestment,
            Math.max(
              emergencyMinDynamicInvestment,
              Math.min(minDynamicInvestment, maxDynamicInvestment),
            ),
          );
          const fallbackNotional = fallbackMargin * leverage;
          if (fallbackMargin > 0 && Number.isFinite(fallbackNotional) && fallbackNotional > 0) {
            // Simulation fallback: keep trying with executable micro-size instead of
            // dropping the route immediately when orderbook-model EV sizing returns null.
            margin = fallbackMargin;
            notional = fallbackNotional;
            dynamicSizingFallbackReason = sizing
              ? 'orderbook_model_below_floor'
              : 'orderbook_model_unavailable';
          } else {
            return {
              success: false,
              error: `no acceptable executable size: minMargin=$${minDynamicInvestment.toFixed(2)} maxMargin=$${maxDynamicInvestment.toFixed(2)} floor=$${dynamicProfitFloor.toFixed(4)}`,
              analysis: buildFailureAnalysis({
                attemptedNotionalUSDT: baseNotional,
                effectiveNotionalUSDT: sizing?.notionalUSDT ?? 0,
                extra: {
                  dynamicSizing: 'ev_orderbook',
                  minDynamicInvestmentUSDT: minDynamicInvestment,
                  maxDynamicInvestmentUSDT: maxDynamicInvestment,
                  dynamicNotionalCapUSDT: snipeConfig.dynamicNotionalCap,
                  bestExpectedNetUSD: sizing?.expectedNetUSD ?? null,
                  bestExpectedRoiPercent: sizing?.expectedRoiPercent ?? null,
                  bestMarketSnapshot: sizing?.marketSnapshot ?? null,
                  sizingMode,
                },
              }),
            };
          }
        } else {
          notional = sizing.notionalUSDT;
          margin = sizing.investmentUSDT;
        }
      } catch (err) {
        return {
          success: false,
          error: `orderbook unavailable for dynamic notional: ${(err as Error).message ?? err}`,
          analysis: buildFailureAnalysis({
            attemptedNotionalUSDT: baseNotional,
            extra: {
              dynamicNotionalError: (err as Error).message ?? String(err),
            },
          }),
        };
      }
    }

    // v2: free margin guard (simulated)
    if (shortFreeRatio < MIN_FREE_MARGIN_PCT || longFreeRatio < MIN_FREE_MARGIN_PCT) {
      return {
        success: false,
        error: `free margin low: ${opportunity.shortExchange}=${shortFreeRatio.toFixed(1)}% ${opportunity.longExchange}=${longFreeRatio.toFixed(1)}%`,
        analysis: buildFailureAnalysis({
          attemptedNotionalUSDT: baseNotional,
          effectiveNotionalUSDT: notional,
        }),
      };
    }

    let shortFillPrice = opportunity.shortMarkPrice;
    let longFillPrice = opportunity.longMarkPrice;
    let shortSlippagePercent = 0;
    let longSlippagePercent = 0;
    let shortExitSlippagePercent = 0;
    let longExitSlippagePercent = 0;
    let executionMarketSnapshot: ProbeMarketSnapshot | undefined;
    const maxSlippagePct = this.config.maxSlippagePercent ?? 1.5;
    const impactCapBps = snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS;
    const minAdaptiveNotional = MIN_EXECUTABLE_NOTIONAL_USDT;
    const maxAdaptiveAttempts = 4;
    let fillsValidated = false;
    for (let attempt = 0; attempt < maxAdaptiveAttempts; attempt += 1) {
      let shortFill: Awaited<ReturnType<typeof fetchMarketFillPrice>>;
      let longFill: Awaited<ReturnType<typeof fetchMarketFillPrice>>;
      try {
        [shortFill, longFill] = await retryTransientFetch(() => Promise.all([
          fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', notional),
          fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', notional),
        ]));
      } catch (err) {
        // Scenario C (ORDERBOOK_DEFER_ENABLED=true): give the orderbook
        // another chance with longer backoffs (500ms -> 1s -> 2s) before
        // giving up. This addresses the common pattern where Binance WS
        // returns an empty orderbook for low-volume symbols for 1-3 seconds
        // around the funding boundary. The default OFF preserves the current
        // immediate-fail behaviour.
        const orderbookFlags = getRelaxGuardsFlags();
        let recoveredFill: [
          Awaited<ReturnType<typeof fetchMarketFillPrice>>,
          Awaited<ReturnType<typeof fetchMarketFillPrice>>,
        ] | null = null;
        let lastBackoffErr: unknown = err;
        if (orderbookFlags.orderbookDeferEnabled) {
          for (const delayMs of ORDERBOOK_BACKOFF_DELAYS_MS) {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            try {
              recoveredFill = await Promise.all([
                fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', notional),
                fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', notional),
              ]);
              break;
            } catch (retryErr) {
              lastBackoffErr = retryErr;
            }
          }
        }
        if (recoveredFill) {
          [shortFill, longFill] = recoveredFill;
        } else {
          return {
            success: false,
            error: `orderbook fetch failed; cannot validate slippage: ${(lastBackoffErr as Error).message ?? lastBackoffErr}`,
            analysis: buildFailureAnalysis({
              attemptedNotionalUSDT: baseNotional,
              effectiveNotionalUSDT: notional,
              extra: {
                orderbookError: (lastBackoffErr as Error).message ?? String(lastBackoffErr),
                orderbookBackoffAttempts: orderbookFlags.orderbookDeferEnabled
                  ? ORDERBOOK_BACKOFF_DELAYS_MS.length
                  : 0,
              },
            }),
          };
        }
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
          return {
            success: false,
            error: `impact exceeded: ${roundTripImpactBps.toFixed(1)}bps > ${impactCapBps}bps (notional=$${notional.toFixed(2)})`,
            shortSlippagePercent: shortFill.slippagePercent,
            longSlippagePercent: longFill.slippagePercent,
            analysis: buildFailureAnalysis({
              attemptedNotionalUSDT: baseNotional,
              effectiveNotionalUSDT: notional,
              shortSlippagePercent: shortFill.slippagePercent,
              longSlippagePercent: longFill.slippagePercent,
              extra: {
                roundTripImpactBps,
                impactCapBps,
              },
            }),
          };
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
            shortSlippagePercent: shortFill.slippagePercent,
            longSlippagePercent: longFill.slippagePercent,
            analysis: buildFailureAnalysis({
              attemptedNotionalUSDT: baseNotional,
              effectiveNotionalUSDT: notional,
              shortSlippagePercent: shortFill.slippagePercent,
              longSlippagePercent: longFill.slippagePercent,
              extra: {
                maxSlippagePct,
              },
            }),
          };
        }
      }

      // Entry-gap drift guard: allow stable basis, block sudden divergence.
      const gapThreshold = snipeConfig.useImpactGuards
        ? impactCapBps / 100
        : maxSlippagePct;
      const effectiveGapThreshold = gapThreshold + ENTRY_GAP_TOLERANCE_PCT;
      const entryGap = getEntryGapMetrics({
        shortPrice: shortFill.fillPrice,
        longPrice: longFill.fillPrice,
        baselineShortPrice: opportunity.shortMarkPrice,
        baselineLongPrice: opportunity.longMarkPrice,
      });
      if (entryGap.driftPercent > effectiveGapThreshold) {
        return {
          success: false,
          error: `entry gap drift exceeded: ${entryGap.driftPercent.toFixed(4)}% > ${effectiveGapThreshold.toFixed(4)}% (baseThreshold=${gapThreshold.toFixed(4)}% tol=${ENTRY_GAP_TOLERANCE_PCT.toFixed(4)}% live=${entryGap.liveGapPercent.toFixed(4)}% base=${entryGap.baselineGapPercent.toFixed(4)}%)`,
          shortSlippagePercent: shortFill.slippagePercent,
          longSlippagePercent: longFill.slippagePercent,
          analysis: buildFailureAnalysis({
            attemptedNotionalUSDT: baseNotional,
            effectiveNotionalUSDT: notional,
            shortSlippagePercent: shortFill.slippagePercent,
            longSlippagePercent: longFill.slippagePercent,
            extra: {
              entryGapDriftPercent: entryGap.driftPercent,
              entryGapLivePercent: entryGap.liveGapPercent,
              entryGapBaselinePercent: entryGap.baselineGapPercent,
              entryGapThresholdPercent: effectiveGapThreshold,
            },
          }),
        };
      }
      // v2: hedge ratio pre-check
      if (snipeConfig.useStrictHedge) {
        const shortQtyEst = notional / shortFill.fillPrice;
        const longQtyEst = notional / longFill.fillPrice;
        const hedgeRatio = Math.abs((longQtyEst * longFill.fillPrice) / (shortQtyEst * shortFill.fillPrice));
        if (hedgeRatio < HEDGE_RATIO_MIN || hedgeRatio > HEDGE_RATIO_MAX) {
          return {
            success: false,
            error: `hedge ratio ${hedgeRatio.toFixed(6)} outside [${HEDGE_RATIO_MIN}, ${HEDGE_RATIO_MAX}]`,
            shortSlippagePercent: shortFill.slippagePercent,
            longSlippagePercent: longFill.slippagePercent,
            analysis: buildFailureAnalysis({
              attemptedNotionalUSDT: baseNotional,
              effectiveNotionalUSDT: notional,
              shortSlippagePercent: shortFill.slippagePercent,
              longSlippagePercent: longFill.slippagePercent,
              extra: {
                hedgeRatio,
                hedgeRatioMin: HEDGE_RATIO_MIN,
                hedgeRatioMax: HEDGE_RATIO_MAX,
              },
            }),
          };
        }
      }

      shortFillPrice = shortFill.fillPrice;
      longFillPrice = longFill.fillPrice;
      shortSlippagePercent = shortFill.slippagePercent;
      longSlippagePercent = longFill.slippagePercent;
      try {
        const [shortExitFill, longExitFill] = await retryTransientFetch(() => Promise.all([
          fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'buy', notional),
          fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'sell', notional),
        ]));
        shortExitSlippagePercent = shortExitFill.slippagePercent;
        longExitSlippagePercent = longExitFill.slippagePercent;
      } catch (err) {
        return {
          success: false,
          error: `exit orderbook fetch failed; cannot estimate close cost: ${(err as Error).message ?? err}`,
          analysis: buildFailureAnalysis({
            attemptedNotionalUSDT: baseNotional,
            effectiveNotionalUSDT: notional,
            shortSlippagePercent: shortFill.slippagePercent,
            longSlippagePercent: longFill.slippagePercent,
            extra: {
              exitOrderbookError: (err as Error).message ?? String(err),
            },
          }),
        };
      }
      executionMarketSnapshot = await this.captureProbeMarketSnapshot(opportunity, notional);
      fillsValidated = true;
      break;
    }
    if (!fillsValidated) {
      return {
        success: false,
        error: 'unable to validate entry slippage',
        analysis: buildFailureAnalysis({
          attemptedNotionalUSDT: baseNotional,
          effectiveNotionalUSDT: notional,
        }),
      };
    }
    // Sign convention: (longFill - shortFill) / shortFill. Positive means worse entry.
    const entryGap = getEntryGapMetrics({
      shortPrice: shortFillPrice,
      longPrice: longFillPrice,
      baselineShortPrice: opportunity.shortMarkPrice,
      baselineLongPrice: opportunity.longMarkPrice,
    });
    const entryGapPercent = entryGap.liveGapPercent;
    const execHedgeFeePct = (shortFeeInfo.fee + longFeeInfo.fee) * 2 * 100;
    let conservativeExpectedNetProfit = 0;
    let conservativeEvDecision: Record<string, unknown> = {};

    // Conservative EV ??always forced ON (matches REAL fail-safe policy)
    {
      const usesInstantRate = pairUsesInstantaneousRate(
        opportunity.shortExchange, opportunity.longExchange,
      );
      const shortDrift = snipeConfig.useDriftBuffer
        ? calcDriftBuffer(shortRateForDecision, undefined, usesInstantRate)
        : 0;
      const longDrift = snipeConfig.useDriftBuffer
        ? calcDriftBuffer(longRateForDecision, undefined, usesInstantRate)
        : 0;
      const roundTripFeeDec = execHedgeFeePct / 100;
      const entryImpactDec = (shortSlippagePercent + longSlippagePercent) / 100;
      const exitImpactDec = (shortExitSlippagePercent + longExitSlippagePercent) / 100;
      const shortQuoteVolume24h = this.latestRates.find((rate) => (
        rate.exchange === opportunity.shortExchange && rate.symbol === opportunity.shortSymbol
      ))?.quoteVolume24h;
      const longQuoteVolume24h = this.latestRates.find((rate) => (
        rate.exchange === opportunity.longExchange && rate.symbol === opportunity.longSymbol
      ))?.quoteVolume24h;
      const basisConvergenceReservePct = basisReservePctFromEntryGap(
        entryGap.driftPercent,
        entryGap.liveGapPercent,
        executionMarketSnapshot?.basisBps,
      );
      const volumeReservePct = volumeLiquidityReservePct({
        notionalUSDT: notional,
        shortQuoteVolume24h,
        longQuoteVolume24h,
        marketSnapshot: executionMarketSnapshot,
      });
      const dataHealthPenaltyUSD = Date.now() - this.lastRatesUpdate > RATES_REFRESH_INTERVAL_MS * 3
        ? notional * (STALE_DATA_PENALTY_BPS / 10000)
        : 0;
      const ev = calcConservativeEV(
        notional, shortRateForDecision, longRateForDecision,
        shortDrift, longDrift, roundTripFeeDec, entryImpactDec, exitImpactDec,
        {
          basisConvergenceReservePct,
          volumeLiquidityReservePct: volumeReservePct,
          dataHealthPenaltyUSD,
        },
      );
      conservativeExpectedNetProfit = ev.expectedNetUSD;
      conservativeEvDecision = {
        expectedFundingUSD: ev.expectedFundingUSD,
        roundTripFeeUSD: ev.roundTripFeeUSD,
        entryImpactUSD: ev.entryImpactUSD,
        exitImpactUSD: ev.exitImpactUSD,
        timingReserveUSD: ev.timingReserveUSD,
        basisConvergenceReserveUSD: ev.basisConvergenceReserveUSD,
        volumeLiquidityReserveUSD: ev.volumeLiquidityReserveUSD,
        dataHealthPenaltyUSD: ev.dataHealthPenaltyUSD,
        evRatio: ev.evRatio,
        passesMinProfit: ev.passesMinProfit,
        passesEVRatio: ev.passesEVRatio,
        shortEntrySlippagePercent: shortSlippagePercent,
        longEntrySlippagePercent: longSlippagePercent,
        shortExitSlippagePercent,
        longExitSlippagePercent,
        entryGapLivePercent: entryGap.liveGapPercent,
        entryGapDriftPercent: entryGap.driftPercent,
        basisRiskReservePct: basisConvergenceReservePct,
        liveSpreadPercent: spreadPercentForDecision,
        configuredMinSpreadPercent: this.config.minSpreadPercent,
        liveSpreadBelowConfiguredMin,
        executionGate: 'positive_spread_then_ev',
      };
      const executionEvFloorBase = getAcceptableNetEvFloor(investmentUSDT);
      const executionEvFloor = isSnipe
        ? Math.min(executionEvFloorBase, SIM_EXECUTION_MIN_EV_FLOOR_USD)
        : executionEvFloorBase;
      if (ev.expectedNetUSD < executionEvFloor) {
        return {
          success: false,
          error: `conservative EV failed: $${ev.expectedNetUSD.toFixed(4)} ratio=${ev.evRatio.toFixed(2)} floor=${executionEvFloor.toFixed(4)}`,
          shortSlippagePercent,
          longSlippagePercent,
          analysis: buildFailureAnalysis({
            attemptedNotionalUSDT: baseNotional,
            effectiveNotionalUSDT: notional,
            shortSlippagePercent,
            longSlippagePercent,
            extra: {
              conservativeEvUSD: ev.expectedNetUSD,
              conservativeEvRatio: ev.evRatio,
              passesMinProfit: ev.passesMinProfit,
              passesEVRatio: ev.passesEVRatio,
              expectedFundingUSD: ev.expectedFundingUSD,
              roundTripFeeUSD: ev.roundTripFeeUSD,
              entryImpactUSD: ev.entryImpactUSD,
              exitImpactUSD: ev.exitImpactUSD,
              timingReserveUSD: ev.timingReserveUSD,
              basisConvergenceReserveUSD: ev.basisConvergenceReserveUSD,
              volumeLiquidityReserveUSD: ev.volumeLiquidityReserveUSD,
              dataHealthPenaltyUSD: ev.dataHealthPenaltyUSD,
              entryGapLivePercent: entryGap.liveGapPercent,
              entryGapDriftPercent: entryGap.driftPercent,
              basisRiskReservePct: basisConvergenceReservePct,
              shortExitSlippagePercent,
              longExitSlippagePercent,
              shortQuoteVolume24h: shortQuoteVolume24h ?? null,
              longQuoteVolume24h: longQuoteVolume24h ?? null,
              executionMarketSnapshot: executionMarketSnapshot ?? null,
            },
          }),
        };
      }
    }

    const shortEntryFee = notional * shortFeeRate;
    const longEntryFee = notional * longFeeRate;
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
        return {
          success: false,
          error: `insufficient sim balance on ${target}`,
          analysis: buildFailureAnalysis({
            attemptedNotionalUSDT: baseNotional,
            effectiveNotionalUSDT: notional,
            shortSlippagePercent,
            longSlippagePercent,
            extra: {
              insufficientTarget: target,
              requiredBalanceUSDT: required,
              availableBalanceUSDT: workingBalances[target] ?? 0,
            },
          }),
        };
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
      fundingRate: shortRateForDecision,
      openedAt: timestamp,
      positionType: 'hedge_short',
      fundingCollected: 0,
      spread: spreadForDecision,
      nextFundingTime: targetFundingTime,
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
      fundingRate: longRateForDecision,
      openedAt: timestamp,
      positionType: 'hedge_long',
      fundingCollected: 0,
      spread: spreadForDecision,
      nextFundingTime: targetFundingTime,
      isSnipe,
      fundingReceived: 0,
      entryFee: longEntryFee,
      fundingIntervalMs: opportunity.fundingIntervalMs,
      entryGapPercent,
    };

    const perFunding = notional * shortRateForDecision - notional * longRateForDecision;
    const totalRoundTripFees = notional * shortFeeRate * 2
      + notional * longFeeRate * 2;
    const netProfit = conservativeExpectedNetProfit;
    // Visibility: how much the conservative EV is shaving off the raw spread.
    // Equals timing + basis + volume + dataHealth + entry/exit impact reserves
    // + any drift-buffer impact. Shown in the entry telegram alert so that
    // "expNet vs perFunding-fees" gap is no longer a mystery.
    const totalReservesUSD = perFunding - totalRoundTripFees - netProfit;

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
    const entryTrade: TradeEvent = {
      timestamp,
      type: isSnipe ? 'snipe_entry' : 'entry',
      simulation: true,
      baseAsset: opportunity.baseAsset,
      shortExchange: opportunity.shortExchange,
      longExchange: opportunity.longExchange,
      spread: spreadForDecision,
      spreadPercent: spreadPercentForDecision,
      margin,
      leverage,
      notional,
      entryFee: shortEntryFee + longEntryFee,
      netProfit,
      expectedNetProfit: netProfit,
      expectedRoiPercent: calcExpectedRoiPercent(netProfit, margin, leverage),
      perFunding,
      totalRoundTripFees,
      totalReservesUSD,
      pairId,
      analysis: {
        conservativeEvDecision,
        perFundingBeforeReserves: perFunding,
        totalRoundTripFees,
        totalReservesUSD,
        dynamicSizingFallbackReason,
      },
    };
    const persisted = this.recordTrades([entryTrade]);
    const persistedEntryEvents = persisted.events;
    const entryPair = buildTradePairsFromEvents(persistedEntryEvents)[0];
    if (entryPair) {
      void sendTelegramMessage(
        formatTradePairTelegramMessage(entryPair, 'entry', {
          currentTotalBalanceUSDT: this.getCurrentSimBalanceTotal(savedState),
          note: formatPersistenceTelegramNote(persistedEntryEvents, pairId),
        }),
        {
          kind: 'entry',
          pairId,
          symbol: opportunity.baseAsset,
          exchanges: `${opportunity.shortExchange}/${opportunity.longExchange}`,
          fundingTime: new Date(targetFundingTime).toISOString(),
          structured: {
            expNet: netProfit,
            perFunding,
            totalRoundTripFees,
            totalReservesUSD,
            margin,
            notional,
            leverage,
            spreadPercent: spreadPercentForDecision,
            expectedRoiPercent: entryPair.expectedRoiPercent,
          },
        },
      );
    }

    return {
      success: true,
      state: savedState,
      pairId,
      executedNotional: notional,
      shortSlippagePercent,
      longSlippagePercent,
    };
  }
}

export function getServerSimScheduler() {
  return ServerSimScheduler.getInstance();
}
