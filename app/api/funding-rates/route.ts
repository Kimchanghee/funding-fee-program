import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId } from '@/lib/types';
import { SUPPORTED_EXCHANGES, TRACKED_SYMBOLS } from '@/lib/types';
import { fetchFundingRates } from '@/lib/exchanges';
import { findOpportunities } from '@/lib/opportunities';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const exchangeParam = url.searchParams.get('exchanges');
  const exchanges = exchangeParam
    ? (exchangeParam.split(',') as ExchangeId[])
    : SUPPORTED_EXCHANGES;

  const symbols = TRACKED_SYMBOLS.map((b) => `${b}/USDT:USDT`);

  const results = await Promise.allSettled(
    exchanges.map((id) => fetchFundingRates(id, undefined, symbols)),
  );

  const allRates = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => (r as PromiseFulfilledResult<ReturnType<typeof fetchFundingRates> extends Promise<infer T> ? T : never>).value);

  const errors = results
    .filter((r) => r.status === 'rejected')
    .map((r, i) => ({
      exchange: exchanges[i],
      error: (r as PromiseRejectedResult).reason?.message,
    }));

  const opportunities = findOpportunities(allRates);

  return NextResponse.json({
    success: true,
    data: { rates: allRates, opportunities, errors },
    timestamp: Date.now(),
  });
}
