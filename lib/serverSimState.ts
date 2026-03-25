import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  SUPPORTED_EXCHANGES,
  type ExchangeId,
  type FundingPayment,
  type SimPosition,
  type SimStateSnapshot,
} from './types';

const DATA_DIR = join(process.cwd(), 'data');
const SIM_STATE_FILE = join(DATA_DIR, 'sim-state.json');
const MAX_FUNDING_HISTORY = 500;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function buildExchangeNumberMap(
  values: Partial<Record<string, unknown>> | undefined,
): Record<ExchangeId, number> {
  const result = {} as Record<ExchangeId, number>;
  for (const exchange of SUPPORTED_EXCHANGES) {
    const raw = values?.[exchange];
    result[exchange] = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  }
  return result;
}

function sanitizeFundingHistory(history: unknown): FundingPayment[] {
  if (!Array.isArray(history)) return [];

  return history
    .filter((item): item is FundingPayment => {
      if (!item || typeof item !== 'object') return false;
      const payment = item as Record<string, unknown>;
      return SUPPORTED_EXCHANGES.includes(payment.exchange as ExchangeId)
        && typeof payment.symbol === 'string'
        && typeof payment.amount === 'number'
        && Number.isFinite(payment.amount)
        && typeof payment.rate === 'number'
        && Number.isFinite(payment.rate)
        && typeof payment.timestamp === 'number'
        && Number.isFinite(payment.timestamp)
        && (payment.side === 'long' || payment.side === 'short');
    })
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_FUNDING_HISTORY);
}

function sanitizeSimPositions(positions: unknown): SimPosition[] {
  if (!Array.isArray(positions)) return [];
  return positions.filter((position): position is SimPosition => {
    if (!position || typeof position !== 'object') return false;
    const candidate = position as Record<string, unknown>;
    return typeof candidate.simId === 'string'
      && SUPPORTED_EXCHANGES.includes(candidate.exchange as ExchangeId)
      && typeof candidate.symbol === 'string'
      && typeof candidate.displaySymbol === 'string'
      && typeof candidate.baseAsset === 'string'
      && (candidate.side === 'long' || candidate.side === 'short')
      && typeof candidate.size === 'number'
      && Number.isFinite(candidate.size)
      && typeof candidate.sizeUSD === 'number'
      && Number.isFinite(candidate.sizeUSD)
      && typeof candidate.entryPrice === 'number'
      && Number.isFinite(candidate.entryPrice)
      && typeof candidate.markPrice === 'number'
      && Number.isFinite(candidate.markPrice)
      && typeof candidate.leverage === 'number'
      && Number.isFinite(candidate.leverage)
      && typeof candidate.margin === 'number'
      && Number.isFinite(candidate.margin)
      && typeof candidate.unrealizedPnl === 'number'
      && Number.isFinite(candidate.unrealizedPnl)
      && typeof candidate.unrealizedPnlPercent === 'number'
      && Number.isFinite(candidate.unrealizedPnlPercent)
      && typeof candidate.liquidationPrice === 'number'
      && Number.isFinite(candidate.liquidationPrice)
      && typeof candidate.fundingRate === 'number'
      && Number.isFinite(candidate.fundingRate)
      && typeof candidate.openedAt === 'number'
      && Number.isFinite(candidate.openedAt)
      && typeof candidate.fundingCollected === 'number'
      && Number.isFinite(candidate.fundingCollected)
      && typeof candidate.spread === 'number'
      && Number.isFinite(candidate.spread)
      && typeof candidate.nextFundingTime === 'number'
      && Number.isFinite(candidate.nextFundingTime)
      && typeof candidate.entryFee === 'number'
      && Number.isFinite(candidate.entryFee);
  });
}

