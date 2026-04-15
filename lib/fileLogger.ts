import fs from 'fs';
import path from 'path';
import { getDataDir } from './dataDir';
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

const LEGACY_LOG_REGEX = /^\[(.*?)\]\s+\[(INFO|SUCCESS|WARNING|ERROR)\]\s*(.*)$/i;

const INVALID_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]+/g;
const NON_ASCII_RE = /[^\u0000-\u007F]/;
const HIGH_BYTE_RE = /[\u0080-\u00FF]/;
const KOREAN_RE = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;

function hasUtf8MojibakeSymptoms(value: string): boolean {
  if (!HIGH_BYTE_RE.test(value)) return false;
  return !KOREAN_RE.test(value)
    || /�/.test(value)
    || /(Ã|â|ä|å|æ|ç|ë|î|ï|ô|ø|ú|û|ü|ÿ|Â|©|†|ƒ)/.test(value);
}

function tryRepairUtf8Mojibake(value: string): string {
  if (!value) return '';
  if (!NON_ASCII_RE.test(value)) return value;
  if (!hasUtf8MojibakeSymptoms(value)) return value;

  try {
    const latin1 = Buffer.from(value, 'latin1').toString('utf8');
    if (!latin1 || /\uFFFD/.test(latin1)) return value;

    const repairedKorCount = (latin1.match(KOREAN_RE) ?? []).length;
    const originalKorCount = (value.match(KOREAN_RE) ?? []).length;
    const hasMoreReadableKorean = repairedKorCount > 0 && repairedKorCount >= originalKorCount;
    if (!hasMoreReadableKorean) {
      const repairedHighByteCount = (latin1.match(HIGH_BYTE_RE) ?? []).length;
      const originalHighByteCount = (value.match(HIGH_BYTE_RE) ?? []).length;
      if (repairedHighByteCount >= originalHighByteCount) return value;
    }

    return latin1;
  } catch {
    return value;
  }
}

function normalizeText(value: unknown): string {
  if (value == null) return '';
  const repaired = tryRepairUtf8Mojibake(String(value));
  return repaired
    .replace(INVALID_CONTROL_CHARS_RE, '')
    .normalize('NFC')
    .replace(/\u0000/g, '')
    .replace(/\uFFFD+/g, '')
    .trim();
}

function normalizeLogLevel(value: unknown): FileLogEntry['level'] {
  if (value === 'success') return 'success';
  if (value === 'warning') return 'warning';
  if (value === 'error') return 'error';
  if (value === 'info') return 'info';
  return 'info';
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber)) return parsedNumber;
    const parsedDate = Date.parse(value.trim());
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return null;
}

function normalizeLegacyLogLine(line: string): FileLogEntry | null {
  const match = LEGACY_LOG_REGEX.exec(line);
  if (!match) return null;
  const [, tsText, levelText, messageText] = match;
  const timestamp = normalizeTimestamp(tsText);
  if (timestamp == null) return null;
  return {
    timestamp,
    level: normalizeLogLevel(levelText?.toLowerCase()),
    message: normalizeText(messageText),
  };
}

function normalizeFileLogEntry(raw: unknown): FileLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<FileLogEntry> & { timestamp?: unknown; level?: unknown; message?: unknown };
  const timestamp = normalizeTimestamp(record.timestamp);
  if (timestamp == null) return null;
  const level = normalizeLogLevel(typeof record.level === 'string' ? record.level.toLowerCase() : null);
  const message = normalizeText(record.message);
  if (!message) return null;
  return {
    timestamp,
    level,
    message,
    exchange: normalizeText(record.exchange) || undefined,
    detail: normalizeText(record.detail) || undefined,
  };
}

function parseJsonlFileLines<T>(
  filePath: string,
  normalize: (entry: unknown) => T | null,
  normalizeLegacy?: (line: string) => T | null,
): T[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [normalize(JSON.parse(line))];
      } catch {
        if (normalizeLegacy) {
          return [normalizeLegacy(line)];
        }
        return [null];
      }
    })
    .filter((entry): entry is T => entry !== null)
  .sort((a, b) => (typeof (b as { timestamp: number }).timestamp === 'number' && typeof (a as { timestamp: number }).timestamp === 'number')
      ? b.timestamp - a.timestamp
      : 0);
}

function normalizeTradeEvent(raw: unknown): TradeEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<TradeEvent> & { timestamp?: unknown };
  const timestamp = normalizeTimestamp(record.timestamp);
  if (timestamp == null) return null;
  return {
    ...(record as Omit<TradeEvent, 'timestamp'>),
    timestamp,
    type: typeof record.type === 'string' ? record.type as TradeEvent['type'] : 'error',
    simulation: record.simulation === true,
  };
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
  executionLabel?: '[SIM]' | '[REAL]';
  executionScope?: ExecutedTradeScope;
}

