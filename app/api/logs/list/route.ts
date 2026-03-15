import { NextRequest, NextResponse } from 'next/server';
import { readLogs, listDates } from '@/lib/fileLogger';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || undefined;
  const listOnly = url.searchParams.get('list') === 'true';

  if (listOnly) {
    return NextResponse.json({ success: true, dates: listDates('logs') });
  }

  const entries = readLogs(date);
  return NextResponse.json({ success: true, date: date || 'today', count: entries.length, entries });
}
