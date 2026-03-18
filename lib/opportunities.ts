import type { FundingRate, ArbitrageOpportunity } from './types';
import { calcAnnualReturn, getMinutesToFunding } from './exchanges/utils';

/**
 * From all collected funding rates, find the best delta-neutral
 * arbitrage opportunities (same base asset, different exchanges).
 */
export function findOpportunities(
  rates: FundingRate[],
  topN = 20,
): ArbitrageOpportunity[] {
  // Group by base asset
  const byAsset = new Map<string, FundingRate[]>();
  for (const r of rates) {
    const list = byAsset.get(r.baseAsset) ?? [];
    list.push(r);
    byAsset.set(r.baseAsset, list);
  }

  const opportunities: ArbitrageOpportunity[] = [];

  for (const [baseAsset, assetRates] of byAsset) {
    if (assetRates.length < 2) continue;

    // Sort descending by rate
    const sorted = [...assetRates].sort((a, b) => b.rate - a.rate);
    const high = sorted[0]; // highest rate → go SHORT
    const low = high
      ? [...sorted].reverse().find((r) => r.exchange !== high.exchange)
      : undefined; // lowest rate on a different exchange → go LONG

    if (!high || !low) continue;

    const spread = high.rate - low.rate;
    if (spread <= 0) continue;

    const nearestFunding = Math.min(
      high.nextFundingTime || Date.now() + 480 * 60000,
      low.nextFundingTime || Date.now() + 480 * 60000,
    );

    // 펀딩 주기: 양쪽 중 더 짧은 간격 사용 (안전)
    const DEFAULT_INTERVAL_MS = 8 * 3600 * 1000;
    const shortIntervalMs = (high.intervalHours || 8) * 3600 * 1000;
    const longIntervalMs = (low.intervalHours || 8) * 3600 * 1000;
    const fundingIntervalMs = Math.min(shortIntervalMs, longIntervalMs) || DEFAULT_INTERVAL_MS;

    opportunities.push({
      id: `${baseAsset}-${high.exchange}-${low.exchange}`,
      baseAsset,
      shortExchange: high.exchange,
      shortSymbol: high.symbol,
      shortRate: high.rate,
      shortRatePercent: high.ratePercent,
      shortMarkPrice: high.markPrice,
      longExchange: low.exchange,
      longSymbol: low.symbol,
      longRate: low.rate,
      longRatePercent: low.ratePercent,
      longMarkPrice: low.markPrice,
      spread,
      spreadPercent: spread * 100,
      annualReturnPercent: calcAnnualReturn(spread),
      nextFundingTime: nearestFunding,
      minutesToFunding: getMinutesToFunding(nearestFunding),
      fundingIntervalMs,
    });
  }

  // Sort by spread descending
  return opportunities.sort((a, b) => b.spread - a.spread).slice(0, topN);
}

export interface ProfitEstimate {
  perFunding: number;       // 펀딩 수익 (수수료 전)
  netPerFunding: number;    // 순수익 (1회 펀딩 기준, 수수료 후)
  totalFees: number;        // 왕복 수수료 합계
  totalCapital: number;
  actualPortfolio: number;  // 실제/시뮬 총 자산
  per1h: number;
  per4h: number;
  perDay: number;
  perMonth: number;
  perWeek: number;
  perYear: number;
  roiPerFunding: number;    // 총 자산 대비 8h 수익률 (%)
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
    perWeek: number;
    perMonth: number;
    perYear: number;
    roiPer1h: number;
    roiPer4h: number;
    roiPerDay: number;
    roiPerWeek: number;
    roiPerMonth: number;
    roiPerYear: number;
  };
}

/**
 * 헷징용 수익 예측 — 펀딩 주기(1h/4h/8h) 실제 반영
 * ROI 기준: 해당 쌍에 투입된 자본 = investmentUSDT × 2 (숏+롱)
 */
