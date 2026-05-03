import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from './dataDir';

/**
 * Append-only persistence of every Telegram message the server emits.
 *
 * Files
 * -----
 *  data/telegram/<YYYY-MM-DD>.jsonl   - one JSON record per line, KST-dated
 *  data/telegram/index.json           - light-weight rollup for quick scans
 *
 * Design notes
 * ------------
 *  - JSONL append happens AFTER the network call. Even if Telegram returns
 *    an error or times out, we still write a record with deliverySuccess=false
 *    so that "missing trades" can be cross-checked against attempted alerts.
 *  - All callers should funnel through `sendTelegramMessage` in
 *    lib/telegramServer.ts, which calls `appendTelegramArchive` itself.
 *    For backfill-from-historical-trade-events use `appendTelegramArchive`
 *    directly and set `synthetic: true`.
 *  - The index is recomputed incrementally on each append (cheap; the
 *    counts and per-symbol top-30 are tiny). Falls back to recomputation
 *    from disk if it gets out of sync with the JSONL files.
 */

export type TelegramArchiveKind =
  | 'entry'
  | 'exit'
  | 'snipe_complete'
  | 'funding'
  | 'transfer'
  | 'balance_warning'
  | 'error'
  | 'daily_summary'
  | 'watchdog'
  | 'manual'
  | 'other';

export interface TelegramArchiveStructured {
  expNet?: number;
  perFunding?: number;
  totalRoundTripFees?: number;
  totalReservesUSD?: number;
  realPnl?: number;
  totalFunding?: number;
  totalPricePnl?: number;
  totalFees?: number;
  fundingDelta?: number;
  pricePnlDelta?: number;
  margin?: number;
  notional?: number;
  leverage?: number;
  spreadPercent?: number;
  expectedRoiPercent?: number;
  realizedRoiPercent?: number;
  [key: string]: unknown;
}

export interface TelegramArchiveMetadata {
  kind?: TelegramArchiveKind;
  tradeId?: string;
  pairId?: string;
  symbol?: string;
  exchanges?: string;
  side?: 'long' | 'short' | string;
  fundingTime?: string;
  structured?: TelegramArchiveStructured;
  /** Set true for entries reconstructed from older trade events (no real send). */
  synthetic?: boolean;
}

export interface TelegramArchiveRecord extends TelegramArchiveMetadata {
  ts: string;            // ISO8601 in KST (with offset +09:00)
  tsUnix: number;        // UTC ms epoch
  messageId?: number;    // Telegram response message_id (when available)
  chatId: string;
  text: string;
  deliverySuccess: boolean;
  deliveryError?: string;
  buildSha?: string;
}

