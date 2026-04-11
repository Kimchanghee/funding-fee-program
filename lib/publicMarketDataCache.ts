import { fetchFundingRates, fetchMarketFillPrice } from './exchanges';
import { SUPPORTED_EXCHANGES, type ExchangeId, type FundingRate } from './types';

export interface FundingExchangeSnapshot {
  rates: FundingRate[];
  timestamp: number;
  status: 'ok' | 'error';
  error?: string;
  source: 'live' | 'fresh-cache' | 'stale-cache';
  stale: boolean;
}

export interface OrderbookFillSnapshot {
  fillPrice: number;
  slippagePercent: number;
  midPrice: number;
  worstPrice: number;
  timestamp: number;
  status: 'ok' | 'error';
  error?: string;
  source: 'live' | 'fresh-cache' | 'stale-cache';
  stale: boolean;
}

export interface FundingCacheHealth {
  exchange: ExchangeId;
  status: 'idle' | 'ok' | 'error';
  source: 'none' | 'live' | 'fresh-cache' | 'stale-cache';
  stale: boolean;
  inFlight: boolean;
  ageMs: number | null;
  ratesCount: number;
  lastError?: string;
}

export interface OrderbookCacheHealthSummary {
  entries: number;
  inFlight: number;
  freshEntries: number;
  staleEntries: number;
  oldestAgeMs: number | null;
}

interface FundingCacheEntry {
  rates: FundingRate[];
  timestamp: number;
  status: 'ok' | 'error';
  error?: string;
}

interface OrderbookCacheEntry {
  fillPrice: number;
  slippagePercent: number;
  midPrice: number;
  worstPrice: number;
  timestamp: number;
  status: 'ok' | 'error';
  error?: string;
}

const FUNDING_REFRESH_TIMEOUT_MS = 25_000;
const FUNDING_FRESH_TTL_MS = 6_000;
const FUNDING_STALE_TTL_MS = 45_000;
const ORDERBOOK_FRESH_TTL_MS = 1_500;
const ORDERBOOK_STALE_TTL_MS = 7_500;

const fundingCache = new Map<ExchangeId, FundingCacheEntry>();
const fundingInFlight = new Map<ExchangeId, Promise<FundingCacheEntry>>();
const orderbookCache = new Map<string, OrderbookCacheEntry>();
const orderbookInFlight = new Map<string, Promise<OrderbookCacheEntry>>();

function isUsableFundingCache(entry: FundingCacheEntry | undefined, ttlMs: number, now: number): entry is FundingCacheEntry {
  return !!entry && entry.rates.length > 0 && (now - entry.timestamp) < ttlMs;
}

function isUsableOrderbookCache(entry: OrderbookCacheEntry | undefined, ttlMs: number, now: number): entry is OrderbookCacheEntry {
  return !!entry
    && Number.isFinite(entry.fillPrice)
    && Number.isFinite(entry.slippagePercent)
    && Number.isFinite(entry.midPrice)
    && Number.isFinite(entry.worstPrice)
    && (now - entry.timestamp) < ttlMs;
}