export function estimateProfit(
  opportunity: ArbitrageOpportunity,
  investmentUSDT: number,
  leverage: number,
): ProfitEstimate {
  // 헷징: 숏 $700 + 롱 $700 = $1,400 / 쌍
  const totalCapital = investmentUSDT * 2;
  const notional = investmentUSDT * leverage;
  const intervalH = (opportunity.fundingIntervalMs ?? 8 * 3600000) / 3600000;
  const fundingsPerDay = 24 / intervalH;

  const perFunding = notional * opportunity.spread;

  // 왕복 수수료: 진입(숏+롱) + 청산(숏+롱) = 4 × 0.05%
  const TAKER_FEE = 0.0005;
  const totalFees = notional * TAKER_FEE * 4;

  const netPerFunding = perFunding;
  const per1h = perFunding / intervalH;
  const per4h = per1h * 4;
  const perDay = perFunding * fundingsPerDay;
  const perWeek = perDay * 7;
  const perMonth = perDay * 30;
  const perYear = perDay * 365;

  const netPerDay = perDay - totalFees;
  const netPerWeek = perWeek - totalFees;
  const netPerMonth = perMonth - totalFees;
  const netPerYear = perYear - totalFees;

  // ROI: 해당 쌍 투입 자본 대비
  const roiPerFunding = (netPerFunding / totalCapital) * 100;
  const roiPer1h = (per1h / totalCapital) * 100;
  const roiPer4h = (per4h / totalCapital) * 100;
  const roiPerDay = (netPerDay / totalCapital) * 100;
  const roiPerWeek = (netPerWeek / totalCapital) * 100;
  const roiPerMonth = (netPerMonth / totalCapital) * 100;
  const roiPerYear = (netPerYear / totalCapital) * 100;

  // 복리: 투입자본 기준 매 펀딩 수익률
  const ratePerFunding = perFunding / totalCapital;
  const compound1h = totalCapital * (Math.pow(1 + ratePerFunding / intervalH, 1) - 1);
  const compound4h = totalCapital * (Math.pow(1 + ratePerFunding / intervalH, 4) - 1);
  const compoundDay = totalCapital * (Math.pow(1 + ratePerFunding, fundingsPerDay) - 1) - totalFees;
  const compoundWeek = totalCapital * (Math.pow(1 + ratePerFunding, fundingsPerDay * 7) - 1) - totalFees;
  const compoundMonth = totalCapital * (Math.pow(1 + ratePerFunding, fundingsPerDay * 30) - 1) - totalFees;
  const compoundYear = totalCapital * (Math.pow(1 + ratePerFunding, fundingsPerDay * 365) - 1) - totalFees;

  return {
    perFunding: netPerFunding, netPerFunding, totalFees, totalCapital, actualPortfolio: totalCapital,
    per1h, per4h, perDay: netPerDay, perMonth: netPerMonth, perWeek: netPerWeek, perYear: netPerYear,
    roiPerFunding, roiPer1h, roiPer4h, roiPerDay, roiPerWeek, roiPerMonth, roiPerYear,
    compound: {
      per1h: compound1h, per4h: compound4h, perDay: compoundDay, perWeek: compoundWeek, perMonth: compoundMonth, perYear: compoundYear,
      roiPer1h: (compound1h / totalCapital) * 100, roiPer4h: (compound4h / totalCapital) * 100,
      roiPerDay: (compoundDay / totalCapital) * 100, roiPerWeek: (compoundWeek / totalCapital) * 100,
      roiPerMonth: (compoundMonth / totalCapital) * 100, roiPerYear: (compoundYear / totalCapital) * 100,
    },
  };
}

/**
 * 숏온리용 수익 예측 — shortRate 기반, 단일 포지션
 * ROI 기준: investmentUSDT (숏 마진만)
 */
export function estimateProfitShortOnly(
  opportunity: ArbitrageOpportunity,
  investmentUSDT: number,
  leverage: number,
): ProfitEstimate {
  // 숏온리: $700 마진 1개
  const totalCapital = investmentUSDT;
  const notional = investmentUSDT * leverage;
  const intervalH = (opportunity.fundingIntervalMs ?? 8 * 3600000) / 3600000;
  const fundingsPerDay = 24 / intervalH;

  // 숏 포지션: 양의 펀딩레이트 → 수령
  const perFunding = notional * opportunity.shortRate;

  // 수수료: 숏 1개만 (진입+청산 = 2 × 0.05%)
  const TAKER_FEE = 0.0005;
  const totalFees = notional * TAKER_FEE * 2;

  const netPerFunding = perFunding;
  const per1h = perFunding / intervalH;
  const per4h = per1h * 4;
  const perDay = perFunding * fundingsPerDay;
  const perWeek = perDay * 7;
  const perMonth = perDay * 30;
  const perYear = perDay * 365;

  const netPerDay = perDay - totalFees;
  const netPerWeek = perWeek - totalFees;
  const netPerMonth = perMonth - totalFees;
  const netPerYear = perYear - totalFees;

  // ROI: 숏 마진 기준
  const roiPerFunding = (netPerFunding / totalCapital) * 100;
  const roiPer1h = (per1h / totalCapital) * 100;
  const roiPer4h = (per4h / totalCapital) * 100;
  const roiPerDay = (netPerDay / totalCapital) * 100;
  const roiPerWeek = (netPerWeek / totalCapital) * 100;
  const roiPerMonth = (netPerMonth / totalCapital) * 100;
  const roiPerYear = (netPerYear / totalCapital) * 100;

  const ratePerFunding = perFunding / totalCapital;
  const compound1h = totalCapital * (Math.pow(1 + ratePerFunding / intervalH, 1) - 1);
  const compound4h = totalCapital * (Math.pow(1 + ratePerFunding / intervalH, 4) - 1);
  const compoundDay = totalCapital * (Math.pow(1 + ratePerFunding, fundingsPerDay) - 1) - totalFees;
  const compoundWeek = totalCapital * (Math.pow(1 + ratePerFunding, fundingsPerDay * 7) - 1) - totalFees;
  const compoundMonth = totalCapital * (Math.pow(1 + ratePerFunding, fundingsPerDay * 30) - 1) - totalFees;
  const compoundYear = totalCapital * (Math.pow(1 + ratePerFunding, fundingsPerDay * 365) - 1) - totalFees;

  return {
    perFunding: netPerFunding, netPerFunding, totalFees, totalCapital, actualPortfolio: totalCapital,
    per1h, per4h, perDay: netPerDay, perMonth: netPerMonth, perWeek: netPerWeek, perYear: netPerYear,
    roiPerFunding, roiPer1h, roiPer4h, roiPerDay, roiPerWeek, roiPerMonth, roiPerYear,
    compound: {
      per1h: compound1h, per4h: compound4h, perDay: compoundDay, perWeek: compoundWeek, perMonth: compoundMonth, perYear: compoundYear,
      roiPer1h: (compound1h / totalCapital) * 100, roiPer4h: (compound4h / totalCapital) * 100,
      roiPerDay: (compoundDay / totalCapital) * 100, roiPerWeek: (compoundWeek / totalCapital) * 100,
      roiPerMonth: (compoundMonth / totalCapital) * 100, roiPerYear: (compoundYear / totalCapital) * 100,
    },
  };
}
