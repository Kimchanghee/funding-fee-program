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
  perDay: number;
  perMonth: number;
  perYear: number;
  roiPerFunding: number;    // 총 자산 대비 8h 수익률 (%)
  roiPerDay: number;
  roiPerMonth: number;
  roiPerYear: number;
  compound: {
    perDay: number;
    perMonth: number;
    perYear: number;
    roiPerDay: number;
    roiPerMonth: number;
    roiPerYear: number;
  };
}

export function estimateProfit(
  opportunity: ArbitrageOpportunity,
  investmentUSDT: number,
  leverage: number,
  actualPortfolio?: number, // 시뮬 총 자산 또는 실제 총 자산
): ProfitEstimate {
  // investmentUSDT = 한쪽 거래소 마진
  // 총 투자금 = investmentUSDT × 2 (숏 거래소 + 롱 거래소)
  const totalCapital = investmentUSDT * 2;
  const portfolio = actualPortfolio ?? totalCapital;
  const notional = investmentUSDT * leverage; // 한쪽 포지션 명목가치
  const perFunding = notional * opportunity.spread; // 8h당 양쪽 합산 수익

  // 왕복 수수료: 진입(숏+롱) + 청산(숏+롱) = 4 × 0.05%
  const TAKER_FEE = 0.0005;
  const totalFees = notional * TAKER_FEE * 4; // 왕복 수수료 합계
  const netPerFunding = perFunding - totalFees; // 1회 펀딩 순수익

  // Simple interest (단리: 순수익 기준)
  // 수수료는 진입/청산 시 1회만 발생, 보유 중 펀딩은 매 8h 순수익
  // 스나이핑(1회): netPerFunding
  // 장기보유(N회): perFunding * N - totalFees (수수료는 1번만)
  const perDay = perFunding * 3 - totalFees; // 하루 보유: 3회 펀딩 - 1회 수수료
  const perMonth = perFunding * 3 * 30 - totalFees;
  const perYear = perFunding * 3 * 365 - totalFees;

  // ROI based on actual portfolio
  const roiPerFunding = (netPerFunding / portfolio) * 100;
  const roiPerDay = (perDay / portfolio) * 100;
  const roiPerMonth = (perMonth / portfolio) * 100;
  const roiPerYear = (perYear / portfolio) * 100;

  // Compound interest (복리: 펀딩 수익만 복리, 수수료는 1회만)
  // 수수료는 진입/청산 시 1회 발생 — 복리 기간마다 차감하면 안 됨
  const grossRatePerPeriod = perFunding / portfolio;
  const compoundDay = portfolio * (Math.pow(1 + grossRatePerPeriod, 3) - 1) - totalFees;
  const compoundMonth = portfolio * (Math.pow(1 + grossRatePerPeriod, 90) - 1) - totalFees;
  const compoundYear = portfolio * (Math.pow(1 + grossRatePerPeriod, 1095) - 1) - totalFees;

  return {
    perFunding,
    netPerFunding,
    totalFees,
    totalCapital,
    actualPortfolio: portfolio,
    perDay,
    perMonth,
    perYear,
    roiPerFunding,
    roiPerDay,
    roiPerMonth,
    roiPerYear,
    compound: {
      perDay: compoundDay,
      perMonth: compoundMonth,
      perYear: compoundYear,
      roiPerDay: (compoundDay / portfolio) * 100,
      roiPerMonth: (compoundMonth / portfolio) * 100,
      roiPerYear: (compoundYear / portfolio) * 100,
    },
  };
}
