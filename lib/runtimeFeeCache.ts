/**
 * Runtime fee cache — fetches actual account trading fees from exchange APIs
 * and provides a resolution function that falls back through:
 *   runtimeFees → feeOverrides → EXCHANGE_FEES preset
 */
import { fetchAccountFees } from './exchanges';
import { getExchangeFee, type ApiConfig, type ExchangeId, type FeeOverrides } from './types';

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
  const existing = runtimeFees.get(exchange);
  if (!forceFresh && existing && Date.now() - existing.fetchedAt < FEE_CACHE_TTL_MS) {
    return true; // cache still fresh
  }

  const result = await fetchAccountFees(exchange, config, symbol);
  if (!result) return false;

  runtimeFees.set(exchange, {
    maker: result.maker,
    taker: result.taker,
    fetchedAt: Date.now(),
  });
  return true;
}

/**
 * Refresh fee cache for multiple exchanges in parallel.
 */
export async function refreshAllFeeCaches(
  configs: Partial<Record<ExchangeId, ApiConfig>>,
): Promise<void> {
  const entries = Object.entries(configs) as Array<[ExchangeId, ApiConfig]>;
  await Promise.allSettled(
    entries
      .filter(([, config]) => config?.apiKey)
      .map(([exchange, config]) => refreshFeeCache(exchange, config)),
  );
}

/**
 * Resolve fee for a given exchange, preferring runtime cache over overrides over preset.
 */
export function resolveRuntimeFee(
  exchange: ExchangeId,
  orderType: 'maker' | 'taker',
  overrides?: FeeOverrides,
): number {
  const cached = runtimeFees.get(exchange);
  if (cached && Date.now() - cached.fetchedAt < FEE_CACHE_TTL_MS) {
    return cached[orderType];
  }
  return getExchangeFee(exchange, orderType, overrides);
}

export type FeeSource = 'runtime' | 'override' | 'preset';

/**
 * Resolve fee with source information — used to enforce runtime fee availability in REAL mode.
 */
export function resolveRuntimeFeeDetailed(
  exchange: ExchangeId,
  orderType: 'maker' | 'taker',
  overrides?: FeeOverrides,
): { fee: number; source: FeeSource; fresh: boolean } {
  const cached = runtimeFees.get(exchange);
  if (cached && Date.now() - cached.fetchedAt < FEE_CACHE_TTL_MS) {
    return { fee: cached[orderType], source: 'runtime', fresh: true };
  }
  const overrideFees = overrides?.[exchange];
  if (overrideFees && typeof overrideFees[orderType] === 'number') {
    return { fee: overrideFees[orderType], source: 'override', fresh: false };
  }
  return { fee: getExchangeFee(exchange, orderType, overrides), source: 'preset', fresh: false };
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
