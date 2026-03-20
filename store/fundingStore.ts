'use client';

import { create } from 'zustand';
import type {
  FundingRate,
  ArbitrageOpportunity,
  Position,
  SimPosition,
  Balance,
  ApiConfig,
  StrategyConfig,
  LogEntry,
  LogLevel,
  ExchangeId,
  FundingPayment,
} from '@/lib/types';
import { SUPPORTED_EXCHANGES } from '@/lib/types';
import { saveApiConfigs, loadApiConfigs, saveEnabledExchanges, loadEnabledExchanges, saveStrategyConfig, loadStrategyConfig, saveLogs, loadLogs, saveFundingHistory, loadFundingHistory, saveSimState, loadSimState, clearSimState } from '@/lib/keyStore';
import { estimateProfit, findOpportunities } from '@/lib/opportunities';
import { fmtNum } from '@/lib/format';

// ─────────────────────────────────────────────
// Fee constants
// ─────────────────────────────────────────────
const TAKER_FEE = 0.0005; // 0.05% per side
// 왕복 수수료: 진입(숏+롱) + 청산(숏+롱) = 4 × 0.05% = 0.2%
const ROUND_TRIP_FEE = TAKER_FEE * 4; // 0.002 (0.2%)
const ROUND_TRIP_FEE_PERCENT = ROUND_TRIP_FEE * 100; // 0.2%

function getEffectiveMinSpread(config: { minSpreadPercent: number }): number {
  return Math.max(config.minSpreadPercent, ROUND_TRIP_FEE_PERCENT);
}

// ─────────────────────────────────────────────
// State shape
// ─────────────────────────────────────────────
interface FundingState {
  // Data
  fundingRates: FundingRate[];
  opportunities: ArbitrageOpportunity[];
  positions: Position[];
  balances: Partial<Record<ExchangeId, Balance>>;
  logs: LogEntry[];
  fundingHistory: FundingPayment[];

  // Config
  apiConfigs: Partial<Record<ExchangeId, ApiConfig>>;
  strategyConfig: StrategyConfig;

  // Status
  isLoadingRates: boolean;
  isLoadingPositions: boolean;
  isLoadingHistory: boolean;
  strategyRunning: boolean;
  connectedExchanges: ExchangeId[];
  lastRatesUpdate: number | null;
  lastPositionsUpdate: number | null;
  ratesStatus: 'idle' | 'loading' | 'success' | 'error';
  ratesError: string | null;

  // Exchange toggle
  enabledExchanges: ExchangeId[];

  // Per-exchange fetch status
  exchangeFetchStatus: Partial<Record<ExchangeId, 'ok' | 'error' | 'loading'>>;
  exchangeFetchErrors: Partial<Record<ExchangeId, string>>;

  // Simulation (헷징 전용 잔고 풀)
  simulationMode: boolean;
  simBalances: Record<ExchangeId, number>;
  simPositions: SimPosition[];
  simTotalFundingEarned: number;
  simTotalTopUps: number;
  simTotalFees: number;

  // Snipe mode (코인별 독립 타이머)
  snipeActive: boolean;           // 사용자가 켠 상태 (반복 사이클 유지)
  snipeTargets: Record<string, number>;  // baseAsset → targetFundingTime
  _snipeTimers: Record<string, ReturnType<typeof setTimeout>>;      // baseAsset → 진입 타이머
  _snipeCloseTimers: Record<string, ReturnType<typeof setTimeout>>; // baseAsset → 청산 타이머

  // UI state
  showApiPanel: boolean;
  showStrategyPanel: boolean;
  rateFilter: string;
  exchangeFilter: ExchangeId[];
  positionToClose: Position | null;

  // Real orderbook spreads (keyed by baseAsset)
  realSpreads: Record<string, { effectiveSpread: number; shortSlippage: number; longSlippage: number; updatedAt: number }>;

  // Polling interval handles
  _ratesInterval: ReturnType<typeof setInterval> | null;
  _positionsInterval: ReturnType<typeof setInterval> | null;

  // Actions
  init: () => void;
  setApiConfig: (exchange: ExchangeId, config: ApiConfig) => void;
  removeApiConfig: (exchange: ExchangeId) => void;
  setStrategyConfig: (config: Partial<StrategyConfig>) => void;

  refreshRates: () => Promise<void>;
  refreshPositions: () => Promise<void>;
  refreshAndStampPositions: (baseAsset: string, exchanges: ExchangeId[]) => Promise<void>;
  refreshBalances: () => Promise<void>;
  refreshRealSpreads: () => Promise<void>;

  startPolling: () => void;
  stopPolling: () => void;

  executeStrategy: (opportunity: ArbitrageOpportunity) => Promise<boolean>;
  closePosition: (position: Position) => Promise<void>;
  testConnection: (exchange: ExchangeId) => Promise<boolean>;

  addLog: (level: LogLevel, message: string, exchange?: ExchangeId, detail?: string) => void;
  clearLogs: () => void;

  // Simulation actions
  toggleSimulationMode: () => void;
  resetSimulation: () => void;
  clearSimFundingHistory: () => void;
  closeSimPosition: (simId: string) => Promise<void>;
  tickSimFunding: () => void;

  // Snipe actions (코인별 독립 스나이핑)
  scheduleAllSnipes: () => void;
  scheduleSnipeForAsset: (opportunity: ArbitrageOpportunity) => void;
  cancelSnipe: () => void;
  cancelSnipeForAsset: (snipeKey: string) => void;
  _executeSnipeEntry: (opportunity: ArbitrageOpportunity, targetFundingTime: number) => void;
  _executeSnipeClose: (target: ArbitrageOpportunity) => Promise<void>;

  toggleExchange: (exchange: ExchangeId) => void;
  setShowApiPanel: (v: boolean) => void;
  setShowStrategyPanel: (v: boolean) => void;
  setRateFilter: (v: string) => void;
  setExchangeFilter: (v: ExchangeId[]) => void;
  setPositionToClose: (v: Position | null) => void;

  fetchFundingHistory: () => Promise<void>;
  redistributeBalances: () => void;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function makeApiHeaders(config: ApiConfig): Record<string, string> {
  const h: Record<string, string> = {
    'x-api-key': config.apiKey,
    'x-api-secret': config.secret,
    'Content-Type': 'application/json',
  };
  if (config.passphrase) h['x-api-passphrase'] = config.passphrase;
  return h;
}

let logCounter = 0;

function makeLog(level: LogLevel, message: string, exchange?: ExchangeId, detail?: string): LogEntry {
  return {
    id: `${Date.now()}-${++logCounter}`,
    timestamp: Date.now(),
    level,
    message,
    exchange,
    detail,
  };
}

// ─────────────────────────────────────────────
// File persistence: batch log/trade sending
// ─────────────────────────────────────────────
interface PendingLog {
  timestamp: number;
  level: string;
  message: string;
  exchange?: string;
  detail?: string;
}

interface PendingTrade {
  timestamp: number;
  type: string;
  simulation: boolean;
  [key: string]: unknown;
}

let logBatch: PendingLog[] = [];
let tradeBatch: PendingTrade[] = [];
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;
let tradeFlushTimer: ReturnType<typeof setTimeout> | null = null;

function queueLog(level: string, message: string, exchange?: string, detail?: string) {
  logBatch.push({ timestamp: Date.now(), level, message, exchange, detail });
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogs, 2000); // 2초마다 배치 전송
  }
}

function queueTrade(event: PendingTrade) {
  tradeBatch.push(event);
  if (!tradeFlushTimer) {
    tradeFlushTimer = setTimeout(flushTrades, 1000); // 거래는 1초마다 즉시 전송
  }
}

function flushLogs() {
  logFlushTimer = null;
  if (logBatch.length === 0) return;
  const entries = [...logBatch];
  logBatch = [];
  fetch('/api/logs/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  }).catch(() => { /* silent — don't break UI for log persistence */ });
}

