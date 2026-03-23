import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, FundingRate } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { fetchFundingRates } from '@/lib/exchanges';
import { findOpportunities } from '@/lib/opportunities';
import { saveSnapshotIfRankChanged } from '@/lib/snapshot';

export const maxDuration = 120;

// ── Per-exchange cache (independent per exchange) ──
interface ExchangeCache {
  rates: FundingRate[];
  timestamp: number;
  status: 'ok' | 'error';
  error?: string;
}

const exchangeCacheMap = new Map<ExchangeId, ExchangeCache>();
const PER_EXCHANGE_TIMEOUT = 40_000; // 전체 종목 스캔 시 loadMarkets(~10s) + fetchFundingRates(~20s) 시간 확보
const CACHE_TTL = 6_000; // 6s — fresh enough for REST-only polling

/**
 * Fetch funding rates for a single exchange with timeout.
 * Returns cached data on failure if available.
 */
async function fetchSingleExchange(
  id: ExchangeId,
  symbols?: string[],
): Promise<ExchangeCache> {
  const existing = exchangeCacheMap.get(id);

  try {
    console.log(`[API] ${id}: fetch 시작`);
    const rates = await Promise.race([
      fetchFundingRates(id, undefined, symbols),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`타임아웃 (${PER_EXCHANGE_TIMEOUT / 1000}s)`)), PER_EXCHANGE_TIMEOUT),
      ),
    ]);
    console.log(`[API] ${id}: ${rates.length}개 데이터 수신`);

    const cache: ExchangeCache = {
      rates,
      timestamp: Date.now(),
      status: 'ok',
    };
    exchangeCacheMap.set(id, cache);
    return cache;
  } catch (err) {
    const errorMsg = (err as Error).message || 'unknown error';
    console.error(`[API] ${id}: 실패 — ${errorMsg}`);

    // If we have cached data less than 30s old, return it as stale-but-usable
    if (existing && (Date.now() - existing.timestamp) < 30_000) {
      return {
        ...existing,
        status: 'error',
        error: `${errorMsg} (캐시 데이터 사용)`,
      };
    }

    return {
      rates: [],
      timestamp: Date.now(),
      status: 'error',
      error: errorMsg,
    };
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
      { success: false, error: 'No valid exchanges specified', data: { rates: [], opportunities: [], errors: [], exchangeStatus: {} }, timestamp: Date.now() },
      { status: 400 },
    );
  }

  // 전체 선물 종목 스캔 — symbols를 넘기지 않으면 거래소 전체 USDT 페어 반환
  const symbols: string[] | undefined = undefined;
  const now = Date.now();

  // Determine which exchanges need refresh vs can use cache
  const toFetch: ExchangeId[] = [];
  const cached: ExchangeId[] = [];

  for (const id of exchanges) {
    const c = exchangeCacheMap.get(id);
    if (c && (now - c.timestamp) < CACHE_TTL && c.status === 'ok') {
      cached.push(id);
    } else {
      toFetch.push(id);
    }
  }

  // Fetch stale/missing exchanges in parallel (each independent)
  if (toFetch.length > 0) {
    await Promise.allSettled(
      toFetch.map((id) => fetchSingleExchange(id, symbols)),
    );
  }

  // Aggregate results from all exchanges
  const allRates: FundingRate[] = [];
  const errors: { exchange: ExchangeId; error: string }[] = [];
  const exchangeStatus: Record<string, 'ok' | 'error'> = {};

  for (const id of exchanges) {
    const c = exchangeCacheMap.get(id);
    if (c && c.rates.length > 0) {
      allRates.push(...c.rates);
      exchangeStatus[id] = c.status;
      if (c.error) {
        errors.push({ exchange: id, error: c.error });
      }
    } else {
      exchangeStatus[id] = 'error';
      errors.push({
        exchange: id,
        error: c?.error || '데이터 없음',
      });
    }
  }

  // Even if some exchanges failed, return whatever we have
  if (allRates.length === 0) {
    return NextResponse.json({
      success: false,
      error: errors.map((e) => `${e.exchange}:${e.error}`).join(' | ') || '모든 거래소에서 펀딩률 조회 실패',
      data: { rates: [], opportunities: [], errors, exchangeStatus },
      timestamp: now,
    }, { status: 502 });
  }

  const opportunities = findOpportunities(allRates);

  // Save snapshot async (don't block response)
  saveSnapshotIfRankChanged(allRates, opportunities).catch(() => {});

  return NextResponse.json({
    success: true,
    data: { rates: allRates, opportunities, errors, exchangeStatus },
    timestamp: Date.now(),
  });
}
