import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, ApiConfig } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { saveServerApiConfig, removeServerApiConfig, listConfiguredExchanges } from '@/lib/serverKeyStore';

/** GET: 설정된 거래소 목록만 반환 (키 노출 X) */
export async function GET() {
  const configured = listConfiguredExchanges();
  return NextResponse.json({ success: true, configured });
}

/** POST: 거래소 API 키 저장 (서버 측 암호화 파일) */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { exchange: string; config: ApiConfig };
    const { exchange, config } = body;

    if (!SUPPORTED_EXCHANGES.includes(exchange as ExchangeId)) {
      return NextResponse.json({ success: false, error: 'Unsupported exchange' }, { status: 400 });
    }
    if (!config?.apiKey || !config?.secret) {
      return NextResponse.json({ success: false, error: 'apiKey and secret required' }, { status: 400 });
    }

    saveServerApiConfig(exchange as ExchangeId, {
      apiKey: config.apiKey,
      secret: config.secret,
      ...(config.passphrase ? { passphrase: config.passphrase } : {}),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

/** DELETE: 거래소 API 키 삭제 */
export async function DELETE(req: NextRequest) {
  try {
    const { exchange } = await req.json() as { exchange: string };
    if (!SUPPORTED_EXCHANGES.includes(exchange as ExchangeId)) {
      return NextResponse.json({ success: false, error: 'Unsupported exchange' }, { status: 400 });
    }
    removeServerApiConfig(exchange as ExchangeId);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
