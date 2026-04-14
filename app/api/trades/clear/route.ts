import { NextResponse } from 'next/server';
import { clearData } from '@/lib/fileLogger';

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const includeExecutedTrades = url.searchParams.get('includeExecuted') === 'true';
    const includeFundingReceipts = url.searchParams.get('includeFundingReceipts') === 'true';
    const count = clearData('trades', {
      includeExecutedTrades,
      includeFundingReceipts,
    });
    return NextResponse.json({
      success: true,
      cleared: count,
      includeExecutedTrades,
      includeFundingReceipts,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
