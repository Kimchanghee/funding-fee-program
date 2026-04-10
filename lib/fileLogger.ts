import fs from 'fs';
import path from 'path';
import { getDataDir } from './dataDir';

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

function getLogsDir(): string {
  return path.join(getLoggerDataDir(), 'logs');
}

function getTradesDir(): string {
  return path.join(getLoggerDataDir(), 'trades');
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDateStr(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toISOString().slice(0, 10);
}

const LOG_RETENTION_DAYS = 7;

function pruneOldFiles(dir: string): void {
  try {
    ensureDir(dir);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - LOG_RETENTION_DAYS);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    for (const f of files) {
      const dateStr = f.replace('.jsonl', '');
      if (dateStr < cutoffStr) {
        fs.unlinkSync(path.join(dir, f));
        console.log(`[fileLogger] pruned old file: ${f}`);
      }
    }
  } catch (err) {
    console.error('[fileLogger] pruneOldFiles failed:', err);
  }
}

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
  detail?: string;
}

let lastPruneDate = '';

export function appendLogs(entries: FileLogEntry[]): void {
  if (entries.length === 0) return;
  try {
    const logsDir = getLogsDir();
    const tradesDir = getTradesDir();
    ensureDir(logsDir);
    const dateStr = getDateStr();
    const filePath = path.join(logsDir, `${dateStr}.jsonl`);
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf-8');
    if (dateStr !== lastPruneDate) {
      lastPruneDate = dateStr;
      pruneOldFiles(logsDir);
      pruneOldFiles(tradesDir);
    }
  } catch (err) {
    console.error('[fileLogger] appendLogs failed:', err);
  }
}

export function appendTrades(events: TradeEvent[]): void {
  if (events.length === 0) return;
  try {
    const logsDir = getLogsDir();
    const tradesDir = getTradesDir();
    ensureDir(tradesDir);
    const dateStr = getDateStr();
    const filePath = path.join(tradesDir, `${dateStr}.jsonl`);
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf-8');
    if (dateStr !== lastPruneDate) {
      lastPruneDate = dateStr;
      pruneOldFiles(logsDir);
      pruneOldFiles(tradesDir);
    }
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

export function clearData(type: 'logs' | 'trades'): number {
  try {
    const dir = type === 'logs' ? getLogsDir() : getTradesDir();
    ensureDir(dir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    for (const f of files) {
      fs.unlinkSync(path.join(dir, f));
    }
    return files.length;
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
