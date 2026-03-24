import type { FundingRate, ArbitrageOpportunity, ExchangeId } from './types';
import { getHedgeFees } from './types';
import { calcAnnualReturn, getMinutesToFunding } from './exchanges/utils';

/**
 * From all collected funding rates, find the best delta-neutral
 * arbitrage opportunities (same base asset, different exchanges).
 */
export function findOpportunities(
  rates: FundingRate[],
  topN = 20,
  investmentUSDT = 1000,
  leverage = 5,
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

    // Both sides must have funded before we collect — use the later time (conservative)
    const highFundingTime = high.nextFundingTime || Date.now() + 480 * 60000;
    const lowFundingTime = low.nextFundingTime || Date.now() + 480 * 60000;
    const nearestFunding = Math.max(highFundingTime, lowFundingTime);

    // 펀딩 시각 정렬 검증: 양쪽 펀딩 시각이 2분 이상 어긋나면 스나이프 불가
    // (한쪽은 펀딩을 받고, 다른 쪽은 아직 → 가격 리스크 노출)
    const fundingTimeDiffMs = Math.abs(highFundingTime - lowFundingTime);
    if (fundingTimeDiffMs > 120_000) continue; // 2분 초과 차이 → 스킵

    // 펀딩 주기: 양쪽 중 더 긴 간격 사용 (보수적 ROI 계산)
    const DEFAULT_INTERVAL_MS = 8 * 3600 * 1000;
    const shortIntervalMs = (high.intervalHours || 8) * 3600 * 1000;
    const longIntervalMs = (low.intervalHours || 8) * 3600 * 1000;
    const fundingIntervalMs = Math.max(shortIntervalMs, longIntervalMs) || DEFAULT_INTERVAL_MS;

    const notional = investmentUSDT * leverage;
    // 거래소별 실제 수수료 적용 (taker 기준 — 보수적 추정, maker 성공 시 실제 비용은 더 낮음)
    const roundTripFee = getHedgeFees(high.exchange as ExchangeId, low.exchange as ExchangeId, 'taker');
    const netProfit = notional * spread - notional * roundTripFee;

    // 수수료 차감 후 순수익이 0 이하면 리스팅에서 제거
    if (netProfit <= 0) continue;

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
      annualReturnPercent: calcAnnualReturn(spread, fundingIntervalMs),
      nextFundingTime: nearestFunding,
      minutesToFunding: getMinutesToFunding(nearestFunding),
      fundingIntervalMs,
      netProfit,
    });
  }

  // Sort by ROI per hour descending (accounts for funding interval: 1h > 8h)
  return opportunities.sort((a, b) => {
    const aIntervalH = (a.fundingIntervalMs ?? 8 * 3600000) / 3600000;
    const bIntervalH = (b.fundingIntervalMs ?? 8 * 3600000) / 3600000;
    const aRoiPerH = a.netProfit / aIntervalH;
    const bRoiPerH = b.netProfit / bIntervalH;
    return bRoiPerH - aRoiPerH;
  }).slice(0, topN);
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

/**
 * 헷징용 수익 예측 — 스나이프 전략 (매 펀딩마다 진입/청산)
 * 수수료: 매 사이클 발생 (진입+청산 = 4 × 0.05% per cycle)
 * ROI 기준: 해당 쌍에 투입된 자본 = investmentUSDT × 2 (숏+롱)
 */
export function estimateProfit(
  opportunity: ArbitrageOpportunity,
  investmentUSDT: number,
  leverage: number,
  skipFees = false, // true면 spread에 이미 수수료 포함 (realSpread 사용 시)
): ProfitEstimate {
  const totalCapital = investmentUSDT * 2;
  const notional = investmentUSDT * leverage;
  const intervalH = (opportunity.fundingIntervalMs ?? 8 * 3600000) / 3600000;
  const fundingsPerDay = 24 / intervalH;

  const grossPerFunding = notional * opportunity.spread;

  // skipFees=true면 spread에 이미 수수료+슬리피지 반영됨 → 이중 차감 방지
  const roundTripFee = skipFees ? 0 : getHedgeFees(opportunity.shortExchange, opportunity.longExchange, 'taker');
  const feesPerCycle = notional * roundTripFee;

  // 순수익 = 펀딩 수익 - 해당 사이클 수수료
  const netPerFunding = grossPerFunding - feesPerCycle;
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

  // ROI: 해당 쌍 투입 자본 대비
  const roiPerFunding = (netPerFunding / totalCapital) * 100;
  const roiPer1h = (netPer1h / totalCapital) * 100;
  const roiPer4h = (netPer4h / totalCapital) * 100;
  const roiPerDay = (netPerDay / totalCapital) * 100;
  const roiPerWeek = (netPerWeek / totalCapital) * 100;
  const roiPerMonth = (netPerMonth / totalCapital) * 100;
  const roiPerYear = (netPerYear / totalCapital) * 100;

  // 복리: 수수료 차감 후 순수익률 기준 (펀딩 간격 미만은 선형)
  const netRatePerFunding = netPerFunding / totalCapital;
  const MAX_COMPOUND = 10; // 최대 10배 (1000%) 캡 — 오버플로우 방지
  const safeCompound = (periods: number) => {
    if (netRatePerFunding <= -1) return -totalCapital;
    const raw = totalCapital * (Math.pow(1 + netRatePerFunding, periods) - 1);
    return Math.max(-totalCapital, Math.min(raw, totalCapital * MAX_COMPOUND));
  };
  const compound1h = netPer1h; // 1h 내 복리 불가 — 선형
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
    perFunding: grossPerFunding, netPerFunding, totalFees: feesPerCycle, totalCapital, actualPortfolio: totalCapital,
    per1h: netPer1h, per4h: netPer4h,
    perDay: netPerDay, per2Day: netPer2Day, per3Day: netPer3Day, per4Day: netPer4Day, per5Day: netPer5Day, per6Day: netPer6Day,
    perWeek: netPerWeek, per2Week: netPer2Week, per3Week: netPer3Week, perMonth: netPerMonth, per3Month: netPer3Month, per6Month: netPer6Month, perYear: netPerYear,
    roiPerFunding, roiPer1h, roiPer4h, roiPerDay, roiPerWeek, roiPerMonth, roiPerYear,
    compound: {
      per1h: compound1h, per4h: compound4h,
      perDay: compoundDay, per2Day: compound2Day, per3Day: compound3Day, per4Day: compound4Day, per5Day: compound5Day, per6Day: compound6Day,
      perWeek: compoundWeek, per2Week: compound2Week, per3Week: compound3Week, perMonth: compoundMonth, per3Month: compound3Month, per6Month: compound6Month, perYear: compoundYear,
      roiPer1h: (compound1h / totalCapital) * 100, roiPer4h: (compound4h / totalCapital) * 100,
      roiPerDay: (compoundDay / totalCapital) * 100, roiPerWeek: (compoundWeek / totalCapital) * 100,
      roiPerMonth: (compoundMonth / totalCapital) * 100, roiPerYear: (compoundYear / totalCapital) * 100,
    },
  };
}
