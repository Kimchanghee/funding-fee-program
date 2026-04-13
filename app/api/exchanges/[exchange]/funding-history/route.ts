import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId } from '@/lib/types';
import { isExchangeOperable } from '@/lib/types';
import { fetchFundingHistory } from '@/lib/exchanges';
import { getApiConfigFromRequest } from '@/lib/getApiConfigFromRequest';
import { hasRequiredApiCredentials } from '@/lib/apiCredentials';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ exchange: string }> },
) {
  const { exchange } = await params;
  if (!isExchangeOperable(exchange)) {
    return NextResponse.json({ success: false, error: 'Unsupported exchange' }, { status: 400 });
  }
  const id = exchange as ExchangeId;
  const config = getApiConfigFromRequest(req, id);

  if (!hasRequiredApiCredentials(id, config)) {
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
