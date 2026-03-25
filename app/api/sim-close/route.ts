import { NextRequest, NextResponse } from 'next/server';
import { getServerSimScheduler } from '@/lib/serverSimScheduler';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { simId: string };
    if (typeof body.simId !== 'string' || !body.simId.trim()) {
      return NextResponse.json({ success: false, error: 'Invalid simId' }, { status: 400 });
    }

    const result = await getServerSimScheduler().closeManual(body.simId.trim());
    return NextResponse.json(result, { status: result.success ? 200 : 404 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
