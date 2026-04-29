import { NextRequest, NextResponse } from 'next/server';
import { appendTrades, type TradeEvent } from '@/lib/fileLogger';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { events: TradeEvent[]; engineId?: string; eventSource?: string };
    if (!body.events || !Array.isArray(body.events)) {
      return NextResponse.json({ success: false, error: 'events array required' }, { status: 400 });
    }
    const result = appendTrades(body.events, {
      engineId: body.engineId ?? req.headers.get('x-trade-engine-id') ?? 'client-store',
      eventSource: body.eventSource ?? req.headers.get('x-trade-event-source') ?? 'api-trades-save',
    });
    return NextResponse.json({
      success: true,
      count: result.count,
      persistedAt: result.persistedAt,
      dataDir: result.dataDir,
      tradeFiles: result.tradeFiles,
      executedFiles: result.executedFiles,
      eventIds: result.events.map((event) => event.eventId),
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
