import { NextRequest, NextResponse } from 'next/server';
import { loadSimAccountingFromTradeLogs } from '@/lib/simAccounting';

function parseTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const from = parseTimestamp(url.searchParams.get('from'));
  const to = parseTimestamp(url.searchParams.get('to'));

  const data = loadSimAccountingFromTradeLogs({ from, to });
  return NextResponse.json({ success: true, data });
}
