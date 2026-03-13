import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, FundingRate, ArbitrageOpportunity } from '@/lib/types';
import { SUPPORTED_EXCHANGES, TRACKED_SYMBOLS } from '@/lib/types';
import { fetchFundingRates } from '@/lib/exchanges';
import { findOpportunities } from '@/lib/opportunities';
import { saveSnapshotIfRankChanged } from '@/lib/snapshot';

export const maxDuration = 60;

// ── Server-side cache: serve stale data instantly while refreshing ──
interface RatesCache {
  rates: FundingRate[];
  opportunities: ArbitrageOpportunity[];
  errors: { exchange: ExchangeId; error: string }[];
  timestamp: number;
}

// Cache keyed by sorted exchange list to avoid cross-contamination
const MAX_CACHE_ENTRIES = 10; // prevent unbounded memory growth from arbitrary exchange params
const cacheMap = new Map<string, RatesCache>();
const refreshSet = new Set<string>();
const CACHE_TTL = 8_000; // 8s — serve cached data if fresh enough

function cacheKey(exchanges: ExchangeId[]): string {
  return [...exchanges].sort().join(',');
}

const PER_EXCHANGE_TIMEOUT = 15_000; // 15s — 한 거래소가 전체를 지연시키지 않도록

async function doFetch(exchanges: ExchangeId[], symbols: string[]): Promise<RatesCache> {
  const results = await Promise.allSettled(
    exchanges.map((id) =>
      Promise.race([
        fetchFundingRates(id, undefined, symbols),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`[${id}] 전체 타임아웃 (${PER_EXCHANGE_TIMEOUT / 1000}s)`)), PER_EXCHANGE_TIMEOUT),
        ),
      ]),
    ),
  );

  const allRates: FundingRate[] = [];
  const errors: { exchange: ExchangeId; error: string }[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      allRates.push(...(r.value as FundingRate[]));
    } else {
      errors.push({
        exchange: exchanges[i],
        error: (r as PromiseRejectedResult).reason?.message || 'unknown error',
      });
    }
  }

  if (allRates.length === 0) {
    throw new Error(
      errors.map((e) => `${e.exchange}:${e.error}`).join(' | ') || 'all exchanges failed',
    );
  }

  const opportunities = findOpportunities(allRates);

  // 순위 변경 시 스냅샷 저장 (비동기, 실패해도 무시)
  saveSnapshotIfRankChanged(allRates, opportunities).catch(() => {});

  return { rates: allRates, opportunities, errors, timestamp: Date.now() };
}

async function refreshCacheWithRetry(
  key: string,
  exchanges: ExchangeId[],
  symbols: string[],
): Promise<void> {
  try {
    const result = await doFetch(exchanges, symbols);
    cacheMap.set(key, result);
    return;
  } catch {
    // Retry once after 2s on failure instead of serving stale indefinitely
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    try {
      const retry = await doFetch(exchanges, symbols);
      cacheMap.set(key, retry);
    } catch {
      // keep stale cache
    }
  } finally {
    refreshSet.delete(key);
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const exchangeParam = url.searchParams.get('exchanges');
  const exchanges = exchangeParam
    ? [...new Set(exchangeParam.split(','))].filter((e): e is ExchangeId => SUPPORTED_EXCHANGES.includes(e as ExchangeId))
    : SUPPORTED_EXCHANGES;

  if (exchanges.length === 0) {
    return NextResponse.json(
      { success: false, error: 'No valid exchanges specified', data: { rates: [], opportunities: [], errors: [] }, timestamp: Date.now() },
      { status: 400 },
    );
  }

  const symbols = TRACKED_SYMBOLS.map((b) => `${b}/USDT:USDT`);
  const now = Date.now();
  const key = cacheKey(exchanges);
  const cache = cacheMap.get(key) ?? null;

  // If cache is fresh enough, return immediately and refresh in background
  if (cache && (now - cache.timestamp) < CACHE_TTL) {
    return NextResponse.json({
      success: true,
      data: { rates: cache.rates, opportunities: cache.opportunities, errors: cache.errors },
      timestamp: cache.timestamp,
    });
  }

  // If cache exists but stale, return stale immediately + kick background refresh if not already running
  if (cache) {
    if (!refreshSet.has(key)) {
      refreshSet.add(key);
      void refreshCacheWithRetry(key, exchanges, symbols);
    }

    return NextResponse.json({
      success: true,
      data: { rates: cache.rates, opportunities: cache.opportunities, errors: cache.errors },
      timestamp: cache.timestamp,
    });
  }

  // First load or no cache — must wait
  try {
    const result = await doFetch(exchanges, symbols);
    // Evict oldest entry if cache is full
    if (cacheMap.size >= MAX_CACHE_ENTRIES && !cacheMap.has(key)) {
      const oldest = [...cacheMap.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) cacheMap.delete(oldest[0]);
    }
    cacheMap.set(key, result);

    return NextResponse.json({
      success: true,
      data: { rates: result.rates, opportunities: result.opportunities, errors: result.errors },
      timestamp: result.timestamp,
    });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: (err as Error).message || '모든 거래소에서 펀딩률 조회 실패',
      data: { rates: [], opportunities: [], errors: [] },
      timestamp: now,
    }, { status: 502 });
  }
}