async function refreshFundingExchange(id: ExchangeId): Promise<FundingCacheEntry> {
  const existing = fundingInFlight.get(id);
  if (existing) return existing;

  const task = (async () => {
    const previous = fundingCache.get(id);

    try {
      const rates = await Promise.race([
        fetchFundingRates(id),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout (${Math.round(FUNDING_REFRESH_TIMEOUT_MS / 1000)}s)`)), FUNDING_REFRESH_TIMEOUT_MS),
        ),
      ]);

      const next: FundingCacheEntry = {
        rates,
        timestamp: Date.now(),
        status: 'ok',
      };
      fundingCache.set(id, next);
      return next;
    } catch (error) {
      const errorMsg = (error as Error).message || 'unknown error';

      if (isUsableFundingCache(previous, FUNDING_STALE_TTL_MS, Date.now())) {
        const fallback: FundingCacheEntry = {
          ...previous,
          status: 'error',
          error: `${errorMsg} (using stale cache)`,
        };
        fundingCache.set(id, fallback);
        return fallback;
      }

      const failed: FundingCacheEntry = {
        rates: [],
        timestamp: Date.now(),
        status: 'error',
        error: errorMsg,
      };
      fundingCache.set(id, failed);
      return failed;
    } finally {
      fundingInFlight.delete(id);
    }
  })();

  fundingInFlight.set(id, task);
  return task;
}

export async function getFundingExchangeSnapshot(
  id: ExchangeId,
): Promise<FundingExchangeSnapshot> {
  const now = Date.now();
  const cached = fundingCache.get(id);

  const hasUsableFreshFundingCache = !!cached
    && cached.rates.length > 0
    && (now - cached.timestamp) < FUNDING_FRESH_TTL_MS;
  if (hasUsableFreshFundingCache) {
    return {
      rates: cached.rates,
      timestamp: cached.timestamp,
      status: cached.status,
      error: cached.error,
      source: 'fresh-cache',
      stale: false,
    };
  }

  const hasUsableStaleFundingCache = !!cached
    && cached.rates.length > 0
    && (now - cached.timestamp) < FUNDING_STALE_TTL_MS;
  if (fundingInFlight.has(id) && hasUsableStaleFundingCache) {
    return {
      rates: cached.rates,
      timestamp: cached.timestamp,
      source: 'stale-cache',
      stale: true,
      status: 'error',
      error: cached.error ?? 'refresh in progress (using stale cache)',
    };
  }

  const refreshed = await refreshFundingExchange(id);
  return {
    rates: refreshed.rates,
    timestamp: refreshed.timestamp,
    status: refreshed.status,
    error: refreshed.error,
    source: refreshed.status === 'ok' ? 'live' : 'stale-cache',
    stale: refreshed.status !== 'ok',
  };
}

function makeOrderbookCacheKey(
  exchange: ExchangeId,
  symbol: string,
  side: 'buy' | 'sell',
  notional: number,
): string {
  const roundedNotional = Math.round(notional * 100) / 100;
  return `${exchange}:${symbol}:${side}:${roundedNotional}`;
}

async function refreshOrderbookFill(
  exchange: ExchangeId,
  symbol: string,
  side: 'buy' | 'sell',
  notional: number,
): Promise<OrderbookCacheEntry> {
  const key = makeOrderbookCacheKey(exchange, symbol, side, notional);
  const existing = orderbookInFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const previous = orderbookCache.get(key);

    try {
      const result = await fetchMarketFillPrice(exchange, symbol, side, notional);
      const next: OrderbookCacheEntry = {
        ...result,
        timestamp: Date.now(),
        status: 'ok',
      };
      orderbookCache.set(key, next);
      return next;
    } catch (error) {
      const errorMsg = (error as Error).message || 'unknown error';

      if (isUsableOrderbookCache(previous, ORDERBOOK_STALE_TTL_MS, Date.now())) {
        const fallback: OrderbookCacheEntry = {
          ...previous,
          status: 'error',
          error: `${errorMsg} (using stale cache)`,
        };
        orderbookCache.set(key, fallback);
        return fallback;
      }

      const failed: OrderbookCacheEntry = {
        fillPrice: NaN,
        slippagePercent: NaN,
        midPrice: NaN,
        worstPrice: NaN,
        timestamp: Date.now(),
        status: 'error',
        error: errorMsg,
      };
      orderbookCache.set(key, failed);
      return failed;
    } finally {
      orderbookInFlight.delete(key);
    }
  })();

  orderbookInFlight.set(key, task);
  return task;
}

export async function getOrderbookFillSnapshot(
  exchange: ExchangeId,
  symbol: string,
  side: 'buy' | 'sell',
  notional: number,
): Promise<OrderbookFillSnapshot> {
  const key = makeOrderbookCacheKey(exchange, symbol, side, notional);
  const now = Date.now();
  const cached = orderbookCache.get(key);

  const hasUsableFreshOrderbookCache = !!cached
    && Number.isFinite(cached.fillPrice)
    && Number.isFinite(cached.slippagePercent)
    && Number.isFinite(cached.midPrice)
    && Number.isFinite(cached.worstPrice)
    && (now - cached.timestamp) < ORDERBOOK_FRESH_TTL_MS;
  if (hasUsableFreshOrderbookCache) {
    return {
      fillPrice: cached.fillPrice,
      slippagePercent: cached.slippagePercent,
      midPrice: cached.midPrice,
      worstPrice: cached.worstPrice,
      timestamp: cached.timestamp,
      status: cached.status,
      error: cached.error,
      source: 'fresh-cache',
      stale: false,
    };
  }

  const hasUsableStaleOrderbookCache = !!cached
    && Number.isFinite(cached.fillPrice)
    && Number.isFinite(cached.slippagePercent)
    && Number.isFinite(cached.midPrice)
    && Number.isFinite(cached.worstPrice)
    && (now - cached.timestamp) < ORDERBOOK_STALE_TTL_MS;
  if (orderbookInFlight.has(key) && hasUsableStaleOrderbookCache) {
    return {
      fillPrice: cached.fillPrice,
      slippagePercent: cached.slippagePercent,
      midPrice: cached.midPrice,
      worstPrice: cached.worstPrice,
      timestamp: cached.timestamp,
      source: 'stale-cache',
      stale: true,
      status: 'error',
      error: cached.error ?? 'refresh in progress (using stale cache)',
    };
  }

  const refreshed = await refreshOrderbookFill(exchange, symbol, side, notional);
  return {
    fillPrice: refreshed.fillPrice,
    slippagePercent: refreshed.slippagePercent,
    midPrice: refreshed.midPrice,
    worstPrice: refreshed.worstPrice,
    timestamp: refreshed.timestamp,
    status: refreshed.status,
    error: refreshed.error,
    source: refreshed.status === 'ok' ? 'live' : 'stale-cache',
    stale: refreshed.status !== 'ok',
  };
}

export function getFundingCacheHealth(): Record<string, FundingCacheHealth> {
  const now = Date.now();
  const result: Record<string, FundingCacheHealth> = {};

  for (const exchange of SUPPORTED_EXCHANGES) {
    const cached = fundingCache.get(exchange);
    const inFlight = fundingInFlight.has(exchange);
    const hasFresh = !!cached && cached.rates.length > 0 && (now - cached.timestamp) < FUNDING_FRESH_TTL_MS;
    const hasStale = !!cached && cached.rates.length > 0 && (now - cached.timestamp) < FUNDING_STALE_TTL_MS;

    result[exchange] = {
      exchange,
      status: !cached ? 'idle' : cached.status,
      source: hasFresh ? 'fresh-cache' : hasStale ? 'stale-cache' : 'none',
      stale: !!cached && !hasFresh,
      inFlight,
      ageMs: cached ? Math.max(0, now - cached.timestamp) : null,
      ratesCount: cached?.rates.length ?? 0,
      lastError: cached?.error,
    };
  }

  return result;
}

export function getOrderbookCacheHealth(): OrderbookCacheHealthSummary {
  const now = Date.now();
  let freshEntries = 0;
  let staleEntries = 0;
  let oldestAgeMs: number | null = null;

  for (const entry of orderbookCache.values()) {
    const ageMs = Math.max(0, now - entry.timestamp);
    if (ageMs < ORDERBOOK_FRESH_TTL_MS) {
      freshEntries += 1;
    } else if (ageMs < ORDERBOOK_STALE_TTL_MS) {
      staleEntries += 1;
    }
    oldestAgeMs = oldestAgeMs == null ? ageMs : Math.max(oldestAgeMs, ageMs);
  }

  return {
    entries: orderbookCache.size,
    inFlight: orderbookInFlight.size,
    freshEntries,
    staleEntries,
    oldestAgeMs,
  };
}
