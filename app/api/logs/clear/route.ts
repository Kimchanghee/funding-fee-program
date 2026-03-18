import { NextResponse } from 'next/server';
import { clearData } from '@/lib/fileLogger';

export async function DELETE() {
  try {
    const count = clearData('logs');
    return NextResponse.json({ success: true, cleared: count });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
