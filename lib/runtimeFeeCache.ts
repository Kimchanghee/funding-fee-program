/**
 * Runtime fee resolver for simulation-only execution.
 * Account-level fee fetching has been removed with REAL trading.
 */
import {
  getExchangeFee,
  getRawExchangeFee,
  getTotalPaybackRate,
  type ApiConfig,
  type ExchangeId,
  type FeeOverrides,
  type PaybackOverrides,
} from './types';

interface CachedFee {
  maker: number;
  taker: number;
  fetchedAt: number;
}

const FEE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const runtimeFees = new Map<ExchangeId, CachedFee>();

/**
 * Refresh fee cache for a single exchange.
 * Returns true if the cache was updated, false if fetch failed or was skipped.
 */
export async function refreshFeeCache(
  exchange: ExchangeId,
  config: ApiConfig,
  symbol?: string,
  forceFresh = false,
): Promise<boolean> {
  void exchange;
  void config;
  void symbol;
  void forceFresh;
  return false;
}

/**
 * Refresh fee cache for multiple exchanges in parallel.
 */
export async function refreshAllFeeCaches(
  configs: Partial<Record<ExchangeId, ApiConfig>>,
): Promise<void> {
  void configs;
}

/**
 * Resolve fee for a given exchange, preferring runtime cache over overrides over preset.
 */
export function resolveRuntimeFee(
  exchange: ExchangeId,
  orderType: 'maker' | 'taker',
  feeOverrides?: FeeOverrides,
  paybackOverrides?: PaybackOverrides,
): number {
  const cached = runtimeFees.get(exchange);
  if (cached && Date.now() - cached.fetchedAt < FEE_CACHE_TTL_MS) {
    const paybackRate = getTotalPaybackRate(exchange, paybackOverrides);
    return cached[orderType] * (1 - paybackRate);
  }
  return getExchangeFee(exchange, orderType, feeOverrides, paybackOverrides);
}

export type FeeSource = 'runtime' | 'override' | 'preset';

/**
 * Resolve fee with source information.
 */
export function resolveRuntimeFeeDetailed(
  exchange: ExchangeId,
  orderType: 'maker' | 'taker',
  feeOverrides?: FeeOverrides,
  paybackOverrides?: PaybackOverrides,
): { fee: number; source: FeeSource; fresh: boolean } {
  const cached = runtimeFees.get(exchange);
  if (cached && Date.now() - cached.fetchedAt < FEE_CACHE_TTL_MS) {
    const paybackRate = getTotalPaybackRate(exchange, paybackOverrides);
    return { fee: cached[orderType] * (1 - paybackRate), source: 'runtime', fresh: true };
  }
  const overrideFees = feeOverrides?.[exchange];
  if (overrideFees && typeof overrideFees[orderType] === 'number') {
    return {
      fee: getExchangeFee(exchange, orderType, feeOverrides, paybackOverrides),
      source: 'override',
      fresh: false,
    };
  }
  return {
    fee: getRawExchangeFee(exchange, orderType, feeOverrides) * (1 - getTotalPaybackRate(exchange, paybackOverrides)),
    source: 'preset',
    fresh: false,
  };
}

/**
 * Get the current runtime fee cache state (for diagnostics).
 */
export function getRuntimeFeeStatus(): Record<string, { maker: number; taker: number; ageMs: number } | null> {
  const result: Record<string, { maker: number; taker: number; ageMs: number } | null> = {};
  for (const exchange of ['binance', 'bybit', 'okx', 'bitget', 'gate', 'bingx'] as ExchangeId[]) {
    const cached = runtimeFees.get(exchange);
    result[exchange] = cached
      ? { maker: cached.maker, taker: cached.taker, ageMs: Date.now() - cached.fetchedAt }
      : null;
  }
  return result;
}

/** Clear the runtime fee cache (for testing) */
export function clearRuntimeFeeCache(): void {
  runtimeFees.clear();
}
