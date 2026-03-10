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

let cache: RatesCache | null = null;
let refreshInProgress = false;
const CACHE_TTL = 15_000; // 15s — serve cached data if fresh enough

async function doFetch(exchanges: ExchangeId[], symbols: string[]): Promise<RatesCache> {
  const results = await Promise.allSettled(
    exchanges.map((id) => fetchFundingRates(id, undefined, symbols)),
  );

  const allRates = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => (r as PromiseFulfilledResult<ReturnType<typeof fetchFundingRates> extends Promise<infer T> ? T : never>).value);

  const errors = results
    .filter((r) => r.status === 'rejected')
    .map((r, i) => ({
      exchange: exchanges[i],
      error: (r as PromiseRejectedResult).reason?.message,
    }));

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
    if (!refreshInProgress) {
      refreshInProgress = true;
      doFetch(exchanges, symbols)
        .then((result) => { cache = result; })
        .catch(() => {})
        .finally(() => { refreshInProgress = false; });
    }

    return NextResponse.json({
      success: true,
      data: { rates: cache.rates, opportunities: cache.opportunities, errors: cache.errors },
      timestamp: cache.timestamp,
    });
  }

  // First load or no cache — must wait
  try {
    cache = await doFetch(exchanges, symbols);
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: (err as Error).message || '모든 거래소에서 펀딩률 조회 실패',
      data: { rates: [], opportunities: [], errors: [] },
      timestamp: now,
    }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    data: { rates: cache.rates, opportunities: cache.opportunities, errors: cache.errors },
    timestamp: cache.timestamp,
  });
}
