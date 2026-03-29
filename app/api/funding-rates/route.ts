import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, FundingRate } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { fetchFundingRates } from '@/lib/exchanges';
import { findOpportunities } from '@/lib/opportunities';
import { saveSnapshotIfRankChanged } from '@/lib/snapshot';

export const maxDuration = 120;

interface ExchangeCache {
  rates: FundingRate[];
  timestamp: number;
  status: 'ok' | 'error';
  error?: string;
}

const exchangeCacheMap = new Map<ExchangeId, ExchangeCache>();
const PER_EXCHANGE_TIMEOUT = 25_000;
const CACHE_TTL = 6_000;
const STALE_FALLBACK_TTL = 30_000;

async function fetchSingleExchange(
  id: ExchangeId,
  symbols?: string[],
): Promise<ExchangeCache> {
  const existing = exchangeCacheMap.get(id);

  try {
    const rates = await Promise.race([
      fetchFundingRates(id, undefined, symbols),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout (${PER_EXCHANGE_TIMEOUT / 1000}s)`)), PER_EXCHANGE_TIMEOUT),
      ),
    ]);

    const cache: ExchangeCache = {
      rates,
      timestamp: Date.now(),
      status: 'ok',
    };
    exchangeCacheMap.set(id, cache);
    return cache;
  } catch (err) {
    const errorMsg = (err as Error).message || 'unknown error';

    if (existing && existing.rates.length > 0 && (Date.now() - existing.timestamp) < STALE_FALLBACK_TTL) {
      const fallbackCache: ExchangeCache = {
        ...existing,
        status: 'error',
        error: `${errorMsg} (using stale cache)`,
      };
      exchangeCacheMap.set(id, fallbackCache);
      return fallbackCache;
    }

    const errorCache: ExchangeCache = {
      rates: [],
      timestamp: Date.now(),
      status: 'error',
      error: errorMsg,
    };
    exchangeCacheMap.set(id, errorCache);
    return errorCache;
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const exchangeParam = url.searchParams.get('exchanges');
  const exchanges = exchangeParam
    ? [...new Set(exchangeParam.split(','))].filter(
      (exchange): exchange is ExchangeId => SUPPORTED_EXCHANGES.includes(exchange as ExchangeId),
    )
    : SUPPORTED_EXCHANGES;

  if (exchanges.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error: 'No valid exchanges specified',
        data: { rates: [], opportunities: [], errors: [], exchangeStatus: {} },
        timestamp: Date.now(),
      },
      { status: 400 },
    );
  }

  const symbols: string[] | undefined = undefined;
  const now = Date.now();

  const toFetch: ExchangeId[] = [];
  for (const id of exchanges) {
    const cache = exchangeCacheMap.get(id);
    const hasFreshUsableCache = !!cache
      && cache.rates.length > 0
      && (now - cache.timestamp) < CACHE_TTL;
    if (!hasFreshUsableCache) {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    await Promise.allSettled(toFetch.map((id) => fetchSingleExchange(id, symbols)));
  }

  const allRates: FundingRate[] = [];
  const errors: { exchange: ExchangeId; error: string }[] = [];
  const exchangeStatus: Record<string, 'ok' | 'error'> = {};

  for (const id of exchanges) {
    const cache = exchangeCacheMap.get(id);
    if (cache && cache.rates.length > 0) {
      allRates.push(...cache.rates);
      exchangeStatus[id] = cache.status;
      if (cache.error) {
        errors.push({ exchange: id, error: cache.error });
      }
    } else {
      exchangeStatus[id] = 'error';
      errors.push({ exchange: id, error: cache?.error || 'no data' });
    }
  }

  if (allRates.length === 0) {
    return NextResponse.json({
      success: false,
      error: errors.map((e) => `${e.exchange}:${e.error}`).join(' | ') || 'all exchanges failed',
      data: { rates: [], opportunities: [], errors, exchangeStatus },
      timestamp: now,
    }, { status: 502 });
  }

  const opportunities = findOpportunities(allRates);
  saveSnapshotIfRankChanged(allRates, opportunities).catch(() => {});

  return NextResponse.json({
    success: true,
    data: { rates: allRates, opportunities, errors, exchangeStatus },
    timestamp: Date.now(),
  });
}
