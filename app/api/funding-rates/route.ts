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
const cacheMap = new Map<string, RatesCache>();
const refreshSet = new Set<string>();
const CACHE_TTL = 8_000; // 8s — serve cached data if fresh enough

function cacheKey(exchanges: ExchangeId[]): string {
  return [...exchanges].sort().join(',');
}

async function doFetch(exchanges: ExchangeId[], symbols: string[]): Promise<RatesCache> {
  const results = await Promise.allSettled(
    exchanges.map((id) => fetchFundingRates(id, undefined, symbols)),
  );

  const allRates = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => (r as PromiseFulfilledResult<ReturnType<typeof fetchFundingRates> extends Promise<infer T> ? T : never>).value);

  // Map errors with correct exchange index (iterate full results, not filtered)
  const errors: { exchange: ExchangeId; error: string }[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      errors.push({
        exchange: exchanges[i],
        error: (results[i] as PromiseRejectedResult).reason?.message,
      });
    }
  }

  const opportunities = findOpportunities(allRates);

  // 순위 변경 시 스냅샷 저장 (비동기, 실패해도 무시)
  saveSnapshotIfRankChanged(allRates, opportunities).catch(() => {});

  return { rates: allRates, opportunities, errors, timestamp: Date.now() };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const exchangeParam = url.searchParams.get('exchanges');
  const exchanges = exchangeParam
    ? (exchangeParam.split(',') as ExchangeId[])
    : SUPPORTED_EXCHANGES;

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
      doFetch(exchanges, symbols)
        .then((result) => { cacheMap.set(key, result); })
        .catch(() => {
          // Retry once after 2s on failure instead of serving stale indefinitely
          setTimeout(() => {
            doFetch(exchanges, symbols)
              .then((result) => { cacheMap.set(key, result); })
              .catch(() => {});
          }, 2000);
        })
        .finally(() => { refreshSet.delete(key); });
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
