import type { FundingRate, ExchangeId } from '../types';

export function normalizeFundingRate(
  exchange: ExchangeId,
  rawRate: number,
  symbol: string,
  markPrice: number,
  nextFundingTime: number,
): FundingRate {
  const parts = symbol.replace(':USDT', '').replace(':USD', '').split('/');
  const baseAsset = parts[0] ?? symbol.split('/')[0] ?? 'UNKNOWN';
  const displaySymbol = `${baseAsset}/USDT`;
  return {
    exchange,
    symbol,
    displaySymbol,
    baseAsset,
    rate: rawRate,
    ratePercent: rawRate * 100,
    nextFundingTime,
    markPrice,
    intervalHours: 8,
    updatedAt: Date.now(),
  };
}

export function getMinutesToFunding(nextFundingTime: number): number {
  if (!nextFundingTime) return 480;
  return Math.max(0, Math.round((nextFundingTime - Date.now()) / 60000));
}

export function calcAnnualReturn(spreadDecimal: number): number {
  // 3 fundings per day × 365 days × spread
  return spreadDecimal * 3 * 365 * 100;
}
