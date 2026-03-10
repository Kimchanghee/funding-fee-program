import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId } from '@/lib/types';
import { openPosition } from '@/lib/exchanges';

function getApiConfig(req: NextRequest) {
  return {
    apiKey: req.headers.get('x-api-key') || '',
    secret: req.headers.get('x-api-secret') || '',
    passphrase: req.headers.get('x-api-passphrase') || undefined,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ exchange: string }> },
) {
  const { exchange } = await params;
  const id = exchange as ExchangeId;
  const config = getApiConfig(req);

  if (!config.apiKey || !config.secret) {
    return NextResponse.json({ success: false, error: 'API credentials required' }, { status: 401 });
  }

  try {
    const body = await req.json() as {
      symbol: string;
      side: 'long' | 'short';
      amountUSDT: number;
      leverage: number;
    };
    const result = await openPosition(id, config, body.symbol, body.side, body.amountUSDT, body.leverage);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
