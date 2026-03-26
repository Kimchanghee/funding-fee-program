import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  closePosition,
  fetchFundingHistory as fetchFundingHistoryFromExchange,
  fetchFundingRates,
  fetchMarketFillPrice,
  getPartialExecution,
  openPositionExact,
  type ExecutedOrderSummary,
} from './exchanges';
import { appendTrades, type TradeEvent } from './fileLogger';
import {
  findOpportunities,
  getOpportunityHourlyNetProfit,
  getOpportunityId,
  getOpportunityLegKeys,
} from './opportunities';
import { loadAllServerApiConfigs } from './serverKeyStore';
import {
  makeServerPositionKey,
  removeServerPositionMeta,
  upsertServerPositionMeta,
} from './serverPositionMeta';
import { sendTelegramMessage } from './telegram';
import {
  getExchangeFee,
  getHedgeFeesWithOverrides,
  calcNetSpreadPercent,
  getResolvedTimingConfig,
  sanitizeFeeOverrides,
  sanitizeTimingConfig,
  type ApiConfig,
  type ArbitrageOpportunity,
  type ExchangeId,
  type FeeOverrides,
  type FundingPayment,
  type FundingRate,
  type TimingConfig,
} from './types';

const DATA_DIR = join(process.cwd(), 'data');
const STATE_FILE = join(DATA_DIR, 'scheduler-state.json');
const LOG_FILE = join(DATA_DIR, 'scheduler.log');
const CLOSE_RETRY_DELAY_MS = 30_000;
const FUNDING_MATCH_WINDOW_MS = 10 * 60 * 1000;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown';
}

export interface SchedulerConfig {
  investmentUSDT: number;
  leverage: number;
  minSpreadPercent: number;
  enabledExchanges: ExchangeId[];
  maxConcurrentPairs: number;
  feeOverrides?: FeeOverrides;
  timingConfig?: TimingConfig;
  maxSlippagePercent?: number; // 최대 슬리피지 % (기본 1.5%)
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

class ServerScheduler {
  private static instance: ServerScheduler | null = null;

  private active = false;
  private config: SchedulerConfig = {
    investmentUSDT: 500,
    leverage: 5,
    minSpreadPercent: 0.01,
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
  private loadedPersistedState = false;

  static getInstance(): ServerScheduler {
    if (!ServerScheduler.instance) {
      ServerScheduler.instance = new ServerScheduler();
    }
    return ServerScheduler.instance;
  }

  private constructor() {
    this.loadPersistedState();
  }

  private normalizeConfig(config: SchedulerConfig): SchedulerConfig {
    return {
      ...config,
      feeOverrides: sanitizeFeeOverrides(config.feeOverrides),
      timingConfig: getResolvedTimingConfig(sanitizeTimingConfig(config.timingConfig)),
    };
  }

  private getTimingConfig() {
    return getResolvedTimingConfig(this.config.timingConfig);
  }

  start(config: SchedulerConfig) {
    if (this.active) {
      this.stop();
    }

    const continuingSession = this.scheduledEntries.size > 0 || this.activePositions.size > 0;

    this.active = true;
    this.config = this.normalizeConfig(config);
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
      `scheduler started | investment=$${this.config.investmentUSDT} leverage=${this.config.leverage}x exchanges=${this.config.enabledExchanges.join(',')} minSpread=${this.config.minSpreadPercent}%`,
    );
    void sendTelegramMessage(
      `[Server Scheduler] started\ninvestment: $${this.config.investmentUSDT} | leverage: ${this.config.leverage}x\nexchanges: ${this.config.enabledExchanges.join(', ')}\nminSpread: ${this.config.minSpreadPercent}%`,
    );
  }

  updateConfig(config: SchedulerConfig) {
    const nextConfig = this.normalizeConfig(config);

    this.config = nextConfig;

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
        `scheduler config updated | investment=$${nextConfig.investmentUSDT} leverage=${nextConfig.leverage}x exchanges=${nextConfig.enabledExchanges.join(',')} minSpread=${nextConfig.minSpreadPercent}%`,
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
    this.pollInterval = setInterval(() => void this.poll(), 30_000);
  }

