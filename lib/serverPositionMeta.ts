import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ExchangeId, OrderLiquidity } from './types';
import { getDataDir } from './dataDir';

const DATA_DIR = getDataDir();
const META_FILE = join(DATA_DIR, 'real-position-meta.json');

export interface ServerRealPositionMeta {
  pairId: string;
  positionType: 'hedge_long' | 'hedge_short';
  openedAt: number;
  entryFee: number;
  entryOrderLiquidity: OrderLiquidity;
  entryFilledNotional: number;
}

export type ServerRealPositionMetaMap = Record<string, ServerRealPositionMeta>;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function makeServerPositionKey(
  exchange: ExchangeId | string,
  symbol: string,
  side: 'long' | 'short',
): string {
  return `${exchange}:${symbol}:${side}`;
}

export function loadAllServerPositionMeta(): ServerRealPositionMetaMap {
  if (!existsSync(META_FILE)) return {};
  try {
    return JSON.parse(readFileSync(META_FILE, 'utf-8')) as ServerRealPositionMetaMap;
  } catch {
    return {};
  }
}

function saveAllServerPositionMeta(meta: ServerRealPositionMetaMap): void {
  ensureDataDir();
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

export function upsertServerPositionMeta(
  entries: Array<{ key: string; meta: ServerRealPositionMeta }>,
): void {
  if (entries.length === 0) return;
  const current = loadAllServerPositionMeta();
  for (const entry of entries) {
    current[entry.key] = entry.meta;
  }
  saveAllServerPositionMeta(current);
}

export function removeServerPositionMeta(keys: string[]): void {
  if (keys.length === 0) return;
  const current = loadAllServerPositionMeta();
  let changed = false;
  for (const key of keys) {
    if (key in current) {
      delete current[key];
      changed = true;
    }
  }
  if (changed) {
    saveAllServerPositionMeta(current);
  }
}
