import { NextRequest, NextResponse } from 'next/server';
import { readTrades, listDates } from '@/lib/fileLogger';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || undefined;
  const listOnly = url.searchParams.get('list') === 'true';

  if (listOnly) {
    return NextResponse.json({ success: true, dates: listDates('trades') });
  }

  const events = readTrades(date);
  return NextResponse.json({ success: true, date: date || 'today', count: events.length, events });
}
