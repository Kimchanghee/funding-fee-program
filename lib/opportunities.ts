import type { FundingRate, ArbitrageOpportunity, ExchangeId, FeeOverrides, PaybackOverrides } from './types';
import {
  getHedgeFeeBreakdown,
  getHedgeFeesWithOverrides,
  calcNetSpreadPercent,
  MIN_DRIFT_BUFFER_BPS,
  MIN_PROFIT_USD,
  MIN_EV_RATIO,
} from './types';
import { calcAnnualReturn, getMinutesToFunding } from './exchanges/utils';
import { pairUsesInstantaneousRate } from './exchangeProfiles';

const FUNDING_ALIGNMENT_TOLERANCE_MS = 120_000;

// ── v2.1: Funding Drift Buffer ──

/**
 * Calculate conservative funding rate drift buffer.
 * Accounts for rate volatility between display time and actual settlement.
 *
 * For exchanges with frequent rate updates (e.g. Bybit every minute)
 * or instantaneous rate usage (e.g. OKX), apply larger buffer.
 *
 * @param displayedRate - Current displayed funding rate (decimal, e.g. 0.0005)
 * @param recentRateHistory - Optional recent rate changes for more precise buffer
 * @param exchangeUsesInstantRate - Whether the exchange uses instantaneous rate at settlement
 * @returns Buffer amount in decimal (same unit as displayedRate)
 */
export function calcDriftBuffer(
  displayedRate: number,
  recentRateHistory?: { last1mChange: number; last5mChange: number },
  exchangeUsesInstantRate = false,
): number {
  const minBuffer = MIN_DRIFT_BUFFER_BPS / 10000; // 1bp in decimal

  if (!recentRateHistory) {
    // No history available — use a conservative default
    return exchangeUsesInstantRate
      ? Math.max(minBuffer, Math.abs(displayedRate) * 0.05) // 5% of rate for instant-rate exchanges
      : minBuffer;
  }

  const { last1mChange, last5mChange } = recentRateHistory;
  const buffer = Math.max(
    Math.abs(last1mChange),
    Math.abs(last5mChange) * 0.5,
    minBuffer,
  );

  // Instant-rate exchanges (OKX) need larger buffer
  return exchangeUsesInstantRate ? buffer * 1.5 : buffer;
}

// ── v2.1: Conservative Expected Value ──

export interface ConservativeEVResult {
  expectedFundingUSD: number;
  roundTripFeeUSD: number;
  entryImpactUSD: number;
  exitImpactUSD: number;
  timingReserveUSD: number;
  expectedNetUSD: number;
  passesMinProfit: boolean;
  passesEVRatio: boolean;
  evRatio: number;
}

/**
 * Conservative Expected Value calculation per v2.1 strategy.
 * All impacts are per-exchange-mid-based (not cross-exchange average).
 *
 * @param notionalUSD - Position notional in USD
 * @param shortRate - Short leg funding rate (decimal)
 * @param longRate - Long leg funding rate (decimal)
 * @param shortDriftBuffer - Drift buffer for short leg (decimal)
 * @param longDriftBuffer - Drift buffer for long leg (decimal)
 * @param roundTripFeePct - Round-trip fee as decimal (e.g. 0.0016 for 0.16%)
 * @param entryImpactPct - Entry impact as decimal (e.g. 0.0004 for 4bps), per-exchange mid based
 * @param exitImpactPct - Exit impact as decimal, per-exchange mid based
 */
export function calcConservativeEV(
  notionalUSD: number,
  shortRate: number,
  longRate: number,
  shortDriftBuffer: number,
  longDriftBuffer: number,
  roundTripFeePct: number,
  entryImpactPct: number,
  exitImpactPct: number,
): ConservativeEVResult {
  const shortFR_eff = shortRate - shortDriftBuffer;
  const longFR_eff = longRate + longDriftBuffer;
  const expectedFundingUSD = notionalUSD * (shortFR_eff - longFR_eff);
  const roundTripFeeUSD = notionalUSD * roundTripFeePct;
  const entryImpactUSD = notionalUSD * entryImpactPct;
  const exitImpactUSD = notionalUSD * exitImpactPct;
  // Timing reserve: 0.5bp flat for rounding/latency
  const timingReserveUSD = notionalUSD * 0.00005;

  const expectedNetUSD = expectedFundingUSD
    - roundTripFeeUSD
    - entryImpactUSD
    - exitImpactUSD
    - timingReserveUSD;

  const worstCaseExitUSD = roundTripFeeUSD + entryImpactUSD + exitImpactUSD + timingReserveUSD;
  const evRatio = worstCaseExitUSD > 0 ? expectedNetUSD / worstCaseExitUSD : 0;

  return {
    expectedFundingUSD,
    roundTripFeeUSD,
    entryImpactUSD,
    exitImpactUSD,
    timingReserveUSD,
    expectedNetUSD,
    passesMinProfit: expectedNetUSD >= MIN_PROFIT_USD,
    passesEVRatio: evRatio >= MIN_EV_RATIO,
    evRatio,
  };
}