  private async poll() {
    if (!this.active) return;

    this.lastPollTime = Date.now();

    try {
      const results = await Promise.allSettled(
        this.config.enabledExchanges.map((exchange) => fetchFundingRates(exchange)),
      );

      const rates = results
        .filter((result): result is PromiseFulfilledResult<FundingRate[]> => result.status === 'fulfilled')
        .flatMap((result) => result.value);

      if (rates.length === 0) {
        this.saveState();
        return;
      }

      const opportunities = findOpportunities(
        rates,
        200,
        this.config.investmentUSDT,
        this.config.leverage,
        this.config.feeOverrides,
      );

      const occupiedLegs = this.getOccupiedLegs();

      const filtered = opportunities.filter((opportunity) => {
        const opportunityId = getOpportunityId(opportunity);
        if (this.scheduledEntries.has(opportunityId) || this.activePositions.has(opportunityId)) return false;
        if (getOpportunityLegKeys(opportunity).some((legKey) => occupiedLegs.has(legKey))) return false;
        if (!this.config.enabledExchanges.includes(opportunity.shortExchange)) return false;
        if (!this.config.enabledExchanges.includes(opportunity.longExchange)) return false;

        const aheadWindowMs = Math.max(5 * 3600000, opportunity.fundingIntervalMs ?? 8 * 3600000);
        if (opportunity.nextFundingTime - this.lastPollTime > aheadWindowMs) return false;
        if (opportunity.nextFundingTime < this.lastPollTime) return false;
        if (opportunity.spreadPercent < this.config.minSpreadPercent) return false;
        if (opportunity.netProfit <= 0) return false;

        return true;
      });

      const currentCount = this.scheduledEntries.size + this.activePositions.size;
      const slotsAvailable = this.config.maxConcurrentPairs - currentCount;
      const toSchedule: ArbitrageOpportunity[] = [];
      const selectedLegs = new Set(occupiedLegs);

      for (const opportunity of filtered) {
        if (toSchedule.length >= Math.max(0, slotsAvailable)) break;
        const legKeys = getOpportunityLegKeys(opportunity);
        if (legKeys.some((legKey) => selectedLegs.has(legKey))) continue;
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
    const timing = this.getTimingConfig();

    let targetTime = opportunity.nextFundingTime;
    const intervalMs = opportunity.fundingIntervalMs ?? 8 * 3600000;
    const now = Date.now();

    while (targetTime <= now) targetTime += intervalMs;
    if (targetTime - now < timing.entryLeadMs + 1_000) targetTime += intervalMs;

    const scheduledEntry: ScheduledEntry = {
      opportunityId,
      asset,
      opportunity,
      targetTime,
      timer: this.scheduleEntryTimer(opportunity, targetTime),
    };

    this.scheduledEntries.set(opportunityId, scheduledEntry);
    this.saveState();

    const delayMs = Math.max(0, targetTime - now - timing.entryLeadMs);
    const minutes = Math.floor(delayMs / 60000);
    const seconds = Math.floor((delayMs / 1000) % 60);
    this.log(
      'info',
      `entry scheduled | asset=${asset} opportunityId=${opportunityId} in=${minutes}m${seconds}s short=${opportunity.shortExchange} long=${opportunity.longExchange} spread=${opportunity.spreadPercent.toFixed(4)}% hourlyNet=${getOpportunityHourlyNetProfit(opportunity).toFixed(4)}`,
    );
  }

  private scheduleEntryTimer(opportunity: ArbitrageOpportunity, targetTime: number) {
    const delayMs = Math.max(0, targetTime - Date.now() - this.getTimingConfig().entryLeadMs);
    return setTimeout(() => {
      void this.executeEntry(opportunity, targetTime);
    }, delayMs);
  }

  private async executeEntry(opportunity: ArbitrageOpportunity, targetFundingTime: number) {
    const opportunityId = getOpportunityId(opportunity);
    const asset = opportunity.baseAsset;
    this.scheduledEntries.delete(opportunityId);
    this.saveState();

    if (!this.active) {
      this.log('warning', `entry skipped while inactive | asset=${asset}`);
      return;
    }

    const secondsUntilFunding = (targetFundingTime - Date.now()) / 1000;
    if (secondsUntilFunding < -10) {
      this.log('warning', `entry skipped due to stale timing | asset=${asset} lateBy=${Math.abs(secondsUntilFunding).toFixed(0)}s`);
      return;
    }
    if (secondsUntilFunding > 30) {
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
      const targetNotional = this.config.investmentUSDT * this.config.leverage;
      const [shortFill, longFill] = await Promise.all([
        fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', targetNotional),
        fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', targetNotional),
      ]);

      // ── Slippage guard: 설정값 이상이면 거래 차단 (기본 1.5%) ──
      const MAX_SLIPPAGE_PCT = this.config.maxSlippagePercent ?? 1.5;
      if (shortFill.slippagePercent > MAX_SLIPPAGE_PCT || longFill.slippagePercent > MAX_SLIPPAGE_PCT) {
        const worstSide = shortFill.slippagePercent > longFill.slippagePercent ? 'short' : 'long';
        const worstExchange = worstSide === 'short' ? opportunity.shortExchange : opportunity.longExchange;
        const worstSlippage = Math.max(shortFill.slippagePercent, longFill.slippagePercent);
        this.log(
          'warning',
          `entry blocked by slippage guard | asset=${asset} ${worstSide}(${worstExchange}) slippage=${worstSlippage.toFixed(4)}% > ${MAX_SLIPPAGE_PCT}% | short(${opportunity.shortExchange})=${shortFill.slippagePercent.toFixed(4)}% long(${opportunity.longExchange})=${longFill.slippagePercent.toFixed(4)}%`,
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
          detail: `slippage_${worstSide}(${worstExchange}):${worstSlippage.toFixed(6)}% max:${MAX_SLIPPAGE_PCT}% short(${opportunity.shortExchange}):${shortFill.slippagePercent.toFixed(6)}% long(${opportunity.longExchange}):${longFill.slippagePercent.toFixed(6)}%`,
        }]);
        return;
      }

      const entryGapPct = ((longFill.fillPrice - shortFill.fillPrice) / shortFill.fillPrice) * 100;
      const hedgeFeePct = getHedgeFeesWithOverrides(
        opportunity.shortExchange,
        opportunity.longExchange,
        'taker',
        this.config.feeOverrides,
      ) * 100;
      const realNetSpread = calcNetSpreadPercent(opportunity.spreadPercent, entryGapPct, hedgeFeePct);

      if (realNetSpread <= 0) {
        this.log(
          'warning',
          `entry blocked by profitability gate | asset=${asset} netSpread=${realNetSpread.toFixed(4)}% entryGap=${entryGapPct.toFixed(4)}% fees=${hedgeFeePct.toFixed(3)}%`,
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
          detail: `realNetSpread:${realNetSpread.toFixed(6)} entryGapPct:${entryGapPct.toFixed(6)} hedgeFeePct:${hedgeFeePct.toFixed(6)}`,
        }]);
        return;
      }

