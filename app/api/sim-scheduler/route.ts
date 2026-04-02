import { NextRequest, NextResponse } from 'next/server';
import { getServerSimScheduler, type ServerSimSchedulerConfig } from '@/lib/serverSimScheduler';
import { SUPPORTED_EXCHANGES, hasValidFeeOverrides, hasValidPaybackOverrides, hasValidTimingConfig, type ExchangeId } from '@/lib/types';

function validateConfig(config: ServerSimSchedulerConfig) {
  if (typeof config.investmentUSDT !== 'number' || config.investmentUSDT <= 0) {
    return 'Invalid investmentUSDT';
  }
  if (typeof config.leverage !== 'number' || config.leverage < 1 || config.leverage > 125) {
    return 'Invalid leverage';
  }
  if (typeof config.minSpreadPercent !== 'number' || !Number.isFinite(config.minSpreadPercent) || config.minSpreadPercent < 0) {
    return 'Invalid minSpreadPercent';
  }
  if (typeof config.compoundInvesting !== 'boolean') {
    return 'Invalid compoundInvesting';
  }
  if (!Array.isArray(config.enabledExchanges) || config.enabledExchanges.length === 0) {
    return 'enabledExchanges required';
  }
  for (const exchange of config.enabledExchanges) {
    if (!SUPPORTED_EXCHANGES.includes(exchange as ExchangeId)) {
      return `Unsupported exchange: ${exchange}`;
    }
  }
  if (!hasValidFeeOverrides(config.feeOverrides)) {
    return 'Invalid feeOverrides';
  }
  if (!hasValidPaybackOverrides(config.paybackOverrides)) {
    return 'Invalid paybackOverrides';
  }
  if (!hasValidTimingConfig(config.timingConfig)) {
    return 'Invalid timingConfig';
  }
  if (
    config.maxSlippagePercent !== undefined
    && (
      typeof config.maxSlippagePercent !== 'number'
      || !Number.isFinite(config.maxSlippagePercent)
      || config.maxSlippagePercent <= 0
      || config.maxSlippagePercent > 10
    )
  ) {
    return 'Invalid maxSlippagePercent (0, 10]';
  }
  if (
    config.minVolume24hUSD !== undefined
    && (
      typeof config.minVolume24hUSD !== 'number'
      || !Number.isFinite(config.minVolume24hUSD)
      || config.minVolume24hUSD < 0
    )
  ) {
    return 'Invalid minVolume24hUSD (>= 0)';
  }
  return null;
}

export async function GET() {
  return NextResponse.json(getServerSimScheduler().getStatus());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      action: 'start' | 'update' | 'stop';
      config?: ServerSimSchedulerConfig;
    };
    const scheduler = getServerSimScheduler();

    if (body.action === 'start' || body.action === 'update') {
      if (!body.config) {
        return NextResponse.json({ success: false, error: 'config required' }, { status: 400 });
      }
      const error = validateConfig(body.config);
      if (error) {
        return NextResponse.json({ success: false, error }, { status: 400 });
      }

      const status = body.action === 'start'
        ? await scheduler.start(body.config)
        : await scheduler.updateConfig(body.config);
      return NextResponse.json({ success: true, status });
    }

    if (body.action === 'stop') {
      const status = await scheduler.stop();
      return NextResponse.json({ success: true, status });
    }

    return NextResponse.json({ success: false, error: 'Invalid action (start|update|stop)' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