// ── v2.1: Time-Normalized Scoring ──

/**
 * Time-normalized opportunity score per v2.1 strategy.
 * score = expectedNetUSD * fillProb * fundingCaptureProb / capitalLockSec
 *
 * @param expectedNetUSD - Expected net profit from conservative EV
 * @param capitalLockSec - How long capital is locked (entry to exit)
 * @param fillProb - Probability of full fill (default 1.0, refine with data)
 * @param fundingCaptureProb - Probability of capturing funding (default 1.0)
 */
export function calcTimeNormalizedScore(
  expectedNetUSD: number,
  capitalLockSec: number,
  fillProb = 1.0,
  fundingCaptureProb = 1.0,
): number {
  if (capitalLockSec <= 0) return 0;
  return (expectedNetUSD * fillProb * fundingCaptureProb) / capitalLockSec;
}

export function getOpportunityIntervalHours(
  opportunity: Pick<ArbitrageOpportunity, 'fundingIntervalMs'>,
): number {
  return Math.max(1, (opportunity.fundingIntervalMs ?? 8 * 3600000) / 3600000);
}

export function makeOpportunityId(
  baseAsset: string,
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
  fundingIntervalMs: number,
): string {
  const intervalHours = Math.max(1, Math.round(fundingIntervalMs / 3600000));
  return `${baseAsset}:${shortExchange}:${longExchange}:${intervalHours}h`;
}

export function getOpportunityId(opportunity: ArbitrageOpportunity): string {
  return opportunity.id || makeOpportunityId(
    opportunity.baseAsset,
    opportunity.shortExchange,
    opportunity.longExchange,
    opportunity.fundingIntervalMs ?? 8 * 3600000,
  );
}

export function getOpportunityLegKeys(opportunity: ArbitrageOpportunity): string[] {
  return [
    `${opportunity.shortExchange}:${opportunity.shortSymbol}:short`,
    `${opportunity.longExchange}:${opportunity.longSymbol}:long`,
    // 방향 무관 키 — 같은 거래소+심볼이 중복 진입하는 것을 방지
    `${opportunity.shortExchange}:${opportunity.shortSymbol}`,
    `${opportunity.longExchange}:${opportunity.longSymbol}`,
  ];
}

export function getOpportunityHourlyNetProfit(opportunity: ArbitrageOpportunity): number {
  return opportunity.netProfit / getOpportunityIntervalHours(opportunity);
}

export function getOpportunityTimeGroupKey(
  nextFundingTime: number,
  toleranceMs = FUNDING_ALIGNMENT_TOLERANCE_MS,
): number {
  return Math.round(nextFundingTime / toleranceMs) * toleranceMs;
}

/**
 * From all collected funding rates, find delta-neutral arbitrage opportunities.
 * Keep every profitable route instead of collapsing to one opportunity per asset.
 */
export const DEFAULT_MIN_VOLUME_24H_USD = 7_500_000; // ≈100억원

