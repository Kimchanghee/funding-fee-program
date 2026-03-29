import type { FundingRate, ExchangeId } from '../types';

export function normalizeFundingRate(
  exchange: ExchangeId,
  rawRate: number,
  symbol: string,
  markPrice: number,
  nextFundingTime: number,
  intervalHours = 8,
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
    intervalHours,
    updatedAt: Date.now(),
  };
}

export function getMinutesToFunding(nextFundingTime: number): number {
  if (!nextFundingTime) return 480;
  return Math.max(0, Math.round((nextFundingTime - Date.now()) / 60000));
}

/**
 * Annualized return from net spread percent per funding cycle.
 * Example: `netSpreadPctPerFunding=0.05` means +0.05% per funding.
 */
export function calcAnnualReturn(netSpreadPctPerFunding: number, fundingIntervalMs?: number): number {
  const intervalH = (fundingIntervalMs ?? 8 * 3600000) / 3600000;
  const fundingsPerDay = 24 / intervalH;
  return netSpreadPctPerFunding * fundingsPerDay * 365;
}
