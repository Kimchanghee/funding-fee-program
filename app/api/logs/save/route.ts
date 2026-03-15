import { NextRequest, NextResponse } from 'next/server';
import { appendLogs, type FileLogEntry } from '@/lib/fileLogger';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { entries: FileLogEntry[] };
    if (!body.entries || !Array.isArray(body.entries)) {
      return NextResponse.json({ success: false, error: 'entries array required' }, { status: 400 });
    }
    appendLogs(body.entries);
    return NextResponse.json({ success: true, count: body.entries.length });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
