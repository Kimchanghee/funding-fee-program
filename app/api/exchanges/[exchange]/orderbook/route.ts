import { NextRequest, NextResponse } from 'next/server';
import { getOrderbookFillSnapshot } from '@/lib/publicMarketDataCache';
import type { ExchangeId } from '@/lib/types';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ exchange: string }> },
) {
  const { exchange } = await params;
  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol');
  const side = url.searchParams.get('side') as 'buy' | 'sell';
  const notional = parseFloat(url.searchParams.get('notional') || '0');

  if (!symbol || !side || !notional) {
    return NextResponse.json(
      { success: false, error: 'symbol, side, notional required' },
      { status: 400 },
    );
  }

  try {
    const result = await getOrderbookFillSnapshot(
      exchange as ExchangeId,
      symbol,
      side,
      notional,
    );
    if (!Number.isFinite(result.fillPrice)) {
      throw new Error(result.error || 'orderbook unavailable');
    }
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
