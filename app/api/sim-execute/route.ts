import { NextRequest, NextResponse } from 'next/server';
import { getServerSimScheduler } from '@/lib/serverSimScheduler';
import type { ArbitrageOpportunity } from '@/lib/types';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      opportunity: ArbitrageOpportunity;
      investmentUSDT: number;
    };

    if (!body.opportunity?.shortExchange || !body.opportunity?.longExchange) {
      return NextResponse.json({ success: false, error: 'Invalid opportunity' }, { status: 400 });
    }
    if (typeof body.investmentUSDT !== 'number' || body.investmentUSDT <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid investmentUSDT' }, { status: 400 });
    }

    const result = await getServerSimScheduler().executeManual(body.opportunity, body.investmentUSDT);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
