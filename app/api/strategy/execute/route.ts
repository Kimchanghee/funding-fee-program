import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, ApiConfig, ArbitrageOpportunity } from '@/lib/types';
import { openPosition, closePosition } from '@/lib/exchanges';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      opportunity: ArbitrageOpportunity;
      investmentUSDT: number;
      leverage: number;
      apiConfigs: Partial<Record<ExchangeId, ApiConfig>>;
    };

    const { opportunity, investmentUSDT, leverage, apiConfigs } = body;

    // Runtime validation
    if (!opportunity?.shortExchange || !opportunity?.longExchange || !opportunity?.shortSymbol || !opportunity?.longSymbol) {
      return NextResponse.json({ success: false, error: 'Invalid opportunity data' }, { status: 400 });
    }
    if (typeof investmentUSDT !== 'number' || investmentUSDT <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid investmentUSDT' }, { status: 400 });
    }
    if (typeof leverage !== 'number' || leverage < 1 || leverage > 125) {
      return NextResponse.json({ success: false, error: 'Invalid leverage' }, { status: 400 });
    }

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

    // Rollback: if one side succeeded but the other failed, close the successful side
    let rollbackError: string | undefined;
    if (shortOk && !longOk) {
      try {
        const shortData = shortResult.value;
        await closePosition(
          opportunity.shortExchange,
          shortConfig,
          opportunity.shortSymbol,
          'short',
          shortData.amount,
        );
        rollbackError = `롱 진입 실패 → 숏 포지션 롤백(청산) 완료`;
      } catch (rbErr) {
        rollbackError = `롱 진입 실패 + 숏 롤백 실패: ${(rbErr as Error).message} — 수동 청산 필요!`;
      }
    } else if (!shortOk && longOk) {
      try {
        const longData = longResult.value;
        await closePosition(
          opportunity.longExchange,
          longConfig,
          opportunity.longSymbol,
          'long',
          longData.amount,
        );
        rollbackError = `숏 진입 실패 → 롱 포지션 롤백(청산) 완료`;
      } catch (rbErr) {
        rollbackError = `숏 진입 실패 + 롱 롤백 실패: ${(rbErr as Error).message} — 수동 청산 필요!`;
      }
    }

    return NextResponse.json({
      success: shortOk && longOk,
      short: shortOk
        ? { success: true, data: shortResult.value }
        : { success: false, error: (shortResult.reason as Error).message },
      long: longOk
        ? { success: true, data: longResult.value }
        : { success: false, error: (longResult.reason as Error).message },
      rollback: rollbackError,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
