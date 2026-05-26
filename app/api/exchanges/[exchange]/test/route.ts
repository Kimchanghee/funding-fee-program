import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({
    success: false,
    mode: 'sim-only',
    error: 'REAL exchange credential test API has been removed.',
  }, { status: 410 });
}
