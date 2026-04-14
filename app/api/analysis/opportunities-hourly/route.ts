import { NextRequest, NextResponse } from 'next/server';
import {
  listOpportunityHourlySnapshotKeys,
  readOpportunityHourlySnapshots,
  type OpportunitySnapshotSource,
} from '@/lib/analysisLogger';

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSource(value: string | null): OpportunitySnapshotSource | null {
  if (!value || value === 'all') return null;
  if (value === 'api_funding_rates') return value;
  if (value === 'server_scheduler') return value;
  if (value === 'server_sim_scheduler') return value;
  return null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rawSource = url.searchParams.get('source');
  const source = parseSource(rawSource);
  if (rawSource && rawSource !== 'all' && !source) {
    return NextResponse.json(
      { success: false, error: 'Invalid source (all|api_funding_rates|server_scheduler|server_sim_scheduler)' },
      { status: 400 },
    );
  }

  const listOnly = url.searchParams.get('list') === 'true';
  const from = parseTimestamp(url.searchParams.get('from'));
  const to = parseTimestamp(url.searchParams.get('to'));
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : null;

  if (listOnly) {
    return NextResponse.json({
      success: true,
      source: source ?? 'all',
      keys: listOpportunityHourlySnapshotKeys(source ?? undefined),
    });
  }

  const snapshots = readOpportunityHourlySnapshots({
    source: source ?? undefined,
    from,
    to,
    limit,
  });

  return NextResponse.json({
    success: true,
    source: source ?? 'all',
    count: snapshots.length,
    snapshots,
  });
}
