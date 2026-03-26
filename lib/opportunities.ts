import type { FundingRate, ArbitrageOpportunity, ExchangeId, FeeOverrides } from './types';
import { getHedgeFeesWithOverrides, calcNetSpreadPercent } from './types';
import { calcAnnualReturn, getMinutesToFunding } from './exchanges/utils';

const FUNDING_ALIGNMENT_TOLERANCE_MS = 120_000;

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
export function findOpportunities(
  rates: FundingRate[],
  topN = 20,
  investmentUSDT = 1000,
  leverage = 5,
  feeOverrides?: FeeOverrides,
): ArbitrageOpportunity[] {
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
        ) * 100;
        // ★ 통합 계산식: 수수료 + 안전마진(3bps) 반영 (entryGap은 탐색 단계에서 0)
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
          annualReturnPercent: calcAnnualReturn(spread, fundingIntervalMs),
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
}

export interface EstimateProfitOptions {
  skipFees?: boolean;
  feeOverrides?: FeeOverrides;
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
  const { skipFees, feeOverrides } = typeof options === 'boolean'
    ? { skipFees: options, feeOverrides: undefined }
    : { skipFees: options.skipFees ?? false, feeOverrides: options.feeOverrides };
  const totalCapital = investmentUSDT * 2;
  const notional = investmentUSDT * leverage;
  const intervalH = getOpportunityIntervalHours(opportunity);
  const fundingsPerDay = 24 / intervalH;

  const grossPerFunding = notional * opportunity.spread;
  const roundTripFeePct = skipFees
    ? 0
    : getHedgeFeesWithOverrides(
      opportunity.shortExchange,
      opportunity.longExchange,
      'taker',
      feeOverrides,
    ) * 100;
  const feesPerCycle = notional * (roundTripFeePct / 100);
  const netPerFunding = skipFees
    ? grossPerFunding
    : notional * (calcNetSpreadPercent(opportunity.spreadPercent, 0, roundTripFeePct, 0) / 100);
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
  };
}
