import {
  listDates,
  readLogs,
  readTrades,
  type FileLogEntry,
  type TradeEvent,
} from '@/lib/fileLogger';
import type {
  RuntimeAuditCountItem,
  RuntimeAuditGuardSection,
  RuntimeAuditResult,
  RuntimeAuditSystemLogSection,
  RuntimeAuditTradeSection,
} from './types';

const EXECUTION_EVENT_TYPES = new Set<TradeEvent['type']>([
  'entry',
  'snipe_entry',
  'exit',
  'snipe_exit',
  'auto_exit',
  'funding',
  'snipe_complete',
]);

function toCountItems<K extends string>(items: K[]): RuntimeAuditCountItem[] {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item, (map.get(item) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function collectTradesInWindow(from: number, to: number): TradeEvent[] {
  const results: TradeEvent[] = [];
  const dates = listDates('trades');

  for (const date of dates) {
    const rows = readTrades(date);
    for (const row of rows) {
      const timestamp = normalizeTimestamp((row as { timestamp?: unknown }).timestamp);
      if (timestamp === null) continue;
      if (timestamp > to) continue;
      if (timestamp < from) continue;
      results.push({ ...row, timestamp });
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);
  return results;
}

function collectLogsInWindow(from: number, to: number): FileLogEntry[] {
  const results: FileLogEntry[] = [];
  const dates = listDates('logs');

  for (const date of dates) {
    const rows = readLogs(date);
    for (const row of rows) {
      const timestamp = normalizeTimestamp((row as { timestamp?: unknown }).timestamp);
      if (timestamp === null) continue;
      if (timestamp > to) continue;
      if (timestamp < from) continue;
      results.push({ ...row, timestamp });
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);
  return results;
}

function toModeKey(event: Pick<TradeEvent, 'simulation'>): string {
  return event.simulation ? 'sim' : 'real';
}

function buildTradeSection(events: TradeEvent[], sampleLimit: number): RuntimeAuditTradeSection {
  return {
    total: events.length,
    byType: toCountItems(events.map((event) => event.type)),
    byMode: toCountItems(events.map((event) => toModeKey(event))),
    latestAt: events.length > 0 ? events[0].timestamp : null,
    samples: events.slice(0, sampleLimit),
  };
}

function buildGuardSection(events: TradeEvent[], sampleLimit: number): RuntimeAuditGuardSection {
  return {
    total: events.length,
    byReason: toCountItems(events.map((event) => (event.reason?.trim() || 'unknown'))),
    byMode: toCountItems(events.map((event) => toModeKey(event))),
    latestAt: events.length > 0 ? events[0].timestamp : null,
    samples: events.slice(0, sampleLimit),
  };
}

function buildSystemLogSection(entries: FileLogEntry[], sampleLimit: number): RuntimeAuditSystemLogSection {
  return {
    total: entries.length,
    byLevel: toCountItems(entries.map((entry) => entry.level)),
    latestAt: entries.length > 0 ? entries[0].timestamp : null,
    samples: entries.slice(0, sampleLimit),
  };
}

export function buildRuntimeAuditReport(options?: {
  windowHours?: number;
  now?: number;
  sampleLimit?: number;
}): RuntimeAuditResult {
  const now = options?.now ?? Date.now();
  const hours = Math.max(1, Math.min(168, Math.floor(options?.windowHours ?? 24)));
  const sampleLimit = Math.max(1, Math.min(200, Math.floor(options?.sampleLimit ?? 30)));
  const from = now - (hours * 60 * 60 * 1000);

  const trades = collectTradesInWindow(from, now);
  const logs = collectLogsInWindow(from, now);

  const executionEvents = trades.filter((event) => EXECUTION_EVENT_TYPES.has(event.type));
  const guardBlocks = trades.filter((event) => event.type === 'guard_block');
  const nonExecutionTradeEvents = trades.filter((event) => (
    !EXECUTION_EVENT_TYPES.has(event.type) && event.type !== 'guard_block'
  ));

  return {
    window: {
      from,
      to: now,
      hours,
    },
    tradeEventsTotal: trades.length,
    execution: buildTradeSection(executionEvents, sampleLimit),
    guardBlocks: buildGuardSection(guardBlocks, sampleLimit),
    nonExecutionTradeEvents: buildTradeSection(nonExecutionTradeEvents, sampleLimit),
    systemLogs: buildSystemLogSection(logs, sampleLimit),
  };
}

