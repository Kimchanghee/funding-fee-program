import { NextRequest, NextResponse } from 'next/server';
import { getServerSimScheduler } from '@/lib/serverSimScheduler';
import { isExchangeOperable, sanitizeEnabledExchanges, type ExchangeId, type SimStateSnapshot } from '@/lib/types';

function validateEnabledExchanges(enabledExchanges: unknown): enabledExchanges is ExchangeId[] {
  return Array.isArray(enabledExchanges)
    && enabledExchanges.length > 0
    && enabledExchanges.every((exchange) => isExchangeOperable(exchange));
}

export async function GET() {
  const scheduler = getServerSimScheduler();
  return NextResponse.json({ success: true, data: scheduler.getStatus().state });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as
      | {
        action: 'reset' | 'reconfigure';
        enabledExchanges: ExchangeId[];
        investmentUSDT: number;
      }
      | {
        action: 'clearFundingHistory';
      }
      | {
        action: 'replace';
        state: SimStateSnapshot;
      };

    const scheduler = getServerSimScheduler();

    if (body.action === 'clearFundingHistory') {
      const data = await scheduler.clearFundingHistory();
      return NextResponse.json({ success: true, data });
    }

    if (body.action === 'replace') {
      const data = await scheduler.replaceState(body.state);
      return NextResponse.json({ success: true, data });
    }

    if (!validateEnabledExchanges(body.enabledExchanges)) {
      return NextResponse.json({ success: false, error: 'Invalid enabledExchanges' }, { status: 400 });
    }
    if (typeof body.investmentUSDT !== 'number' || body.investmentUSDT <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid investmentUSDT' }, { status: 400 });
    }

    const enabledExchanges = sanitizeEnabledExchanges(body.enabledExchanges);
    const data = body.action === 'reset'
      ? await scheduler.resetState(enabledExchanges, body.investmentUSDT)
      : await scheduler.reconfigureState(enabledExchanges, body.investmentUSDT);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json() as { enabledExchanges: ExchangeId[]; investmentUSDT: number };
    if (!validateEnabledExchanges(body.enabledExchanges)) {
      return NextResponse.json({ success: false, error: 'Invalid enabledExchanges' }, { status: 400 });
    }
    if (typeof body.investmentUSDT !== 'number' || body.investmentUSDT <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid investmentUSDT' }, { status: 400 });
    }

    const enabledExchanges = sanitizeEnabledExchanges(body.enabledExchanges);
    const data = await getServerSimScheduler().resetState(enabledExchanges, body.investmentUSDT);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
