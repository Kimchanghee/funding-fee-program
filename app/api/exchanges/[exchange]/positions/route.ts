import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { fetchPositions } from '@/lib/exchanges';
import { getApiConfigFromRequest } from '@/lib/getApiConfigFromRequest';
import { loadAllServerPositionMeta, makeServerPositionKey } from '@/lib/serverPositionMeta';
import { hasRequiredApiCredentials } from '@/lib/apiCredentials';

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

  if (!hasRequiredApiCredentials(id, config)) {
    return NextResponse.json({ success: false, error: 'API credentials required' }, { status: 401 });
  }

  try {
    const positions = await fetchPositions(id, config);
    const serverMeta = loadAllServerPositionMeta();
    const enriched = positions.map((position) => {
      const meta = serverMeta[makeServerPositionKey(position.exchange, position.symbol, position.side)];
      if (!meta) return position;
      return {
        ...position,
        pairId: meta.pairId,
        positionType: meta.positionType,
        openedAt: meta.openedAt,
        entryFee: meta.entryFee,
        entryOrderLiquidity: meta.entryOrderLiquidity,
        entryFilledNotional: meta.entryFilledNotional,
      };
    });
    return NextResponse.json({ success: true, data: enriched });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
