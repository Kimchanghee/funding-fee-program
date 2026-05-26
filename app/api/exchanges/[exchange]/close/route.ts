import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({
    success: false,
    mode: 'sim-only',
    error: 'REAL position close API has been removed. Use simulation only.',
  }, { status: 410 });
}
