import { NextResponse } from 'next/server';

const SIM_ONLY_STATUS = {
  success: false,
  mode: 'sim-only',
  configured: [],
  error: 'REAL API key storage has been removed. This app now runs simulation only.',
};

export async function GET() {
  return NextResponse.json(SIM_ONLY_STATUS, { status: 410 });
}

export async function POST() {
  return NextResponse.json(SIM_ONLY_STATUS, { status: 410 });
}

export async function DELETE() {
  return NextResponse.json(SIM_ONLY_STATUS, { status: 410 });
}