export function findOpportunities(
  rates: FundingRate[],
  topN = 20,
  investmentUSDT = 1000,
  leverage = 5,
  feeOverrides?: FeeOverrides,
  paybackOverrides?: PaybackOverrides,
  minVolume24hUSD?: number,
): ArbitrageOpportunity[] {
  // 볼륨 필터는 비동기 fetchTickers 타이밍 이슈로 여기서 적용하지 않음
  // → 스케줄링 단계(fundingStore)에서 realSpread/볼륨 데이터 확인 후 필터링
  void minVolume24hUSD; // kept in signature for scheduling callers
  const byAsset = new Map<string, FundingRate[]>();
  for (const rate of rates) {
    const list = byAsset.get(rate.baseAsset) ?? [];
    list.push(rate);
    byAsset.set(rate.baseAsset, list);
  }

  const opportunities = new Map<string, ArbitrageOpportunity>();

  for (const [baseAsset, assetRates] of byAsset) {
    if (assetRates.length < 2) continue;

    for (let shortIndex = 0; shortIndex < assetRates.length; shortIndex++) {
      for (let longIndex = 0; longIndex < assetRates.length; longIndex++) {
        if (shortIndex === longIndex) continue;

        const shortCandidate = assetRates[shortIndex];
        const longCandidate = assetRates[longIndex];

        if (shortCandidate.exchange === longCandidate.exchange) continue;

        const spread = shortCandidate.rate - longCandidate.rate;
        if (spread <= 0) continue;

        const shortFundingTime = shortCandidate.nextFundingTime || Date.now() + 480 * 60000;
        const longFundingTime = longCandidate.nextFundingTime || Date.now() + 480 * 60000;
        const fundingTimeDiffMs = Math.abs(shortFundingTime - longFundingTime);
        if (fundingTimeDiffMs > FUNDING_ALIGNMENT_TOLERANCE_MS) continue;

        const shortIntervalMs = (shortCandidate.intervalHours || 8) * 3600 * 1000;
        const longIntervalMs = (longCandidate.intervalHours || 8) * 3600 * 1000;
        const fundingIntervalMs = Math.max(shortIntervalMs, longIntervalMs);
        const nextFundingTime = Math.max(shortFundingTime, longFundingTime);

        const notional = investmentUSDT * leverage;
        const roundTripFeePct = getHedgeFeesWithOverrides(
          shortCandidate.exchange,
          longCandidate.exchange,
          'taker',
          feeOverrides,
          paybackOverrides,
        ) * 100;
        // ★ 통합 계산식: 수수료 + 안전마진(1.5bps) 반영 (entryGap은 탐색 단계에서 0)
        const netSpreadPct = calcNetSpreadPercent(spread * 100, 0, roundTripFeePct);
        const netProfit = notional * (netSpreadPct / 100);
        if (netProfit <= 0) continue;

        const candidate: ArbitrageOpportunity = {
          id: makeOpportunityId(
            baseAsset,
            shortCandidate.exchange,
            longCandidate.exchange,
            fundingIntervalMs,
          ),
          baseAsset,
          shortExchange: shortCandidate.exchange,
          shortSymbol: shortCandidate.symbol,
          shortRate: shortCandidate.rate,
          shortRatePercent: shortCandidate.ratePercent,
          shortMarkPrice: shortCandidate.markPrice,
          longExchange: longCandidate.exchange,
          longSymbol: longCandidate.symbol,
          longRate: longCandidate.rate,
          longRatePercent: longCandidate.ratePercent,
          longMarkPrice: longCandidate.markPrice,
          spread,
          spreadPercent: spread * 100,
          annualReturnPercent: calcAnnualReturn(netSpreadPct, fundingIntervalMs),
          nextFundingTime,
          minutesToFunding: getMinutesToFunding(nextFundingTime),
          fundingIntervalMs,
          netProfit,
        };

        const existing = opportunities.get(candidate.id);
        if (
          !existing
          || getOpportunityHourlyNetProfit(candidate) > getOpportunityHourlyNetProfit(existing)
          || (
            getOpportunityHourlyNetProfit(candidate) === getOpportunityHourlyNetProfit(existing)
            && candidate.nextFundingTime < existing.nextFundingTime
          )
        ) {
          opportunities.set(candidate.id, candidate);
        }
      }
    }
  }

  return Array.from(opportunities.values())
    .sort((a, b) => {
      const hourlyDiff = getOpportunityHourlyNetProfit(b) - getOpportunityHourlyNetProfit(a);
      if (hourlyDiff !== 0) return hourlyDiff;
      if (b.netProfit !== a.netProfit) return b.netProfit - a.netProfit;
      return a.nextFundingTime - b.nextFundingTime;
    })
    .slice(0, topN);
}

export interface ProfitEstimate {
  perFunding: number;
  netPerFunding: number;
  rawTotalFees: number;
  traderFeePayback: number;
  referralFeePayback: number;
  totalFeePayback: number;
  totalFees: number;
  totalCapital: number;
  actualPortfolio: number;
  per1h: number;
  per4h: number;
  perDay: number;
  per2Day: number;
  per3Day: number;
  per4Day: number;
  per5Day: number;
  per6Day: number;
  perWeek: number;
  per2Week: number;
  per3Week: number;
  perMonth: number;
  per3Month: number;
  per6Month: number;
  perYear: number;
  roiPerFunding: number;
  roiPer1h: number;
  roiPer4h: number;
  roiPerDay: number;
  roiPerWeek: number;
  roiPerMonth: number;
  roiPerYear: number;
  compound: {
    per1h: number;
    per4h: number;
    perDay: number;
    per2Day: number;
    per3Day: number;
    per4Day: number;
    per5Day: number;
    per6Day: number;
    perWeek: number;
    per2Week: number;
    per3Week: number;
    perMonth: number;
    per3Month: number;
    per6Month: number;
    perYear: number;
    roiPer1h: number;
    roiPer4h: number;
    roiPerDay: number;
    roiPerWeek: number;
    roiPerMonth: number;
    roiPerYear: number;
  };
  /** Conservative EV matching actual execution guard formula */
  conservativeEV: ConservativeEVResult;
}