const EXECUTED_EVENT_TYPES = new Set<TradeEvent['type']>([
  'entry',
  'snipe_entry',
  'exit',
  'snipe_exit',
  'auto_exit',
  'funding',
  'snipe_complete',
  'guard_block',
  'schedule_probe',
]);
const FUNDING_RECEIPT_EVENT_TYPES = new Set<TradeEvent['type']>(['funding']);

function normalizeTradeEvent(event: TradeEvent): TradeEvent {
  if (!EXECUTED_EVENT_TYPES.has(event.type)) {
    return event;
  }
  return {
    ...event,
    executionLabel: event.simulation ? '[SIM]' : '[REAL]',
    executionScope: event.simulation ? 'sim' : 'real',
  };
}

function appendEventsToDailyFile(events: TradeEvent[], dir: string, dateStr: string): void {
  if (events.length === 0) return;
  ensureDir(dir);
  const filePath = path.join(dir, `${dateStr}.jsonl`);
  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf-8');
}

export function appendLogs(entries: FileLogEntry[]): void {
  if (entries.length === 0) return;
  try {
    const normalizedEntries = entries
      .map((entry) => normalizeFileLogEntry(entry))
      .filter((entry): entry is FileLogEntry => entry !== null);
    if (normalizedEntries.length === 0) return;
    const logsDir = getLogsDir();
    ensureDir(logsDir);
    const dateStr = getDateStr();
    const filePath = path.join(logsDir, `${dateStr}.jsonl`);
    const lines = normalizedEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf-8');
  } catch (err) {
    console.error('[fileLogger] appendLogs failed:', err);
  }
}

export function appendTrades(events: TradeEvent[]): void {
  if (events.length === 0) return;
  try {
    const tradesDir = getTradesDir();
    const dateStr = getDateStr();
    const normalizedEvents = events.map(normalizeTradeEvent);

    appendEventsToDailyFile(normalizedEvents, tradesDir, dateStr);
    appendEventsToDailyFile(
      normalizedEvents.filter((event) => event.executionScope === 'sim'),
      getExecutedTradesDir('sim'),
      dateStr,
    );
    appendEventsToDailyFile(
      normalizedEvents.filter((event) => event.executionScope === 'real'),
      getExecutedTradesDir('real'),
      dateStr,
    );
    appendEventsToDailyFile(
      normalizedEvents.filter(
        (event) => event.executionScope === 'sim' && FUNDING_RECEIPT_EVENT_TYPES.has(event.type),
      ),
      getFundingReceiptsDir('sim'),
      dateStr,
    );
    appendEventsToDailyFile(
      normalizedEvents.filter(
        (event) => event.executionScope === 'real' && FUNDING_RECEIPT_EVENT_TYPES.has(event.type),
      ),
      getFundingReceiptsDir('real'),
      dateStr,
    );
  } catch (err) {
    console.error('[fileLogger] appendTrades failed:', err);
  }
}

export function readLogs(dateStr?: string): FileLogEntry[] {
  try {
    const logsDir = getLogsDir();
    ensureDir(logsDir);
    const target = dateStr || getDateStr();
    const filePath = path.join(logsDir, `${target}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    return parseJsonlFileLines(filePath, normalizeFileLogEntry, normalizeLegacyLogLine);
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
    return parseJsonlFileLines<TradeEvent>(filePath, (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const record = raw as Partial<TradeEvent> & { timestamp?: unknown };
      const timestamp = normalizeTimestamp(record.timestamp);
      if (timestamp == null) return null;
      return {
        ...(record as Omit<TradeEvent, 'timestamp'>),
        timestamp,
        type: typeof record.type === 'string' ? record.type as TradeEvent['type'] : 'error',
        simulation: record.simulation === true,
      };
    });
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
    return parseJsonlFileLines<TradeEvent>(filePath, normalizeTradeEvent);
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
    return parseJsonlFileLines<TradeEvent>(filePath, (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const record = raw as Partial<TradeEvent> & { timestamp?: unknown };
      const timestamp = normalizeTimestamp(record.timestamp);
      if (timestamp == null) return null;
      return {
        ...(record as Omit<TradeEvent, 'timestamp'>),
        timestamp,
        type: typeof record.type === 'string' ? record.type as TradeEvent['type'] : 'funding',
        simulation: record.simulation === true,
      };
    });
  } catch {
    return [];
  }
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

