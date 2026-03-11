import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { fetchFundingHistory } from '@/lib/exchanges';

function getApiConfig(req: NextRequest) {
  return {
    apiKey: req.headers.get('x-api-key') || '',
    secret: req.headers.get('x-api-secret') || '',
    passphrase: req.headers.get('x-api-passphrase') || undefined,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ exchange: string }> },
) {
  const { exchange } = await params;
  if (!SUPPORTED_EXCHANGES.includes(exchange as ExchangeId)) {
    return NextResponse.json({ success: false, error: 'Unsupported exchange' }, { status: 400 });
  }
  const id = exchange as ExchangeId;
  const config = getApiConfig(req);

  if (!config.apiKey || !config.secret) {
    return NextResponse.json({ success: false, error: 'API credentials required' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20') || 20, 1), 200);

  try {
    const history = await fetchFundingHistory(id, config, undefined, limit);
    return NextResponse.json({ success: true, data: history });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
