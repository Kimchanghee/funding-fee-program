import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId } from '@/lib/types';
import { fetchFundingRates } from '@/lib/exchanges';
import { SUPPORTED_EXCHANGES, TRACKED_SYMBOLS } from '@/lib/types';

function getApiConfig(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key') || '';
  const secret = req.headers.get('x-api-secret') || '';
  const passphrase = req.headers.get('x-api-passphrase') || undefined;
  return apiKey && secret ? { apiKey, secret, passphrase } : undefined;
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

  // Build symbol list for this exchange
  const symbols = TRACKED_SYMBOLS.map((base) => {
    switch (id) {
      case 'binance': return `${base}/USDT:USDT`;
      case 'bybit': return `${base}/USDT:USDT`;
      case 'okx': return `${base}/USDT:USDT`;
      case 'bitget': return `${base}/USDT:USDT`;
      case 'gate': return `${base}/USDT:USDT`;
      default: return `${base}/USDT:USDT`;
    }
  });

  try {
    const rates = await fetchFundingRates(id, config, symbols);
    return NextResponse.json({ success: true, data: rates });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