export function createDefaultSimState(
  enabledExchanges: ExchangeId[],
  investmentUSDT: number,
): SimStateSnapshot {
  const perExchange = Math.max(0, investmentUSDT * 2);
  const simBalances = {} as Record<ExchangeId, number>;
  const simInitialBalances = {} as Record<ExchangeId, number>;

  for (const exchange of SUPPORTED_EXCHANGES) {
    const balance = enabledExchanges.includes(exchange) ? perExchange : 0;
    simBalances[exchange] = balance;
    simInitialBalances[exchange] = balance;
  }

  return {
    simBalances,
    simInitialBalances,
    simPositions: [],
    simTotalFundingEarned: 0,
    simTotalTopUps: 0,
    simTotalFees: 0,
    simTotalClosedPnl: 0,
    simClosedPnlPerExchange: {},
    simClosedFeesPerExchange: {},
    fundingHistory: [],
    updatedAt: Date.now(),
  };
}

export function sanitizeSimStateSnapshot(raw: unknown): SimStateSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as Record<string, unknown>;

  return {
    simBalances: buildExchangeNumberMap(snapshot.simBalances as Partial<Record<string, unknown>> | undefined),
    simInitialBalances: buildExchangeNumberMap(snapshot.simInitialBalances as Partial<Record<string, unknown>> | undefined),
    simPositions: sanitizeSimPositions(snapshot.simPositions),
    simTotalFundingEarned: typeof snapshot.simTotalFundingEarned === 'number' && Number.isFinite(snapshot.simTotalFundingEarned)
      ? snapshot.simTotalFundingEarned
      : 0,
    simTotalTopUps: typeof snapshot.simTotalTopUps === 'number' && Number.isFinite(snapshot.simTotalTopUps)
      ? snapshot.simTotalTopUps
      : 0,
    simTotalFees: typeof snapshot.simTotalFees === 'number' && Number.isFinite(snapshot.simTotalFees)
      ? snapshot.simTotalFees
      : 0,
    simTotalClosedPnl: typeof snapshot.simTotalClosedPnl === 'number' && Number.isFinite(snapshot.simTotalClosedPnl)
      ? snapshot.simTotalClosedPnl
      : 0,
    simClosedPnlPerExchange: buildExchangeNumberMap(snapshot.simClosedPnlPerExchange as Partial<Record<string, unknown>> | undefined),
    simClosedFeesPerExchange: buildExchangeNumberMap(snapshot.simClosedFeesPerExchange as Partial<Record<string, unknown>> | undefined),
    fundingHistory: sanitizeFundingHistory(snapshot.fundingHistory),
    updatedAt: typeof snapshot.updatedAt === 'number' && Number.isFinite(snapshot.updatedAt)
      ? snapshot.updatedAt
      : Date.now(),
  };
}

export function loadServerSimState(): SimStateSnapshot | null {
  try {
    if (!existsSync(SIM_STATE_FILE)) return null;
    return sanitizeSimStateSnapshot(JSON.parse(readFileSync(SIM_STATE_FILE, 'utf-8')));
  } catch {
    return null;
  }
}

export function saveServerSimState(state: SimStateSnapshot): SimStateSnapshot {
  ensureDataDir();
  const normalized = sanitizeSimStateSnapshot(state) ?? state;
  const nextState: SimStateSnapshot = {
    ...normalized,
    updatedAt: Date.now(),
  };
  writeFileSync(SIM_STATE_FILE, JSON.stringify(nextState, null, 2), 'utf-8');
  return nextState;
}

export function getOrCreateServerSimState(
  enabledExchanges: ExchangeId[],
  investmentUSDT: number,
): SimStateSnapshot {
  const existing = loadServerSimState();
  if (existing) return existing;
  const created = createDefaultSimState(enabledExchanges, investmentUSDT);
  return saveServerSimState(created);
}

export function resetServerSimState(
  enabledExchanges: ExchangeId[],
  investmentUSDT: number,
): SimStateSnapshot {
  return saveServerSimState(createDefaultSimState(enabledExchanges, investmentUSDT));
}
