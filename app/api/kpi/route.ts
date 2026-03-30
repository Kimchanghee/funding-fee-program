import { NextResponse } from 'next/server';
import { computeKpi } from '@/lib/executionKpi';
import { getActiveStates, getCompletedStates } from '@/lib/executionState';

export async function GET() {
  try {
    const kpi = computeKpi();
    const activeStates = getActiveStates();
    const recentCompleted = getCompletedStates().slice(-20);

    return NextResponse.json({
      success: true,
      kpi,
      activeTradeCount: activeStates.length,
      recentCompleted: recentCompleted.map(s => ({
        tradeId: s.tradeId,
        asset: s.asset,
        outcome: s.outcome,
        orphanLegMs: s.orphanLegMs,
        fundingCaptured: s.fundingCaptured,
        duration: s.completedAt && s.startedAt ? s.completedAt - s.startedAt : null,
        phases: s.phaseHistory.length,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