      const shortQty = targetNotional / shortFill.fillPrice;
      const longQty = targetNotional / longFill.fillPrice;
      const shortLimitPrice = shortFill.worstPrice * (1 - 0.0005);
      const longLimitPrice = longFill.worstPrice * (1 + 0.0005);

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
        ),
        openPositionExact(
          opportunity.longExchange,
          longConfig,
          opportunity.longSymbol,
          'long',
          longQty,
          longLimitPrice,
          this.config.leverage,
          this.config.feeOverrides,
        ),
      ]);

      const shortOk = shortResult.status === 'fulfilled';
      const longOk = longResult.status === 'fulfilled';
      const shortFailure = shortResult.status === 'rejected' ? shortResult.reason : undefined;
      const longFailure = longResult.status === 'rejected' ? longResult.reason : undefined;
      const shortPartial = shortFailure ? getPartialExecution(shortFailure) : null;
      const longPartial = longFailure ? getPartialExecution(longFailure) : null;

      if (!shortOk || !longOk) {
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

      const pairId = `srv-${Date.now()}-${opportunityId.replace(/[:]/g, '-')}`;
      const entryTime = Date.now();
      const closeAt = Math.max(Date.now(), targetFundingTime + this.getTimingConfig().closeDelayMs);
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
        closeTimer: this.scheduleCloseTimer(opportunityId, closeAt),
      };

      this.activePositions.set(opportunityId, activePosition);
      this.persistServerMeta(activePosition);
      this.stats.totalEntries++;

      const expectedPerFunding = (shortResult.value.filledNotional * opportunity.shortRate)
        - (longResult.value.filledNotional * opportunity.longRate);
      const expectedTotalRoundTripFees = shortResult.value.estimatedFee
        + longResult.value.estimatedFee
        + (shortResult.value.filledNotional * getExchangeFee(opportunity.shortExchange, 'taker', this.config.feeOverrides))
        + (longResult.value.filledNotional * getExchangeFee(opportunity.longExchange, 'taker', this.config.feeOverrides));

      this.recordTrades([{
        timestamp: entryTime,
        type: 'snipe_entry',
        simulation: false,
        baseAsset: asset,
        shortExchange: opportunity.shortExchange,
        longExchange: opportunity.longExchange,
        spread: opportunity.spread,
        spreadPercent: opportunity.spreadPercent,
        margin: this.config.investmentUSDT,
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
        `[Server] ${asset} entry complete\nshort ${opportunity.shortExchange.toUpperCase()} $${shortResult.value.filledNotional.toFixed(2)}\nlong ${opportunity.longExchange.toUpperCase()} $${longResult.value.filledNotional.toFixed(2)}\nspread: +${opportunity.spreadPercent.toFixed(4)}%`,
      );

      this.saveState();
    } catch (err) {
      this.stats.errors++;
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

        if (!shortResult) {
          try {
            shortResult = await closePosition(
              position.opportunity.shortExchange,
              shortConfig,
              position.opportunity.shortSymbol,
              'short',
              position.shortAmount,
              this.config.feeOverrides,
            );
            if (!existingShortLeg) {
              removeServerPositionMeta([makeServerPositionKey(
                position.opportunity.shortExchange,
                position.opportunity.shortSymbol,
                'short',
              )]);
            }
          } catch (retryErr) {
            errors.push(`short-retry:${(retryErr as Error).message}`);
          }
        }

        if (!longResult) {
          try {
            longResult = await closePosition(
              position.opportunity.longExchange,
              longConfig,
              position.opportunity.longSymbol,
              'long',
              position.longAmount,
              this.config.feeOverrides,
            );
            if (!existingLongLeg) {
              removeServerPositionMeta([makeServerPositionKey(
                position.opportunity.longExchange,
                position.opportunity.longSymbol,
                'long',
              )]);
            }
          } catch (retryErr) {
            errors.push(`long-retry:${(retryErr as Error).message}`);
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
      await closePosition(exchange, config, symbol, side, amount, this.config.feeOverrides);
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
