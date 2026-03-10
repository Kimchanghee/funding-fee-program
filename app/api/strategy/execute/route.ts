import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, ApiConfig, ArbitrageOpportunity } from '@/lib/types';
import { openPosition } from '@/lib/exchanges';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      opportunity: ArbitrageOpportunity;
      investmentUSDT: number;
      leverage: number;
      apiConfigs: Partial<Record<ExchangeId, ApiConfig>>;
    };

    const { opportunity, investmentUSDT, leverage, apiConfigs } = body;

    const shortConfig = apiConfigs[opportunity.shortExchange];
    const longConfig = apiConfigs[opportunity.longExchange];

    if (!shortConfig || !longConfig) {
      return NextResponse.json(
        { success: false, error: 'Missing API config for one or both exchanges' },
        { status: 400 },
      );
    }

    // Execute both positions concurrently
    const [shortResult, longResult] = await Promise.allSettled([
      openPosition(
        opportunity.shortExchange,
        shortConfig,
        opportunity.shortSymbol,
        'short',
        investmentUSDT,
        leverage,
      ),
      openPosition(
        opportunity.longExchange,
        longConfig,
        opportunity.longSymbol,
        'long',
        investmentUSDT,
        leverage,
      ),
    ]);

    const shortOk = shortResult.status === 'fulfilled';
    const longOk = longResult.status === 'fulfilled';

    return NextResponse.json({
      success: shortOk && longOk,
      short: shortOk
        ? { success: true, data: shortResult.value }
        : { success: false, error: (shortResult.reason as Error).message },
      long: longOk
        ? { success: true, data: longResult.value }
        : { success: false, error: (longResult.reason as Error).message },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
