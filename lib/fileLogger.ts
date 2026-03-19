import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const TRADES_DIR = path.join(DATA_DIR, 'trades');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDateStr(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Log entry (general application logs) ──
export interface FileLogEntry {
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  exchange?: string;
  detail?: string;
}

// ── Trade event (entry, exit, funding, error) ──
export interface TradeEvent {
  timestamp: number;
  type: 'entry' | 'exit' | 'funding' | 'snipe_entry' | 'snipe_exit' | 'snipe_complete' | 'auto_exit' | 'error' | 'guard_block' | 'shortonly_entry' | 'shortonly_exit';
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
  entryFee?: number;
  exitFee?: number;
  fundingAmount?: number;
  fundingRate?: number;
  pnl?: number;
  reason?: string;
  detail?: string;
}

/**
 * Append log entries to daily JSONL file.
 * File: data/logs/YYYY-MM-DD.jsonl
 */
export function appendLogs(entries: FileLogEntry[]): void {
  if (entries.length === 0) return;
  try {
    ensureDir(LOGS_DIR);
    const dateStr = getDateStr();
    const filePath = path.join(LOGS_DIR, `${dateStr}.jsonl`);
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf-8');
  } catch (err) {
    console.error('[fileLogger] appendLogs failed:', err);
  }
}

/**
 * Append trade events to daily JSONL file.
 * File: data/trades/YYYY-MM-DD.jsonl
 */
export function appendTrades(events: TradeEvent[]): void {
  if (events.length === 0) return;
  try {
    ensureDir(TRADES_DIR);
    const dateStr = getDateStr();
    const filePath = path.join(TRADES_DIR, `${dateStr}.jsonl`);
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf-8');
  } catch (err) {
    console.error('[fileLogger] appendTrades failed:', err);
  }
}

/**
 * Read logs for a specific date range.
 * Returns parsed entries sorted by timestamp desc.
 */
export function readLogs(dateStr?: string): FileLogEntry[] {
  try {
    ensureDir(LOGS_DIR);
    const target = dateStr || getDateStr();
    const filePath = path.join(LOGS_DIR, `${target}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as FileLogEntry)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/**
 * Read trade events for a specific date.
 */
export function readTrades(dateStr?: string): TradeEvent[] {
  try {
    ensureDir(TRADES_DIR);
    const target = dateStr || getDateStr();
    const filePath = path.join(TRADES_DIR, `${target}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as TradeEvent)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/**
 * Clear all files in a directory (logs or trades).
 */
export function clearData(type: 'logs' | 'trades'): number {
  try {
    const dir = type === 'logs' ? LOGS_DIR : TRADES_DIR;
    ensureDir(dir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      fs.unlinkSync(path.join(dir, f));
    }
    return files.length;
  } catch (err) {
    console.error(`[fileLogger] clearData(${type}) failed:`, err);
    return 0;
  }
}

/**
 * List available log/trade dates.
 */
export function listDates(type: 'logs' | 'trades'): string[] {
  try {
    const dir = type === 'logs' ? LOGS_DIR : TRADES_DIR;
    ensureDir(dir);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
