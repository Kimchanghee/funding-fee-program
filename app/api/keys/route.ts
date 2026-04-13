import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, ApiConfig } from '@/lib/types';
import { isExchangeOperable, isSupportedExchange } from '@/lib/types';
import { saveServerApiConfig, removeServerApiConfig, listConfiguredExchanges } from '@/lib/serverKeyStore';
import { getMissingApiCredentialFields } from '@/lib/apiCredentials';

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
    const exchangeId = exchange as ExchangeId;

    if (!isExchangeOperable(exchangeId)) {
      return NextResponse.json({ success: false, error: 'Unsupported exchange' }, { status: 400 });
    }
    const missingFields = getMissingApiCredentialFields(exchangeId, config);
    if (missingFields.length > 0) {
      return NextResponse.json(
        { success: false, error: `missing required credentials: ${missingFields.join(', ')}` },
        { status: 400 },
      );
    }

    saveServerApiConfig(exchangeId, {
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
    if (!isSupportedExchange(exchange)) {
      return NextResponse.json({ success: false, error: 'Unsupported exchange' }, { status: 400 });
    }
    removeServerApiConfig(exchange as ExchangeId);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
