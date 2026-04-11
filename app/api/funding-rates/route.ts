import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, FundingRate } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { getFundingExchangeSnapshot } from '@/lib/publicMarketDataCache';
import { findOpportunities } from '@/lib/opportunities';
import { saveSnapshotIfRankChanged } from '@/lib/snapshot';

export const maxDuration = 120;

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

  const snapshots = await Promise.all(exchanges.map((exchange) => getFundingExchangeSnapshot(exchange)));

  const allRates: FundingRate[] = [];
  const errors: { exchange: ExchangeId; error: string }[] = [];
  const exchangeStatus: Record<string, 'ok' | 'error'> = {};
  const cacheState: Record<string, { source: string; stale: boolean; ageMs: number }> = {};

  for (let i = 0; i < exchanges.length; i += 1) {
    const exchange = exchanges[i];
    const snapshot = snapshots[i];
    const ageMs = Math.max(0, Date.now() - snapshot.timestamp);

    cacheState[exchange] = {
      source: snapshot.source,
      stale: snapshot.stale,
      ageMs,
    };

    if (snapshot.rates.length > 0) {
      allRates.push(...snapshot.rates);
      exchangeStatus[exchange] = snapshot.status;
      if (snapshot.error) {
        errors.push({ exchange, error: snapshot.error });
      }
      continue;
    }

    exchangeStatus[exchange] = 'error';
    errors.push({ exchange, error: snapshot.error || 'no data' });
  }

  if (allRates.length === 0) {
    return NextResponse.json({
      success: false,
      error: errors.map((e) => `${e.exchange}:${e.error}`).join(' | ') || 'all exchanges failed',
      data: { rates: [], opportunities: [], errors, exchangeStatus, cacheState },
      timestamp: Date.now(),
    }, { status: 502 });
  }

  const opportunities = findOpportunities(allRates);
  saveSnapshotIfRankChanged(allRates, opportunities).catch(() => {});

  return NextResponse.json({
    success: true,
    data: { rates: allRates, opportunities, errors, exchangeStatus, cacheState },
    timestamp: Date.now(),
  });
}
