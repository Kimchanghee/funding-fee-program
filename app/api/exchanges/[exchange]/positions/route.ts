import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    success: false,
    mode: 'sim-only',
    error: 'REAL positions API has been removed. Use simulation positions.',
  }, { status: 410 });
}
