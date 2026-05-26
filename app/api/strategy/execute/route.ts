import { NextResponse } from 'next/server';

const SIM_ONLY_STATUS = {
  success: false,
  mode: 'sim-only',
  error: 'REAL strategy execution has been removed. Use /api/sim-execute or /api/sim-scheduler.',
};

export async function POST() {
  return NextResponse.json(SIM_ONLY_STATUS, { status: 410 });
}
