import { NextRequest, NextResponse } from 'next/server';
import { getServerScheduler, type SchedulerConfig } from '@/lib/serverScheduler';
import type { ExchangeId, FeeOverrides } from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';

function hasValidFeeOverrides(overrides: unknown): overrides is FeeOverrides {
  if (overrides == null) return true;
  if (typeof overrides !== 'object') return false;

  for (const [exchange, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!SUPPORTED_EXCHANGES.includes(exchange as ExchangeId)) return false;
    if (!value || typeof value !== 'object') return false;

    const fees = value as Record<string, unknown>;
    if (typeof fees.maker !== 'number' || fees.maker < 0) return false;
    if (typeof fees.taker !== 'number' || fees.taker < 0) return false;
  }

  return true;
}

export async function GET() {
  const scheduler = getServerScheduler();
  return NextResponse.json(scheduler.getStatus());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { action: string; config?: SchedulerConfig };
    const scheduler = getServerScheduler();

    if (body.action === 'start') {
      if (!body.config) {
        return NextResponse.json({ success: false, error: 'config required' }, { status: 400 });
      }
      const { config } = body;

      // Validate
      if (typeof config.investmentUSDT !== 'number' || config.investmentUSDT <= 0) {
        return NextResponse.json({ success: false, error: 'Invalid investmentUSDT' }, { status: 400 });
      }
      if (typeof config.leverage !== 'number' || config.leverage < 1 || config.leverage > 125) {
        return NextResponse.json({ success: false, error: 'Invalid leverage' }, { status: 400 });
      }
      if (!Array.isArray(config.enabledExchanges) || config.enabledExchanges.length === 0) {
        return NextResponse.json({ success: false, error: 'enabledExchanges required' }, { status: 400 });
      }
      for (const ex of config.enabledExchanges) {
        if (!SUPPORTED_EXCHANGES.includes(ex as ExchangeId)) {
          return NextResponse.json({ success: false, error: `Unsupported exchange: ${ex}` }, { status: 400 });
        }
      }
      if (!hasValidFeeOverrides(config.feeOverrides)) {
        return NextResponse.json({ success: false, error: 'Invalid feeOverrides' }, { status: 400 });
      }

      scheduler.start(config);
      return NextResponse.json({ success: true, status: scheduler.getStatus() });
    }

    if (body.action === 'stop') {
      scheduler.stop();
      return NextResponse.json({ success: true, status: scheduler.getStatus() });
    }

    return NextResponse.json({ success: false, error: 'Invalid action (start|stop)' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
