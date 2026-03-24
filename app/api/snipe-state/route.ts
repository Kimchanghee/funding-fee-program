import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(process.cwd(), 'data', 'snipe-state.json');

interface SnipeState {
  simSnipeActive: boolean;
  realSnipeActive: boolean;
  updatedAt: number;
}

function ensureDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export async function GET() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return NextResponse.json({ success: true, data: { simSnipeActive: false, realSnipeActive: false } });
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const data: SnipeState = JSON.parse(raw);
    return NextResponse.json({ success: true, data });
  } catch {
    return NextResponse.json({ success: true, data: { simSnipeActive: false, realSnipeActive: false } });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<SnipeState>;
    ensureDir();

    // Load existing state and merge
    let current: SnipeState = { simSnipeActive: false, realSnipeActive: false, updatedAt: Date.now() };
    try {
      if (fs.existsSync(STATE_FILE)) {
        current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch { /* start fresh */ }

    if (typeof body.simSnipeActive === 'boolean') current.simSnipeActive = body.simSnipeActive;
    if (typeof body.realSnipeActive === 'boolean') current.realSnipeActive = body.realSnipeActive;
    current.updatedAt = Date.now();

    fs.writeFileSync(STATE_FILE, JSON.stringify(current, null, 2));
    return NextResponse.json({ success: true, data: current });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
