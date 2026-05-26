import { NextResponse } from 'next/server';

const SIM_ONLY_STATUS = {
  success: false,
  active: false,
  mode: 'sim-only',
  error: 'REAL scheduler has been removed. Use /api/sim-scheduler.',
};

export async function GET() {
  return NextResponse.json(SIM_ONLY_STATUS, { status: 410 });
}

export async function POST() {
  return NextResponse.json(SIM_ONLY_STATUS, { status: 410 });
}
