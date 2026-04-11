import { NextResponse } from 'next/server';
import { getWsPublicDataHealth } from '@/lib/exchanges/wsPublicData';
import { getFundingCacheHealth, getOrderbookCacheHealth } from '@/lib/publicMarketDataCache';

export async function GET() {
  return NextResponse.json({
    success: true,
    timestamp: Date.now(),
    data: {
      funding: getFundingCacheHealth(),
      orderbook: getOrderbookCacheHealth(),
      ws: getWsPublicDataHealth(),
    },
  });
}