export interface EstimateProfitOptions {
  skipFees?: boolean;
  feeOverrides?: FeeOverrides;
  paybackOverrides?: PaybackOverrides;
  /** When true, apply funding drift buffer in conservative EV (matches execution guard useDriftBuffer) */
  useDriftBuffer?: boolean;
  /** Entry impact percent (e.g. 0.12 for 0.12%) applied to conservative EV */
  entryImpactPercent?: number;
  /** Exit impact percent (defaults to entryImpactPercent when omitted) */
  exitImpactPercent?: number;
}

/**
 * Estimate hedge profits for a funding arbitrage cycle.
 */
export function estimateProfit(
  opportunity: ArbitrageOpportunity,
  investmentUSDT: number,
  leverage: number,
  options: boolean | EstimateProfitOptions = false,
): ProfitEstimate {
  const {
    skipFees,
    feeOverrides,
    paybackOverrides,
    useDriftBuffer,
    entryImpactPercent,
    exitImpactPercent,
  } = typeof options === 'boolean'
    ? {
      skipFees: options,
      feeOverrides: undefined,
      paybackOverrides: undefined,
      useDriftBuffer: false,
      entryImpactPercent: 0,
      exitImpactPercent: 0,
    }
    : {
      skipFees: options.skipFees ?? false,
      feeOverrides: options.feeOverrides,
      paybackOverrides: options.paybackOverrides,
      useDriftBuffer: options.useDriftBuffer ?? false,
      entryImpactPercent: Math.max(0, options.entryImpactPercent ?? 0),
      exitImpactPercent: Math.max(0, options.exitImpactPercent ?? options.entryImpactPercent ?? 0),
    };
  const totalCapital = investmentUSDT * 2;
  const notional = investmentUSDT * leverage;
  const intervalH = getOpportunityIntervalHours(opportunity);
  const fundingsPerDay = 24 / intervalH;

  const grossPerFunding = notional * opportunity.spread;
  const hedgeFeeBreakdown = skipFees
    ? null
    : getHedgeFeeBreakdown(
      opportunity.shortExchange,
      opportunity.longExchange,
      'taker',
      feeOverrides,
      paybackOverrides,
    );
  const rawRoundTripFeePct = (hedgeFeeBreakdown?.rawRoundTripRate ?? 0) * 100;
  const traderPaybackPct = (hedgeFeeBreakdown?.traderPaybackRoundTripRate ?? 0) * 100;
  const referralPaybackPct = (hedgeFeeBreakdown?.referralPaybackRoundTripRate ?? 0) * 100;
  const rawFeesPerCycle = notional * (rawRoundTripFeePct / 100);
  const traderPaybackPerCycle = notional * (traderPaybackPct / 100);
  const referralPaybackPerCycle = notional * (referralPaybackPct / 100);
  const totalPaybackPerCycle = traderPaybackPerCycle + referralPaybackPerCycle;
  const feesPerCycle = rawFeesPerCycle - totalPaybackPerCycle;

  // Conservative EV — same formula used by actual execution guard
  const usesInstantRate = pairUsesInstantaneousRate(
    opportunity.shortExchange, opportunity.longExchange,
  );
  const shortDrift = useDriftBuffer
    ? calcDriftBuffer(opportunity.shortRate, undefined, usesInstantRate)
    : 0;
  const longDrift = useDriftBuffer
    ? calcDriftBuffer(opportunity.longRate, undefined, usesInstantRate)
    : 0;
  const roundTripFeeDec = hedgeFeeBreakdown?.effectiveRoundTripRate ?? 0;
  const entryImpactDec = entryImpactPercent / 100;
  const exitImpactDec = exitImpactPercent / 100;
  const conservativeEV = calcConservativeEV(
    notional, opportunity.shortRate, opportunity.longRate,
    shortDrift, longDrift, roundTripFeeDec, entryImpactDec, exitImpactDec,
  );

  // Use conservative EV as the base for all profit projections
  const netPerFunding = skipFees
    ? grossPerFunding
    : conservativeEV.expectedNetUSD;
  const netPer1h = netPerFunding / intervalH;
  const netPer4h = netPer1h * 4;
  const netPerDay = netPerFunding * fundingsPerDay;
  const netPer2Day = netPerDay * 2;
  const netPer3Day = netPerDay * 3;
  const netPer4Day = netPerDay * 4;
  const netPer5Day = netPerDay * 5;
  const netPer6Day = netPerDay * 6;
  const netPerWeek = netPerDay * 7;
  const netPer2Week = netPerDay * 14;
  const netPer3Week = netPerDay * 21;
  const netPerMonth = netPerDay * 30;
  const netPer3Month = netPerDay * 90;
  const netPer6Month = netPerDay * 180;
  const netPerYear = netPerDay * 365;

  const roiPerFunding = (netPerFunding / totalCapital) * 100;
  const roiPer1h = (netPer1h / totalCapital) * 100;
  const roiPer4h = (netPer4h / totalCapital) * 100;
  const roiPerDay = (netPerDay / totalCapital) * 100;
  const roiPerWeek = (netPerWeek / totalCapital) * 100;
  const roiPerMonth = (netPerMonth / totalCapital) * 100;
  const roiPerYear = (netPerYear / totalCapital) * 100;

  const netRatePerFunding = netPerFunding / totalCapital;
  const safeCompound = (periods: number) => {
    if (netRatePerFunding <= -1) return -totalCapital;
    const raw = totalCapital * (Math.pow(1 + netRatePerFunding, periods) - 1);
    if (!isFinite(raw)) return totalCapital * 1e6;
    return Math.max(-totalCapital, raw);
  };

  const compound1h = netPer1h;
  const compound4h = intervalH <= 4 ? safeCompound(4 / intervalH) : netPer4h;
  const compoundDay = safeCompound(fundingsPerDay);
  const compound2Day = safeCompound(fundingsPerDay * 2);
  const compound3Day = safeCompound(fundingsPerDay * 3);
  const compound4Day = safeCompound(fundingsPerDay * 4);
  const compound5Day = safeCompound(fundingsPerDay * 5);
  const compound6Day = safeCompound(fundingsPerDay * 6);
  const compoundWeek = safeCompound(fundingsPerDay * 7);
  const compound2Week = safeCompound(fundingsPerDay * 14);
  const compound3Week = safeCompound(fundingsPerDay * 21);
  const compoundMonth = safeCompound(fundingsPerDay * 30);
  const compound3Month = safeCompound(fundingsPerDay * 90);
  const compound6Month = safeCompound(fundingsPerDay * 180);
  const compoundYear = safeCompound(fundingsPerDay * 365);

  return {
    perFunding: grossPerFunding,
    netPerFunding,
    rawTotalFees: rawFeesPerCycle,
    traderFeePayback: traderPaybackPerCycle,
    referralFeePayback: referralPaybackPerCycle,
    totalFeePayback: totalPaybackPerCycle,
    totalFees: feesPerCycle,
    totalCapital,
    actualPortfolio: totalCapital,
    per1h: netPer1h,
    per4h: netPer4h,
    perDay: netPerDay,
    per2Day: netPer2Day,
    per3Day: netPer3Day,
    per4Day: netPer4Day,
    per5Day: netPer5Day,
    per6Day: netPer6Day,
    perWeek: netPerWeek,
    per2Week: netPer2Week,
    per3Week: netPer3Week,
    perMonth: netPerMonth,
    per3Month: netPer3Month,
    per6Month: netPer6Month,
    perYear: netPerYear,
    roiPerFunding,
    roiPer1h,
    roiPer4h,
    roiPerDay,
    roiPerWeek,
    roiPerMonth,
    roiPerYear,
    compound: {
      per1h: compound1h,
      per4h: compound4h,
      perDay: compoundDay,
      per2Day: compound2Day,
      per3Day: compound3Day,
      per4Day: compound4Day,
      per5Day: compound5Day,
      per6Day: compound6Day,
      perWeek: compoundWeek,
      per2Week: compound2Week,
      per3Week: compound3Week,
      perMonth: compoundMonth,
      per3Month: compound3Month,
      per6Month: compound6Month,
      perYear: compoundYear,
      roiPer1h: (compound1h / totalCapital) * 100,
      roiPer4h: (compound4h / totalCapital) * 100,
      roiPerDay: (compoundDay / totalCapital) * 100,
      roiPerWeek: (compoundWeek / totalCapital) * 100,
      roiPerMonth: (compoundMonth / totalCapital) * 100,
      roiPerYear: (compoundYear / totalCapital) * 100,
    },
    conservativeEV,
  };
}
