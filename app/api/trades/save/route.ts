import { NextRequest, NextResponse } from 'next/server';
import { appendTrades, type TradeEvent } from '@/lib/fileLogger';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { events: TradeEvent[] };
    if (!body.events || !Array.isArray(body.events)) {
      return NextResponse.json({ success: false, error: 'events array required' }, { status: 400 });
    }
    appendTrades(body.events);
    return NextResponse.json({ success: true, count: body.events.length });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
