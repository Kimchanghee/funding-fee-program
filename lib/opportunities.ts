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
    const low = sorted[sorted.length - 1]; // lowest rate → go LONG

    if (!high || !low) continue;
    if (high.exchange === low.exchange) {
      // Use second lowest if same exchange
      if (sorted.length < 2) continue;
    }

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
  perFunding: number;
  totalCapital: number;
  perDay: number;
  perMonth: number;
  perYear: number;
  compound: {
    perDay: number;
    perMonth: number;
    perYear: number;
  };
}

export function estimateProfit(
  opportunity: ArbitrageOpportunity,
  investmentUSDT: number,
  leverage: number,
): ProfitEstimate {
  // investmentUSDT = 한쪽 거래소 마진
  // 총 투자금 = investmentUSDT × 2 (숏 거래소 + 롱 거래소)
  const totalCapital = investmentUSDT * 2;
  const notional = investmentUSDT * leverage; // 한쪽 포지션 명목가치
  const perFunding = notional * opportunity.spread; // 8h당 양쪽 합산 수익

  // Simple interest (단리: 수익률 고정, 재투자 없음)
  const perDay = perFunding * 3;
  const perMonth = perFunding * 3 * 30;
  const perYear = perFunding * 3 * 365;

  // Compound interest (복리: 수익 재투자)
  // 총 자본 대비 8h당 수익률 = perFunding / totalCapital
  const ratePerPeriod = perFunding / totalCapital;
  const compoundDay = totalCapital * (Math.pow(1 + ratePerPeriod, 3) - 1);
  const compoundMonth = totalCapital * (Math.pow(1 + ratePerPeriod, 90) - 1);
  const compoundYear = totalCapital * (Math.pow(1 + ratePerPeriod, 1095) - 1);

  return {
    perFunding,
    totalCapital,
    perDay,
    perMonth,
    perYear,
    compound: {
      perDay: compoundDay,
      perMonth: compoundMonth,
      perYear: compoundYear,
    },
  };
}
