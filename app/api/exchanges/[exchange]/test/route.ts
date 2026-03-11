import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { testConnection } from '@/lib/exchanges';

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
  if (!SUPPORTED_EXCHANGES.includes(exchange as ExchangeId)) {
    return NextResponse.json({ success: false, error: 'Unsupported exchange' }, { status: 400 });
  }
  const id = exchange as ExchangeId;
  const config = getApiConfig(req);

  if (!config.apiKey || !config.secret) {
    return NextResponse.json({ success: false, error: 'API credentials required' }, { status: 401 });
  }

  try {
    const ok = await testConnection(id, config);
    return NextResponse.json({ success: ok });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
