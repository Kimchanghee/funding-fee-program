import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, FeeOverrides } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { openPosition } from '@/lib/exchanges';
import { getApiConfigFromRequest } from '@/lib/getApiConfigFromRequest';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ exchange: string }> },
) {
  const { exchange } = await params;

  if (!SUPPORTED_EXCHANGES.includes(exchange as ExchangeId)) {
    return NextResponse.json({ success: false, error: `Unsupported exchange: ${exchange}` }, { status: 400 });
  }
  const id = exchange as ExchangeId;
  const config = getApiConfigFromRequest(req, id);

  if (!config.apiKey || !config.secret) {
    return NextResponse.json({ success: false, error: 'API credentials required' }, { status: 401 });
  }

  try {
    const body = await req.json() as {
      symbol: string;
      side: 'long' | 'short';
      amountUSDT: number;
      leverage: number;
      feeOverrides?: FeeOverrides;
    };

    // Runtime validation
    if (!body.symbol || typeof body.symbol !== 'string') {
      return NextResponse.json({ success: false, error: 'Invalid symbol' }, { status: 400 });
    }
    if (body.side !== 'long' && body.side !== 'short') {
      return NextResponse.json({ success: false, error: 'Invalid side: must be long or short' }, { status: 400 });
    }
    if (typeof body.amountUSDT !== 'number' || body.amountUSDT <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid amountUSDT: must be positive number' }, { status: 400 });
    }
    if (typeof body.leverage !== 'number' || body.leverage < 1 || body.leverage > 125) {
      return NextResponse.json({ success: false, error: 'Invalid leverage: must be 1-125' }, { status: 400 });
    }

    const result = await openPosition(id, config, body.symbol, body.side, body.amountUSDT, body.leverage, body.feeOverrides);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
