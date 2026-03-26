import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
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
const SIM_STATE_BACKUP = join(DATA_DIR, 'sim-state.backup.json');
const SIM_STATE_TMP = join(DATA_DIR, 'sim-state.tmp.json');
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

/** 상태가 실질적 데이터를 갖고 있는지 (기본값이 아닌지) 판별 */
function hasRealData(state: SimStateSnapshot): boolean {
  return state.simPositions.length > 0
    || state.fundingHistory.length > 0
    || state.simTotalFundingEarned !== 0
    || state.simTotalFees !== 0
    || state.simTotalClosedPnl !== 0;
}

/** 파일 하나를 안전하게 파싱 시도 */
function tryLoadFile(filePath: string): SimStateSnapshot | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw || raw.trim().length === 0) return null;
    return sanitizeSimStateSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 서버 sim 상태 로드 — 메인 파일 실패 시 백업에서 복구
 */
export function loadServerSimState(): SimStateSnapshot | null {
  // 1) 메인 파일 시도
  const main = tryLoadFile(SIM_STATE_FILE);
  if (main) return main;

  // 2) 메인 실패 → 백업에서 복구
  const backup = tryLoadFile(SIM_STATE_BACKUP);
  if (backup) {
    // 백업이 유효하면 메인 파일로 복원
    try {
      ensureDataDir();
      writeFileSync(SIM_STATE_FILE, JSON.stringify(backup, null, 2), 'utf-8');
    } catch {
      // 복원 실패해도 메모리에는 반환
    }
    console.warn('[SimState] 메인 파일 손상 → 백업에서 복구됨');
    return backup;
  }

  return null;
}

/**
 * 서버 sim 상태 저장 — 원자적 쓰기 (tmp → rename) + 백업 유지
 */
export function saveServerSimState(state: SimStateSnapshot): SimStateSnapshot {
  ensureDataDir();
  const normalized = sanitizeSimStateSnapshot(state) ?? state;
  const nextState: SimStateSnapshot = {
    ...normalized,
    updatedAt: Date.now(),
  };
  const json = JSON.stringify(nextState, null, 2);

  try {
    // 1) 기존 메인 파일이 있고 실제 데이터가 있으면 백업
    const existingMain = tryLoadFile(SIM_STATE_FILE);
    if (existingMain && hasRealData(existingMain)) {
      try {
        writeFileSync(SIM_STATE_BACKUP, JSON.stringify(existingMain, null, 2), 'utf-8');
      } catch {
        // 백업 실패는 무시 — 메인 쓰기는 진행
      }
    }

    // 2) 원자적 쓰기: tmp 파일에 쓰고 rename (Windows: 기존 파일 삭제 필요)
    writeFileSync(SIM_STATE_TMP, json, 'utf-8');
    try { unlinkSync(SIM_STATE_FILE); } catch { /* may not exist */ }
    renameSync(SIM_STATE_TMP, SIM_STATE_FILE);
  } catch {
    // rename 실패 시 직접 쓰기 (fallback)
    try {
      writeFileSync(SIM_STATE_FILE, json, 'utf-8');
    } catch {
      // 최종 실패 — 데이터 유실 방지를 위해 최소한 tmp에라도 남김
    }
    // tmp 정리
    try { unlinkSync(SIM_STATE_TMP); } catch { /* ignore */ }
  }

  return nextState;
}

/**
 * 기존 상태 로드 또는 기본값 생성
 * ★ 기본값 생성 시 디스크에 저장하지 않음 — 실제 mutation 시에만 저장
 */
export function getOrCreateServerSimState(
  enabledExchanges: ExchangeId[],
  investmentUSDT: number,
): SimStateSnapshot {
  const existing = loadServerSimState();
  if (existing) return existing;
  // ★ 기본값은 메모리에만 반환 — 빈 상태가 디스크의 기존 데이터를 덮어쓰는 것을 방지
  return createDefaultSimState(enabledExchanges, investmentUSDT);
}

export function resetServerSimState(
  enabledExchanges: ExchangeId[],
  investmentUSDT: number,
): SimStateSnapshot {
  return saveServerSimState(createDefaultSimState(enabledExchanges, investmentUSDT));
}
