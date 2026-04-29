import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDataDir } from './dataDir';
import { EXECUTED_TRADE_EVENT_TYPES } from './tradeEvents';
import { formatDateYmd } from './timeFormat';

function getLegacyDataDir(): string | null {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!base) return null;
  return path.join(base, 'funding-fee-program', 'data');
}

function resolveLoggerDataDir(): string {
  const primary = getDataDir();
  if (process.env.FUNDING_FEE_DATA_DIR?.trim()) {
    return primary;
  }
  const hasPrimaryLogs = fs.existsSync(path.join(primary, 'logs')) || fs.existsSync(path.join(primary, 'trades'));
  if (hasPrimaryLogs) return primary;

  const legacy = getLegacyDataDir();
  if (!legacy) return primary;
  const hasLegacyLogs = fs.existsSync(path.join(legacy, 'logs')) || fs.existsSync(path.join(legacy, 'trades'));
  return hasLegacyLogs ? legacy : primary;
}

let cachedDataDir: string | null = null;

function getLoggerDataDir(): string {
  if (!cachedDataDir) {
    cachedDataDir = resolveLoggerDataDir();
  }
  return cachedDataDir;
}

export function getActiveLoggerDataDir(): string {
  return getLoggerDataDir();
}

function getLogsDir(): string {
  return path.join(getLoggerDataDir(), 'logs');
}

function getTradesDir(): string {
  return path.join(getLoggerDataDir(), 'trades');
}

export type ExecutedTradeScope = 'sim' | 'real';

function getExecutedTradesDir(scope: ExecutedTradeScope): string {
  return path.join(getLoggerDataDir(), 'trades-executed', scope);
}

