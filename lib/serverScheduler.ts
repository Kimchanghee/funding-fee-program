import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  closePosition,
  fetchBalance,
  fetchFundingHistory as fetchFundingHistoryFromExchange,
  fetchFundingRates,
  fetchMarketFillPrice,
  fetchOrderbook,
  calcOrderbookImpactBps,
  checkFundingSettled,
  getPartialExecution,
  openPositionExact,
  type ExecutedOrderSummary,
} from './exchanges';
import { warmFundingRatesWs, warmOrderbookWs } from './exchanges/wsPublicData';
import {
  EXCHANGE_PROFILES,
  getPairEntryLeadMs,
  getPairMaxSettlementWaitMs,
  hasTierCExchange,
  pairSupportsConfirmedClose,
  pairUsesInstantaneousRate,
} from './exchangeProfiles';
import { appendTrades, readTrades, type TradeEvent } from './fileLogger';
import { getEntryGapMetrics } from './entryGapGuard';
import { rebalanceExecutedHedge } from './hedgeRebalance';
import { getFundingExchangeSnapshot } from './publicMarketDataCache';
import { refreshAllFeeCaches, resolveRuntimeFee, resolveRuntimeFeeDetailed } from './runtimeFeeCache';
import {
  buildBalanceEqualizationPlan,
  getBalanceEqualizationPlanningBalances,
  getOpportunityBalanceEqualizationMultiplier,
  type BalanceEqualizationPlan,
} from './balanceEqualization';
import { checkPairLiquidationDistance } from './liquidationGuard';
import {
  findOpportunities,
  getOpportunityId,
  getOpportunityLegKeys,
  calcConservativeEV,
  calcDriftBuffer,
} from './opportunities';
import { saveOpportunityHourlySnapshot } from './analysisLogger';
import {
  createExecutionState,
  transitionPhase,
  completeExecution,
} from './executionState';
import { RouteFailureMemory, makeRouteFailureKey } from './routeFailureMemory';
import { loadAllServerApiConfigs } from './serverKeyStore';
import {
  makeServerPositionKey,
  removeServerPositionMeta,
  upsertServerPositionMeta,
} from './serverPositionMeta';
import { sendTelegramMessage } from './telegram';
import {
  getResolvedTimingConfig,
  sanitizeEnabledExchanges,
  sanitizeFeeOverrides,
  sanitizePaybackOverrides,
  sanitizeTimingConfig,
  DEFAULT_CONFIRMED_SNIPE_CONFIG,
  MAX_FUNDING_TIMESTAMP_DIFF_MS,
  MAX_ROUND_TRIP_IMPACT_BPS,
  MIN_FREE_MARGIN_PCT,
  MAX_ORPHAN_LEG_MS,
  HEDGE_RATIO_MIN,
  HEDGE_RATIO_MAX,
  type ApiConfig,
  type ArbitrageOpportunity,
  type Balance,
  type ConfirmedSnipeConfig,
  type ExchangeId,
  type FeeOverrides,
  type PaybackOverrides,
  type FundingPayment,
  type FundingRate,
  type TimingConfig,
} from './types';
import { getDataDir } from './dataDir';

const DATA_DIR = getDataDir();
const STATE_FILE = join(DATA_DIR, 'scheduler-state.json');
const LOG_FILE = join(DATA_DIR, 'scheduler.log');
const CLOSE_RETRY_DELAY_MS = 30_000;
const FUNDING_MATCH_WINDOW_MS = 10 * 60 * 1000;
const LIVE_FUNDING_TIME_DRIFT_MS = 60_000;
const FUNDING_UNIVERSE_CACHE_TTL_MS = 60 * 60 * 1000;
const FULL_FUNDING_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const FAST_SYMBOL_CAP_PER_EXCHANGE = 24;
const FAST_SYMBOL_MIN_PER_EXCHANGE = 8;
const COMPOUND_BALANCE_USAGE_PCT = 0.9;
const MIN_ENTRY_NOTIONAL_USDT = 100;
const MAX_ADAPTIVE_NOTIONAL_ATTEMPTS = 4;
const WS_WARM_INTERVAL_MS = 15_000;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown';
}

/** Resolve v2.1 config. Missing means all toggles OFF. */
function getSnipeConfig(config?: ConfirmedSnipeConfig): ConfirmedSnipeConfig {
  return config ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
}

function getFallbackImpactPercent(config: Pick<SchedulerConfig, 'maxSlippagePercent' | 'confirmedSnipeConfig'>): number {
  const snipeConfig = getSnipeConfig(config.confirmedSnipeConfig);
  if (snipeConfig.useImpactGuards) {
    const maxRoundTripImpactBps = snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS;
    // round-trip bps -> per-event (entry/exit) percent
    return maxRoundTripImpactBps / 200;
  }
  // bps -> percent (4bps = 0.04%)
  return (snipeConfig.targetImpactBps ?? 4) / 100;
}

function estimatePreEntryConservativeEV(
  opportunity: ArbitrageOpportunity,
  config: SchedulerConfig,
) {
  const notional = config.investmentUSDT * config.leverage;
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

  const snipeConfig = getSnipeConfig(config.confirmedSnipeConfig);
  const usesInstantRate = pairUsesInstantaneousRate(opportunity.shortExchange, opportunity.longExchange);
  const shortDrift = snipeConfig.useDriftBuffer
    ? calcDriftBuffer(opportunity.shortRate, undefined, usesInstantRate)
    : 0;
  const longDrift = snipeConfig.useDriftBuffer
    ? calcDriftBuffer(opportunity.longRate, undefined, usesInstantRate)
    : 0;
  const impactDec = getFallbackImpactPercent(config) / 100;

  return calcConservativeEV(
    notional,
    opportunity.shortRate,
    opportunity.longRate,
    shortDrift,
    longDrift,
    roundTripFeeDec,
    impactDec,
    impactDec,
  );
}

export interface SchedulerConfig {
  investmentUSDT: number;
  leverage: number;
  minSpreadPercent: number;
  compoundInvesting: boolean;
  enabledExchanges: ExchangeId[];
  maxConcurrentPairs: number;
  feeOverrides?: FeeOverrides;
  paybackOverrides?: PaybackOverrides;
  timingConfig?: TimingConfig;
  maxSlippagePercent?: number; // Max per-leg slippage percent (default 1.5)
  minVolume24hUSD?: number; // Minimum 24h quote volume in USD
  confirmedSnipeConfig?: ConfirmedSnipeConfig; // v2.1; undefined means all toggles OFF
}

interface SchedulerStats {
  totalEntries: number;
  totalCloses: number;
  totalProfit: number;
  errors: number;
}

interface PersistedScheduledEntry {
  opportunityId: string;
  asset: string;
  opportunity: ArbitrageOpportunity;
  targetTime: number;
}

interface PersistedActivePosition {
  opportunityId: string;
  asset: string;
  opportunity: ArbitrageOpportunity;
  pairId: string;
  shortAmount: number;
  longAmount: number;
  shortEntry: ExecutedOrderSummary;
  longEntry: ExecutedOrderSummary;
  closedLegs: ClosedLeg[];
  entryTime: number;
  targetFundingTime: number;
  closeAt: number;
  closeAttempts: number;
  evDecision?: number;
}

interface PersistedState {
  active: boolean;
  config: SchedulerConfig;
  startedAt: number | null;
  stats: SchedulerStats;
  scheduledEntries?: PersistedScheduledEntry[];
  activePositions?: PersistedActivePosition[];
  lastPollTime?: number;
}

interface ScheduledEntry extends PersistedScheduledEntry {
  timer: ReturnType<typeof setTimeout> | null;
}

interface ActivePosition extends PersistedActivePosition {
  closeTimer: ReturnType<typeof setTimeout> | null;
}

interface ClosedLeg {
  exchange: ExchangeId;
  symbol: string;
  side: 'long' | 'short';
  entry: ExecutedOrderSummary;
  exit: ExecutedOrderSummary;
}

interface FundingVerificationResult {
  verified: boolean;
  payments: FundingPayment[];
  errors: string[];
}

interface FundingUniverseCacheEntry {
  symbols: string[];
  updatedAt: number;
}

class ServerScheduler {
  private static instance: ServerScheduler | null = null;

  private active = false;
  private config: SchedulerConfig = {
    investmentUSDT: 500,
    leverage: 5,
    minSpreadPercent: 0.01,
    compoundInvesting: true,
    enabledExchanges: [],
    maxConcurrentPairs: 5,
    timingConfig: getResolvedTimingConfig(),
  };
  private startedAt: number | null = null;
  private stats: SchedulerStats = { totalEntries: 0, totalCloses: 0, totalProfit: 0, errors: 0 };

  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private scheduledEntries = new Map<string, ScheduledEntry>();
  private activePositions = new Map<string, ActivePosition>();
  private lastPollTime = 0;
  private lastWsWarmAt = 0;
  private loadedPersistedState = false;
  private routeFailureMemory = new RouteFailureMemory();
  private fundingUniverseCache = new Map<ExchangeId, FundingUniverseCacheEntry>();
  private lastFullFundingScanAt = 0;
  private balanceSnapshot: Partial<Record<ExchangeId, Balance>> = {};
  private lastBalanceRefreshAt = 0;
  private lastBalanceEqualizationPlan: BalanceEqualizationPlan | null = null;

  private static BALANCE_REFRESH_INTERVAL_MS = 60_000;

  static getInstance(): ServerScheduler {
    if (!ServerScheduler.instance) {
      ServerScheduler.instance = new ServerScheduler();
    }
    return ServerScheduler.instance;
  }

  private constructor() {
    this.loadPersistedState();
    this.bootstrapRouteFailureMemory();
  }

  private bootstrapRouteFailureMemory() {
    try {
      this.routeFailureMemory.ingestEvents(readTrades(), { simulation: false });
    } catch (error) {
      this.log('warning', `route failure memory bootstrap failed: ${getErrorMessage(error)}`);
    }
  }

  private normalizeConfig(config: SchedulerConfig): SchedulerConfig {
    return {
      ...config,
      enabledExchanges: sanitizeEnabledExchanges(config.enabledExchanges),
      compoundInvesting: config.compoundInvesting ?? true,
      feeOverrides: sanitizeFeeOverrides(config.feeOverrides),
      paybackOverrides: sanitizePaybackOverrides(config.paybackOverrides),
      timingConfig: getResolvedTimingConfig(sanitizeTimingConfig(config.timingConfig)),
    };
  }

