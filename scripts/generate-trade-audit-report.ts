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
  const scheduleMilestones = Object.entries(summary.diagnostics.scheduleMilestones)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `- \`${key}\`: \`${count}\``);
  const scheduleReasons = Object.entries(summary.diagnostics.scheduleReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `- \`${key}\`: \`${count}\``);
  const guardReasons = Object.entries(summary.diagnostics.guardReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `- \`${key}\`: \`${count}\``);

  const notes = [
    '- `snipe_entry` / `snipe_exit` are real trade events and must be counted as entry/exit.',
    '- `schedule_probe` includes candidates, selected reservations, scheduled lifecycle, execute attempts, execute success/failure, and cancel-before-execute telemetry.',
    '- `guard_block` records why a planned or attempted entry did not proceed.',
    '- Current SIM PnL UI includes funding, unrealized PnL, and closed PnL together.',
    '- Trade log dates are KST file names based on each event timestamp; event timestamps below are rendered in KST.',
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
    `- Realized pnl total: \`${summary.realized.exitPnlUSD.toFixed(4)}\``,
    '',
    '## SIM / REAL Breakdown',
    `- SIM: events \`${summary.modeBreakdown.SIM.totalEvents}\`, entries \`${summary.modeBreakdown.SIM.entries}\`, exits \`${summary.modeBreakdown.SIM.exits}\`, completed \`${summary.modeBreakdown.SIM.completed}\`, schedule_probe \`${summary.modeBreakdown.SIM.scheduleProbes}\`, guard_block \`${summary.modeBreakdown.SIM.guardBlocks}\`, pnl \`${summary.modeBreakdown.SIM.pnlUSD.toFixed(4)}\`, funding \`${summary.modeBreakdown.SIM.fundingUSD.toFixed(4)}\`, fees \`${summary.modeBreakdown.SIM.feesUSD.toFixed(4)}\``,
    `- REAL: events \`${summary.modeBreakdown.REAL.totalEvents}\`, entries \`${summary.modeBreakdown.REAL.entries}\`, exits \`${summary.modeBreakdown.REAL.exits}\`, completed \`${summary.modeBreakdown.REAL.completed}\`, schedule_probe \`${summary.modeBreakdown.REAL.scheduleProbes}\`, guard_block \`${summary.modeBreakdown.REAL.guardBlocks}\`, pnl \`${summary.modeBreakdown.REAL.pnlUSD.toFixed(4)}\`, funding \`${summary.modeBreakdown.REAL.fundingUSD.toFixed(4)}\`, fees \`${summary.modeBreakdown.REAL.feesUSD.toFixed(4)}\``,
    '',
    '## Schedule Diagnostics',
    `- scheduled: \`${summary.diagnostics.scheduledCount}\``,
    `- selected candidates: \`${summary.diagnostics.selectedCandidateCount}\``,
    `- rejected candidates: \`${summary.diagnostics.rejectedCandidateCount}\``,
    `- execute / success / failed: \`${summary.diagnostics.executeCount}\` / \`${summary.diagnostics.executeSuccessCount}\` / \`${summary.diagnostics.executeFailedCount}\``,
    `- canceled before execute: \`${summary.diagnostics.canceledBeforeExecuteCount}\``,
    '',
    '### Schedule Milestones',
    ...(scheduleMilestones.length > 0 ? scheduleMilestones : ['- none']),
    '',
    '### Schedule Reasons',
    ...(scheduleReasons.length > 0 ? scheduleReasons : ['- none']),
    '',
    '### Guard Reasons',
    ...(guardReasons.length > 0 ? guardReasons : ['- none']),
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
