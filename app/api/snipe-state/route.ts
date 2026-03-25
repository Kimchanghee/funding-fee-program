import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import type { SnipeStateSnapshot } from '@/lib/types';

const STATE_FILE = path.join(process.cwd(), 'data', 'snipe-state.json');

function buildDefaultState(): SnipeStateSnapshot {
  return {
    simSnipeActive: false,
    realSnipeActive: false,
    simulationMode: true,
    updatedAt: Date.now(),
  };
}

function normalizeState(raw?: Partial<SnipeStateSnapshot> | null): SnipeStateSnapshot {
  return {
    simSnipeActive: typeof raw?.simSnipeActive === 'boolean' ? raw.simSnipeActive : false,
    realSnipeActive: typeof raw?.realSnipeActive === 'boolean' ? raw.realSnipeActive : false,
    simulationMode: typeof raw?.simulationMode === 'boolean' ? raw.simulationMode : true,
    updatedAt: typeof raw?.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function ensureDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export async function GET() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return NextResponse.json({ success: true, data: buildDefaultState() });
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const data = normalizeState(JSON.parse(raw) as Partial<SnipeStateSnapshot>);
    return NextResponse.json({ success: true, data });
  } catch {
    return NextResponse.json({ success: true, data: buildDefaultState() });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<SnipeStateSnapshot>;
    ensureDir();

    // Load existing state and merge
    let current = buildDefaultState();
    try {
      if (fs.existsSync(STATE_FILE)) {
        current = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<SnipeStateSnapshot>);
      }
    } catch { /* start fresh */ }

    if (typeof body.simSnipeActive === 'boolean') current.simSnipeActive = body.simSnipeActive;
    if (typeof body.realSnipeActive === 'boolean') current.realSnipeActive = body.realSnipeActive;
    if (typeof body.simulationMode === 'boolean') current.simulationMode = body.simulationMode;
    current.updatedAt = Date.now();

    fs.writeFileSync(STATE_FILE, JSON.stringify(current, null, 2));
    return NextResponse.json({ success: true, data: current });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
