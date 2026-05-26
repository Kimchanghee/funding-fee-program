import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    success: false,
    mode: 'sim-only',
    error: 'REAL balance API has been removed. Use simulation balances.',
  }, { status: 410 });
}