  private getTimingConfig() {
    return getResolvedTimingConfig(this.config.timingConfig);
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

  private shouldRunFullFundingScan(now: number): boolean {
    if (this.lastFullFundingScanAt === 0) return true;
    if (now - this.lastFullFundingScanAt >= FULL_FUNDING_SCAN_INTERVAL_MS) return true;
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
      if (set.size >= FAST_SYMBOL_CAP_PER_EXCHANGE) return;
      set.add(symbol);
    };

    for (const position of this.activePositions.values()) {
      add(position.opportunity.shortExchange, position.opportunity.shortSymbol);
      add(position.opportunity.longExchange, position.opportunity.longSymbol);
    }

    for (const entry of this.scheduledEntries.values()) {
      add(entry.opportunity.shortExchange, entry.opportunity.shortSymbol);
      add(entry.opportunity.longExchange, entry.opportunity.longSymbol);
    }

    for (const exchange of this.config.enabledExchanges) {
      let set = byExchange.get(exchange);
      if (!set) {
        set = new Set<string>();
        byExchange.set(exchange, set);
      }
      const universe = this.getFreshUniverseSymbols(exchange, now);
      if (!universe) continue;
      const minTarget = Math.min(FAST_SYMBOL_MIN_PER_EXCHANGE, FAST_SYMBOL_CAP_PER_EXCHANGE);
      for (const symbol of universe) {
        if (set.size >= minTarget) break;
        set.add(symbol);
      }
    }

    const output = new Map<ExchangeId, string[]>();
    for (const exchange of this.config.enabledExchanges) {
      const symbols = Array.from(byExchange.get(exchange) ?? []);
      if (symbols.length === 0) continue;
      output.set(exchange, symbols.slice(0, FAST_SYMBOL_CAP_PER_EXCHANGE));
    }
    return output;
  }

  private async maybeRefreshBalanceSnapshot(apiConfigs: Partial<Record<ExchangeId, ApiConfig>>) {
    const now = Date.now();
    const hasSnapshot = this.config.enabledExchanges.some((exchange) => !!this.balanceSnapshot[exchange]);
    if (hasSnapshot && now - this.lastBalanceRefreshAt < ServerScheduler.BALANCE_REFRESH_INTERVAL_MS) {
      return;
    }

    this.lastBalanceRefreshAt = now;
    const nextSnapshot = { ...this.balanceSnapshot };
    const targets = this.config.enabledExchanges.filter((exchange) => !!apiConfigs[exchange]);

    await Promise.allSettled(
      targets.map(async (exchange) => {
        const balance = await fetchBalance(exchange, apiConfigs[exchange]!);
        if (balance.status === 'connected') {
          nextSnapshot[exchange] = balance;
        }
      }),
    );

    this.balanceSnapshot = nextSnapshot;
    const balanceMap = {} as Partial<Record<ExchangeId, number>>;
    for (const exchange of this.config.enabledExchanges) {
      balanceMap[exchange] = nextSnapshot[exchange]?.availableUSDT ?? 0;
    }
    this.lastBalanceEqualizationPlan = buildBalanceEqualizationPlan(this.config.enabledExchanges, balanceMap);
  }

  start(config: SchedulerConfig) {
    if (this.active) {
      this.stop();
    }

    const continuingSession = this.scheduledEntries.size > 0 || this.activePositions.size > 0;

    this.active = true;
    this.config = this.normalizeConfig(config);
    this.pruneFundingUniverseCache();
    if (!continuingSession) {
      this.startedAt = Date.now();
      this.stats = { totalEntries: 0, totalCloses: 0, totalProfit: 0, errors: 0 };
    } else if (!this.startedAt) {
      this.startedAt = Date.now();
    }

    this.restoreTimers();
    this.saveState();
    this.startPolling();

    this.log(
      'info',
      `scheduler started | investment=$${this.config.investmentUSDT} leverage=${this.config.leverage}x compound=${this.config.compoundInvesting ? 'on' : 'off'} exchanges=${this.config.enabledExchanges.join(',')} minSpread=${this.config.minSpreadPercent}%`,
    );
    void sendTelegramMessage(
      `[Server Scheduler] started\ninvestment: $${this.config.investmentUSDT} | leverage: ${this.config.leverage}x | compound: ${this.config.compoundInvesting ? 'ON' : 'OFF'}\nexchanges: ${this.config.enabledExchanges.join(', ')}\nminSpread: ${this.config.minSpreadPercent}%`,
    );
  }

  updateConfig(config: SchedulerConfig) {
    const nextConfig = this.normalizeConfig(config);

    this.config = nextConfig;
    this.pruneFundingUniverseCache();

    for (const entry of this.scheduledEntries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.scheduledEntries.clear();

    if (this.active) {
      this.restoreTimers();
      this.saveState();
      this.startPolling();
      setTimeout(() => void this.poll(), 250);
      this.log(
        'info',
        `scheduler config updated | investment=$${nextConfig.investmentUSDT} leverage=${nextConfig.leverage}x compound=${nextConfig.compoundInvesting ? 'on' : 'off'} exchanges=${nextConfig.enabledExchanges.join(',')} minSpread=${nextConfig.minSpreadPercent}%`,
      );
    } else {
      this.saveState();
    }
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    for (const entry of this.scheduledEntries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }

    for (const pos of this.activePositions.values()) {
      if (pos.closeTimer) clearTimeout(pos.closeTimer);
      pos.closeTimer = null;
    }

    const openPositions = this.activePositions.size;
    this.active = false;
    this.saveState();

    this.log(
      'info',
      `scheduler stopped | entries=${this.stats.totalEntries} closes=${this.stats.totalCloses}${openPositions > 0 ? ` openPositions=${openPositions}` : ''}`,
    );
    void sendTelegramMessage(
      `[Server Scheduler] stopped\nentries: ${this.stats.totalEntries} | closes: ${this.stats.totalCloses}${openPositions > 0 ? `\nopen positions require manual handling: ${openPositions}` : ''}`,
    );
  }

  getStatus() {
    return {
      active: this.active,
      config: this.config,
      startedAt: this.startedAt,
      stats: this.stats,
      scheduledEntries: Array.from(this.scheduledEntries.values()).map((entry) => ({
        opportunityId: entry.opportunityId,
        asset: entry.asset,
        targetTime: entry.targetTime,
        shortExchange: entry.opportunity.shortExchange,
        longExchange: entry.opportunity.longExchange,
        spreadPercent: entry.opportunity.spreadPercent,
      })),
      activePositions: Array.from(this.activePositions.values()).map((pos) => ({
        opportunityId: pos.opportunityId,
        asset: pos.asset,
        pairId: pos.pairId,
        shortExchange: pos.opportunity.shortExchange,
        longExchange: pos.opportunity.longExchange,
        entryTime: pos.entryTime,
        closeAt: pos.closeAt,
        closeAttempts: pos.closeAttempts,
      })),
      lastPollTime: this.lastPollTime,
      balanceEqualization: this.lastBalanceEqualizationPlan,
    };
  }

  isActive() {
    return this.active;
  }

  private getOccupiedLegs(excludeOpportunityId?: string) {
    const occupiedLegs = new Set<string>();

    for (const [opportunityId, entry] of this.scheduledEntries) {
      if (opportunityId === excludeOpportunityId) continue;
      getOpportunityLegKeys(entry.opportunity).forEach((legKey) => occupiedLegs.add(legKey));
    }

    for (const [opportunityId, position] of this.activePositions) {
      if (opportunityId === excludeOpportunityId) continue;
      getOpportunityLegKeys(position.opportunity).forEach((legKey) => occupiedLegs.add(legKey));
    }

    return occupiedLegs;
  }

  private loadPersistedState() {
    if (this.loadedPersistedState) return;
    this.loadedPersistedState = true;

    try {
      if (!existsSync(STATE_FILE)) return;

      const saved = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as PersistedState;
      this.config = saved.config ? this.normalizeConfig(saved.config) : this.config;
      this.startedAt = saved.startedAt ?? null;
      this.stats = saved.stats ?? this.stats;
      this.lastPollTime = saved.lastPollTime ?? 0;
      this.active = !!saved.active;

      for (const entry of saved.scheduledEntries ?? []) {
        const opportunityId = entry.opportunityId ?? getOpportunityId(entry.opportunity);
        this.scheduledEntries.set(opportunityId, {
          ...entry,
          opportunityId,
          timer: null,
        });
      }

      for (const pos of saved.activePositions ?? []) {
        const opportunityId = pos.opportunityId ?? getOpportunityId(pos.opportunity);
        this.activePositions.set(opportunityId, {
          ...pos,
          opportunityId,
          closedLegs: pos.closedLegs ?? [],
          closeTimer: null,
        });
      }

      if (this.active) {
        this.restoreTimers();
        this.startPolling();
        this.log(
          'info',
          `scheduler auto-resumed | startedAt=${this.startedAt ? new Date(this.startedAt).toISOString() : 'unknown'} openPositions=${this.activePositions.size} scheduled=${this.scheduledEntries.size}`,
        );
      } else if (this.activePositions.size > 0 || this.scheduledEntries.size > 0) {
        this.log(
          'info',
          `scheduler state loaded without auto-start | openPositions=${this.activePositions.size} scheduled=${this.scheduledEntries.size}`,
        );
      }
    } catch (err) {
      this.log('error', `failed to load scheduler state: ${(err as Error).message}`);
    }
  }

  private restoreTimers() {
    const now = Date.now();

    for (const [opportunityId, entry] of this.scheduledEntries) {
      if (entry.timer) clearTimeout(entry.timer);

      if (entry.targetTime < now - 30_000) {
        this.scheduledEntries.delete(opportunityId);
        continue;
      }

      entry.timer = this.scheduleEntryTimer(entry.opportunity, entry.targetTime);
    }

    for (const [opportunityId, pos] of this.activePositions) {
      if (pos.closeTimer) clearTimeout(pos.closeTimer);
      pos.closeTimer = this.scheduleCloseTimer(opportunityId, pos.closeAt);
    }
  }

  private startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    setTimeout(() => void this.poll(), 2_000);
    this.pollInterval = setInterval(() => void this.poll(), 5_000);
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

    for (const position of this.activePositions.values()) {
      addOrderbookTarget(position.opportunity.shortExchange, position.opportunity.shortSymbol);
      addOrderbookTarget(position.opportunity.longExchange, position.opportunity.longSymbol);
    }

    void Promise.allSettled([
      ...Array.from(fundingSymbols.entries()).map(([exchange, symbols]) => warmFundingRatesWs(exchange, symbols)),
      ...Array.from(orderbookTargets.values()).map(async ({ exchange, symbol }) => {
        warmOrderbookWs(exchange, symbol, 50);
      }),
    ]);
  }