interface TelegramArchiveIndex {
  lastUpdated: string;          // ISO8601 KST
  totalMessages: number;
  totalSyntheticBackfilled: number;
  byKind: Record<string, number>;
  byDate: Record<string, number>;        // KST date -> count
  bySymbol: Record<string, number>;      // top 30 by count
  byDeliverySuccess: { ok: number; fail: number };
  firstSeen?: string;
  lastSeen?: string;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function ensureTelegramDir(): string {
  const dir = join(getDataDir(), 'telegram');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** KST-local YYYY-MM-DD given a UTC ms epoch. */
export function kstDateString(tsUnix: number): string {
  const kst = new Date(tsUnix + KST_OFFSET_MS);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** ISO8601 with explicit +09:00 offset (KST). */
export function kstIsoString(tsUnix: number): string {
  const kst = new Date(tsUnix + KST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = kst.getUTCFullYear();
  const mm = pad(kst.getUTCMonth() + 1);
  const dd = pad(kst.getUTCDate());
  const hh = pad(kst.getUTCHours());
  const mi = pad(kst.getUTCMinutes());
  const ss = pad(kst.getUTCSeconds());
  const ms = String(kst.getUTCMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}+09:00`;
}

let cachedBuildSha: string | null | undefined;
function resolveBuildSha(): string | undefined {
  if (cachedBuildSha !== undefined) return cachedBuildSha ?? undefined;
  const fromEnv = process.env.GIT_SHA || process.env.FUNDING_FEE_BUILD_SHA;
  if (fromEnv && fromEnv.trim().length > 0) {
    cachedBuildSha = fromEnv.trim();
    return cachedBuildSha;
  }
  // Best-effort: read .git/HEAD; falls back to undefined silently.
  try {
    // Skip in production deploys where standalone bundle may not include .git.
    const headPath = join(process.cwd(), '..', '..', '.git', 'HEAD');
    if (!existsSync(headPath)) {
      cachedBuildSha = null;
      return undefined;
    }
    const head = readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      const refPath = join(process.cwd(), '..', '..', '.git', ref);
      if (existsSync(refPath)) {
        cachedBuildSha = readFileSync(refPath, 'utf-8').trim().slice(0, 12);
        return cachedBuildSha ?? undefined;
      }
    } else if (/^[0-9a-f]{40}$/i.test(head)) {
      cachedBuildSha = head.slice(0, 12);
      return cachedBuildSha;
    }
  } catch {
    // Ignore — best-effort.
  }
  cachedBuildSha = null;
  return undefined;
}

function indexPath(): string {
  return join(ensureTelegramDir(), 'index.json');
}

function emptyIndex(): TelegramArchiveIndex {
  return {
    lastUpdated: kstIsoString(Date.now()),
    totalMessages: 0,
    totalSyntheticBackfilled: 0,
    byKind: {},
    byDate: {},
    bySymbol: {},
    byDeliverySuccess: { ok: 0, fail: 0 },
  };
}

export function loadTelegramArchiveIndex(): TelegramArchiveIndex {
  const file = indexPath();
  if (!existsSync(file)) return emptyIndex();
  try {
    const raw = readFileSync(file, 'utf-8');
    return JSON.parse(raw) as TelegramArchiveIndex;
  } catch {
    return emptyIndex();
  }
}

function updateIndexInPlace(index: TelegramArchiveIndex, record: TelegramArchiveRecord): void {
  const date = kstDateString(record.tsUnix);
  index.totalMessages += 1;
  if (record.synthetic) index.totalSyntheticBackfilled += 1;
  const kind = record.kind ?? 'other';
  index.byKind[kind] = (index.byKind[kind] ?? 0) + 1;
  index.byDate[date] = (index.byDate[date] ?? 0) + 1;
  if (record.symbol) {
    index.bySymbol[record.symbol] = (index.bySymbol[record.symbol] ?? 0) + 1;
  }
  if (record.deliverySuccess) {
    index.byDeliverySuccess.ok += 1;
  } else {
    index.byDeliverySuccess.fail += 1;
  }
  if (!index.firstSeen || record.ts < index.firstSeen) index.firstSeen = record.ts;
  if (!index.lastSeen || record.ts > index.lastSeen) index.lastSeen = record.ts;
  // Trim bySymbol to top 30.
  const symbols = Object.entries(index.bySymbol).sort((a, b) => b[1] - a[1]);
  if (symbols.length > 30) {
    index.bySymbol = Object.fromEntries(symbols.slice(0, 30));
  }
  index.lastUpdated = kstIsoString(Date.now());
}

function writeIndex(index: TelegramArchiveIndex): void {
  try {
    writeFileSync(indexPath(), JSON.stringify(index, null, 2), 'utf-8');
  } catch (err) {
    console.error('[telegramArchive] index write failed:', err);
  }
}

/**
 * Append a single message record. Never throws — callers should be able to
 * fire-and-forget without try/catch since archive failures must not break
 * actual Telegram delivery flow.
 */
export function appendTelegramArchive(record: Omit<TelegramArchiveRecord, 'ts' | 'tsUnix' | 'buildSha'> & {
  tsUnix?: number;
  buildSha?: string;
}): TelegramArchiveRecord | null {
  try {
    const tsUnix = record.tsUnix ?? Date.now();
    const full: TelegramArchiveRecord = {
      ...record,
      ts: kstIsoString(tsUnix),
      tsUnix,
      buildSha: record.buildSha ?? resolveBuildSha(),
    };
    const dir = ensureTelegramDir();
    const file = join(dir, `${kstDateString(tsUnix)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf-8');
    const idx = loadTelegramArchiveIndex();
    updateIndexInPlace(idx, full);
    writeIndex(idx);
    return full;
  } catch (err) {
    console.error('[telegramArchive] append failed:', err);
    return null;
  }
}

/**
 * Recompute the index by scanning every .jsonl file. O(N) over all archived
 * messages; intended for one-shot use after a backfill or when the index
 * gets corrupted. Cheap as long as N is in the thousands.
 */
export function rebuildTelegramArchiveIndex(): TelegramArchiveIndex {
  const dir = ensureTelegramDir();
  const index = emptyIndex();
  let files: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return index;
  }
  for (const name of files) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as TelegramArchiveRecord;
        updateIndexInPlace(index, rec);
      } catch {
        // skip malformed line
      }
    }
  }
  writeIndex(index);
  return index;
}
