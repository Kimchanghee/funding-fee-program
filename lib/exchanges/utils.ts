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

export function calcAnnualReturn(spreadDecimal: number): number {
  // 순수익 기준: 스프레드 - 왕복수수료(0.2%) 후 연환산
  const ROUND_TRIP_FEE = 0.0005 * 4; // 0.002
  const netSpread = spreadDecimal - ROUND_TRIP_FEE;
  // 3 fundings per day × 365 days × net spread
  return netSpread * 3 * 365 * 100;
}
