import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, FeeOverrides, PaybackOverrides } from '@/lib/types';
import {
  SUPPORTED_EXCHANGES,
  hasValidFeeOverrides,
  hasValidPaybackOverrides,
  sanitizeFeeOverrides,
  sanitizePaybackOverrides,
} from '@/lib/types';
import { closePosition } from '@/lib/exchanges';
import { getApiConfigFromRequest } from '@/lib/getApiConfigFromRequest';
import { makeServerPositionKey, removeServerPositionMeta } from '@/lib/serverPositionMeta';
import { hasRequiredApiCredentials } from '@/lib/apiCredentials';

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

  if (!hasRequiredApiCredentials(id, config)) {
    return NextResponse.json({ success: false, error: 'API credentials required' }, { status: 401 });
  }

  try {
    const body = await req.json() as {
      symbol: string;
      side: 'long' | 'short';
      amount: number;
      feeOverrides?: FeeOverrides;
      paybackOverrides?: PaybackOverrides;
    };

    // Runtime validation
    if (!body.symbol || typeof body.symbol !== 'string') {
      return NextResponse.json({ success: false, error: 'Invalid symbol' }, { status: 400 });
    }
    if (body.side !== 'long' && body.side !== 'short') {
      return NextResponse.json({ success: false, error: 'Invalid side: must be long or short' }, { status: 400 });
    }
    if (typeof body.amount !== 'number' || body.amount <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid amount: must be positive number' }, { status: 400 });
    }
    if (!hasValidFeeOverrides(body.feeOverrides)) {
      return NextResponse.json({ success: false, error: 'Invalid feeOverrides' }, { status: 400 });
    }
    if (!hasValidPaybackOverrides(body.paybackOverrides)) {
      return NextResponse.json({ success: false, error: 'Invalid paybackOverrides' }, { status: 400 });
    }

    const result = await closePosition(
      id,
      config,
      body.symbol,
      body.side,
      body.amount,
      sanitizeFeeOverrides(body.feeOverrides),
      sanitizePaybackOverrides(body.paybackOverrides),
    );
    removeServerPositionMeta([makeServerPositionKey(id, body.symbol, body.side)]);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
