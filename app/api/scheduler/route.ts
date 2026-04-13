import { NextRequest, NextResponse } from 'next/server';
import { getServerScheduler, type SchedulerConfig } from '@/lib/serverScheduler';
import {
  hasValidFeeOverrides,
  hasValidPaybackOverrides,
  hasValidTimingConfig,
  isExchangeOperable,
  sanitizeEnabledExchanges,
} from '@/lib/types';

export async function GET() {
  const scheduler = getServerScheduler();
  return NextResponse.json(scheduler.getStatus());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { action: string; config?: SchedulerConfig };
    const scheduler = getServerScheduler();

    const validateConfig = (config: SchedulerConfig) => {
      if (typeof config.investmentUSDT !== 'number' || config.investmentUSDT <= 0) {
        return 'Invalid investmentUSDT';
      }
      if (typeof config.leverage !== 'number' || config.leverage < 1 || config.leverage > 125) {
        return 'Invalid leverage';
      }
      if (typeof config.compoundInvesting !== 'boolean') {
        return 'Invalid compoundInvesting';
      }
      if (!Array.isArray(config.enabledExchanges) || config.enabledExchanges.length === 0) {
        return 'enabledExchanges required';
      }
      for (const ex of config.enabledExchanges) {
        if (!isExchangeOperable(ex)) {
          return `Unsupported exchange: ${ex}`;
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
    };

    if (body.action === 'start' || body.action === 'update') {
      if (!body.config) {
        return NextResponse.json({ success: false, error: 'config required' }, { status: 400 });
      }
      const config: SchedulerConfig = {
        ...body.config,
        enabledExchanges: sanitizeEnabledExchanges(body.config.enabledExchanges),
      };
      const error = validateConfig(config);
      if (error) {
        return NextResponse.json({ success: false, error }, { status: 400 });
      }

      if (body.action === 'start') {
        scheduler.start(config);
      } else {
        scheduler.updateConfig(config);
      }
      return NextResponse.json({ success: true, status: scheduler.getStatus() });
    }

    if (body.action === 'stop') {
      scheduler.stop();
      return NextResponse.json({ success: true, status: scheduler.getStatus() });
    }

    return NextResponse.json({ success: false, error: 'Invalid action (start|update|stop)' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
