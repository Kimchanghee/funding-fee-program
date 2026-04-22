import os from 'os';
import { getDataDir } from './dataDir';
import { getActiveLoggerDataDir, listDates, readTrades, type TradeEvent } from './fileLogger';

export type SchedulerRuntimeMode = 'real' | 'sim';

export interface SchedulerRuntimeIdentity {
  mode: SchedulerRuntimeMode;
  hostname: string;
  pid: number;
  cwd: string;
  dataDir: string;
  loggerDataDir: string;
  port: string | null;
  now: number;
}

export interface TradeWindowDiagnostics {
  windowHours: number;
  simulation: boolean;
  totalEvents: number;
  executedEvents: number;
  guardBlockEvents: number;
  guardBlockReasons: Record<string, number>;
  lastEventAt: number | null;
  lastExecutedAt: number | null;
  lastGuardBlockAt: number | null;
}

const EXECUTED_EVENT_TYPES = new Set<TradeEvent['type']>([
  'entry',
  'snipe_entry',
  'exit',
  'snipe_exit',
  'auto_exit',
  'funding',
  'snipe_complete',
]);

const DIAGNOSTIC_CACHE_TTL_MS = 2_000;
const MAX_TRADE_FILES_TO_SCAN = 4;

const diagnosticsCache = new Map<string, { at: number; value: TradeWindowDiagnostics }>();

function normalizeReason(reason?: string): string {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'unknown';
}

export function getSchedulerRuntimeIdentity(mode: SchedulerRuntimeMode): SchedulerRuntimeIdentity {
  return {
    mode,
    hostname: os.hostname(),
    pid: process.pid,
    cwd: process.cwd(),
    dataDir: getDataDir(),
    loggerDataDir: getActiveLoggerDataDir(),
    port: process.env.PORT?.trim() || null,
    now: Date.now(),
  };
}

export function getTradeWindowDiagnostics(options: {
  simulation: boolean;
  windowHours?: number;
  now?: number;
}): TradeWindowDiagnostics {
  const now = options.now ?? Date.now();
  const windowHours = Math.max(1, Math.floor(options.windowHours ?? 6));
  const cutoff = now - (windowHours * 60 * 60 * 1000);
  const cacheKey = `${options.simulation ? 'sim' : 'real'}:${windowHours}`;
  const cached = diagnosticsCache.get(cacheKey);
  if (cached && now - cached.at <= DIAGNOSTIC_CACHE_TTL_MS) {
    return cached.value;
  }

  let totalEvents = 0;
  let executedEvents = 0;
  let guardBlockEvents = 0;
  const guardBlockReasons: Record<string, number> = {};
  let lastEventAt: number | null = null;
  let lastExecutedAt: number | null = null;
  let lastGuardBlockAt: number | null = null;

  const tradeDates = listDates('trades').slice(0, MAX_TRADE_FILES_TO_SCAN);
  for (const date of tradeDates) {
    const events = readTrades(date);
    for (const event of events) {
      if (event.simulation !== options.simulation) continue;

      if (lastEventAt === null || event.timestamp > lastEventAt) {
        lastEventAt = event.timestamp;
      }
      if (event.type === 'guard_block' && (lastGuardBlockAt === null || event.timestamp > lastGuardBlockAt)) {
        lastGuardBlockAt = event.timestamp;
      }
      if (EXECUTED_EVENT_TYPES.has(event.type) && (lastExecutedAt === null || event.timestamp > lastExecutedAt)) {
        lastExecutedAt = event.timestamp;
      }

      if (event.timestamp < cutoff) break;

      totalEvents += 1;

      if (EXECUTED_EVENT_TYPES.has(event.type)) {
        executedEvents += 1;
      }

      if (event.type === 'guard_block') {
        guardBlockEvents += 1;
        const reason = normalizeReason(event.reason);
        guardBlockReasons[reason] = (guardBlockReasons[reason] ?? 0) + 1;
      }
    }
  }

  const result: TradeWindowDiagnostics = {
    windowHours,
    simulation: options.simulation,
    totalEvents,
    executedEvents,
    guardBlockEvents,
    guardBlockReasons,
    lastEventAt,
    lastExecutedAt,
    lastGuardBlockAt,
  };
  diagnosticsCache.set(cacheKey, { at: now, value: result });
  return result;
}
