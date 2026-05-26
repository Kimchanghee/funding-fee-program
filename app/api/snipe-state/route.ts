import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import type { SnipeStateSnapshot } from '@/lib/types';
import { getDataDir } from '@/lib/dataDir';
import { getServerSimScheduler } from '@/lib/serverSimScheduler';

const STATE_FILE = path.join(getDataDir(), 'snipe-state.json');

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
    realSnipeActive: false,
    simulationMode: true,
    updatedAt: typeof raw?.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function ensureDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveSchedulerState() {
  const simActive = !!getServerSimScheduler().getStatus().active;
  return { simActive, realActive: false };
}

function reconcileWithRuntime(state: SnipeStateSnapshot) {
  try {
    const runtime = resolveSchedulerState();
    if (state.simSnipeActive === runtime.simActive && state.realSnipeActive === runtime.realActive) {
      return state;
    }
    return {
      ...state,
      simSnipeActive: runtime.simActive,
      realSnipeActive: runtime.realActive,
      updatedAt: Date.now(),
    };
  } catch {
    return state;
  }
}

export async function GET() {
  try {
    let data = buildDefaultState();
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      data = normalizeState(JSON.parse(raw) as Partial<SnipeStateSnapshot>);
    }
    const reconciled = reconcileWithRuntime(data);
    if (reconciled.updatedAt !== data.updatedAt
      || reconciled.simSnipeActive !== data.simSnipeActive
      || reconciled.realSnipeActive !== data.realSnipeActive
    ) {
      ensureDir();
      fs.writeFileSync(STATE_FILE, JSON.stringify(reconciled, null, 2));
    }
    return NextResponse.json({ success: true, data: reconciled });
  } catch {
    const fallback = reconcileWithRuntime(buildDefaultState());
    return NextResponse.json({ success: true, data: fallback });
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
    current.realSnipeActive = false;
    current.simulationMode = true;
    current.updatedAt = Date.now();

    fs.writeFileSync(STATE_FILE, JSON.stringify(current, null, 2));
    return NextResponse.json({ success: true, data: current });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