  private lastFeeCacheRefresh = 0;
  private static FEE_CACHE_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  private async poll() {
    if (!this.active) return;

    this.lastPollTime = Date.now();
    const apiConfigs = loadAllServerApiConfigs();

    // Periodically refresh runtime fee cache from exchange APIs
    if (Date.now() - this.lastFeeCacheRefresh > ServerScheduler.FEE_CACHE_REFRESH_INTERVAL_MS) {
      this.lastFeeCacheRefresh = Date.now();
      refreshAllFeeCaches(apiConfigs).catch((err) => {
        this.log('warning', `fee cache refresh failed: ${getErrorMessage(err)}`);
      });
    }

    try {
      await this.maybeRefreshBalanceSnapshot(apiConfigs);
      this.pruneFundingUniverseCache();
      const wsWarmSymbols = this.buildFastFundingSymbols(this.lastPollTime);
      this.prewarmWsMarketData(this.lastPollTime, wsWarmSymbols);
      const fullScan = this.shouldRunFullFundingScan(this.lastPollTime);
      const fastSymbols = fullScan ? new Map<ExchangeId, string[]>() : wsWarmSymbols;

      let results = await Promise.allSettled(
        this.config.enabledExchanges.map((exchange) => {
          const symbols = fullScan ? undefined : fastSymbols.get(exchange);
          if (symbols && symbols.length > 0) {
            return fetchFundingRates(exchange, undefined, symbols);
          }
          return getFundingExchangeSnapshot(exchange).then((snapshot) => snapshot.rates);
        }),
      );

      let rates = results
        .filter((result): result is PromiseFulfilledResult<FundingRate[]> => result.status === 'fulfilled')
        .flatMap((result) => result.value);

      let effectiveFullScan = fullScan;
      if (rates.length === 0 && !fullScan) {
        results = await Promise.allSettled(
          this.config.enabledExchanges.map((exchange) =>
            getFundingExchangeSnapshot(exchange).then((snapshot) => snapshot.rates),
          ),
        );
        rates = results
          .filter((result): result is PromiseFulfilledResult<FundingRate[]> => result.status === 'fulfilled')
          .flatMap((result) => result.value);
        effectiveFullScan = true;
      }

      if (rates.length === 0) {
        this.saveState();
        return;
      }

      if (effectiveFullScan) {
        this.updateFundingUniverseCacheFromRates(rates, this.lastPollTime);
        this.lastFullFundingScanAt = this.lastPollTime;
      }

      const opportunities = findOpportunities(
        rates,
        200,
        this.config.investmentUSDT,
        this.config.leverage,
        this.config.feeOverrides,
        this.config.paybackOverrides,
        this.config.minVolume24hUSD,
      );
      try {
        saveOpportunityHourlySnapshot({
          source: 'server_scheduler',
          exchanges: this.config.enabledExchanges,
          rates,
          opportunities,
          capturedAt: this.lastPollTime,
        });
      } catch {
        // Ignore snapshot persistence failures.
      }
      const minVolume24hUSD = this.config.minVolume24hUSD ?? 0;
      const volumeByExchangeAsset = new Map<string, number>();
      for (const rate of rates) {
        if (typeof rate.quoteVolume24h === 'number' && Number.isFinite(rate.quoteVolume24h)) {
          volumeByExchangeAsset.set(`${rate.exchange}:${rate.baseAsset}`, rate.quoteVolume24h);
        }
      }

      const occupiedLegs = this.getOccupiedLegs();

      const filtered = opportunities.filter((opportunity) => {
        const opportunityId = getOpportunityId(opportunity);
        if (this.scheduledEntries.has(opportunityId) || this.activePositions.has(opportunityId)) return false;
        const routeFailureKey = makeRouteFailureKey(
          opportunity.baseAsset,
          opportunity.shortExchange,
          opportunity.longExchange,
        );
        if (this.routeFailureMemory.isBlocked(routeFailureKey, this.lastPollTime)) return false;
        if (getOpportunityLegKeys(opportunity).some((legKey) => occupiedLegs.has(legKey))) return false;
        if (!this.config.enabledExchanges.includes(opportunity.shortExchange)) return false;
        if (!this.config.enabledExchanges.includes(opportunity.longExchange)) return false;

        const aheadWindowMs = Math.max(5 * 3600000, opportunity.fundingIntervalMs ?? 8 * 3600000);
        if (opportunity.nextFundingTime - this.lastPollTime > aheadWindowMs) return false;
        if (opportunity.nextFundingTime < this.lastPollTime) return false;
        if (opportunity.spreadPercent < this.config.minSpreadPercent) return false;
        const preEntryEv = estimatePreEntryConservativeEV(opportunity, this.config);
        if (!preEntryEv || !preEntryEv.passesMinProfit || !preEntryEv.passesEVRatio) return false;
        if (minVolume24hUSD > 0) {
          const shortVol = volumeByExchangeAsset.get(`${opportunity.shortExchange}:${opportunity.baseAsset}`);
          const longVol = volumeByExchangeAsset.get(`${opportunity.longExchange}:${opportunity.baseAsset}`);
          if (
            (shortVol !== undefined && shortVol < minVolume24hUSD)
            || (longVol !== undefined && longVol < minVolume24hUSD)
          ) {
            return false;
          }
        }

        // v2.1: strict funding timestamp alignment (3s) when confirmed snipe is active
        const snipeCfg = getSnipeConfig(this.config.confirmedSnipeConfig);
        if (snipeCfg.useConfirmedClose) {
          const shortRate = rates.find(r => r.exchange === opportunity.shortExchange && r.symbol === opportunity.shortSymbol);
          const longRate = rates.find(r => r.exchange === opportunity.longExchange && r.symbol === opportunity.longSymbol);
          if (shortRate && longRate) {
            const tsDiff = Math.abs(shortRate.nextFundingTime - longRate.nextFundingTime);
            if (tsDiff > MAX_FUNDING_TIMESTAMP_DIFF_MS) return false;
          }
        }

        return true;
      });

      const currentCount = this.scheduledEntries.size + this.activePositions.size;
      const slotsAvailable = this.config.maxConcurrentPairs - currentCount;
      const balancePlan = this.lastBalanceEqualizationPlan;
      const workingBalances = balancePlan && balancePlan.totalBalanceUSDT > 0
        ? getBalanceEqualizationPlanningBalances(balancePlan, false)
        : null;
      const getPlanningCostFactor = (exchange: ExchangeId) => (
        1 + (this.config.leverage * resolveRuntimeFee(
          exchange,
          'taker',
          this.config.feeOverrides,
          this.config.paybackOverrides,
        ))
      );
      const getOpportunityPlanScore = (opportunity: ArbitrageOpportunity) => {
        const preEntryEv = estimatePreEntryConservativeEV(opportunity, this.config);
        const baseScore = preEntryEv?.expectedNetUSD ?? opportunity.netProfit ?? opportunity.spreadPercent;
        return baseScore * getOpportunityBalanceEqualizationMultiplier(balancePlan, opportunity);
      };
      const ranked = [...filtered].sort((a, b) => {
        const scoreDiff = getOpportunityPlanScore(b) - getOpportunityPlanScore(a);
        if (scoreDiff !== 0) return scoreDiff;
        if (b.spreadPercent !== a.spreadPercent) return b.spreadPercent - a.spreadPercent;
        return a.nextFundingTime - b.nextFundingTime;
      });
      const toSchedule: ArbitrageOpportunity[] = [];
      const selectedLegs = new Set(occupiedLegs);

      for (const opportunity of ranked) {
        if (toSchedule.length >= Math.max(0, slotsAvailable)) break;
        const legKeys = getOpportunityLegKeys(opportunity);
        if (legKeys.some((legKey) => selectedLegs.has(legKey))) continue;

        if (workingBalances) {
          const baseMargin = Math.max(0, this.config.investmentUSDT);
          const shortCost = baseMargin * getPlanningCostFactor(opportunity.shortExchange);
          const longCost = baseMargin * getPlanningCostFactor(opportunity.longExchange);
          const shortAvail = workingBalances[opportunity.shortExchange] ?? 0;
          const longAvail = workingBalances[opportunity.longExchange] ?? 0;
          if (shortAvail < shortCost || longAvail < longCost) continue;
          workingBalances[opportunity.shortExchange] = Math.max(0, shortAvail - shortCost);
          workingBalances[opportunity.longExchange] = Math.max(0, longAvail - longCost);
        }

        toSchedule.push(opportunity);
        legKeys.forEach((legKey) => selectedLegs.add(legKey));
      }

      for (const opportunity of toSchedule) {
        this.scheduleEntry(opportunity);
      }

      this.saveState();
    } catch (err) {
      this.stats.errors++;
      this.log('error', `poll failed: ${(err as Error).message}`);
      this.saveState();
    }
  }

  private scheduleEntry(opportunity: ArbitrageOpportunity) {
    const opportunityId = getOpportunityId(opportunity);
    const asset = opportunity.baseAsset;
    if (this.scheduledEntries.has(opportunityId)) return;

    // v2.1: use exchange-profile entry lead time (falls back to legacy if larger)
    const profileLeadMs = getPairEntryLeadMs(
      opportunity.shortExchange,
      opportunity.longExchange,
    );
    const legacyLeadMs = this.getTimingConfig().entryLeadMs;
    const entryLeadMs = Math.max(profileLeadMs, legacyLeadMs);

    // Skip Tier C pairs unless explicitly enabled
    if (hasTierCExchange(opportunity.shortExchange, opportunity.longExchange)) {
      const tierCExchange = EXCHANGE_PROFILES[opportunity.shortExchange].tier === 'C'
        ? opportunity.shortExchange
        : opportunity.longExchange;
      if (!this.config.enabledExchanges.includes(tierCExchange)) return;
    }

    let targetTime = opportunity.nextFundingTime;
    const intervalMs = opportunity.fundingIntervalMs ?? 8 * 3600000;
    const now = Date.now();

    while (targetTime <= now) targetTime += intervalMs;
    if (targetTime - now < entryLeadMs + 1_000) targetTime += intervalMs;

    const scheduledEntry: ScheduledEntry = {
      opportunityId,
      asset,
      opportunity,
      targetTime,
      timer: this.scheduleEntryTimer(opportunity, targetTime, entryLeadMs),
    };

    this.scheduledEntries.set(opportunityId, scheduledEntry);
    this.saveState();

    const delayMs = Math.max(0, targetTime - now - entryLeadMs);
    const minutes = Math.floor(delayMs / 60000);
    const seconds = Math.floor((delayMs / 1000) % 60);
    this.log(
      'info',
      `entry scheduled | asset=${asset} opportunityId=${opportunityId} in=${minutes}m${seconds}s ` +
      `short=${opportunity.shortExchange} long=${opportunity.longExchange} ` +
      `spread=${opportunity.spreadPercent.toFixed(4)}% entryLead=${entryLeadMs}ms`,
    );
  }

  private scheduleEntryTimer(
    opportunity: ArbitrageOpportunity,
    targetTime: number,
    entryLeadMs?: number,
  ) {
    const leadMs = entryLeadMs ?? Math.max(
      getPairEntryLeadMs(opportunity.shortExchange, opportunity.longExchange),
      this.getTimingConfig().entryLeadMs,
    );
    const delayMs = Math.max(0, targetTime - Date.now() - leadMs);
    return setTimeout(() => {
      void this.executeEntry(opportunity, targetTime);
    }, delayMs);
  }