function flushTrades() {
  tradeFlushTimer = null;
  if (tradeBatch.length === 0) return;
  const events = [...tradeBatch];
  tradeBatch = [];
  fetch('/api/trades/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  }).catch(() => { /* silent */ });
}

// ─────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────
export const useFundingStore = create<FundingState>((set, get) => ({
  fundingRates: [],
  opportunities: [],
  positions: [],
  balances: {},
  logs: [],
  apiConfigs: {},
  strategyConfig: {
    investmentUSDT: 1000,
    leverage: 5,
    minSpreadPercent: 0.25,
    autoExecute: false,
    compoundInvesting: true,
  },
  fundingHistory: [],
  simulationMode: true,
  simBalances: { binance: 700, bybit: 700, okx: 700, bitget: 700, gate: 700, bingx: 700 },
  simPositions: [],
  simTotalFundingEarned: 0,
  simTotalTopUps: 0,
  simTotalFees: 0,
  snipeActive: false,
  snipeTargets: {},
  _snipeTimers: {},
  _snipeCloseTimers: {},
  isLoadingRates: false,
  isLoadingPositions: false,
  isLoadingHistory: false,
  strategyRunning: false,
  connectedExchanges: [],
  lastRatesUpdate: null,
  lastPositionsUpdate: null,
  ratesStatus: 'idle',
  ratesError: null,
  enabledExchanges: [...SUPPORTED_EXCHANGES],
  exchangeFetchStatus: {},
  exchangeFetchErrors: {},
  showApiPanel: false,
  showStrategyPanel: false,
  rateFilter: '',
  exchangeFilter: [],
  positionToClose: null,
  realSpreads: {},
  _ratesInterval: null,
  _positionsInterval: null,

  // ── Init ──────────────────────────────────────
  init() {
    try {
      // React 18 Strict Mode / HMR에서 상태 초기화
      set({ isLoadingRates: false, snipeActive: false, snipeTargets: {}, _snipeTimers: {}, _snipeCloseTimers: {} });

      // ── 1회성 데이터 정리: 시뮬 초기화 (v3 마이그레이션) ──
      const MIGRATION_KEY = 'funding_fee_migration_v3';
      if (typeof window !== 'undefined' && !localStorage.getItem(MIGRATION_KEY)) {
        localStorage.removeItem('funding_fee_history');
        localStorage.removeItem('funding_fee_sim_state');
        localStorage.removeItem('funding_fee_logs');
        localStorage.setItem(MIGRATION_KEY, '1');
      }

      // 저장된 로그 & 펀딩 히스토리 복원 (HMR/새로고침에서도 유지)
      const savedLogs = loadLogs();
      const savedHistory = loadFundingHistory();
      if (savedLogs.length > 0) set({ logs: savedLogs });
      if (savedHistory !== null && savedHistory.length > 0) {
        set({ fundingHistory: savedHistory });
      } else if (savedHistory === null) {
        // localStorage에 키 자체가 없을 때만 서버에서 복원 (명시적 초기화 후엔 스킵)
        fetch('/api/trades/list?list=true').then(r => r.json()).then((res: { dates?: string[] }) => {
          if (!res.dates || res.dates.length === 0) return;
          // 최근 7일치 펀딩 기록 복원
          const dates = res.dates.slice(0, 7);
          Promise.all(dates.map(d => fetch(`/api/trades/list?date=${d}`).then(r => r.json()))).then(results => {
            const fundingRecords: FundingPayment[] = [];
            for (const res of results) {
              if (!res.events) continue;
              for (const e of res.events as Array<{ type: string; timestamp: number; exchange: string; symbol: string; fundingAmount: number; fundingRate: number; side: string; simulation: boolean }>) {
                if (e.type === 'funding' && e.simulation && e.fundingAmount && Math.abs(e.fundingAmount) > 0.0001) {
                  fundingRecords.push({
                    exchange: e.exchange as ExchangeId,
                    symbol: e.symbol || '',
                    amount: e.fundingAmount,
                    rate: e.fundingRate || 0,
                    timestamp: e.timestamp,
                    side: (e.side as 'long' | 'short') || 'long',
                  });
                }
              }
            }
            if (fundingRecords.length > 0) {
              fundingRecords.sort((a, b) => b.timestamp - a.timestamp);
              set({ fundingHistory: fundingRecords });
              saveFundingHistory(fundingRecords);
              get().addLog('info', `[복원] 로컬 파일에서 펀딩 수령 내역 ${fundingRecords.length}건 복원`);
            }
          });
        }).catch(() => { /* silent */ });
      }

      const saved = loadApiConfigs();
      set({ apiConfigs: saved });
      const connected = Object.keys(saved) as ExchangeId[];
      set({ connectedExchanges: connected });

      // 저장된 전략 설정 로드
      const savedStrategy = loadStrategyConfig();
      if (savedStrategy) {
        set({ strategyConfig: { ...get().strategyConfig, ...savedStrategy } });
      }

      // 저장된 거래소 ON/OFF 설정 로드
      const savedEnabled = loadEnabledExchanges();
      if (savedEnabled && savedEnabled.length > 0) {
        const valid = savedEnabled.filter(e => SUPPORTED_EXCHANGES.includes(e as ExchangeId)) as ExchangeId[];
        if (valid.length >= 2) {
          set({ enabledExchanges: valid });
        }
      }

      // 저장된 시뮬레이션 상태 복원 (잔고, 포지션, 누적 펀딩)
      const savedSim = loadSimState();
      if (savedSim) {
        set({
          simBalances: savedSim.simBalances as Record<ExchangeId, number>,
          simPositions: savedSim.simPositions,
          simTotalFundingEarned: savedSim.simTotalFundingEarned,
          simTotalTopUps: savedSim.simTotalTopUps ?? 0,
          simTotalFees: savedSim.simTotalFees ?? 0,
        });
      } else {
        // 최초 실행: 활성 거래소 기준으로 초기 잔고 설정
        const enabled = get().enabledExchanges;
        const perExchange = get().strategyConfig.investmentUSDT;
        const newBal = {} as Record<ExchangeId, number>;
        for (const ex of SUPPORTED_EXCHANGES) {
          newBal[ex] = enabled.includes(ex) ? perExchange : 0;
        }
        set({ simBalances: newBal });
      }

      const enabled = get().enabledExchanges;
      get().addLog('info', '펀딩피 프로그램 초기화 완료', undefined,
        `활성 거래소: ${enabled.map(e => e.toUpperCase()).join(', ')} (${enabled.length}개)`);
      set({ ratesStatus: 'loading' });
      get().refreshRates().catch((err) => {
        console.error('[init] refreshRates failed:', err);
        set({ ratesStatus: 'error', ratesError: (err as Error).message, isLoadingRates: false });
      });
      get().startPolling();
    } catch (err) {
      console.error('[init] 초기화 실패:', err);
      set({ ratesStatus: 'error', ratesError: `초기화 실패: ${(err as Error).message}`, isLoadingRates: false });
    }
  },

  // ── API config ────────────────────────────────
  setApiConfig(exchange, config) {
    const prev = get().apiConfigs;
    const next = { ...prev, [exchange]: config };
    set({ apiConfigs: next });
    saveApiConfigs(next);
    const connected = Object.keys(next) as ExchangeId[];
    set({ connectedExchanges: connected });
    get().addLog('success', `${exchange.toUpperCase()} API 키 저장됨`, exchange);
  },

  removeApiConfig(exchange) {
    const prev = get().apiConfigs;
    const next = { ...prev };
    delete next[exchange];
    set({ apiConfigs: next });
    saveApiConfigs(next);
    const connected = Object.keys(next) as ExchangeId[];
    set({ connectedExchanges: connected });
    get().addLog('warning', `${exchange.toUpperCase()} API 키 삭제됨`, exchange);
  },

  setStrategyConfig(config) {
    set((s) => {
      const next = { ...s.strategyConfig, ...config };
      saveStrategyConfig(next);

      // investmentUSDT 변경 시 시뮬 잔고는 건드리지 않음 (누적 펀딩 수익 보존)
      // 잔고 리셋은 resetSimulation()으로만 수행
      return { strategyConfig: next };
    });
  },

  // ── Refresh rates (거래소별 개별 비동기 — 응답 즉시 UI 업데이트) ──
  async refreshRates() {
    if (get().isLoadingRates) {
      console.log('[refreshRates] skip — already loading');
      return;
    }
    set({ isLoadingRates: true, ratesStatus: get().lastRatesUpdate ? get().ratesStatus : 'loading', ratesError: null });

    const enabled = get().enabledExchanges;
    console.log('[refreshRates] start:', enabled.join(','));

    // 비활성 거래소 데이터 제거 (OFF한 거래소가 기회 계산에 남는 것 방지)
    set(s => ({
      fundingRates: s.fundingRates.filter(r => enabled.includes(r.exchange)),
    }));

    // 거래소별 개별 fetch — 먼저 응답 오는 거래소부터 즉시 반영
    await Promise.allSettled(
      enabled.map(async (exchangeId) => {
        set(s => ({ exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'loading' } }));
        try {
          const res = await fetch(`/api/funding-rates?exchanges=${exchangeId}`, {
            signal: AbortSignal.timeout(30000),
          });
          const json = await res.json() as {
            success: boolean;
            error?: string;
            data: { rates: FundingRate[]; errors: { exchange: ExchangeId; error: string }[] };
            timestamp: number;
          };

          if (json.success && json.data.rates.length > 0) {
            console.log(`[refreshRates] ${exchangeId}: ${json.data.rates.length}개 수신`);
            // 이 거래소 데이터를 기존 데이터에 머지 → 즉시 기회 재계산
            try {
              set(s => {
                const otherRates = s.fundingRates.filter(r => r.exchange !== exchangeId);
                const merged = [...otherRates, ...json.data.rates];
                const { investmentUSDT, leverage } = s.strategyConfig;
                const opportunities = findOpportunities(merged, 20, investmentUSDT, leverage);

                // 시뮬 포지션 마크가격 업데이트
                let updatedSimPositions = s.simPositions;
                if (s.simPositions.length > 0) {
                  updatedSimPositions = s.simPositions.map(pos => {
                    if (pos.exchange !== exchangeId) return pos;
                    const liveRate = json.data.rates.find(r => r.symbol === pos.symbol);
                    if (!liveRate) return pos;
                    const mp = liveRate.markPrice || pos.markPrice;
                    const pricePnl = pos.side === 'short'
                      ? (pos.entryPrice - mp) * pos.size
                      : (mp - pos.entryPrice) * pos.size;
                    const pnl = pricePnl - (pos.entryFee ?? 0);
                    const margin = pos.margin || 1;
                    return { ...pos, markPrice: mp, unrealizedPnl: pnl, unrealizedPnlPercent: (pnl / margin) * 100, fundingRate: liveRate.rate };
                  });
                }

                return {
                  fundingRates: merged,
                  opportunities,
                  lastRatesUpdate: json.timestamp || Date.now(),
                  ratesStatus: 'success',
                  ratesError: null,
                  simPositions: updatedSimPositions,
                  exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'ok' },
                  exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: undefined },
                };
              });
            } catch (setErr) {
              console.error(`[refreshRates] ${exchangeId} set() 실패:`, setErr);
              // set() 실패해도 최소한 상태는 업데이트
              set({
                lastRatesUpdate: Date.now(),
                ratesStatus: 'success',
                exchangeFetchStatus: { ...get().exchangeFetchStatus, [exchangeId]: 'ok' },
              });
            }

            if (json.data.errors?.length > 0) {
              for (const e of json.data.errors) {
                get().addLog('warning', `${(e.exchange || '?').toUpperCase()} 펀딩률 오류`, e.exchange, e.error);
              }
            }
          } else {
            const errMsg = json.error || '데이터 없음';
            console.warn(`[refreshRates] ${exchangeId}: ${errMsg}`);
            set(s => ({
              exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'error' },
              exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: errMsg },
            }));
          }
        } catch (err) {
          console.error(`[refreshRates] ${exchangeId} fetch 실패:`, (err as Error).message);
          set(s => ({
            exchangeFetchStatus: { ...s.exchangeFetchStatus, [exchangeId]: 'error' },
            exchangeFetchErrors: { ...s.exchangeFetchErrors, [exchangeId]: (err as Error).message },
          }));
        }
      }),
    );

    // 모든 거래소 완료 후 — 이번 라운드에서 하나도 성공 못했으면 에러
    const anyOk = enabled.some(ex => get().exchangeFetchStatus[ex] === 'ok');
    console.log('[refreshRates] done — anyOk:', anyOk, 'lastUpdate:', get().lastRatesUpdate);
    if (!anyOk) {
      set({ ratesStatus: 'error', ratesError: '모든 거래소에서 데이터 조회 실패' });
      if (!get().lastRatesUpdate) {
        setTimeout(() => get().refreshRates(), 3000);
      }
    }
    set({ isLoadingRates: false });
  },

  // ── Refresh positions (활성 거래소만) ─────────────
  async refreshPositions() {
    const configs = get().apiConfigs;
    const enabled = get().enabledExchanges;
    const activeConfigs = (Object.entries(configs) as [ExchangeId, ApiConfig][])
      .filter(([exchange]) => enabled.includes(exchange));
    if (activeConfigs.length === 0) return;
    set({ isLoadingPositions: true });

    const allPositions: Position[] = [];

    await Promise.allSettled(
      activeConfigs.map(async ([exchange, config]) => {
        const res = await fetch(`/api/exchanges/${exchange}/positions`, {
          headers: makeApiHeaders(config),
        });
        const json = await res.json() as { success: boolean; data: Position[] };
        if (json.success && json.data) allPositions.push(...json.data);
      }),
    );

    // 기존 포지션의 positionType 보존 (exchange+symbol+side 기준 매칭)
    const prevPositions = get().positions;
    for (const pos of allPositions) {
      const prev = prevPositions.find(p =>
        p.exchange === pos.exchange && p.symbol === pos.symbol && p.side === pos.side,
      );
      if (prev && prev.positionType !== 'manual') {
        pos.positionType = prev.positionType;
        pos.openedAt = prev.openedAt;
      }
    }

    set({ positions: allPositions, isLoadingPositions: false, lastPositionsUpdate: Date.now() });
  },

  // refreshPositions 후 새로 생긴 포지션에만 positionType 세팅
  // (기존에 있던 manual 포지션은 건드리지 않음)
  async refreshAndStampPositions(baseAsset: string, exchanges: ExchangeId[]) {
    // refresh 전 기존 포지션 스냅샷 (exchange+symbol+side 키)
    const beforeKeys = new Set(
      get().positions.map(p => `${p.exchange}:${p.symbol}:${p.side}`),
    );
    await get().refreshPositions();
    set(s => {
      const updated = s.positions.map(p => {
        if (p.baseAsset !== baseAsset) return p;
        if (!exchanges.includes(p.exchange)) return p;
        if (p.positionType !== 'manual') return p; // 이미 타입이 있으면 유지
        // refresh 전에 이미 있던 포지션이면 스킵 (사용자 기존 포지션)
        const key = `${p.exchange}:${p.symbol}:${p.side}`;
        if (beforeKeys.has(key)) return p;
        // hedge: 숏/롱 구분
        return {
          ...p,
          positionType: (p.side === 'short' ? 'hedge_short' : 'hedge_long') as Position['positionType'],
        };
      });
      return { positions: updated };
    });
  },

  // ── Refresh balances (활성 거래소만) ──────────────
  async refreshBalances() {
    const configs = get().apiConfigs;
    const enabled = get().enabledExchanges;
    const activeConfigs = (Object.entries(configs) as [ExchangeId, ApiConfig][])
      .filter(([exchange]) => enabled.includes(exchange));
    if (activeConfigs.length === 0) return;

    const next: Partial<Record<ExchangeId, Balance>> = {};

    await Promise.allSettled(
      activeConfigs.map(async ([exchange, config]) => {
        const res = await fetch(`/api/exchanges/${exchange}/balance`, {
          headers: makeApiHeaders(config),
        });
        const json = await res.json() as { success: boolean; data: Balance };
        if (json.success) next[exchange] = json.data;
      }),
    );

    set({ balances: next });
  },

  // ── Refresh real orderbook spreads for scheduled coins ──
  async refreshRealSpreads() {
    const { snipeTargets, opportunities, strategyConfig, realSpreads } = get();
    const notional = strategyConfig.investmentUSDT * strategyConfig.leverage;
    const now = Date.now();
    const STALE_MS = 10_000;

    // Collect unique baseAssets from snipeTargets
    const uniqueAssets = new Set<string>();
    for (const key of Object.keys(snipeTargets)) {
      uniqueAssets.add(key);
    }
    if (uniqueAssets.size === 0) return;

    await Promise.allSettled(
      Array.from(uniqueAssets).map(async (baseAsset) => {
        // Skip if data is fresh
        const existing = realSpreads[baseAsset];
        if (existing && now - existing.updatedAt < STALE_MS) return;

        const opp = opportunities.find(o => o.baseAsset === baseAsset);
        if (!opp) return;

        const symbol = `${baseAsset}/USDT:USDT`;

        try {
          const [shortRes, longRes] = await Promise.all([
            fetch(`/api/exchanges/${opp.shortExchange}/orderbook?symbol=${encodeURIComponent(symbol)}&side=sell&notional=${notional}`),
            fetch(`/api/exchanges/${opp.longExchange}/orderbook?symbol=${encodeURIComponent(symbol)}&side=buy&notional=${notional}`),
          ]);
          const [shortJson, longJson] = await Promise.all([shortRes.json(), longRes.json()]) as [
            { success: boolean; slippagePercent: number },
            { success: boolean; slippagePercent: number },
          ];

          if (shortJson.success && longJson.success) {
            const shortSlippage = shortJson.slippagePercent;
            const longSlippage = longJson.slippagePercent;
            const effectiveSpread = opp.spreadPercent - shortSlippage - longSlippage;
            set(state => ({
              realSpreads: {
                ...state.realSpreads,
                [baseAsset]: { effectiveSpread, shortSlippage, longSlippage, updatedAt: Date.now() },
              },
            }));
          }
        } catch {
          // Silent — real spread just won't be shown
        }
      }),
    );
  },

  // ── Balance redistribution ────────────────────
  redistributeBalances() {
    const { simBalances, simPositions, enabledExchanges, strategyConfig } = get();
    const threshold = strategyConfig.investmentUSDT * 0.5;

    // Compute free balance (balance minus locked margin) per exchange
    const freeBalances: Partial<Record<ExchangeId, number>> = {};
    for (const ex of enabledExchanges) {
      const bal = simBalances[ex] ?? 0;
      const locked = simPositions.filter(p => p.exchange === ex).reduce((s, p) => s + p.margin, 0);
      freeBalances[ex] = Math.max(0, bal - locked);
    }

    // Find critically low exchanges (free balance below threshold)
    const lowExchanges = enabledExchanges.filter(ex => (freeBalances[ex] ?? 0) < threshold);
    if (lowExchanges.length === 0) return;

    // Equalize: transfer from highest-surplus donors toward average
    const avgFree = enabledExchanges.reduce((s, ex) => s + (freeBalances[ex] ?? 0), 0) / enabledExchanges.length;

    for (const target of lowExchanges) {
      const targetFree = freeBalances[target] ?? 0;
      const needed = avgFree - targetFree;
      if (needed <= 0) continue;

      // Donors: exchanges with free balance above average, sorted by surplus desc
      const donors = enabledExchanges
        .filter(ex => ex !== target && (freeBalances[ex] ?? 0) > avgFree)
        .sort((a, b) => (freeBalances[b] ?? 0) - (freeBalances[a] ?? 0));

      let remaining = needed;
      for (const donor of donors) {
        if (remaining <= 0) break;
        const surplus = (freeBalances[donor] ?? 0) - avgFree;
        const transfer = Math.min(surplus, remaining);
        if (transfer <= 0) continue;

        set(s => ({
          simBalances: {
            ...s.simBalances,
            [donor]: (s.simBalances[donor] ?? 0) - transfer,
            [target]: (s.simBalances[target] ?? 0) + transfer,
          },
        }));
        freeBalances[donor] = (freeBalances[donor] ?? 0) - transfer;
        freeBalances[target] = (freeBalances[target] ?? 0) + transfer;
        remaining -= transfer;

        get().addLog('info',
          `[SIM] 잔고 재분배: ${donor.toUpperCase()} → ${target.toUpperCase()} $${fmtNum(transfer, 0)}`,
          target,
          `${donor.toUpperCase()} 여유잔고 → ${target.toUpperCase()} (임계값 $${fmtNum(threshold, 0)} 미만 감지)`,
        );
      }
    }
  },

  // ── Polling ───────────────────────────────────
  startPolling() {
    const s = get();
    if (s._ratesInterval) clearInterval(s._ratesInterval);
    if (s._positionsInterval) clearInterval(s._positionsInterval);

    // 첫 데이터가 아직 없으면 1초 후 즉시 재시도 (init 실패 보완)
    if (!get().lastRatesUpdate) {
      setTimeout(() => {
        if (!get().lastRatesUpdate) get().refreshRates();
      }, 1000);
    }

    // 8초 간격 펀딩률 폴링 (REST only, WS 없이 빠르게)
    const ratesInterval = setInterval(() => {
      get().refreshRates();
      if (get().snipeActive) {
        get().refreshRealSpreads();
      }
    }, 8_000);

    const positionsInterval = setInterval(() => {
      get().refreshPositions();
      get().refreshBalances();
      get().fetchFundingHistory();
      get().tickSimFunding();
      // 잔고 재분배: 잔고 부족 거래소에 여유 거래소에서 균등 분배
      if (get().simulationMode) {
        get().redistributeBalances();
      }
      // snipeActive → 아직 예약 안 된 코인들 자동 스케줄
      const st = get();
      const shouldAutoSnipe = st.snipeActive || st.strategyConfig.autoExecute;
      if (shouldAutoSnipe) {
        get().scheduleAllSnipes();
      }
    }, 15_000);

    set({ _ratesInterval: ratesInterval, _positionsInterval: positionsInterval });
  },

  stopPolling() {
    const { _ratesInterval, _positionsInterval, _snipeTimers, _snipeCloseTimers } = get();
    if (_ratesInterval) clearInterval(_ratesInterval);
    if (_positionsInterval) clearInterval(_positionsInterval);
    // 모든 코인별 스나이핑 타이머 정리
    for (const t of Object.values(_snipeTimers)) clearTimeout(t);
    for (const t of Object.values(_snipeCloseTimers)) clearTimeout(t);
    set({ _ratesInterval: null, _positionsInterval: null, _snipeTimers: {}, _snipeCloseTimers: {}, snipeTargets: {} });
    flushLogs();
    flushTrades();
  },

  // ── Execute strategy (hedge only) ─────────────
  async executeStrategy(opportunity) {
    const { apiConfigs, strategyConfig, simulationMode, simBalances, balances } = get();

    // Guard: spread check
    const effectiveMinSpread = getEffectiveMinSpread(strategyConfig);
    if (opportunity.spreadPercent < effectiveMinSpread) {
      get().addLog('warning',
        `스프레드 ${fmtNum(opportunity.spreadPercent, 4)}%가 최소 기준 ${effectiveMinSpread}% 미만 — 진입 스킵`,
        undefined,
        `${opportunity.baseAsset} ${opportunity.shortExchange}↔${opportunity.longExchange}`,
      );
      queueTrade({
        timestamp: Date.now(), type: 'guard_block', simulation: get().simulationMode,
        baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
        spreadPercent: opportunity.spreadPercent, reason: `스프레드 ${opportunity.spreadPercent.toFixed(4)}% < 최소 ${effectiveMinSpread}%`,
      });
      return false;
    }

    // Guard: 순수익 검증
    const notionalEst = (() => {
      if (!strategyConfig.compoundInvesting) return strategyConfig.investmentUSDT * strategyConfig.leverage;
      if (simulationMode) {
        return Math.min(
          (simBalances[opportunity.shortExchange] ?? 0) * 0.9,
          (simBalances[opportunity.longExchange] ?? 0) * 0.9,
        ) * strategyConfig.leverage;
      } else {
        return Math.min(
          (balances[opportunity.shortExchange]?.availableUSDT ?? 0) * 0.9,
          (balances[opportunity.longExchange]?.availableUSDT ?? 0) * 0.9,
        ) * strategyConfig.leverage;
      }
    })();
    const estFundingRevenue = notionalEst * opportunity.spread;
    const estTotalFees = notionalEst * ROUND_TRIP_FEE;
    if (estFundingRevenue <= estTotalFees) {
      get().addLog('warning',
        `[수익성 검증 실패] ${opportunity.baseAsset} 펀딩수익 $${fmtNum(estFundingRevenue)} ≤ 수수료 $${fmtNum(estTotalFees)} — 진입 스킵`,
        undefined,
        `스프레드: ${fmtNum(opportunity.spreadPercent, 4)}% | 필요 최소: ${ROUND_TRIP_FEE_PERCENT}%`,
      );
      queueTrade({
        timestamp: Date.now(), type: 'guard_block', simulation: get().simulationMode,
        baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
        spreadPercent: opportunity.spreadPercent, reason: `수익성 실패: 펀딩 $${estFundingRevenue.toFixed(2)} ≤ 수수료 $${estTotalFees.toFixed(2)}`,
      });
      return false;
    }

    // Guard: duplicate position — 같은 코인 중복 진입 방지
    if (simulationMode) {
      const existingPair = get().simPositions.find(p => p.baseAsset === opportunity.baseAsset);
      if (existingPair) {
        get().addLog('warning',
          `[SIM] ${opportunity.baseAsset} 이미 헷징 포지션 보유 중 — 중복 진입 스킵`,
          undefined,
          `기존 포지션: ${existingPair.side.toUpperCase()} @ ${existingPair.exchange.toUpperCase()}`,
        );
        return false;
      }
    }

    // ── Simulation branch ──────────────────────
    if (simulationMode) {
      const margin = strategyConfig.compoundInvesting
        ? Math.min(
            (simBalances[opportunity.shortExchange] ?? 0) * 0.9,
            (simBalances[opportunity.longExchange] ?? 0) * 0.9,
          )
        : strategyConfig.investmentUSDT;
      const leverage = strategyConfig.leverage;
      if (opportunity.shortMarkPrice <= 0 || opportunity.longMarkPrice <= 0) {
        get().addLog(
          'warning',
          `[SIM] ${opportunity.baseAsset} 진입 스킵: 유효하지 않은 마크가격`,
          undefined,
          `숏 ${opportunity.shortExchange.toUpperCase()}: ${opportunity.shortMarkPrice}, 롱 ${opportunity.longExchange.toUpperCase()}: ${opportunity.longMarkPrice}`,
        );
        return false;
      }
      const notional = margin * leverage;
      const entryFee = notional * TAKER_FEE;
      const totalCostPerSide = margin + entryFee;
      const { shortExchange, longExchange } = opportunity;

      // ── 잔고 부족 시 여유 거래소에서 내부 이체 (최소 $1,400 유지) ──
      const MIN_BALANCE = strategyConfig.investmentUSDT; // 거래소당 최소 유지 잔고
      const needsTransfer: { target: ExchangeId; needed: number }[] = [];
      for (const ex of [shortExchange, longExchange]) {
        const bal = simBalances[ex] ?? 0;
        if (bal < totalCostPerSide) {
          // 최소 유지 잔고 + 거래 비용 확보
          const needed = Math.max(totalCostPerSide - bal, MIN_BALANCE - bal);
          needsTransfer.push({ target: ex, needed });
        }
      }
      for (const { target, needed } of needsTransfer) {
        // 여유 거래소 찾기: 현재 포지션 마진 제외한 실 가용잔고가 최소잔고 이상인 거래소
        const currentBalances = get().simBalances;
        const currentPositions = get().simPositions;
        const donors = Object.entries(currentBalances)
          .filter(([exId]) => exId !== target)
          .map(([exId, bal]) => {
            const locked = currentPositions.filter(p => p.exchange === exId).reduce((s, p) => s + p.margin, 0);
            const available = bal - locked;
            return { exId: exId as ExchangeId, surplus: available - MIN_BALANCE };
          })
          .filter(d => d.surplus > 0)
          .sort((a, b) => b.surplus - a.surplus);

        let remaining = needed;
        for (const donor of donors) {
          if (remaining <= 0) break;
          const transfer = Math.min(donor.surplus, remaining);
          set(s => ({
            simBalances: {
              ...s.simBalances,
              [donor.exId]: (s.simBalances[donor.exId] ?? 0) - transfer,
              [target]: (s.simBalances[target] ?? 0) + transfer,
            },
          }));
          get().addLog('info',
            `[SIM] 내부 이체: ${donor.exId.toUpperCase()} → ${(target as string).toUpperCase()} $${fmtNum(transfer, 0)}`,
            target,
            `${donor.exId.toUpperCase()} 여유: $${fmtNum(donor.surplus, 0)} → 이체 후 ${(target as string).toUpperCase()} 잔고 확보`,
          );
          remaining -= transfer;
        }

        // 이체 후에도 여전히 부족하면 진입 스킵
        if (remaining > 0) {
          get().addLog('warning',
            `[SIM] ${opportunity.baseAsset} 진입 스킵: ${(target as string).toUpperCase()} 잔고 부족`,
            target,
            `필요: $${fmtNum(totalCostPerSide, 0)} | 가용: $${fmtNum((get().simBalances[target] ?? 0), 0)} | 이체 가능한 여유 거래소 없음`,
          );
          return false;
        }
      }

      // ── 실제 호가창 기반 체결가 계산 (슬리피지 반영) ──
      let shortFillPrice = opportunity.shortMarkPrice;
      let longFillPrice = opportunity.longMarkPrice;
      try {
        const [shortOB, longOB] = await Promise.all([
          fetch(`/api/exchanges/${shortExchange}/orderbook?symbol=${encodeURIComponent(opportunity.shortSymbol)}&side=sell&notional=${notional}`)
            .then(r => r.json()),
          fetch(`/api/exchanges/${longExchange}/orderbook?symbol=${encodeURIComponent(opportunity.longSymbol)}&side=buy&notional=${notional}`)
            .then(r => r.json()),
        ]);
        if (shortOB.success) {
          shortFillPrice = shortOB.fillPrice;
          get().addLog('info', `[SIM] ${opportunity.baseAsset} 숏 체결가: $${fmtNum(shortFillPrice, 2)} (슬리피지: ${fmtNum(shortOB.slippagePercent, 4)}%)`, shortExchange);
        }
        if (longOB.success) {
          longFillPrice = longOB.fillPrice;
          get().addLog('info', `[SIM] ${opportunity.baseAsset} 롱 체결가: $${fmtNum(longFillPrice, 2)} (슬리피지: ${fmtNum(longOB.slippagePercent, 4)}%)`, longExchange);
        }
      } catch (err) {
        get().addLog('warning', `[SIM] ${opportunity.baseAsset} 호가창 조회 실패 — 마크가격 사용`, undefined, (err as Error).message);
      }

      // ── 진입 갭 계산 및 롱 노셔널 조정 ──
      const entryGapPercent = ((shortFillPrice - longFillPrice) / ((shortFillPrice + longFillPrice) / 2)) * 100;
      get().addLog('info', `[SIM] ${opportunity.baseAsset} 진입 갭: ${entryGapPercent.toFixed(4)}% (숏:$${fmtNum(shortFillPrice, 2)} 롱:$${fmtNum(longFillPrice, 2)})`);
      // Gap > 0.1% → adjust long notional to equalize USD exposure
      let adjustedLongNotional = notional;
      if (Math.abs(entryGapPercent) > 0.1) {
        adjustedLongNotional = notional * (shortFillPrice / longFillPrice);
        get().addLog('info', `[SIM] ${opportunity.baseAsset} 롱 노셔널 조정: $${fmtNum(notional, 2)} → $${fmtNum(adjustedLongNotional, 2)} (갭 보정)`);
      }

      const ts = Date.now();
      const pairId = `pair-${ts}-${Math.random().toString(36).slice(2, 8)}`;
      const isSnipe = true;
      const shortPos: SimPosition = {
        simId: `sim-${ts}-short`,
        pairId,
        exchange: shortExchange,
        symbol: opportunity.shortSymbol,
        displaySymbol: `${opportunity.baseAsset}/USDT`,
        baseAsset: opportunity.baseAsset,
        side: 'short',
        size: notional / shortFillPrice,
        sizeUSD: notional,
        entryPrice: shortFillPrice,
        markPrice: opportunity.shortMarkPrice,
        leverage,
        margin,
        unrealizedPnl: -entryFee,
        unrealizedPnlPercent: (-entryFee / margin) * 100,
        liquidationPrice: shortFillPrice * (1 + (1 / leverage) * 0.9),
        fundingRate: opportunity.shortRate,
        openedAt: ts,
        positionType: 'hedge_short',
        fundingCollected: 0,
        spread: opportunity.spread,
        nextFundingTime: opportunity.nextFundingTime,
        isSnipe,
        fundingReceived: 0,
        entryFee,
        fundingIntervalMs: opportunity.fundingIntervalMs,
        entryGapPercent,
      };
      const longPos: SimPosition = {
        simId: `sim-${ts}-long`,
        pairId,
        exchange: longExchange,
        symbol: opportunity.longSymbol,
        displaySymbol: `${opportunity.baseAsset}/USDT`,
        baseAsset: opportunity.baseAsset,
        side: 'long',
        size: adjustedLongNotional / longFillPrice,
        sizeUSD: adjustedLongNotional,
        entryPrice: longFillPrice,
        markPrice: opportunity.longMarkPrice,
        leverage,
        margin,
        unrealizedPnl: -entryFee,
        unrealizedPnlPercent: (-entryFee / margin) * 100,
        liquidationPrice: longFillPrice * (1 - (1 / leverage) * 0.9),
        fundingRate: opportunity.longRate,
        openedAt: ts,
        positionType: 'hedge_long',
        fundingCollected: 0,
        spread: opportunity.spread,
        nextFundingTime: opportunity.nextFundingTime,
        isSnipe,
        fundingReceived: 0,
        entryFee,
        fundingIntervalMs: opportunity.fundingIntervalMs,
        entryGapPercent,
      };

      const perFunding = notional * opportunity.spread;
      set(s => ({
        simPositions: [...s.simPositions, shortPos, longPos],
        simBalances: {
          ...s.simBalances,
          [shortExchange]: s.simBalances[shortExchange] - totalCostPerSide,
          [longExchange]: s.simBalances[longExchange] - totalCostPerSide,
        },
        simTotalFees: s.simTotalFees + entryFee * 2, // 숏+롱 진입 수수료
      }));
      // Persist sim state after entry
      const st1 = get();
      saveSimState({ simBalances: st1.simBalances, simPositions: st1.simPositions, simTotalFundingEarned: st1.simTotalFundingEarned, simTotalTopUps: st1.simTotalTopUps, simTotalFees: st1.simTotalFees });
      const totalRoundTripFees = notional * ROUND_TRIP_FEE;
      const netProfit = perFunding - totalRoundTripFees;
      get().addLog('success',
        `[SIM] ${opportunity.baseAsset} 헷징 진입 완료 (${isSnipe ? '스나이프' : '홀딩'})`,
        undefined,
        `숏:${shortExchange.toUpperCase()} 롱:${longExchange.toUpperCase()} | isSnipe:${isSnipe} | pairId:${pairId} | 마진:$${fmtNum(margin)} | 레버리지:${leverage}x | 스프레드:${fmtNum(opportunity.spreadPercent, 4)}% | 다음펀딩:${new Date(opportunity.nextFundingTime).toLocaleTimeString('ko-KR')} | 8h순수익: $${fmtNum(netProfit)} (펀딩: $${fmtNum(perFunding)} - 수수료: $${fmtNum(totalRoundTripFees)})`,
      );
      // Persist trade event
      queueTrade({
        timestamp: Date.now(),
        type: isSnipe ? 'snipe_entry' : 'entry',
        simulation: true,
        baseAsset: opportunity.baseAsset,
        shortExchange,
        longExchange,
        spread: opportunity.spread,
        spreadPercent: opportunity.spreadPercent,
        margin,
        leverage,
        notional,
        entryFee,
        netProfit,
        perFunding,
        totalRoundTripFees,
        pairId,
      });
      return true;
    }

    // ── Real trading branch ────────────────────
    const shortConfig = apiConfigs[opportunity.shortExchange];
    const longConfig = apiConfigs[opportunity.longExchange];

    if (!shortConfig) {
      get().addLog('error', `${opportunity.shortExchange.toUpperCase()} API 키 없음`, opportunity.shortExchange);
      return false;
    }
    if (!longConfig) {
      get().addLog('error', `${opportunity.longExchange.toUpperCase()} API 키 없음`, opportunity.longExchange);
      return false;
    }

    let realInvestment = strategyConfig.investmentUSDT;
    if (strategyConfig.compoundInvesting) {
      const shortBal = balances[opportunity.shortExchange]?.availableUSDT ?? 0;
      const longBal = balances[opportunity.longExchange]?.availableUSDT ?? 0;
      realInvestment = Math.min(shortBal, longBal) * 0.9;
      if (realInvestment < strategyConfig.investmentUSDT * 0.5) {
        get().addLog('warning', `[복리] 실잔고 부족 — 최소 투자금으로 대체`, undefined,
          `투자금: $${fmtNum(realInvestment, 0)}`);
        realInvestment = strategyConfig.investmentUSDT;
      }
    }

    const profit = estimateProfit(opportunity, realInvestment, strategyConfig.leverage);
    get().addLog('info',
      `전략 실행 시작: ${opportunity.baseAsset} | 숏:${opportunity.shortExchange.toUpperCase()} 롱:${opportunity.longExchange.toUpperCase()}`,
      undefined,
      `투자금: $${fmtNum(realInvestment, 0)} | 예상 8h순수익: $${fmtNum(profit.netPerFunding)} (수수료: -$${fmtNum(profit.totalFees)})`,
    );

    set({ strategyRunning: true });

    try {
      // ── 헷징 실거래: 숏+롱 동시 진입 ──
      const res = await fetch('/api/strategy/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunity,
          investmentUSDT: realInvestment,
          leverage: strategyConfig.leverage,
          apiConfigs: {
            [opportunity.shortExchange]: apiConfigs[opportunity.shortExchange],
            [opportunity.longExchange]: apiConfigs[opportunity.longExchange],
          },
        }),
      });

      const json = await res.json() as {
        success: boolean;
        short: { success: boolean; error?: string };
        long: { success: boolean; error?: string };
      };

      if (json.short?.success) {
        get().addLog('success',
          `${opportunity.shortExchange.toUpperCase()} 숏 포지션 진입 성공`,
          opportunity.shortExchange,
          `${opportunity.baseAsset} Short @${opportunity.shortMarkPrice}`,
        );
      } else {
        get().addLog('error',
          `${opportunity.shortExchange.toUpperCase()} 숏 포지션 진입 실패`,
          opportunity.shortExchange,
          json.short?.error,
        );
      }

      if (json.long?.success) {
        get().addLog('success',
          `${opportunity.longExchange.toUpperCase()} 롱 포지션 진입 성공`,
          opportunity.longExchange,
          `${opportunity.baseAsset} Long @${opportunity.longMarkPrice}`,
        );
      } else {
        get().addLog('error',
          `${opportunity.longExchange.toUpperCase()} 롱 포지션 진입 실패`,
          opportunity.longExchange,
          json.long?.error,
        );
      }

      setTimeout(() => get().refreshAndStampPositions(
        opportunity.baseAsset, [opportunity.shortExchange, opportunity.longExchange],
      ), 2000);
      queueTrade({
        timestamp: Date.now(), type: 'entry', simulation: false,
        baseAsset: opportunity.baseAsset, shortExchange: opportunity.shortExchange, longExchange: opportunity.longExchange,
        spread: opportunity.spread, spreadPercent: opportunity.spreadPercent,
        margin: realInvestment, leverage: strategyConfig.leverage,
        detail: `short:${json.short?.success ? 'OK' : json.short?.error} long:${json.long?.success ? 'OK' : json.long?.error}`,
        success: json.success,
        pairId: `pair-${Date.now()}-${opportunity.baseAsset}`,
      });
      return json.success === true;
    } catch (err) {
      get().addLog('error', '전략 실행 중 오류 발생', undefined, (err as Error).message);
      queueTrade({
        timestamp: Date.now(), type: 'error', simulation: false,
        baseAsset: opportunity.baseAsset, reason: (err as Error).message,
      });
      return false;
    } finally {
      set({ strategyRunning: false });
    }
  },

  // ── Close position ────────────────────────────
  async closePosition(position) {
    const { apiConfigs } = get();
    const config = apiConfigs[position.exchange];
    if (!config) {
      get().addLog('error', `${position.exchange.toUpperCase()} API 키 없음`, position.exchange);
      throw new Error(`${position.exchange.toUpperCase()} API 키 없음`);
    }

    get().addLog('info', `포지션 청산 시도: ${position.displaySymbol} ${position.side}`, position.exchange);

    try {
      const res = await fetch(`/api/exchanges/${position.exchange}/close`, {
        method: 'POST',
        headers: makeApiHeaders(config),
        body: JSON.stringify({
          symbol: position.symbol,
          side: position.side,
          amount: position.size,
        }),
      });
      const json = await res.json() as { success: boolean; error?: string };

      if (json.success) {
        get().addLog('success',
          `${position.displaySymbol} ${position.side.toUpperCase()} 청산 완료`,
          position.exchange,
        );
        queueTrade({
          timestamp: Date.now(),
          type: 'exit',
          simulation: false,
          baseAsset: position.baseAsset,
          exchange: position.exchange,
          shortExchange: position.exchange,
          side: position.side,
          pairId: `exit-${Date.now()}-${position.baseAsset}`,
        });
        setTimeout(() => get().refreshPositions(), 2000);
      } else {
        get().addLog('error', `청산 실패: ${json.error}`, position.exchange);
        throw new Error(`청산 실패: ${json.error}`);
      }
    } catch (err) {
      get().addLog('error', '청산 중 오류', position.exchange, (err as Error).message);
      throw err;
    }
  },

  // ── Test connection ───────────────────────────
  async testConnection(exchange) {
    const config = get().apiConfigs[exchange];
    if (!config) return false;

    get().addLog('info', `${exchange.toUpperCase()} 연결 테스트 중...`, exchange);

    try {
      const res = await fetch(`/api/exchanges/${exchange}/test`, {
        method: 'POST',
        headers: makeApiHeaders(config),
      });
      const json = await res.json() as { success: boolean; error?: string };

      if (json.success) {
        get().addLog('success', `${exchange.toUpperCase()} 연결 성공`, exchange);
      } else {
        get().addLog('error', `${exchange.toUpperCase()} 연결 실패`, exchange, json.error);
      }
      return json.success;
    } catch (err) {
      get().addLog('error', `${exchange.toUpperCase()} 연결 오류`, exchange, (err as Error).message);
      return false;
    }
  },

  // ── Logs ──────────────────────────────────────
  addLog(level, message, exchange, detail) {
    set((s) => {
      const newLogs = [makeLog(level, message, exchange, detail), ...s.logs].slice(0, 500);
      saveLogs(newLogs);
      return { logs: newLogs };
    });
    // Auto-persist to file
    queueLog(level, message, exchange, detail);
  },

  clearLogs() {
    set({ logs: [] });
    saveLogs([]);
  },

  // ── Simulation ────────────────────────────────
  toggleSimulationMode() {
    const next = !get().simulationMode;
    set({ simulationMode: next });
    get().addLog('info', next ? `[SIM] 시뮬레이션 모드 ON — 각 거래소 $${get().strategyConfig.investmentUSDT} 가상 잔고` : '[SIM] 시뮬레이션 모드 OFF');
  },

  resetSimulation() {
    const bal = get().strategyConfig.investmentUSDT;
    const enabled = get().enabledExchanges;
    const newBal = {} as Record<ExchangeId, number>;
    for (const ex of SUPPORTED_EXCHANGES) {
      newBal[ex] = enabled.includes(ex) ? bal : 0;
    }
    set({
      simPositions: [],
      simBalances: newBal,
      simTotalFundingEarned: 0,
      simTotalTopUps: 0,
      simTotalFees: 0,
      fundingHistory: [],
    });
    clearSimState();
    saveFundingHistory([]);
    get().addLog('info', `[SIM] 초기화 완료 — 각 거래소 $${bal} 리셋`);
  },

  clearSimFundingHistory() {
    set({ fundingHistory: [] });
    saveFundingHistory([]);
    get().addLog('info', '[SIM] 펀딩 수령 내역 초기화 완료');
  },

  async closeSimPosition(simId) {
    const pos = get().simPositions.find(p => p.simId === simId);
    if (!pos) return;

    // ── 실제 호가창 기반 청산 체결가 (슬리피지 반영) ──
    let exitPrice = pos.markPrice;
    try {
      const exitSide = pos.side === 'short' ? 'buy' : 'sell';
      const res = await fetch(`/api/exchanges/${pos.exchange}/orderbook?symbol=${encodeURIComponent(pos.symbol)}&side=${exitSide}&notional=${pos.sizeUSD}`).then(r => r.json());
      if (res.success) {
        exitPrice = res.fillPrice;
        get().addLog('info', `[SIM] ${pos.baseAsset} ${pos.side} 청산 체결가: $${fmtNum(exitPrice, 2)} (슬리피지: ${fmtNum(res.slippagePercent, 4)}%)`, pos.exchange);
      }
    } catch {
      // 호가창 조회 실패 시 markPrice 사용
    }

    const exitFee = pos.sizeUSD * TAKER_FEE;
    const pricePnl = pos.side === 'short'
      ? (pos.entryPrice - exitPrice) * pos.size
      : (exitPrice - pos.entryPrice) * pos.size;

    // ── 스나이프 펀딩 직접 계산 (tickSimFunding 의존 X) ──
    let actualFunding = pos.fundingCollected;
    if (pos.isSnipe && actualFunding === 0) {
      // tickSimFunding에서 처리 못 한 경우 직접 계산
      const liveRate = get().fundingRates.find(
        r => r.exchange === pos.exchange && r.symbol === pos.symbol,
      );
      const currentRate = liveRate?.rate ?? pos.fundingRate;
      actualFunding = pos.side === 'short'
        ? pos.sizeUSD * currentRate
        : pos.sizeUSD * (-currentRate);
      // 잔고에도 반영
      set(s => ({
        simBalances: { ...s.simBalances, [pos.exchange]: (s.simBalances[pos.exchange] ?? 0) + actualFunding },
        simTotalFundingEarned: s.simTotalFundingEarned + actualFunding,
      }));
      get().addLog('info',
        `[SIM] 펀딩 직접 계산: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        pos.exchange,
        `$${fmtNum(Math.abs(actualFunding), 4)} (rate: ${fmtNum(currentRate * 100, 4)}%)`,
      );
    }

    const returnAmount = pos.margin + pricePnl - exitFee;
    const netPnl = pricePnl + actualFunding - (pos.entryFee ?? 0) - exitFee;

    // ── 펀딩 수령 내역 기록: tickSimFunding이 이미 기록한 경우 스킵 (fallback 직접계산인 경우만 기록) ──
    const alreadyRecordedByTick = pos.fundingCollected > 0 && actualFunding === pos.fundingCollected;
    const fundingPayment: FundingPayment | null = (actualFunding !== 0 && !alreadyRecordedByTick)
      ? { exchange: pos.exchange, symbol: pos.symbol, amount: actualFunding, rate: pos.fundingRate, timestamp: Date.now(), side: pos.side }
      : null;

    set(s => {
      const newHistory = fundingPayment ? [fundingPayment, ...s.fundingHistory] : s.fundingHistory;
      if (fundingPayment) saveFundingHistory(newHistory);
      return {
        simPositions: s.simPositions.filter(p => p.simId !== simId),
        simBalances: { ...s.simBalances, [pos.exchange]: s.simBalances[pos.exchange] + returnAmount },
        fundingHistory: newHistory,
        simTotalFees: s.simTotalFees + exitFee,
      };
    });
    // Persist sim state after close
    const st2 = get();
    saveSimState({ simBalances: st2.simBalances, simPositions: st2.simPositions, simTotalFundingEarned: st2.simTotalFundingEarned, simTotalTopUps: st2.simTotalTopUps, simTotalFees: st2.simTotalFees });
    get().addLog(netPnl >= 0 ? 'success' : 'warning',
      `[SIM] 포지션 청산: ${pos.displaySymbol} ${pos.side.toUpperCase()}`,
      pos.exchange,
      `순손익: ${netPnl >= 0 ? '+' : ''}$${fmtNum(netPnl)} (펀딩: $${fmtNum(actualFunding, 4)}, 가격손익: $${fmtNum(pricePnl)}, 수수료: -$${fmtNum((pos.entryFee ?? 0) + exitFee)})`,
    );
    queueTrade({
      timestamp: Date.now(), type: pos.isSnipe ? 'snipe_exit' : 'exit', simulation: true,
      baseAsset: pos.baseAsset, exchange: pos.exchange, side: pos.side, symbol: pos.symbol,
      pnl: netPnl, fundingAmount: actualFunding, exitFee,
      entryFee: pos.entryFee ?? 0, pricePnl,
      detail: `margin:$${pos.margin.toFixed(2)} size:${pos.size.toFixed(6)} entry:${pos.entryPrice} exit:${exitPrice}`,
    });
  },

  tickSimFunding() {
    const { simPositions, fundingRates } = get();
    if (simPositions.length === 0) return;
    const now = Date.now();

    let totalNewFunding = 0;
    const balanceDeltaHedge: Partial<Record<ExchangeId, number>> = {};
    const pendingLogs: { level: LogLevel; message: string; exchange: ExchangeId; detail: string }[] = [];
    const simFundingPayments: FundingPayment[] = [];

    const updated = simPositions.map(pos => {
      if (pos.nextFundingTime > now) return pos;
      const liveRate = fundingRates.find(
        r => r.exchange === pos.exchange && r.symbol === pos.symbol,
      );
      const currentRate = liveRate?.rate ?? pos.fundingRate;
      const funding = pos.side === 'short'
        ? pos.sizeUSD * currentRate
        : pos.sizeUSD * (-currentRate);
      totalNewFunding += funding;
      balanceDeltaHedge[pos.exchange] = (balanceDeltaHedge[pos.exchange] ?? 0) + funding;
      pendingLogs.push({
        level: funding >= 0 ? 'success' : 'warning',
        message: `[SIM] 펀딩 ${funding >= 0 ? '수령' : '지불'}: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        exchange: pos.exchange,
        detail: `$${fmtNum(Math.abs(funding), 4)} (${fmtNum(currentRate * 100, 4)}%${liveRate ? '' : ' [진입시rate]'})`,
      });
      queueTrade({
        timestamp: Date.now(), type: 'funding', simulation: true,
        baseAsset: pos.baseAsset, exchange: pos.exchange, side: pos.side, symbol: pos.symbol,
        fundingAmount: funding, fundingRate: currentRate,
        detail: `sizeUSD:$${pos.sizeUSD.toFixed(2)} cumulative:$${(pos.fundingCollected + funding).toFixed(4)}`,
      });
      simFundingPayments.push({
        exchange: pos.exchange,
        symbol: pos.symbol,
        amount: funding,
        rate: currentRate,
        timestamp: Date.now(),
        side: pos.side,
      });
      return {
        ...pos,
        fundingRate: currentRate,
        fundingCollected: pos.fundingCollected + funding,
        nextFundingTime: pos.nextFundingTime + (pos.fundingIntervalMs ?? 8 * 3600 * 1000),
        fundingReceived: (pos.fundingReceived ?? 0) + 1,
      };
    });

    const snipeToClose = updated.filter(p => p.isSnipe && (p.fundingReceived ?? 0) >= 1);

    // 디버그: 스나이프 자동청산 판단 로그
    if (updated.some(p => p.isSnipe)) {
      const snipePositions = updated.filter(p => p.isSnipe);
      for (const p of snipePositions) {
        if ((p.fundingReceived ?? 0) >= 1) {
          pendingLogs.push({
            level: 'info',
            message: `[스나이프 청산대기] ${p.baseAsset} ${p.side} — fundingReceived:${p.fundingReceived} → 자동청산 예정`,
            exchange: p.exchange,
            detail: `simId:${p.simId} | pairId:${p.pairId} | 수령펀딩:$${fmtNum(p.fundingCollected, 4)}`,
          });
        }
      }
    }

    set(s => {
      const newBal = { ...s.simBalances };
      for (const [ex, delta] of Object.entries(balanceDeltaHedge)) {
        newBal[ex as ExchangeId] = (newBal[ex as ExchangeId] ?? 0) + (delta as number);
      }
      const newHistory = simFundingPayments.length > 0
        ? [...simFundingPayments, ...s.fundingHistory]
        : s.fundingHistory;
      if (simFundingPayments.length > 0) saveFundingHistory(newHistory);
      return {
        simPositions: updated,
        simBalances: newBal,
        simTotalFundingEarned: s.simTotalFundingEarned + totalNewFunding,
        fundingHistory: newHistory,
      };
    });

    // Persist sim state after update
    const st3 = get();
    saveSimState({ simBalances: st3.simBalances, simPositions: st3.simPositions, simTotalFundingEarned: st3.simTotalFundingEarned, simTotalTopUps: st3.simTotalTopUps, simTotalFees: st3.simTotalFees });

    // #3: Add logs after state update to avoid mutation during iteration
    for (const log of pendingLogs) {
      get().addLog(log.level, log.message, log.exchange, log.detail);
    }

    // 스나이핑: 펀딩 수령 완료 → 즉시 청산 → 다음 사이클 재예약
    if (snipeToClose.length > 0) {
      queueMicrotask(() => {
        for (const pos of snipeToClose) {
          get().closeSimPosition(pos.simId);
        }
        const totalCollected = snipeToClose.reduce((s, p) => s + p.fundingCollected, 0);
        get().addLog('success',
          `[스나이핑] 펀딩 수령 완료 → ${snipeToClose.length}개 포지션 자동 청산`,
          undefined,
          `총 수령: $${fmtNum(totalCollected, 4)}`,
        );

        // 청산된 코인들 타이머 정리 + 다음 사이클 자동 재예약
        const closedKeys = [...new Set(snipeToClose.map(p => p.baseAsset))];
        for (const key of closedKeys) {
          get().cancelSnipeForAsset(key);
        }
        if (get().snipeActive) {
          get().scheduleAllSnipes();
        }
      });
    }

    // 홀딩: 스프레드 역전 감지 → 자동 청산
  },

  // ── Exchange Toggle ─────────────────────────
  toggleExchange(exchange) {
    const { enabledExchanges, simPositions } = get();

    // 해당 거래소에 열린 포지션이 있으면 OFF 불가 (시뮬 + 실거래 모두 체크)
    if (enabledExchanges.includes(exchange)) {
      const hasSimPositions = simPositions.some(p => p.exchange === exchange);
      const hasRealPositions = get().positions.some(p => p.exchange === exchange);
      if (hasSimPositions || hasRealPositions) {
        get().addLog('warning',
          `${exchange.toUpperCase()} OFF 불가 — 열린 포지션이 있습니다`,
          exchange,
          '포지션을 먼저 청산하세요',
        );
        return;
      }
    }

    let next: ExchangeId[];
    if (enabledExchanges.includes(exchange)) {
      // OFF: 최소 2개는 유지해야 헷징 가능
      if (enabledExchanges.length <= 2) {
        get().addLog('warning', '최소 2개 거래소가 필요합니다 — 비활성화 불가');
        return;
      }
      next = enabledExchanges.filter(e => e !== exchange);
    } else {
      // ON
      next = [...enabledExchanges, exchange];
    }

    // Smart sim balance redistribution — preserve position margins
    const lockedPerExchangeHedge: Partial<Record<ExchangeId, number>> = {};
    for (const pos of simPositions) {
      lockedPerExchangeHedge[pos.exchange] = (lockedPerExchangeHedge[pos.exchange] ?? 0) + pos.margin;
    }

    const newBal = { ...get().simBalances };

    function redistributePool(
      pool: Record<ExchangeId, number>,
      lockedPerEx: Partial<Record<ExchangeId, number>>,
    ): Record<ExchangeId, number> {
      const p = { ...pool };
      if (enabledExchanges.includes(exchange)) {
        // OFF: redistribute disabled exchange's free balance to remaining
        const freedBal = p[exchange] ?? 0;
        p[exchange] = 0;
        const perRemaining = freedBal / next.length;
        for (const ex of next) {
          p[ex] = (p[ex] ?? 0) + perRemaining;
        }
      } else {
        // ON: redistribute only free (non-locked) balance equally
        let totalFree = 0;
        for (const ex of enabledExchanges) {
          const locked = lockedPerEx[ex] ?? 0;
          totalFree += Math.max(0, (p[ex] ?? 0) - locked);
        }
        const freePerExchange = totalFree / next.length;
        for (const ex of SUPPORTED_EXCHANGES) {
          if (next.includes(ex)) {
            const locked = lockedPerEx[ex] ?? 0;
            p[ex] = freePerExchange + locked;
          } else {
            p[ex] = 0;
          }
        }
      }
      return p;
    }

    const updatedBal = redistributePool(newBal, lockedPerExchangeHedge);

    set({ enabledExchanges: next, simBalances: updatedBal });
    saveEnabledExchanges(next);

    const action = enabledExchanges.includes(exchange) ? 'OFF' : 'ON';
    const totalSim = Object.values(updatedBal).reduce((s, v) => s + v, 0);
    get().addLog('info',
      `${exchange.toUpperCase()} ${action} — 활성 ${next.length}개 거래소`,
      exchange,
      `시뮬 총 자산: $${fmtNum(totalSim, 0)} (포지션 마진 보존됨)`,
    );

    // 즉시 새 설정으로 펀딩률 갱신
    get().refreshRates();
  },

  // ── UI ────────────────────────────────────────
  setShowApiPanel: (v) => set({ showApiPanel: v }),
  setShowStrategyPanel: (v) => set({ showStrategyPanel: v }),
  setRateFilter: (v) => set({ rateFilter: v }),
  setExchangeFilter: (v) => set({ exchangeFilter: v }),
  setPositionToClose: (v) => set({ positionToClose: v }),

  // ── 트루 스나이핑: 코인별 독립 타이머 — 펀딩 7초 전 진입 → 수령 확인 → 즉시 청산 ──

  // 펀딩 주기별(1h/4h/8h) 최적 기회 1개씩 선택 → 겹치는 시간대는 최고 수익만
  scheduleAllSnipes() {
    const { opportunities, enabledExchanges: currentEnabled, snipeTargets, simPositions, positions, simulationMode, strategyConfig } = get();
    const effectiveMinPercent = getEffectiveMinSpread(strategyConfig);

    // 이미 예약되었거나 포지션 열린 코인 스킵
    const activeKeys = new Set([
      ...Object.keys(snipeTargets),
      ...(simulationMode ? simPositions : positions).map(p => p.baseAsset),
    ]);

    const now = Date.now();
    const CONFLICT_WINDOW_MS = 2 * 60 * 1000;

    // 헷징 기준: 스프레드 > 최소%, 양쪽 거래소 활성화
    const filtered = opportunities.filter(o => {
      if (activeKeys.has(o.baseAsset)) return false;
      if (!currentEnabled.includes(o.shortExchange)) return false;
      if (!currentEnabled.includes(o.longExchange)) return false;
      return o.spreadPercent > effectiveMinPercent;
    });
    if (filtered.length === 0) return;

    // 이미 스케줄된 펀딩 시간 수집 (2분 이내 겹침 체크용)
    const scheduledTimes: number[] = [];
    for (const snipeKey of Object.keys(snipeTargets)) {
      const opp = opportunities.find(o => o.baseAsset === snipeKey);
      if (opp) scheduledTimes.push(opp.nextFundingTime);
    }

    // 스프레드 높은 순 정렬 → 시간 겹침만 제거하고 모두 선택
    const sorted = [...filtered].sort((a, b) => b.spreadPercent - a.spreadPercent);
    const result: typeof filtered = [];
    for (const opp of sorted) {
      // 이미 스케줄된 시간과 2분 이내 겹치면 스킵
      const conflictsWithScheduled = scheduledTimes.some(t => Math.abs(t - opp.nextFundingTime) < CONFLICT_WINDOW_MS);
      if (conflictsWithScheduled) continue;
      // 이번 라운드에서 선택된 것과 2분 이내 겹치면 스킵 (높은 스프레드가 먼저 선택됨)
      const conflictsWithResult = result.some(r => Math.abs(r.nextFundingTime - opp.nextFundingTime) < CONFLICT_WINDOW_MS);
      if (conflictsWithResult) continue;
      result.push(opp);
    }

    // 스케줄 등록
    for (const opp of result) {
      const minsLeft = Math.round((opp.nextFundingTime - now) / 60000);
      get().addLog('info',
        `[스케줄-헷징] ${opp.baseAsset} 선택 — ${minsLeft}분 후 펀딩`,
        undefined,
        `스프레드: +${fmtNum(opp.spreadPercent, 4)}% | ${opp.shortExchange}↔${opp.longExchange}`,
      );
      get().scheduleSnipeForAsset(opp);
      activeKeys.add(opp.baseAsset);
    }
  },

  // 특정 코인 1개에 대한 스나이핑 예약
  scheduleSnipeForAsset(opportunity) {
    const { _snipeTimers, snipeTargets } = get();
    const snipeKey = opportunity.baseAsset;

    // 이미 예약된 키면 스킵
    if (snipeTargets[snipeKey]) return;

    // 기존 타이머 정리
    if (_snipeTimers[snipeKey]) clearTimeout(_snipeTimers[snipeKey]);

    // 과거 시간 보정
    const intervalMs = opportunity.fundingIntervalMs ?? 8 * 3600 * 1000;
    let targetTime = opportunity.nextFundingTime;
    const now = Date.now();
    while (targetTime <= now) {
      targetTime += intervalMs;
    }

    const ENTRY_BEFORE_MS = 5_000;

    // 펀딩까지 10초 미만 → 다음 사이클
    if (targetTime - now < 10_000) {
      targetTime += intervalMs;
    }

    const entryDelay = Math.max(0, targetTime - now - ENTRY_BEFORE_MS);

    // 타이머 등록
    const timer = setTimeout(() => get()._executeSnipeEntry(opportunity, targetTime), entryDelay);

    set(s => ({
      snipeTargets: { ...s.snipeTargets, [snipeKey]: targetTime },
      _snipeTimers: { ...s._snipeTimers, [snipeKey]: timer },
    }));

    const mins = Math.floor(entryDelay / 1000 / 60);
    const secs = Math.floor((entryDelay / 1000) % 60);
    const intervalH = Math.round(intervalMs / 3600000);
    get().addLog('info',
      `[스나이핑-헷징] ${opportunity.baseAsset} 예약 — ${mins}분 ${secs}초 후`,
      undefined,
      `펀딩주기: ${intervalH}h | 스프레드: +${fmtNum(opportunity.spreadPercent, 4)}%`,
    );
  },

  // ★ 내부: 펀딩 직전 진입 실행 + 수령 후 자동청산 예약
  _executeSnipeEntry(opportunity: ArbitrageOpportunity, targetFundingTime: number) {
    const asset = opportunity.baseAsset;
    const snipeKey = asset;
    const { enabledExchanges: currentEnabled } = get();

    // 진입 시점에 해당 코인의 최신 기회 확인
    const { opportunities } = get();
    const timerMinPercent = getEffectiveMinSpread(get().strategyConfig);
    const latestOpp = opportunities.find(o =>
      o.baseAsset === asset &&
      currentEnabled.includes(o.shortExchange) &&
      currentEnabled.includes(o.longExchange),
    );
    const meetsThreshold = (o: ArbitrageOpportunity) => o.spreadPercent > timerMinPercent;
    const finalTarget = latestOpp && meetsThreshold(latestOpp)
      ? latestOpp
      : meetsThreshold(opportunity) ? opportunity : null;

    if (!finalTarget) {
      get().addLog('warning', `[스나이핑-헷징] ${asset} 기준 미달 — 스킵`);
      get().cancelSnipeForAsset(snipeKey);
      return;
    }

    const secsToFunding = Math.max(0, (targetFundingTime - Date.now()) / 1000).toFixed(1);
    get().addLog('info',
      `[스나이핑-헷징] ${asset} 진입 실행 — 펀딩까지 ${secsToFunding}초`,
      undefined,
      `숏:${finalTarget.shortExchange.toUpperCase()} 롱:${finalTarget.longExchange.toUpperCase()} | 스프레드: +${fmtNum(finalTarget.spreadPercent, 4)}%`,
    );

    const entryTarget = { ...finalTarget, nextFundingTime: targetFundingTime };
    get().executeStrategy(entryTarget).then((success) => {
      if (success) {
        get().addLog('success',
          `[스나이핑-헷징] ${asset} 진입 완료`,
          undefined,
          `펀딩까지 ~${secsToFunding}초`,
        );
        const closeDelay = Math.max(0, targetFundingTime - Date.now()) + 5_000;
        const closeTimer = setTimeout(() => {
          get()._executeSnipeClose(finalTarget);
        }, closeDelay);
        set(s => ({
          _snipeCloseTimers: { ...s._snipeCloseTimers, [snipeKey]: closeTimer },
        }));
        get().addLog('info',
          `[스나이핑-헷징] ${asset} 자동청산 예약 — ${fmtNum(closeDelay / 1000, 0)}초 후`,
        );
      } else {
        get().addLog('error', `[스나이핑-헷징] ${asset} 진입 실패`);
        get().cancelSnipeForAsset(snipeKey);
      }
    });
  },

  // ★ 내부: 펀딩 수령 확인 + 포지션 청산 + 다음 사이클 재예약
  async _executeSnipeClose(target: ArbitrageOpportunity) {
    const { simulationMode } = get();
    const asset = target.baseAsset;
    const snipeKey = asset;

    if (simulationMode) {
      // 시뮬레이션: tickSimFunding 의존 X → 직접 해당 코인 포지션 찾아서 청산
      const simPosForAsset = get().simPositions.filter(p =>
        p.baseAsset === asset && p.isSnipe,
      );
      if (simPosForAsset.length === 0) {
        get().addLog('warning', `[스나이핑-헷징] ${asset} 시뮬 포지션 없음`);
      } else {
        for (const pos of simPosForAsset) {
          await get().closeSimPosition(pos.simId);
        }
        const totalCollected = simPosForAsset.reduce((s, p) => s + p.fundingCollected, 0);
        get().addLog('success',
          `[스나이핑-헷징] ${asset} 시뮬 청산 완료`,
          undefined,
          `${simPosForAsset.length}개 포지션 | 수령 펀딩: $${fmtNum(totalCollected, 4)}`,
        );
      }
    } else {
      // ★ 실거래: 펀딩 수령 확인 후 청산
      get().addLog('info', `[스나이핑-헷징] ${asset} 펀딩 수령 확인 중...`);

      let fundingVerified = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await get().fetchFundingHistory();
          const { fundingHistory } = get();
          const recentFunding = fundingHistory.find(f =>
            f.symbol.includes(asset) &&
            f.exchange === target.shortExchange &&
            f.timestamp > Date.now() - 60_000,
          );
          if (recentFunding) {
            fundingVerified = true;
            get().addLog('success',
              `[스나이핑-헷징] ${asset} 펀딩 수령 확인`,
              recentFunding.exchange,
              `$${fmtNum(Math.abs(recentFunding.amount), 4)} (${fmtNum(recentFunding.rate * 100, 4)}%)`,
            );
            break;
          }
        } catch { /* ignore */ }
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 5_000));
        }
      }

      if (!fundingVerified) {
        get().addLog('warning', `[스나이핑-헷징] ${asset} 펀딩 확인 불가 — 청산 진행`);
      }

      const currentPositions = get().positions;
      const targetPositions = currentPositions.filter(p => {
        if (p.baseAsset !== asset) return false;
        if (p.positionType === 'manual') return false; // 사용자 수동 포지션 보호
        return (p.exchange === target.shortExchange || p.exchange === target.longExchange)
          && (p.positionType === 'hedge_short' || p.positionType === 'hedge_long');
      });

      if (targetPositions.length > 0) {
        get().addLog('info', `[스나이핑-헷징] ${asset} ${targetPositions.length}개 청산 중...`);
        await Promise.allSettled(
          targetPositions.map(pos => get().closePosition(pos)),
        );
        get().addLog('success', `[스나이핑-헷징] ${asset} 청산 완료`);
        queueTrade({
          timestamp: Date.now(), type: 'snipe_complete', simulation: false,
          baseAsset: asset, shortExchange: target.shortExchange, longExchange: target.longExchange,
          detail: `fundingVerified:${fundingVerified} | mode:hedge`,
        });
      } else {
        get().addLog('warning', `[스나이핑-헷징] ${asset} 청산할 포지션 없음`);
      }
    }

    // 해당 키 타이머 정리 + 다음 사이클 재예약
    get().cancelSnipeForAsset(snipeKey);
    if (get().snipeActive) {
      get().scheduleAllSnipes();
    }
  },

  // 특정 코인의 스나이핑 타이머만 정리
  cancelSnipeForAsset(snipeKey: string) {
    const { _snipeTimers, _snipeCloseTimers } = get();
    if (_snipeTimers[snipeKey]) clearTimeout(_snipeTimers[snipeKey]);
    if (_snipeCloseTimers[snipeKey]) clearTimeout(_snipeCloseTimers[snipeKey]);
    set(s => {
      const newTimers = { ...s._snipeTimers };
      const newCloseTimers = { ...s._snipeCloseTimers };
      const newTargets = { ...s.snipeTargets };
      delete newTimers[snipeKey];
      delete newCloseTimers[snipeKey];
      delete newTargets[snipeKey];
      return { _snipeTimers: newTimers, _snipeCloseTimers: newCloseTimers, snipeTargets: newTargets };
    });
  },

  // 전체 스나이핑 중지
  cancelSnipe() {
    const { _snipeTimers, _snipeCloseTimers } = get();
    for (const t of Object.values(_snipeTimers)) clearTimeout(t);
    for (const t of Object.values(_snipeCloseTimers)) clearTimeout(t);
    set({ snipeActive: false, snipeTargets: {}, _snipeTimers: {}, _snipeCloseTimers: {} });
    get().addLog('info', '[스나이핑] 전체 중지됨');
  },

  async fetchFundingHistory() {
    // 시뮬레이션 모드에서는 실거래 API 조회하지 않음 (tickSimFunding에서 자체 기록)
    if (get().simulationMode) return;
    const configs = get().apiConfigs;
    if (Object.keys(configs).length === 0) return;
    set({ isLoadingHistory: true });

    const allHistory: FundingPayment[] = [];

    await Promise.allSettled(
      (Object.entries(configs) as [ExchangeId, ApiConfig][]).map(async ([exchange, config]) => {
        const res = await fetch(`/api/exchanges/${exchange}/funding-history?limit=50`, {
          headers: makeApiHeaders(config),
        });
        const json = await res.json() as { success: boolean; data: FundingPayment[] };
        if (json.success && json.data) allHistory.push(...json.data);
      }),
    );

    allHistory.sort((a, b) => b.timestamp - a.timestamp);
    saveFundingHistory(allHistory);
    set({ fundingHistory: allHistory, isLoadingHistory: false });
  },
}));
