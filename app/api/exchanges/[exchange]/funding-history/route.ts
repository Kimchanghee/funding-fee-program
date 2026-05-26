import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    success: false,
    mode: 'sim-only',
    error: 'REAL funding history API has been removed. Use SIM trade history.',
  }, { status: 410 });
}