  private async executeEntry(opportunity: ArbitrageOpportunity, targetFundingTime: number) {
    const opportunityId = getOpportunityId(opportunity);
    const asset = opportunity.baseAsset;
    this.scheduledEntries.delete(opportunityId);
    this.saveState();

    // State machine: create and track
    createExecutionState(
      opportunityId, asset, opportunity.shortExchange, opportunity.longExchange,
    );
    transitionPhase(opportunityId, 'precheck');

    if (!this.active) {
      this.log('warning', `entry skipped while inactive | asset=${asset}`);
      completeExecution(opportunityId, 'aborted');
      return;
    }

    const secondsUntilFunding = (targetFundingTime - Date.now()) / 1000;
    if (secondsUntilFunding < -30) {
      this.log('warning', `entry skipped due to stale timing | asset=${asset} lateBy=${Math.abs(secondsUntilFunding).toFixed(0)}s`);
      return;
    }
    if (secondsUntilFunding > 60) {
      this.log('warning', `entry skipped due to early timing | asset=${asset} secondsUntilFunding=${secondsUntilFunding.toFixed(0)}`);
      return;
    }

    const apiConfigs = loadAllServerApiConfigs();
    const shortConfig = apiConfigs[opportunity.shortExchange];
    const longConfig = apiConfigs[opportunity.longExchange];

    if (!shortConfig || !longConfig) {
      this.stats.errors++;
      this.log(
        'error',
        `entry aborted due to missing API config | asset=${asset} exchanges=${opportunity.shortExchange}/${opportunity.longExchange}`,
      );
      this.saveState();
      return;
    }

    try {
      const snipeConfig = getSnipeConfig(this.config.confirmedSnipeConfig);
      let shortRateForDecision = opportunity.shortRate;
      let longRateForDecision = opportunity.longRate;
      let spreadForDecision = opportunity.spread;
      let spreadPercentForDecision = opportunity.spreadPercent;
      try {
        const [shortRates, longRates] = await Promise.all([
          fetchFundingRates(opportunity.shortExchange, undefined, [opportunity.shortSymbol]),
          fetchFundingRates(opportunity.longExchange, undefined, [opportunity.longSymbol]),
        ]);
        const shortLiveRate = shortRates.find((rate) => rate.symbol === opportunity.shortSymbol)
          ?? shortRates.find((rate) => rate.baseAsset === opportunity.baseAsset);
        const longLiveRate = longRates.find((rate) => rate.symbol === opportunity.longSymbol)
          ?? longRates.find((rate) => rate.baseAsset === opportunity.baseAsset);
        if (!shortLiveRate || !longLiveRate) {
          this.log(
            'warning',
            `entry blocked by funding revalidate miss | asset=${asset} short=${shortRates.length} long=${longRates.length}`,
          );
          this.recordTrades([{
            timestamp: Date.now(),
            type: 'guard_block',
            simulation: false,
            baseAsset: asset,
            shortExchange: opportunity.shortExchange,
            longExchange: opportunity.longExchange,
            spread: opportunity.spread,
            spreadPercent: opportunity.spreadPercent,
            reason: 'funding_revalidate_missing',
            detail: `shortRates:${shortRates.length} longRates:${longRates.length}`,
          }]);
          return;
        }

        const liveSpread = shortLiveRate.rate - longLiveRate.rate;
        const liveSpreadPercent = liveSpread * 100;
        if (liveSpread <= 0 || liveSpreadPercent < this.config.minSpreadPercent) {
          this.log(
            'warning',
            `entry blocked by live spread revalidate | asset=${asset} spread=${liveSpreadPercent.toFixed(4)}% min=${this.config.minSpreadPercent.toFixed(4)}%`,
          );
          this.recordTrades([{
            timestamp: Date.now(),
            type: 'guard_block',
            simulation: false,
            baseAsset: asset,
            shortExchange: opportunity.shortExchange,
            longExchange: opportunity.longExchange,
            spread: liveSpread,
            spreadPercent: liveSpreadPercent,
            reason: 'live_spread_reverted',
            detail: `liveSpread:${liveSpreadPercent.toFixed(6)} minSpread:${this.config.minSpreadPercent.toFixed(6)}`,
          }]);
          return;
        }

        const shortFundingShiftMs = Math.abs(shortLiveRate.nextFundingTime - targetFundingTime);
        const longFundingShiftMs = Math.abs(longLiveRate.nextFundingTime - targetFundingTime);
        if (shortFundingShiftMs > LIVE_FUNDING_TIME_DRIFT_MS || longFundingShiftMs > LIVE_FUNDING_TIME_DRIFT_MS) {
          this.log(
            'warning',
            `entry blocked by funding window shift | asset=${asset} shortShift=${shortFundingShiftMs}ms longShift=${longFundingShiftMs}ms`,
          );
          this.recordTrades([{
            timestamp: Date.now(),
            type: 'guard_block',
            simulation: false,
            baseAsset: asset,
            shortExchange: opportunity.shortExchange,
            longExchange: opportunity.longExchange,
            spread: liveSpread,
            spreadPercent: liveSpreadPercent,
            reason: 'funding_window_shifted',
            detail: `shortShiftMs:${shortFundingShiftMs} longShiftMs:${longFundingShiftMs} cap:${LIVE_FUNDING_TIME_DRIFT_MS}`,
          }]);
          return;
        }

        if (snipeConfig.useConfirmedClose) {
          const tsDiff = Math.abs(shortLiveRate.nextFundingTime - longLiveRate.nextFundingTime);
          if (tsDiff > MAX_FUNDING_TIMESTAMP_DIFF_MS) {
            this.log(
              'warning',
              `entry blocked by funding timestamp mismatch | asset=${asset} diff=${tsDiff}ms`,
            );
            this.recordTrades([{
              timestamp: Date.now(),
              type: 'guard_block',
              simulation: false,
              baseAsset: asset,
              shortExchange: opportunity.shortExchange,
              longExchange: opportunity.longExchange,
              spread: liveSpread,
              spreadPercent: liveSpreadPercent,
              reason: 'funding_timestamp_mismatch',
              detail: `diffMs:${tsDiff} cap:${MAX_FUNDING_TIMESTAMP_DIFF_MS}`,
            }]);
            return;
          }
        }

        shortRateForDecision = shortLiveRate.rate;
        longRateForDecision = longLiveRate.rate;
        spreadForDecision = liveSpread;
        spreadPercentForDecision = liveSpreadPercent;
      } catch (revalidateErr) {
        this.log(
          'warning',
          `entry blocked by funding revalidate error | asset=${asset} error=${getErrorMessage(revalidateErr)}`,
        );
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'guard_block',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          spread: opportunity.spread,
          spreadPercent: opportunity.spreadPercent,
          reason: 'funding_revalidate_failed',
          detail: getErrorMessage(revalidateErr),
        }]);
        return;
      }

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
      if (shortFeeInfo.source === 'preset' || longFeeInfo.source === 'preset') {
        this.log(
          'warning',
          `entry blocked by runtime fee unavailable | asset=${asset} ${opportunity.shortExchange}=${shortFeeInfo.source} ${opportunity.longExchange}=${longFeeInfo.source}`,
        );
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'guard_block',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          spread: opportunity.spread,
          spreadPercent: opportunity.spreadPercent,
          reason: 'fee_cache_unavailable',
          detail: `${opportunity.shortExchange}:${shortFeeInfo.source} ${opportunity.longExchange}:${longFeeInfo.source}`,
        }]);
        return;
      }

      const shortFeeRate = shortFeeInfo.fee;
      const longFeeRate = longFeeInfo.fee;
      const [shortBalance, longBalance] = await Promise.all([
        fetchBalance(opportunity.shortExchange, shortConfig),
        fetchBalance(opportunity.longExchange, longConfig),
      ]);
      const shortFreeRatio = shortBalance.totalUSDT > 0
        ? (shortBalance.availableUSDT / shortBalance.totalUSDT) * 100 : 0;
      const longFreeRatio = longBalance.totalUSDT > 0
        ? (longBalance.availableUSDT / longBalance.totalUSDT) * 100 : 0;
      const shortCostFactor = 1 + (this.config.leverage * shortFeeRate);
      const longCostFactor = 1 + (this.config.leverage * longFeeRate);
      const maxFeasibleMarginByBalance = Math.max(0, Math.min(
        shortCostFactor > 0 ? shortBalance.availableUSDT / shortCostFactor : 0,
        longCostFactor > 0 ? longBalance.availableUSDT / longCostFactor : 0,
      ));
      const requestedMargin = this.config.compoundInvesting
        ? maxFeasibleMarginByBalance * COMPOUND_BALANCE_USAGE_PCT
        : this.config.investmentUSDT;
      const baseNotional = requestedMargin * this.config.leverage;
      let targetNotional = baseNotional;

      if (!Number.isFinite(baseNotional) || baseNotional < MIN_ENTRY_NOTIONAL_USDT) {
        this.log(
          'warning',
          `entry blocked by balance sizing | asset=${asset} targetNotional=$${baseNotional.toFixed(2)} maxMargin=$${maxFeasibleMarginByBalance.toFixed(2)}`,
        );
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'guard_block',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          spread: opportunity.spread,
          spreadPercent: opportunity.spreadPercent,
          reason: 'insufficient_balance',
          detail: `targetNotional:${baseNotional.toFixed(2)} maxMargin:${maxFeasibleMarginByBalance.toFixed(2)} shortAvail:${shortBalance.availableUSDT.toFixed(2)} longAvail:${longBalance.availableUSDT.toFixed(2)}`,
        }]);
        return;
      }

      if (this.config.compoundInvesting) {
        this.log(
          'info',
          `compound sizing | asset=${asset} requestedMargin=$${requestedMargin.toFixed(2)} baseMargin=$${this.config.investmentUSDT.toFixed(2)} maxByBalance=$${maxFeasibleMarginByBalance.toFixed(2)}`,
        );
      }

      if (snipeConfig.useDynamicNotional) {
        try {
          const [shortOb, longOb] = await Promise.all([
            fetchOrderbook(opportunity.shortExchange, opportunity.shortSymbol, 50),
            fetchOrderbook(opportunity.longExchange, opportunity.longSymbol, 50),
          ]);
          const shortImpact = calcOrderbookImpactBps(shortOb.bids, shortOb.asks, baseNotional, 'sell');
          const longImpact = calcOrderbookImpactBps(longOb.bids, longOb.asks, baseNotional, 'buy');

          targetNotional = Math.min(
            targetNotional,
            shortImpact.depthCapNotional,
            longImpact.depthCapNotional,
            snipeConfig.dynamicNotionalCap,
          );

          this.log(
            'info',
            `dynamic notional | asset=${asset} base=$${baseNotional.toFixed(0)} ` +
            `shortDepthCap=$${shortImpact.depthCapNotional.toFixed(0)} ` +
            `longDepthCap=$${longImpact.depthCapNotional.toFixed(0)} ` +
            `final=$${targetNotional.toFixed(0)}`,
          );

          if (targetNotional < MIN_ENTRY_NOTIONAL_USDT) {
            this.log(
              'warning',
              `entry skipped due to shallow depth | asset=${asset} targetNotional=$${targetNotional.toFixed(0)} < $${MIN_ENTRY_NOTIONAL_USDT}`,
            );
            this.recordTrades([{
              timestamp: Date.now(),
              type: 'guard_block',
              simulation: false,
              baseAsset: asset,
              shortExchange: opportunity.shortExchange,
              longExchange: opportunity.longExchange,
              spread: opportunity.spread,
              spreadPercent: opportunity.spreadPercent,
              reason: 'depth_insufficient',
              detail: `targetNotional:$${targetNotional.toFixed(0)} shortDepthCap:$${shortImpact.depthCapNotional.toFixed(0)} longDepthCap:$${longImpact.depthCapNotional.toFixed(0)}`,
            }]);
            return;
          }
        } catch (err) {
          this.log(
            'warning',
            `entry blocked by orderbook unavailable for dynamic notional | asset=${asset} error=${getErrorMessage(err)}`,
          );
          this.recordTrades([{
            timestamp: Date.now(),
            type: 'guard_block',
            simulation: false,
            baseAsset: asset,
            shortExchange: opportunity.shortExchange,
            longExchange: opportunity.longExchange,
            spread: opportunity.spread,
            spreadPercent: opportunity.spreadPercent,
            reason: 'orderbook_unavailable',
            detail: getErrorMessage(err),
          }]);
          return;
        }
      }

      const requiredShortBalance = (targetNotional / this.config.leverage)
        + (targetNotional * shortFeeRate);
      const requiredLongBalance = (targetNotional / this.config.leverage)
        + (targetNotional * longFeeRate);

      if (shortBalance.availableUSDT < requiredShortBalance || longBalance.availableUSDT < requiredLongBalance) {
        this.log(
          'warning',
          `entry blocked by balance check | asset=${asset} ` +
          `${opportunity.shortExchange}=${shortBalance.availableUSDT.toFixed(2)}/${requiredShortBalance.toFixed(2)} ` +
          `${opportunity.longExchange}=${longBalance.availableUSDT.toFixed(2)}/${requiredLongBalance.toFixed(2)}`,
        );
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'guard_block',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          spread: opportunity.spread,
          spreadPercent: opportunity.spreadPercent,
          reason: 'insufficient_balance',
          detail: `required:${opportunity.shortExchange}=${requiredShortBalance.toFixed(2)},${opportunity.longExchange}=${requiredLongBalance.toFixed(2)} available:${opportunity.shortExchange}=${shortBalance.availableUSDT.toFixed(2)},${opportunity.longExchange}=${longBalance.availableUSDT.toFixed(2)}`,
        }]);
        return;
      }

      if (shortFreeRatio < MIN_FREE_MARGIN_PCT || longFreeRatio < MIN_FREE_MARGIN_PCT) {
        this.log(
          'warning',
          `entry blocked by free margin | asset=${asset} ` +
          `${opportunity.shortExchange}=${shortFreeRatio.toFixed(1)}% ` +
          `${opportunity.longExchange}=${longFreeRatio.toFixed(1)}% min=${MIN_FREE_MARGIN_PCT}%`,
        );
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'guard_block',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          spread: opportunity.spread,
          spreadPercent: opportunity.spreadPercent,
          reason: 'free_margin_low',
          detail: `${opportunity.shortExchange}:${shortFreeRatio.toFixed(1)}% ${opportunity.longExchange}:${longFreeRatio.toFixed(1)}% min:${MIN_FREE_MARGIN_PCT}%`,
        }]);
        return;
      }
      try {
        const liqCheck = await checkPairLiquidationDistance(
          opportunity.shortExchange, opportunity.longExchange,
          shortConfig, longConfig,
          opportunity.shortSymbol, opportunity.longSymbol,
        );
        if (!liqCheck.safe) {
          this.log(
            'warning',
            `entry blocked by liquidation distance | asset=${asset} ${liqCheck.detail}`,
          );
          this.recordTrades([{
            timestamp: Date.now(),
            type: 'guard_block',
            simulation: false,
            baseAsset: asset,
            shortExchange: opportunity.shortExchange,
            longExchange: opportunity.longExchange,
            spread: opportunity.spread,
            spreadPercent: opportunity.spreadPercent,
            reason: 'liq_distance_low',
            detail: liqCheck.detail,
          }]);
          return;
        }
      } catch (liqErr) {
        this.log('warning', `entry blocked by liquidation check failure | asset=${asset} error=${getErrorMessage(liqErr)}`);
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'guard_block',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          spread: opportunity.spread,
          spreadPercent: opportunity.spreadPercent,
          reason: 'liq_check_failed',
          detail: getErrorMessage(liqErr),
        }]);
        return;
      }

      let shortFill: Awaited<ReturnType<typeof fetchMarketFillPrice>> | null = null;
      let longFill: Awaited<ReturnType<typeof fetchMarketFillPrice>> | null = null;
      const maxSlippagePct = this.config.maxSlippagePercent ?? 1.5;
      const impactCapBps = snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS;
      const adaptiveSizingEnabled = this.config.compoundInvesting || snipeConfig.useDynamicNotional;

      for (let attempt = 0; attempt < MAX_ADAPTIVE_NOTIONAL_ATTEMPTS; attempt += 1) {
        [shortFill, longFill] = await Promise.all([
          fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', targetNotional),
          fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', targetNotional),
        ]);

        if (snipeConfig.useImpactGuards) {
          const roundTripImpactBps = (shortFill.slippagePercent + longFill.slippagePercent) * 2 * 100;
          if (roundTripImpactBps > impactCapBps) {
            const scale = Math.max(0.2, Math.min(0.98, (impactCapBps / Math.max(roundTripImpactBps, 0.0001)) * 0.97));
            const nextNotional = Math.floor(targetNotional * scale * 100) / 100;
            if (
              adaptiveSizingEnabled
              && attempt < MAX_ADAPTIVE_NOTIONAL_ATTEMPTS - 1
              && nextNotional >= MIN_ENTRY_NOTIONAL_USDT
              && nextNotional < targetNotional - 1
            ) {
              this.log(
                'info',
                `adaptive notional shrink | asset=${asset} reason=impact from=$${targetNotional.toFixed(2)} to=$${nextNotional.toFixed(2)} roundTrip=${roundTripImpactBps.toFixed(1)}bps cap=${impactCapBps}bps`,
              );
              targetNotional = nextNotional;
              continue;
            }
            this.log(
              'warning',
              `entry blocked by impact guard | asset=${asset} roundTrip=${roundTripImpactBps.toFixed(1)}bps > ${impactCapBps}bps`,
            );
            this.recordTrades([{
              timestamp: Date.now(),
              type: 'guard_block',
              simulation: false,
              baseAsset: asset,
              shortExchange: opportunity.shortExchange,
              longExchange: opportunity.longExchange,
              spread: opportunity.spread,
              spreadPercent: opportunity.spreadPercent,
              reason: 'impact_exceeded',
              detail: `roundTripImpactBps:${roundTripImpactBps.toFixed(1)} cap:${impactCapBps} notional:${targetNotional.toFixed(2)}`,
            }]);
            return;
          }
        } else {
          const worstSlippage = Math.max(shortFill.slippagePercent, longFill.slippagePercent);
          if (worstSlippage > maxSlippagePct) {
            const worstSide = shortFill.slippagePercent > longFill.slippagePercent ? 'short' : 'long';
            const worstExchange = worstSide === 'short' ? opportunity.shortExchange : opportunity.longExchange;
            const scale = Math.max(0.2, Math.min(0.98, (maxSlippagePct / Math.max(worstSlippage, 0.0001)) * 0.97));
            const nextNotional = Math.floor(targetNotional * scale * 100) / 100;
            if (
              adaptiveSizingEnabled
              && attempt < MAX_ADAPTIVE_NOTIONAL_ATTEMPTS - 1
              && nextNotional >= MIN_ENTRY_NOTIONAL_USDT
              && nextNotional < targetNotional - 1
            ) {
              this.log(
                'info',
                `adaptive notional shrink | asset=${asset} reason=slippage from=$${targetNotional.toFixed(2)} to=$${nextNotional.toFixed(2)} worst=${worstSlippage.toFixed(4)}% max=${maxSlippagePct}%`,
              );
              targetNotional = nextNotional;
              continue;
            }
            this.log(
              'warning',
              `entry blocked by slippage guard | asset=${asset} ${worstSide}(${worstExchange}) slippage=${worstSlippage.toFixed(4)}% > ${maxSlippagePct}%`,
            );
            this.recordTrades([{
              timestamp: Date.now(),
              type: 'guard_block',
              simulation: false,
              baseAsset: asset,
              shortExchange: opportunity.shortExchange,
              longExchange: opportunity.longExchange,
              spread: opportunity.spread,
              spreadPercent: opportunity.spreadPercent,
              reason: 'slippage_exceeded',
              detail: `slippage_${worstSide}(${worstExchange}):${worstSlippage.toFixed(6)}% max:${maxSlippagePct}% notional:${targetNotional.toFixed(2)}`,
            }]);
            return;
          }
        }

        const entryGapThreshold = snipeConfig.useImpactGuards
          ? impactCapBps / 100
          : maxSlippagePct;
        const entryGap = getEntryGapMetrics({
          shortPrice: shortFill.fillPrice,
          longPrice: longFill.fillPrice,
          baselineShortPrice: opportunity.shortMarkPrice,
          baselineLongPrice: opportunity.longMarkPrice,
        });
        if (entryGap.driftPercent > entryGapThreshold) {
          this.log(
            'warning',
            `entry blocked by gap drift | asset=${asset} drift=${entryGap.driftPercent.toFixed(4)}% (live=${entryGap.liveGapPercent.toFixed(4)}% base=${entryGap.baselineGapPercent.toFixed(4)}%) > ${entryGapThreshold.toFixed(4)}%`,
          );
          this.recordTrades([{
            timestamp: Date.now(),
            type: 'guard_block',
            simulation: false,
            baseAsset: asset,
            shortExchange: opportunity.shortExchange,
            longExchange: opportunity.longExchange,
            spread: opportunity.spread,
            spreadPercent: opportunity.spreadPercent,
            reason: 'entry_gap_exceeded',
            detail: `entryGapDrift:${entryGap.driftPercent.toFixed(6)}% live:${entryGap.liveGapPercent.toFixed(6)}% base:${entryGap.baselineGapPercent.toFixed(6)}% threshold:${entryGapThreshold.toFixed(6)}% notional:${targetNotional.toFixed(2)}`,
          }]);
          return;
        }

        break;
      }

      if (!shortFill || !longFill) {
        throw new Error('unable to validate entry slippage');
      }

      const execHedgeFeePct = (shortFeeRate + longFeeRate) * 2 * 100;
      let profitabilityPassed = false;
      let profitabilityDetail = '';
      let evDecisionValue: number | undefined;

      // Profitability gate: conservative EV (REAL fail-safe)
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
        const entryImpactDec = (shortFill.slippagePercent + longFill.slippagePercent) / 100;
        const exitImpactDec = entryImpactDec;

        const ev = calcConservativeEV(
          targetNotional,
          shortRateForDecision,
          longRateForDecision,
          shortDrift,
          longDrift,
          roundTripFeeDec,
          entryImpactDec,
          exitImpactDec,
        );

        profitabilityPassed = ev.passesMinProfit && ev.passesEVRatio;
        evDecisionValue = ev.expectedNetUSD;
        profitabilityDetail = `EV=$${ev.expectedNetUSD.toFixed(4)} ratio=${ev.evRatio.toFixed(2)} drift=${shortDrift.toFixed(6)}/${longDrift.toFixed(6)}`;

        if (!profitabilityPassed) {
          this.log(
            'warning',
            `entry blocked by conservative EV | asset=${asset} ${profitabilityDetail}`,
          );
        }
      }

      if (!profitabilityPassed) {
        this.log(
          'warning',
          `entry blocked by profitability gate | asset=${asset} ${profitabilityDetail}`,
        );
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'guard_block',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          spread: opportunity.spread,
          spreadPercent: opportunity.spreadPercent,
          reason: 'profitability_insufficient',
          detail: profitabilityDetail,
        }]);
        return;
      }

      const shortQty = targetNotional / shortFill.fillPrice;
      const longQty = targetNotional / longFill.fillPrice;
      const shortLimitPrice = shortFill.worstPrice * (1 - 0.0005);
      const longLimitPrice = longFill.worstPrice * (1 + 0.0005);

      // v2.1: strict hedge ratio pre-check
      if (snipeConfig.useStrictHedge) {
        const shortNotionalEst = shortQty * shortFill.fillPrice;
        const longNotionalEst = longQty * longFill.fillPrice;
        const hedgeRatio = Math.abs(longNotionalEst / shortNotionalEst);
        if (hedgeRatio < HEDGE_RATIO_MIN || hedgeRatio > HEDGE_RATIO_MAX) {
          this.log(
            'warning',
            `entry blocked by hedge ratio | asset=${asset} ratio=${hedgeRatio.toFixed(6)} ` +
            `allowed=[${HEDGE_RATIO_MIN}, ${HEDGE_RATIO_MAX}]`,
          );
          this.recordTrades([{
            timestamp: Date.now(),
            type: 'guard_block',
            simulation: false,
            baseAsset: asset,
            shortExchange: opportunity.shortExchange,
            longExchange: opportunity.longExchange,
            spread: opportunity.spread,
            spreadPercent: opportunity.spreadPercent,
            reason: 'hedge_ratio_exceeded',
            detail: `hedgeRatio:${hedgeRatio.toFixed(6)}`,
          }]);
          return;
        }
      }

      // ???? Execute both legs with orphan timing measurement ????
      transitionPhase(opportunityId, 'submit_both');
      let shortDoneAt = 0;
      let longDoneAt = 0;
      const execStartMs = Date.now();

      const [shortResult, longResult] = await Promise.allSettled([
        openPositionExact(
          opportunity.shortExchange,
          shortConfig,
          opportunity.shortSymbol,
          'short',
          shortQty,
          shortLimitPrice,
          this.config.leverage,
          this.config.feeOverrides,
          snipeConfig.useIocLimitOnly,
          this.config.paybackOverrides,
        ).finally(() => { shortDoneAt = Date.now(); }),
        openPositionExact(
          opportunity.longExchange,
          longConfig,
          opportunity.longSymbol,
          'long',
          longQty,
          longLimitPrice,
          this.config.leverage,
          this.config.feeOverrides,
          snipeConfig.useIocLimitOnly,
          this.config.paybackOverrides,
        ).finally(() => { longDoneAt = Date.now(); }),
      ]);

      const shortOk = shortResult.status === 'fulfilled';
      const longOk = longResult.status === 'fulfilled';

      // Orphan leg timing: how long was one leg exposed without the other
      const orphanMs = Math.abs(shortDoneAt - longDoneAt);
      const totalExecMs = Date.now() - execStartMs;

      // Hard enforcement: if orphan exceeds cap AND both legs succeeded, rollback both
      if (orphanMs > MAX_ORPHAN_LEG_MS && shortResult.status === 'fulfilled' && longResult.status === 'fulfilled') {
        this.log(
          'warning',
          `orphan leg exceeded - forced rollback | asset=${asset} orphan=${orphanMs}ms > ${MAX_ORPHAN_LEG_MS}ms totalExec=${totalExecMs}ms`,
        );

        await Promise.allSettled([
          this.rollbackSingleEntry(
            opportunity.shortExchange, shortConfig, opportunity.shortSymbol,
            'short', shortResult.value.amount, asset, 'orphan_leg_exceeded',
          ),
          this.rollbackSingleEntry(
            opportunity.longExchange, longConfig, opportunity.longSymbol,
            'long', longResult.value.amount, asset, 'orphan_leg_exceeded',
          ),
        ]);

        completeExecution(opportunityId, 'forced_close', { orphanLegMs: orphanMs });

        this.recordTrades([{
          timestamp: Date.now(),
          type: 'guard_block',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          spread: opportunity.spread,
          spreadPercent: opportunity.spreadPercent,
          reason: 'orphan_leg_exceeded',
          detail: `orphanMs:${orphanMs} cap:${MAX_ORPHAN_LEG_MS} totalExec:${totalExecMs}`,
        }]);
        this.saveState();
        return;
      } else if (orphanMs > MAX_ORPHAN_LEG_MS) {
        // One leg failed anyway; log telemetry and continue rollback handling.
        this.log(
          'warning',
          `orphan leg exposure ${orphanMs}ms > ${MAX_ORPHAN_LEG_MS}ms | asset=${asset} totalExec=${totalExecMs}ms (leg failure handles rollback)`,
        );
      }

      const shortFailure = shortResult.status === 'rejected' ? shortResult.reason : undefined;
      const longFailure = longResult.status === 'rejected' ? longResult.reason : undefined;
      const shortPartial = shortFailure ? getPartialExecution(shortFailure) : null;
      const longPartial = longFailure ? getPartialExecution(longFailure) : null;

      if (!shortOk || !longOk) {
        transitionPhase(opportunityId, shortOk || longOk ? 'one_leg_filled' : 'hedge_or_abort');
        const rollbackTargets = [
          ...(shortOk ? [{
            exchange: opportunity.shortExchange,
            config: shortConfig,
            symbol: opportunity.shortSymbol,
            side: 'short' as const,
            execution: shortResult.value,
            failureReason: `paired leg failed: ${getErrorMessage(longFailure)}`,
          }] : []),
          ...(!shortOk && shortPartial ? [{
            exchange: opportunity.shortExchange,
            config: shortConfig,
            symbol: opportunity.shortSymbol,
            side: 'short' as const,
            execution: shortPartial,
            failureReason: getErrorMessage(shortFailure),
          }] : []),
          ...(longOk ? [{
            exchange: opportunity.longExchange,
            config: longConfig,
            symbol: opportunity.longSymbol,
            side: 'long' as const,
            execution: longResult.value,
            failureReason: `paired leg failed: ${getErrorMessage(shortFailure)}`,
          }] : []),
          ...(!longOk && longPartial ? [{
            exchange: opportunity.longExchange,
            config: longConfig,
            symbol: opportunity.longSymbol,
            side: 'long' as const,
            execution: longPartial,
            failureReason: getErrorMessage(longFailure),
          }] : []),
        ];

        for (const rollback of rollbackTargets) {
          await this.rollbackSingleEntry(
            rollback.exchange,
            rollback.config,
            rollback.symbol,
            rollback.side,
            rollback.execution.amount,
            asset,
            rollback.failureReason,
          );
        }

        this.stats.errors++;
        completeExecution(opportunityId, 'error', { orphanLegMs: orphanMs });
        this.log(
          'error',
          `entry failed | asset=${asset} short=${shortOk ? 'rolled_back' : getErrorMessage(shortFailure)} ` +
          `long=${longOk ? 'rolled_back' : getErrorMessage(longFailure)} ` +
          `rollbackLegs=${rollbackTargets.length}`,
        );
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'error',
          simulation: false,
          baseAsset: asset,
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          reason: 'entry_execution_failed',
          detail: `short:${shortOk ? 'rolled_back' : getErrorMessage(shortFailure)} long:${longOk ? 'rolled_back' : getErrorMessage(longFailure)} rollbackLegs:${rollbackTargets.length}`,
        }]);
        this.saveState();
        return;
      }

      if (shortResult.status !== 'fulfilled' || longResult.status !== 'fulfilled') return;

      // ???? Hedge trim: reduce excess side via shared helper ????
      try {
        const trimResult = await rebalanceExecutedHedge({
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          shortConfig,
          longConfig,
          shortSymbol: opportunity.shortSymbol,
          longSymbol: opportunity.longSymbol,
          shortEntry: shortResult.value,
          longEntry: longResult.value,
          useStrictHedge: snipeConfig.useStrictHedge,
          feeOverrides: this.config.feeOverrides,
          paybackOverrides: this.config.paybackOverrides,
        });
        if (trimResult.trimmed) {
          if (trimResult.shortAmount !== undefined) shortResult.value.amount = trimResult.shortAmount;
          if (trimResult.longAmount !== undefined) longResult.value.amount = trimResult.longAmount;
          if (trimResult.shortFilledNotional !== undefined) shortResult.value.filledNotional = trimResult.shortFilledNotional;
          if (trimResult.longFilledNotional !== undefined) longResult.value.filledNotional = trimResult.longFilledNotional;
          this.log('info', `hedge trim | asset=${asset} ${trimResult.detail}`);
        }
      } catch (trimErr) {
        this.log('warning', `hedge trim failed | asset=${asset} error=${getErrorMessage(trimErr)}`);
      }

      const pairId = `srv-${Date.now()}-${opportunityId.replace(/[:]/g, '-')}`;
      const entryTime = Date.now();
      // v2.1: when confirmed close is ON, fire at funding time (executeClose handles settlement wait)
      // Legacy: fire at funding time + closeDelayMs
      const closeAt = snipeConfig.useConfirmedClose
        ? Math.max(Date.now(), targetFundingTime)
        : Math.max(Date.now(), targetFundingTime + Math.max(0, Math.min(this.getTimingConfig().closeDelayMs, 1_000)));
      const activePosition: ActivePosition = {
        opportunityId,
        asset,
        opportunity,
        pairId,
        shortAmount: shortResult.value.amount,
        longAmount: longResult.value.amount,
        shortEntry: shortResult.value,
        longEntry: longResult.value,
        closedLegs: [],
        entryTime,
        targetFundingTime,
        closeAt,
        closeAttempts: 0,
        evDecision: evDecisionValue,
        closeTimer: this.scheduleCloseTimer(opportunityId, closeAt),
      };

      this.activePositions.set(opportunityId, activePosition);
      this.persistServerMeta(activePosition);
      this.stats.totalEntries++;
      transitionPhase(opportunityId, 'pending_funding');

      const expectedPerFunding = (shortResult.value.filledNotional * shortRateForDecision)
        - (longResult.value.filledNotional * longRateForDecision);
      const expectedTotalRoundTripFees = shortResult.value.estimatedFee
        + longResult.value.estimatedFee
        + (shortResult.value.filledNotional * resolveRuntimeFee(
          opportunity.shortExchange,
          'taker',
          this.config.feeOverrides,
          this.config.paybackOverrides,
        ))
        + (longResult.value.filledNotional * resolveRuntimeFee(
          opportunity.longExchange,
          'taker',
          this.config.feeOverrides,
          this.config.paybackOverrides,
        ));

      this.recordTrades([{
        timestamp: entryTime,
        type: 'snipe_entry',
        simulation: false,
        baseAsset: asset,
        shortExchange: opportunity.shortExchange,
        longExchange: opportunity.longExchange,
        spread: spreadForDecision,
        spreadPercent: spreadPercentForDecision,
        margin: Math.min(shortResult.value.filledNotional, longResult.value.filledNotional) / this.config.leverage,
        leverage: this.config.leverage,
        notional: Math.min(shortResult.value.filledNotional, longResult.value.filledNotional),
        pairId,
        entryFee: shortResult.value.estimatedFee + longResult.value.estimatedFee,
        netProfit: expectedPerFunding - expectedTotalRoundTripFees,
        perFunding: expectedPerFunding,
        totalRoundTripFees: expectedTotalRoundTripFees,
        shortPrice: shortResult.value.price,
        longPrice: longResult.value.price,
        shortLiquidity: shortResult.value.liquidity,
        longLiquidity: longResult.value.liquidity,
        detail: `expectedPerFunding:${expectedPerFunding.toFixed(8)} totalRoundTripFees:${expectedTotalRoundTripFees.toFixed(8)}`,
        success: true,
      }]);

      this.log(
        'success',
        `entry complete | asset=${asset} short=$${shortResult.value.filledNotional.toFixed(2)} long=$${longResult.value.filledNotional.toFixed(2)} pairId=${pairId}`,
      );
      void sendTelegramMessage(
        `[Server] ${asset} entry complete\nshort ${opportunity.shortExchange.toUpperCase()} $${shortResult.value.filledNotional.toFixed(2)}\nlong ${opportunity.longExchange.toUpperCase()} $${longResult.value.filledNotional.toFixed(2)}\nspread: +${spreadPercentForDecision.toFixed(4)}%`,
      );

      this.saveState();
    } catch (err) {
      this.stats.errors++;
      completeExecution(opportunityId, 'error');
      this.log('error', `entry failed | asset=${asset} error=${(err as Error).message}`);
      this.recordTrades([{
        timestamp: Date.now(),
        type: 'error',
        simulation: false,
        baseAsset: asset,
        shortExchange: opportunity.shortExchange,
        longExchange: opportunity.longExchange,
        reason: (err as Error).message,
      }]);
      this.saveState();
    }
  }

  private scheduleCloseTimer(opportunityId: string, closeAt: number) {
    const delayMs = Math.max(0, closeAt - Date.now());
    return setTimeout(() => {
      void this.executeClose(opportunityId);
    }, delayMs);
  }

  private async executeClose(opportunityId: string) {
    const position = this.activePositions.get(opportunityId);
    if (!position) return;
    const asset = position.asset;

    const apiConfigs = loadAllServerApiConfigs();
    const shortConfig = apiConfigs[position.opportunity.shortExchange];
    const longConfig = apiConfigs[position.opportunity.longExchange];

    if (!shortConfig || !longConfig) {
      position.closeAttempts += 1;
      position.closeAt = Date.now() + CLOSE_RETRY_DELAY_MS;
      position.closeTimer = this.scheduleCloseTimer(opportunityId, position.closeAt);
      this.stats.errors++;
      this.log('error', `close postponed due to missing API config | asset=${asset}`);
      this.saveState();
      return;
    }

    // v2.1: when confirmed close is enabled, wait for funding settlement before closing.
    const snipeConfig = getSnipeConfig(this.config.confirmedSnipeConfig);
    if (
      snipeConfig.useConfirmedClose
      && position.closeAttempts === 0
      && pairSupportsConfirmedClose(position.opportunity.shortExchange, position.opportunity.longExchange)
    ) {
      const maxWaitMs = getPairMaxSettlementWaitMs(
        position.opportunity.shortExchange,
        position.opportunity.longExchange,
      );
      const deadline = position.targetFundingTime + maxWaitMs;
      const pollIntervalMs = 2_000;
      let shortSettled = false;
      let longSettled = false;

      transitionPhase(opportunityId, 'wait_settlement_confirm');
      this.log('info', `close: waiting for funding confirmation | asset=${asset} maxWait=${maxWaitMs / 1000}s`);

      while (Date.now() < deadline && (!shortSettled || !longSettled)) {
        const checks = await Promise.allSettled([
          !shortSettled
            ? checkFundingSettled(
                position.opportunity.shortExchange,
                shortConfig,
                position.opportunity.shortSymbol,
                position.targetFundingTime,
              )
            : Promise.resolve({ settled: true } as const),
          !longSettled
            ? checkFundingSettled(
                position.opportunity.longExchange,
                longConfig,
                position.opportunity.longSymbol,
                position.targetFundingTime,
              )
            : Promise.resolve({ settled: true } as const),
        ]);

        if (checks[0].status === 'fulfilled' && checks[0].value.settled) shortSettled = true;
        if (checks[1].status === 'fulfilled' && checks[1].value.settled) longSettled = true;

        if (shortSettled && longSettled) {
          this.log('info', `close: both legs funding confirmed | asset=${asset}`);
          break;
        }

        if (Date.now() + pollIntervalMs >= deadline) break;

        // Settlement wait breaker: abort if adverse price movement exceeds threshold
        const MAX_SETTLEMENT_ADVERSE_BPS = 4;
        try {
          const [shortMark, longMark] = await Promise.all([
            fetchMarketFillPrice(position.opportunity.shortExchange, position.opportunity.shortSymbol, 'sell', 1000).then(f => f.fillPrice),
            fetchMarketFillPrice(position.opportunity.longExchange, position.opportunity.longSymbol, 'buy', 1000).then(f => f.fillPrice),
          ]);
          // Short leg: adverse = price went up; Long leg: adverse = price went down
          const shortAdverseBps = ((shortMark - position.shortEntry.price) / position.shortEntry.price) * 10000;
          const longAdverseBps = ((position.longEntry.price - longMark) / position.longEntry.price) * 10000;
          const worstAdverseBps = Math.max(shortAdverseBps, longAdverseBps);
          if (worstAdverseBps > MAX_SETTLEMENT_ADVERSE_BPS) {
            this.log(
              'warning',
              `settlement wait breaker fired | asset=${asset} adverseBps=${worstAdverseBps.toFixed(1)} > ${MAX_SETTLEMENT_ADVERSE_BPS}`,
            );
            break; // Exit wait loop and flatten immediately.
          }
        } catch { /* non-blocking */ }

        // Hold-time liquidation distance monitor
        try {
          const liqCheck = await checkPairLiquidationDistance(
            position.opportunity.shortExchange, position.opportunity.longExchange,
            shortConfig, longConfig,
            position.opportunity.shortSymbol, position.opportunity.longSymbol,
          );
          if (liqCheck.critical) {
            this.log(
              'warning',
              `critical liq distance during settlement wait - force closing | asset=${asset} ${liqCheck.detail}`,
            );
            break; // Exit wait loop and flatten immediately.
          }
        } catch { /* non-blocking; continue wait */ }

        await this.sleep(pollIntervalMs);
      }

      if (!shortSettled || !longSettled) {
        this.log(
          'warning',
          `close: funding confirmation timeout | asset=${asset} short=${shortSettled} long=${longSettled} - force closing`,
        );
      }
    }

    transitionPhase(opportunityId, 'confirmed_close');
    transitionPhase(opportunityId, 'flatten');
    this.log('info', `close started | asset=${asset} attempt=${position.closeAttempts + 1}`);

    try {
      const existingShortLeg = position.closedLegs.find((leg) => leg.side === 'short') ?? null;
      const existingLongLeg = position.closedLegs.find((leg) => leg.side === 'long') ?? null;

      const [shortClose, longClose] = await Promise.allSettled([
        existingShortLeg
          ? Promise.resolve(existingShortLeg.exit)
          : closePosition(
            position.opportunity.shortExchange,
            shortConfig,
            position.opportunity.shortSymbol,
            'short',
            position.shortAmount,
            this.config.feeOverrides,
            this.config.paybackOverrides,
          ),
        existingLongLeg
          ? Promise.resolve(existingLongLeg.exit)
          : closePosition(
            position.opportunity.longExchange,
            longConfig,
            position.opportunity.longSymbol,
            'long',
            position.longAmount,
            this.config.feeOverrides,
            this.config.paybackOverrides,
          ),
      ]);

      let shortResult = shortClose.status === 'fulfilled' ? shortClose.value : null;
      let longResult = longClose.status === 'fulfilled' ? longClose.value : null;
      const errors: string[] = [];

      if (!shortResult) {
        errors.push(`short:${(shortClose as PromiseRejectedResult).reason?.message || 'unknown'}`);
      } else if (!existingShortLeg) {
        removeServerPositionMeta([makeServerPositionKey(
          position.opportunity.shortExchange,
          position.opportunity.shortSymbol,
          'short',
        )]);
      }

      if (!longResult) {
        errors.push(`long:${(longClose as PromiseRejectedResult).reason?.message || 'unknown'}`);
      } else if (!existingLongLeg) {
        removeServerPositionMeta([makeServerPositionKey(
          position.opportunity.longExchange,
          position.opportunity.longSymbol,
          'long',
        )]);
      }

      if (!shortResult || !longResult) {
        await this.sleep(3_000);

        const [shortRetry, longRetry] = await Promise.allSettled([
          shortResult
            ? Promise.resolve(shortResult)
            : closePosition(
              position.opportunity.shortExchange,
              shortConfig,
              position.opportunity.shortSymbol,
              'short',
              position.shortAmount,
              this.config.feeOverrides,
              this.config.paybackOverrides,
            ),
          longResult
            ? Promise.resolve(longResult)
            : closePosition(
              position.opportunity.longExchange,
              longConfig,
              position.opportunity.longSymbol,
              'long',
              position.longAmount,
              this.config.feeOverrides,
              this.config.paybackOverrides,
            ),
        ]);

        if (!shortResult) {
          if (shortRetry.status === 'fulfilled') {
            shortResult = shortRetry.value;
            if (!existingShortLeg) {
              removeServerPositionMeta([makeServerPositionKey(
                position.opportunity.shortExchange,
                position.opportunity.shortSymbol,
                'short',
              )]);
            }
          } else {
            errors.push(`short-retry:${getErrorMessage(shortRetry.reason)}`);
          }
        }

        if (!longResult) {
          if (longRetry.status === 'fulfilled') {
            longResult = longRetry.value;
            if (!existingLongLeg) {
              removeServerPositionMeta([makeServerPositionKey(
                position.opportunity.longExchange,
                position.opportunity.longSymbol,
                'long',
              )]);
            }
          } else {
            errors.push(`long-retry:${getErrorMessage(longRetry.reason)}`);
          }
        }
      }

      if (!shortResult || !longResult) {
        if (shortResult && !existingShortLeg) {
          position.closedLegs.push({
            exchange: position.opportunity.shortExchange,
            symbol: position.opportunity.shortSymbol,
            side: 'short',
            entry: position.shortEntry,
            exit: shortResult,
          });
          position.shortAmount = 0;
        }
        if (longResult && !existingLongLeg) {
          position.closedLegs.push({
            exchange: position.opportunity.longExchange,
            symbol: position.opportunity.longSymbol,
            side: 'long',
            entry: position.longEntry,
            exit: longResult,
          });
          position.longAmount = 0;
        }

        position.closeAttempts += 1;
        position.closeAt = Date.now() + CLOSE_RETRY_DELAY_MS;
        position.closeTimer = this.scheduleCloseTimer(opportunityId, position.closeAt);
        this.stats.errors++;

        this.log(
          'error',
          `close incomplete, retry scheduled | asset=${asset} attempt=${position.closeAttempts} errors=${errors.join(' | ')}`,
        );
        this.recordTrades([{
          timestamp: Date.now(),
          type: 'exit_failed',
          simulation: false,
          baseAsset: asset,
          shortExchange: position.opportunity.shortExchange,
          longExchange: position.opportunity.longExchange,
          pairId: position.pairId,
          detail: errors.join(' | '),
        }]);
        void sendTelegramMessage(
          `[Server] ${asset} close incomplete\nretry scheduled in ${CLOSE_RETRY_DELAY_MS / 1000}s\n${errors.join('\n')}`,
        );
        this.saveState();
        return;
      }

      const closedLegs = position.closedLegs
        .concat(
          existingShortLeg
            ? []
            : [{
              exchange: position.opportunity.shortExchange,
              symbol: position.opportunity.shortSymbol,
              side: 'short' as const,
              entry: position.shortEntry,
              exit: shortResult,
            }],
          existingLongLeg
            ? []
            : [{
              exchange: position.opportunity.longExchange,
              symbol: position.opportunity.longSymbol,
              side: 'long' as const,
              entry: position.longEntry,
              exit: longResult,
            }],
        )
        .reduce<ClosedLeg[]>((acc, leg) => {
          if (!acc.find((item) => item.side === leg.side)) {
            acc.push(leg);
          }
          return acc;
        }, []);

      transitionPhase(opportunityId, 'reconcile');
      const fundingVerification = await this.verifyFunding(position, shortConfig, longConfig);
      const fundingByLeg = new Map<string, number>();

      for (const payment of fundingVerification.payments) {
        const leg = closedLegs.find((item) =>
          item.exchange === payment.exchange && item.symbol === payment.symbol,
        );
        if (!leg) continue;
        const key = makeServerPositionKey(leg.exchange, leg.symbol, leg.side);
        fundingByLeg.set(key, (fundingByLeg.get(key) ?? 0) + payment.amount);
      }

      const exitTrades: TradeEvent[] = closedLegs.map((leg) => {
        const entryFee = leg.entry.estimatedFee;
        const exitFee = leg.exit.estimatedFee;
        const pricePnl = leg.side === 'short'
          ? (leg.entry.price - leg.exit.price) * leg.exit.amount
          : (leg.exit.price - leg.entry.price) * leg.exit.amount;
        const fundingAmount = fundingByLeg.get(makeServerPositionKey(leg.exchange, leg.symbol, leg.side)) ?? 0;
        const pnl = pricePnl - entryFee - exitFee + fundingAmount;

        return {
          timestamp: Date.now(),
          type: 'snipe_exit',
          simulation: false,
          baseAsset: asset,
          exchange: leg.exchange,
          side: leg.side,
          symbol: leg.symbol,
          pairId: position.pairId,
          entryFee,
          exitFee,
          fundingAmount,
          pricePnl,
          pnl,
          exitPrice: leg.exit.price,
          liquidity: leg.exit.liquidity,
          detail: `entry:${leg.entry.price.toFixed(8)} exit:${leg.exit.price.toFixed(8)} amount:${leg.exit.amount.toFixed(8)} verifiedFunding:${fundingVerification.verified}`,
        };
      });

      const fundingTrades: TradeEvent[] = fundingVerification.payments.map((payment) => ({
        timestamp: payment.timestamp,
        type: 'funding',
        simulation: false,
        baseAsset: asset,
        exchange: payment.exchange,
        side: payment.side,
        symbol: payment.symbol,
        pairId: position.pairId,
        fundingAmount: payment.amount,
        fundingRate: payment.rate,
        detail: `scheduler_verified:${fundingVerification.verified}`,
      }));

      const totalFunding = exitTrades.reduce((sum, trade) => sum + (trade.fundingAmount ?? 0), 0);
      const totalPnl = exitTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);

      this.recordTrades([
        ...exitTrades,
        ...fundingTrades,
        {
          timestamp: Date.now(),
          type: 'snipe_complete',
          simulation: false,
          baseAsset: asset,
          shortExchange: position.opportunity.shortExchange,
          longExchange: position.opportunity.longExchange,
          pairId: position.pairId,
          fundingCollected: fundingVerification.verified ? totalFunding : null,
          pnl: totalPnl,
          detail: fundingVerification.verified
            ? `fundingVerified:true fundingEvents:${fundingVerification.payments.length}`
            : `fundingVerified:false errors:${fundingVerification.errors.join(' | ') || 'none'}`,
        },
      ]);

      transitionPhase(opportunityId, 'cooldown');
      completeExecution(opportunityId, 'success', {
        fundingCaptured: fundingVerification.verified,
        settlementConfirmed: fundingVerification.verified,
        evDecision: position.evDecision,
        evRealized: totalPnl,
      });

      this.activePositions.delete(opportunityId);
      this.stats.totalCloses++;
      this.stats.totalProfit += totalPnl;
      this.log(
        'success',
        `close complete | asset=${asset} pnl=${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(4)} funding=${totalFunding >= 0 ? '+' : ''}$${totalFunding.toFixed(4)}`,
      );
      void sendTelegramMessage(
        `[Server] ${asset} close complete\npnl: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(4)}\nfunding: ${totalFunding >= 0 ? '+' : ''}$${totalFunding.toFixed(4)}${fundingVerification.verified ? '' : '\nfunding verification pending/manual check recommended'}`,
      );
      this.saveState();
    } catch (err) {
      position.closeAttempts += 1;
      position.closeAt = Date.now() + CLOSE_RETRY_DELAY_MS;
      position.closeTimer = this.scheduleCloseTimer(opportunityId, position.closeAt);
      this.stats.errors++;
      this.log('error', `close failed | asset=${asset} error=${(err as Error).message}`);
      this.saveState();
    }
  }

  private async verifyFunding(
    position: ActivePosition,
    shortConfig: ApiConfig,
    longConfig: ApiConfig,
  ): Promise<FundingVerificationResult> {
    const timing = this.getTimingConfig();
    let lastErrors: string[] = [];

    for (let attempt = 0; attempt < timing.fundingVerifyAttempts; attempt++) {
      const results = await Promise.allSettled([
        this.fetchFundingForLeg(
          position.opportunity.shortExchange,
          shortConfig,
          position.opportunity.shortSymbol,
          position.targetFundingTime,
        ),
        this.fetchFundingForLeg(
          position.opportunity.longExchange,
          longConfig,
          position.opportunity.longSymbol,
          position.targetFundingTime,
        ),
      ]);

      const payments: FundingPayment[] = [];
      const errors: string[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled') {
          payments.push(...result.value);
        } else {
          errors.push(result.reason?.message || 'unknown funding fetch failure');
        }
      }

      const dedupedPayments = this.dedupeFundingPayments(payments);
      if (dedupedPayments.length > 0) {
        return { verified: true, payments: dedupedPayments, errors };
      }

      lastErrors = errors;
      if (attempt < timing.fundingVerifyAttempts - 1) {
        await this.sleep(timing.fundingVerifyRetryMs);
      }
    }

    return { verified: false, payments: [], errors: lastErrors };
  }

  private async fetchFundingForLeg(
    exchange: ExchangeId,
    config: ApiConfig,
    symbol: string,
    targetFundingTime: number,
  ) {
    const history = await fetchFundingHistoryFromExchange(exchange, config, symbol, 20);
    return history.filter((payment) =>
      payment.symbol === symbol
      && Math.abs(payment.timestamp - targetFundingTime) <= FUNDING_MATCH_WINDOW_MS
      && Math.abs(payment.amount) > 0.0000001,
    );
  }

  private dedupeFundingPayments(payments: FundingPayment[]) {
    const map = new Map<string, FundingPayment>();

    for (const payment of payments) {
      const key = [
        payment.exchange,
        payment.symbol,
        payment.side,
        payment.timestamp,
        payment.amount.toFixed(8),
      ].join('|');

      if (!map.has(key)) {
        map.set(key, payment);
      }
    }

    return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  private persistServerMeta(position: ActivePosition) {
    upsertServerPositionMeta([
      {
        key: makeServerPositionKey(
          position.opportunity.shortExchange,
          position.opportunity.shortSymbol,
          'short',
        ),
        meta: {
          pairId: position.pairId,
          positionType: 'hedge_short',
          openedAt: position.entryTime,
          entryFee: position.shortEntry.estimatedFee,
          entryOrderLiquidity: position.shortEntry.liquidity,
          entryFilledNotional: position.shortEntry.filledNotional,
        },
      },
      {
        key: makeServerPositionKey(
          position.opportunity.longExchange,
          position.opportunity.longSymbol,
          'long',
        ),
        meta: {
          pairId: position.pairId,
          positionType: 'hedge_long',
          openedAt: position.entryTime,
          entryFee: position.longEntry.estimatedFee,
          entryOrderLiquidity: position.longEntry.liquidity,
          entryFilledNotional: position.longEntry.filledNotional,
        },
      },
    ]);
  }

  private recordTrades(events: TradeEvent[]) {
    appendTrades(events);
    this.routeFailureMemory.ingestEvents(events, { simulation: false });
  }

  private async rollbackSingleEntry(
    exchange: ExchangeId,
    config: ApiConfig,
    symbol: string,
    side: 'long' | 'short',
    amount: number,
    asset: string,
    reason: string,
  ) {
    try {
      await closePosition(
        exchange,
        config,
        symbol,
        side,
        amount,
        this.config.feeOverrides,
        this.config.paybackOverrides,
      );
      this.log('warning', `entry rollback complete | asset=${asset} exchange=${exchange} reason=${reason}`);
    } catch (rollbackErr) {
      this.log(
        'error',
        `entry rollback failed | asset=${asset} exchange=${exchange} reason=${reason} rollbackError=${(rollbackErr as Error).message}`,
      );
    }
  }

  private saveState() {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

      const state: PersistedState = {
        active: this.active,
        config: this.config,
        startedAt: this.startedAt,
        stats: this.stats,
        scheduledEntries: Array.from(this.scheduledEntries.values()).map((entry) => ({
          opportunityId: entry.opportunityId,
          asset: entry.asset,
          opportunity: entry.opportunity,
          targetTime: entry.targetTime,
        })),
        activePositions: Array.from(this.activePositions.values()).map((position) => ({
          opportunityId: position.opportunityId,
          asset: position.asset,
          opportunity: position.opportunity,
          pairId: position.pairId,
          shortAmount: position.shortAmount,
          longAmount: position.longAmount,
          shortEntry: position.shortEntry,
          longEntry: position.longEntry,
          closedLegs: position.closedLegs,
          entryTime: position.entryTime,
          targetFundingTime: position.targetFundingTime,
          closeAt: position.closeAt,
          closeAttempts: position.closeAttempts,
        })),
        lastPollTime: this.lastPollTime,
      };

      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      // ignore persistence errors
    }
  }

  private log(level: string, message: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    console.log(`[ServerScheduler] ${line}`);

    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(LOG_FILE, line + '\n');
    } catch {
      // ignore log persistence errors
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

export function getServerScheduler(): ServerScheduler {
  return ServerScheduler.getInstance();
}
