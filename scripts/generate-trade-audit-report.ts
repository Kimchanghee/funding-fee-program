import fs from 'fs';
import path from 'path';
import { loadTradeEventsForAudit, summarizeTradeEvents, normalizeTradeBucket } from '../lib/tradeAudit';
import { getDataDir } from '../lib/dataDir';
import { getActiveLoggerDataDir } from '../lib/fileLogger';
import { loadServerSimState } from '../lib/serverSimState';
import type { TradeEvent } from '../lib/fileLogger';

interface PersistedSimSchedulerStateShape {
  active?: boolean;
  startedAt?: number | null;
  scheduledEntries?: Array<{
    opportunityId?: string;
    asset?: string;
    targetTime?: number;
    investmentUSDT?: number;
  }>;
}

function formatKst(timestamp: number | null | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '-';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp)).replace(' ', ' ');
}

function buildRouteTableLines(
  routes: ReturnType<typeof summarizeTradeEvents>['routeSummaries'],
): string[] {
  if (routes.length === 0) return ['- none'];
  return routes.slice(0, 10).map((route) => (
    `- \`${route.route}\`: count \`${route.count}\`, funding \`${route.fundingUSD.toFixed(4)}\`, pnl \`${route.pnlUSD.toFixed(4)}\``
  ));
}

function buildLatestEventLines(
  events: ReturnType<typeof summarizeTradeEvents>['latestEvents'],
): string[] {
  if (events.length === 0) return ['- none'];
  return events.slice(0, 10).map((event) => (
    `- \`${formatKst(event.timestamp)}\` \`${event.type}\` \`${event.route}\` sim=\`${event.simulation}\` funding=\`${event.fundingUSD.toFixed(4)}\` pnl=\`${event.pnlUSD.toFixed(4)}\``
  ));
}

async function main() {
  const now = new Date();
  const timestampLabel = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now).replace(/[ :]/g, '-');

  const { scannedDates, coveredDates, events } = loadTradeEventsForAudit();
  const summary = summarizeTradeEvents(events, {
    dates: coveredDates,
    scannedDates,
  });
  const currentSimState = loadServerSimState();
  const dataDir = getDataDir();
  const loggerDataDir = getActiveLoggerDataDir();
  const simSchedulerStatePath = path.join(dataDir, 'sim-scheduler-state.json');
  const simSchedulerState = fs.existsSync(simSchedulerStatePath)
    ? JSON.parse(fs.readFileSync(simSchedulerStatePath, 'utf8')) as PersistedSimSchedulerStateShape
    : null;

  const rawTypes = Object.entries(summary.rawTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `- \`${type}\`: \`${count}\``);
  const normalized = Object.entries(summary.normalizedCounts)
    .map(([bucket, count]) => `- \`${bucket}\`: \`${count}\``);

  const notes = [
    '- `snipe_entry` / `snipe_exit` are real trade events and must be counted as entry/exit.',
    '- `schedule_probe` / `guard_block` are diagnostics, not executed trades.',
    '- Current SIM PnL UI includes funding, unrealized PnL, and closed PnL together.',
    '- Trade log dates are UTC file names; event timestamps below are rendered in KST.',
    '- Trade files are read from the active fileLogger data dir; SIM state/scheduler state are read from `getDataDir()`.',
  ];

  const md = [
    '# Trade Audit',
    '',
    `- Generated (KST): \`${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)}\``,
    `- Trade log dates (UTC, covered): \`${summary.coverage.dates.join(', ') || 'none'}\``,
    `- Trade log dates (UTC, scanned): \`${summary.coverage.scannedDates.join(', ') || 'none'}\``,
    `- Trade data dir: \`${loggerDataDir}\``,
    `- SIM state dir: \`${dataDir}\``,
    `- Total events: \`${summary.coverage.totalEvents}\``,
    `- Simulation events: \`${summary.coverage.simulationEvents}\` | Real events: \`${summary.coverage.realEvents}\``,
    '',
    '## Normalized Counts',
    ...normalized,
    '',
    '## Raw Event Types',
    ...rawTypes,
    '',
    '## Realized Sums',
    `- Funding total: \`${summary.realized.fundingUSD.toFixed(4)}\``,
    `- Exit pnl total: \`${summary.realized.exitPnlUSD.toFixed(4)}\``,
    '',
    '## Current Server SIM State',
    `- Positions: \`${currentSimState?.simPositions.length ?? 0}\``,
    `- Funding history entries: \`${currentSimState?.fundingHistory.length ?? 0}\``,
    `- simTotalFundingEarned: \`${(currentSimState?.simTotalFundingEarned ?? 0).toFixed(4)}\``,
    `- simTotalClosedPnl: \`${(currentSimState?.simTotalClosedPnl ?? 0).toFixed(4)}\``,
    `- simTotalFees: \`${(currentSimState?.simTotalFees ?? 0).toFixed(4)}\``,
    '',
    '## Current SIM Scheduler State',
    `- Active: \`${simSchedulerState?.active ?? false}\``,
    `- StartedAt (KST): \`${formatKst(simSchedulerState?.startedAt ?? null)}\``,
    `- Scheduled entries: \`${simSchedulerState?.scheduledEntries?.length ?? 0}\``,
    ...(simSchedulerState?.scheduledEntries?.slice(0, 5).map((entry) => (
      `- \`${entry.opportunityId ?? 'n/a'}\` asset=\`${entry.asset ?? 'n/a'}\` target=\`${formatKst(entry.targetTime)}\` investment=\`${entry.investmentUSDT ?? 0}\``
    )) ?? ['- none']),
    '',
    '## Top Routes',
    ...buildRouteTableLines(summary.routeSummaries),
    '',
    '## Latest Events',
    ...buildLatestEventLines(summary.latestEvents),
    '',
    '## Notes',
    ...notes,
    '',
  ].join('\n');

  const docsPath = path.join(process.cwd(), 'docs', `trade-audit-${timestampLabel}.md`);
  const dataPath = path.join(process.cwd(), 'data', `trade-audit-${timestampLabel}.json`);
  fs.writeFileSync(docsPath, md, 'utf8');
  fs.writeFileSync(dataPath, JSON.stringify({
    summary,
    currentSimState,
    simSchedulerState,
    normalizedEventTypes: Object.fromEntries(
      Object.keys(summary.rawTypeCounts).map((type) => [type, normalizeTradeBucket(type as TradeEvent['type'])]),
    ),
  }, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify({ docsPath, dataPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