function getFundingReceiptsDir(scope: ExecutedTradeScope): string {
  return path.join(getLoggerDataDir(), 'funding-receipts', scope);
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDateStr(ts?: number): string {
  const now = ts ?? Date.now();
  const formatted = formatDateYmd(now, { timeZone: 'Asia/Seoul' });
  return formatted === '-' ? new Date(now).toISOString().slice(0, 10) : formatted;
}

// Intentionally no automatic retention pruning.
// Historical logs/trades/receipts must remain accumulated unless explicitly cleared.

export interface FileLogEntry {
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  exchange?: string;
  detail?: string;
}

export interface TradeEvent {
  timestamp: number;
  type:
    | 'entry'
    | 'exit'
    | 'funding'
    | 'snipe_entry'
    | 'snipe_exit'
    | 'snipe_complete'
    | 'auto_exit'
    | 'error'
    | 'guard_block'
    | 'exit_failed'
    | 'schedule_probe';
  simulation: boolean;
  baseAsset?: string;
  shortExchange?: string;
  longExchange?: string;
  exchange?: string;
  side?: 'long' | 'short';
  symbol?: string;
  spread?: number;
  spreadPercent?: number;
  margin?: number;
  leverage?: number;
  notional?: number;
  netProfit?: number;
  perFunding?: number;
  totalRoundTripFees?: number;
  pairId?: string;
  entryFee?: number;
  exitFee?: number;
  fundingAmount?: number;
  fundingRate?: number;
  fundingCollected?: number | null;
  pnl?: number;
  pricePnl?: number;
  shortPrice?: number;
  longPrice?: number;
  exitPrice?: number;
  shortLiquidity?: string;
  longLiquidity?: string;
  liquidity?: string;
  success?: boolean;
  reason?: string;
  milestone?: string;
  timeToExecutionMs?: number;
  shortRate?: number;
  longRate?: number;
  hedgedNetSpreadPercent?: number;
  expectedNetProfit?: number;
  expectedRoiPercent?: number;
  probeShortBid?: number;
  probeShortAsk?: number;
  probeLongBid?: number;
  probeLongAsk?: number;
  probeShortMid?: number;
  probeLongMid?: number;
  probeBasisBps?: number;
  probeShortSpreadBps?: number;
  probeLongSpreadBps?: number;
  probeShortBidDepthUsd5?: number;
  probeShortAskDepthUsd5?: number;
  probeLongBidDepthUsd5?: number;
  probeLongAskDepthUsd5?: number;
  probeShortImbalance?: number;
  probeLongImbalance?: number;
  probeShortImpactBps?: number;
  probeLongImpactBps?: number;
  probeEntryCapacityUsd5?: number;
  probeExitCapacityUsd5?: number;
  probeShortMidMoveBps?: number;
  probeLongMidMoveBps?: number;
  probeBasisMoveBps?: number;
  analysis?: Record<string, unknown>;
  detail?: string;
  eventId?: string;
  engineId?: string;
  eventSource?: string;
  persistedAt?: number;
  persistedDataDir?: string;
  persistedTradeFile?: string;
  persistedExecutedFile?: string;
  persistedFundingReceiptFile?: string;
  executionLabel?: '[SIM]실체결' | '[REAL]실체결';
  executionScope?: ExecutedTradeScope;
}

const FUNDING_RECEIPT_EVENT_TYPES = new Set<TradeEvent['type']>(['funding']);

function normalizeTradeEvent(event: TradeEvent): TradeEvent {
  if (!EXECUTED_TRADE_EVENT_TYPES.has(event.type)) {
    return event;
  }
  return {
    ...event,
    executionLabel: event.simulation ? '[SIM]실체결' : '[REAL]실체결',
    executionScope: event.simulation ? 'sim' : 'real',
  };
}

export interface AppendTradesContext {
  engineId?: string;
  eventSource?: string;
}

export interface AppendTradesResult {
  count: number;
  persistedAt: number;
  dataDir: string;
  tradeFiles: string[];
  executedFiles: Partial<Record<ExecutedTradeScope, string[]>>;
  fundingReceiptFiles: Partial<Record<ExecutedTradeScope, string[]>>;
  events: TradeEvent[];
}

function stableTradeEventId(event: TradeEvent): string {
  const basis = {
    timestamp: event.timestamp,
    type: event.type,
    simulation: event.simulation,
    pairId: event.pairId,
    baseAsset: event.baseAsset,
    shortExchange: event.shortExchange,
    longExchange: event.longExchange,
    exchange: event.exchange,
    side: event.side,
    symbol: event.symbol,
    milestone: event.milestone,
    reason: event.reason,
  };
  const hash = createHash('sha1').update(JSON.stringify(basis)).digest('hex').slice(0, 20);
  return `trade_${hash}`;
}

function normalizeTradeEventForAppend(
  event: TradeEvent,
  context: AppendTradesContext | undefined,
  persistedAt: number,
  dataDir: string,
  tradesDir: string,
): TradeEvent {
  const dateStr = getDateStr(
    typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? event.timestamp
      : undefined,
  );
  const executionScope = EXECUTED_TRADE_EVENT_TYPES.has(event.type)
    ? (event.simulation ? 'sim' : 'real')
    : event.executionScope;
  const persistedTradeFile = path.join(tradesDir, `${dateStr}.jsonl`);
  const persistedExecutedFile = executionScope
    ? path.join(getExecutedTradesDir(executionScope), `${dateStr}.jsonl`)
    : undefined;
  const persistedFundingReceiptFile = executionScope && FUNDING_RECEIPT_EVENT_TYPES.has(event.type)
    ? path.join(getFundingReceiptsDir(executionScope), `${dateStr}.jsonl`)
    : undefined;
  const normalized: TradeEvent = normalizeTradeEvent({
    ...event,
    eventId: event.eventId ?? stableTradeEventId(event),
    engineId: event.engineId ?? context?.engineId ?? (event.simulation ? 'unknown-sim-engine' : 'unknown-real-engine'),
    eventSource: event.eventSource ?? context?.eventSource ?? 'unknown',
    persistedAt,
    persistedDataDir: dataDir,
    persistedTradeFile,
    persistedExecutedFile,
    persistedFundingReceiptFile,
  });

  if (!EXECUTED_TRADE_EVENT_TYPES.has(event.type)) {
    return normalized;
  }
  return {
    ...normalized,
    executionLabel: event.simulation ? '[SIM]실체결' : '[REAL]실체결',
    executionScope,
  };
}

function appendEventsToDailyFile(events: TradeEvent[], dir: string, dateStr: string): string | null {
  if (events.length === 0) return null;
  ensureDir(dir);
  const filePath = path.join(dir, `${dateStr}.jsonl`);
  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf-8');
  return filePath;
}

function appendEventsToDailyFiles(events: TradeEvent[], dir: string): string[] {
  if (events.length === 0) return [];
  const byDate = new Map<string, TradeEvent[]>();
  for (const event of events) {
    const dateStr = getDateStr(
      typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
        ? event.timestamp
        : undefined,
    );
    const rows = byDate.get(dateStr) ?? [];
    rows.push(event);
    byDate.set(dateStr, rows);
  }
  const files: string[] = [];
  for (const [dateStr, rows] of byDate.entries()) {
    const filePath = appendEventsToDailyFile(rows, dir, dateStr);
    if (filePath) files.push(filePath);
  }
  return files;
}

export function appendLogs(entries: FileLogEntry[]): void {
  if (entries.length === 0) return;
  try {
    const logsDir = getLogsDir();
    ensureDir(logsDir);
    const dateStr = getDateStr();
    const filePath = path.join(logsDir, `${dateStr}.jsonl`);
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf-8');
  } catch (err) {
    console.error('[fileLogger] appendLogs failed:', err);
  }
}

export function appendTrades(events: TradeEvent[], context?: AppendTradesContext): AppendTradesResult {
  const persistedAt = Date.now();
  const dataDir = getLoggerDataDir();
  if (events.length === 0) {
    return {
      count: 0,
      persistedAt,
      dataDir,
      tradeFiles: [],
      executedFiles: {},
      fundingReceiptFiles: {},
      events: [],
    };
  }
  try {
    const tradesDir = getTradesDir();
    const normalizedEvents = events.map((event) => normalizeTradeEventForAppend(
      event,
      context,
      persistedAt,
      dataDir,
      tradesDir,
    ));

    const tradeFiles = appendEventsToDailyFiles(normalizedEvents, tradesDir);
    const simExecutedFiles = appendEventsToDailyFiles(
      normalizedEvents.filter((event) => event.executionScope === 'sim'),
      getExecutedTradesDir('sim'),
    );
    const realExecutedFiles = appendEventsToDailyFiles(
      normalizedEvents.filter((event) => event.executionScope === 'real'),
      getExecutedTradesDir('real'),
    );
    const simFundingReceiptFiles = appendEventsToDailyFiles(
      normalizedEvents.filter(
        (event) => event.executionScope === 'sim' && FUNDING_RECEIPT_EVENT_TYPES.has(event.type),
      ),
      getFundingReceiptsDir('sim'),
    );
    const realFundingReceiptFiles = appendEventsToDailyFiles(
      normalizedEvents.filter(
        (event) => event.executionScope === 'real' && FUNDING_RECEIPT_EVENT_TYPES.has(event.type),
      ),
      getFundingReceiptsDir('real'),
    );
    return {
      count: normalizedEvents.length,
      persistedAt,
      dataDir,
      tradeFiles,
      executedFiles: {
        sim: simExecutedFiles,
        real: realExecutedFiles,
      },
      fundingReceiptFiles: {
        sim: simFundingReceiptFiles,
        real: realFundingReceiptFiles,
      },
      events: normalizedEvents,
    };
  } catch (err) {
    console.error('[fileLogger] appendTrades failed:', err);
    throw err;
  }
}

export function readLogs(dateStr?: string): FileLogEntry[] {
  try {
    const logsDir = getLogsDir();
    ensureDir(logsDir);
    const target = dateStr || getDateStr();
    const filePath = path.join(logsDir, `${target}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as FileLogEntry)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export function readTrades(dateStr?: string): TradeEvent[] {
  try {
    const tradesDir = getTradesDir();
    ensureDir(tradesDir);
    const target = dateStr || getDateStr();
    const filePath = path.join(tradesDir, `${target}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TradeEvent)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export function readExecutedTrades(scope: ExecutedTradeScope, dateStr?: string): TradeEvent[] {
  try {
    const tradesDir = getExecutedTradesDir(scope);
    ensureDir(tradesDir);
    const target = dateStr || getDateStr();
    const filePath = path.join(tradesDir, `${target}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TradeEvent)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export function readFundingReceipts(scope: ExecutedTradeScope, dateStr?: string): TradeEvent[] {
  try {
    const receiptsDir = getFundingReceiptsDir(scope);
    ensureDir(receiptsDir);
    const target = dateStr || getDateStr();
    const filePath = path.join(receiptsDir, `${target}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TradeEvent)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export type TradeHistoryScope = 'all' | 'sim' | 'real' | 'sim_executed' | 'real_executed';

function scopeSimulation(scope: TradeHistoryScope): boolean | null {
  if (scope === 'sim' || scope === 'sim_executed') return true;
  if (scope === 'real' || scope === 'real_executed') return false;
  return null;
}

function unionDates(...dateLists: string[][]): string[] {
  return Array.from(new Set(dateLists.flat()))
    .sort()
    .reverse();
}

function tradeEventDedupeKey(event: TradeEvent): string {
  return JSON.stringify(event);
}

function dedupeTradeEvents(events: TradeEvent[]): TradeEvent[] {
  const seen = new Set<string>();
  const deduped: TradeEvent[] = [];
  for (const event of events) {
    const key = tradeEventDedupeKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

export function listTradeHistoryDates(scope: TradeHistoryScope): string[] {
  const legacyDates = listDates('trades');
  if (scope === 'all') {
    return unionDates(
      legacyDates,
      listExecutedTradeDates('sim'),
      listExecutedTradeDates('real'),
    );
  }

  const executedScope: ExecutedTradeScope = scopeSimulation(scope) ? 'sim' : 'real';
  return unionDates(legacyDates, listExecutedTradeDates(executedScope));
}

export function readTradeHistory(scope: TradeHistoryScope, dateStr?: string): TradeEvent[] {
  if (scope === 'all') {
    return dedupeTradeEvents([
      ...readTrades(dateStr),
      ...readExecutedTrades('sim', dateStr),
      ...readExecutedTrades('real', dateStr),
    ]).sort((a, b) => b.timestamp - a.timestamp);
  }

  const simulation = scopeSimulation(scope);
  const executedScope: ExecutedTradeScope = simulation ? 'sim' : 'real';
  return dedupeTradeEvents([
    ...readTrades(dateStr).filter((event) => event.simulation === simulation),
    ...readExecutedTrades(executedScope, dateStr),
  ]).sort((a, b) => b.timestamp - a.timestamp);
}

export function clearData(
  type: 'logs' | 'trades',
  options?: {
    includeExecutedTrades?: boolean;
    includeFundingReceipts?: boolean;
  },
): number {
  try {
    const dir = type === 'logs' ? getLogsDir() : getTradesDir();
    ensureDir(dir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    for (const f of files) {
      fs.unlinkSync(path.join(dir, f));
    }
    let deleted = files.length;

    if (type === 'trades' && options?.includeExecutedTrades) {
      for (const scope of ['sim', 'real'] as const) {
        const executedDir = getExecutedTradesDir(scope);
        ensureDir(executedDir);
        const executedFiles = fs.readdirSync(executedDir).filter((f) => f.endsWith('.jsonl'));
        for (const file of executedFiles) {
          fs.unlinkSync(path.join(executedDir, file));
        }
        deleted += executedFiles.length;
      }
    }
    if (type === 'trades' && options?.includeFundingReceipts) {
      for (const scope of ['sim', 'real'] as const) {
        const receiptsDir = getFundingReceiptsDir(scope);
        ensureDir(receiptsDir);
        const receiptFiles = fs.readdirSync(receiptsDir).filter((f) => f.endsWith('.jsonl'));
        for (const file of receiptFiles) {
          fs.unlinkSync(path.join(receiptsDir, file));
        }
        deleted += receiptFiles.length;
      }
    }

    return deleted;
  } catch (err) {
    console.error(`[fileLogger] clearData(${type}) failed:`, err);
    return 0;
  }
}

export function listDates(type: 'logs' | 'trades'): string[] {
  try {
    const dir = type === 'logs' ? getLogsDir() : getTradesDir();
    ensureDir(dir);
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function listExecutedTradeDates(scope: ExecutedTradeScope): string[] {
  try {
    const dir = getExecutedTradesDir(scope);
    ensureDir(dir);
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function listFundingReceiptDates(scope: ExecutedTradeScope): string[] {
  try {
    const dir = getFundingReceiptsDir(scope);
    ensureDir(dir);
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
