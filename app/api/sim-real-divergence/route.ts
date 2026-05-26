import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    success: false,
    mode: 'sim-only',
    error: 'SIM/REAL divergence analysis has been removed because REAL mode is disabled.',
  }, { status: 410 });
}
