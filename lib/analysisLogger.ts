import fs from 'fs';
import path from 'path';
import { getDataDir } from './dataDir';
import type { ArbitrageOpportunity, ExchangeId, FundingRate } from './types';

const ANALYSIS_DIR = path.join(getDataDir(), 'analysis');
const OPPORTUNITY_HOURLY_DIR = path.join(ANALYSIS_DIR, 'opportunities-hourly');

export type OpportunitySnapshotSource =
  | 'api_funding_rates'
  | 'server_scheduler'
  | 'server_sim_scheduler';

export interface OpportunityHourlySnapshot {
  source: OpportunitySnapshotSource;
  hourKeyKST: string;
  firstCapturedAt: number;
  lastCapturedAt: number;
  captureCount: number;
  exchanges: ExchangeId[];
  rateCount: number;
  opportunityCount: number;
  topOpportunity:
    | {
      id: string;
      baseAsset: string;
      shortExchange: ExchangeId;
      longExchange: ExchangeId;
      spreadPercent: number;
      netProfit: number;
      nextFundingTime: number;
    }
    | null;
  rates: FundingRate[];
  opportunities: ArbitrageOpportunity[];
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function toKstHourKey(timestamp: number): string {
  // Convert to KST by offsetting then reading as UTC components.
  const kst = new Date(timestamp + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  const hour = String(kst.getUTCHours()).padStart(2, '0');
  return `${year}-${month}-${day}-${hour}`;
}

function getSourceDir(source: OpportunitySnapshotSource): string {
  return path.join(OPPORTUNITY_HOURLY_DIR, source);
}

function getHourlyFilePath(source: OpportunitySnapshotSource, hourKeyKST: string): string {
  return path.join(getSourceDir(source), `${hourKeyKST}.json`);
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function saveOpportunityHourlySnapshot(params: {
  source: OpportunitySnapshotSource;
  exchanges: ExchangeId[];
  rates: FundingRate[];
  opportunities: ArbitrageOpportunity[];
  capturedAt?: number;
}) {
  const capturedAt = params.capturedAt ?? Date.now();
  const hourKeyKST = toKstHourKey(capturedAt);
  const filePath = getHourlyFilePath(params.source, hourKeyKST);
  ensureDir(path.dirname(filePath));

  const prev = readJsonSafe<OpportunityHourlySnapshot>(filePath);
  const top = params.opportunities[0];

  const snapshot: OpportunityHourlySnapshot = {
    source: params.source,
    hourKeyKST,
    firstCapturedAt: prev?.firstCapturedAt ?? capturedAt,
    lastCapturedAt: capturedAt,
    captureCount: (prev?.captureCount ?? 0) + 1,
    exchanges: [...new Set(params.exchanges)],
    rateCount: params.rates.length,
    opportunityCount: params.opportunities.length,
    topOpportunity: top
      ? {
        id: top.id,
        baseAsset: top.baseAsset,
        shortExchange: top.shortExchange,
        longExchange: top.longExchange,
        spreadPercent: top.spreadPercent,
        netProfit: top.netProfit,
        nextFundingTime: top.nextFundingTime,
      }
      : null,
    rates: params.rates,
    opportunities: params.opportunities,
  };

  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

export function listOpportunityHourlySnapshotKeys(source?: OpportunitySnapshotSource): string[] {
  try {
    const sources: OpportunitySnapshotSource[] = source
      ? [source]
      : ['api_funding_rates', 'server_scheduler', 'server_sim_scheduler'];

    const keys: string[] = [];
    for (const src of sources) {
      const dir = getSourceDir(src);
      if (!fs.existsSync(dir)) continue;
      for (const filename of fs.readdirSync(dir)) {
        if (!filename.endsWith('.json')) continue;
        keys.push(`${src}/${filename.replace('.json', '')}`);
      }
    }
    return keys.sort().reverse();
  } catch {
    return [];
  }
}

export function readOpportunityHourlySnapshots(options?: {
  source?: OpportunitySnapshotSource;
  from?: number | null;
  to?: number | null;
  limit?: number | null;
}): OpportunityHourlySnapshot[] {
  try {
    const keys = listOpportunityHourlySnapshotKeys(options?.source);
    const parsed: OpportunityHourlySnapshot[] = [];
    for (const key of keys) {
      const [source, hourKey] = key.split('/');
      if (
        source !== 'api_funding_rates'
        && source !== 'server_scheduler'
        && source !== 'server_sim_scheduler'
      ) {
        continue;
      }
      const filePath = getHourlyFilePath(source, hourKey);
      const snapshot = readJsonSafe<OpportunityHourlySnapshot>(filePath);
      if (!snapshot) continue;
      if (options?.from != null && snapshot.lastCapturedAt < options.from) continue;
      if (options?.to != null && snapshot.lastCapturedAt > options.to) continue;
      parsed.push(snapshot);
      if (options?.limit != null && options.limit > 0 && parsed.length >= options.limit) {
        break;
      }
    }
    return parsed.sort((a, b) => b.lastCapturedAt - a.lastCapturedAt);
  } catch {
    return [];
  }
}
