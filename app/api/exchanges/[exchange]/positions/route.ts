import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { fetchPositions } from '@/lib/exchanges';
import { getApiConfigFromRequest } from '@/lib/getApiConfigFromRequest';

export async function GET(
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
    const positions = await fetchPositions(id, config);
    return NextResponse.json({ success: true, data: positions });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
