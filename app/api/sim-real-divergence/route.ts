import { NextRequest, NextResponse } from 'next/server';
import { analyzeSimRealDivergence } from '@/lib/simRealDivergence';

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const report = analyzeSimRealDivergence({
      from: parseNumber(url.searchParams.get('from')),
      to: parseNumber(url.searchParams.get('to')),
      days: parseNumber(url.searchParams.get('days')),
      windowMs: parseNumber(url.searchParams.get('windowMs')),
      limit: parseNumber(url.searchParams.get('limit')),
    });

    return NextResponse.json({
      success: true,
      data: report,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'unknown error',
    }, { status: 500 });
  }
}
