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
import { saveApiConfigs, loadApiConfigs } from '@/lib/keyStore';
import { estimateProfit, findOpportunities } from '@/lib/opportunities';
import type { WsRateUpdate } from '@/lib/websocket/parsers';

type WsStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

// ─────────────────────────────────────────────
// Fee constants
// ─────────────────────────────────────────────
const TAKER_FEE = 0.0005; // 0.05% per side
// 왕복 수수료: 진입(숏+롱) + 청산(숏+롱) = 4 × 0.05% = 0.2%
const ROUND_TRIP_FEE = TAKER_FEE * 4; // 0.002 (0.2%)
const ROUND_TRIP_FEE_PERCENT = ROUND_TRIP_FEE * 100; // 0.2%

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
  wsStatuses: Partial<Record<ExchangeId, WsStatus>>;
  ratesStatus: 'idle' | 'loading' | 'success' | 'error';
  ratesError: string | null;

  // Simulation
  simulationMode: boolean;
  simBalances: Record<ExchangeId, number>;
  simPositions: SimPosition[];
  simTotalFundingEarned: number;

  // Automation
  automationActive: boolean;
  automationStartedAt: number | null;
  automationStats: { fundingCollected: number; positionsOpened: number; autoExits: number };

  // Snipe mode (펀딩 직전 진입 → 수령 → 즉시 청산)
  snipeScheduled: boolean;
  snipeTargetTime: number | null;
  _snipeTimer: ReturnType<typeof setTimeout> | null;

  // UI state
  showApiPanel: boolean;
  showStrategyPanel: boolean;
  rateFilter: string; // base asset filter
  exchangeFilter: ExchangeId[];
  positionToClose: Position | null;

  // Polling interval handles
  _ratesInterval: ReturnType<typeof setInterval> | null;
  _positionsInterval: ReturnType<typeof setInterval> | null;
  _recalcTimeout: ReturnType<typeof setTimeout> | null;

  // Actions
  init: () => void;
  setApiConfig: (exchange: ExchangeId, config: ApiConfig) => void;
  removeApiConfig: (exchange: ExchangeId) => void;
  setStrategyConfig: (config: Partial<StrategyConfig>) => void;

  refreshRates: () => Promise<void>;
  refreshPositions: () => Promise<void>;
  refreshBalances: () => Promise<void>;

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
  closeSimPosition: (simId: string) => void;
  tickSimFunding: () => void;

  // Automation actions
  startAutomation: () => void;
  stopAutomation: () => void;
  checkAutoExit: () => void;

  // Snipe actions
  scheduleSnipe: (opportunity: ArbitrageOpportunity) => void;
  cancelSnipe: () => void;

  setShowApiPanel: (v: boolean) => void;
  setShowStrategyPanel: (v: boolean) => void;
  setRateFilter: (v: string) => void;
  setExchangeFilter: (v: ExchangeId[]) => void;
  setPositionToClose: (v: Position | null) => void;

  // WebSocket actions
  updateFundingRateWs: (update: WsRateUpdate) => void;
  setWsStatus: (exchange: ExchangeId, status: WsStatus) => void;
  fetchFundingHistory: () => Promise<void>;
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
const SIM_BALANCE_PER_EXCHANGE = 2000; // 각 거래소 시뮬 초기 잔고 (USDT)

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
    minSpreadPercent: 0.25, // 왕복 수수료(0.2%) + 마진
    autoExecute: false,
    closeOnSpreadReverse: false,
    maxPositionAgeHours: 72,
    compoundInvesting: true, // 복리 모드 기본
  },
  fundingHistory: [],
  simulationMode: true,
  simBalances: { binance: SIM_BALANCE_PER_EXCHANGE, bybit: SIM_BALANCE_PER_EXCHANGE, okx: SIM_BALANCE_PER_EXCHANGE, bitget: SIM_BALANCE_PER_EXCHANGE, gate: SIM_BALANCE_PER_EXCHANGE },
  simPositions: [],
  simTotalFundingEarned: 0,
  automationActive: false,
  automationStartedAt: null,
  automationStats: { fundingCollected: 0, positionsOpened: 0, autoExits: 0 },
  snipeScheduled: false,
  snipeTargetTime: null,
  _snipeTimer: null,
  isLoadingRates: false,
  isLoadingPositions: false,
  isLoadingHistory: false,
  strategyRunning: false,
  connectedExchanges: [],
  lastRatesUpdate: null,
  lastPositionsUpdate: null,
  wsStatuses: {},
  ratesStatus: 'idle',
  ratesError: null,
  showApiPanel: false,
  showStrategyPanel: false,
  rateFilter: '',
  exchangeFilter: [],
  positionToClose: null,
  _ratesInterval: null,
  _positionsInterval: null,
  _recalcTimeout: null,

  // ── Init ──────────────────────────────────────
  init() {
    const saved = loadApiConfigs();
    set({ apiConfigs: saved });
    const connected = Object.keys(saved) as ExchangeId[];
    set({ connectedExchanges: connected });
    get().addLog('info', '펀딩피 프로그램 초기화 완료', undefined, `저장된 거래소: ${connected.join(', ') || '없음'}`);
    get().refreshRates();
    get().startPolling();
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
      return { strategyConfig: next };
    });
  },

  // ── Refresh rates ─────────────────────────────
  async refreshRates() {
    if (get().isLoadingRates) return; // prevent duplicate requests
    set({ isLoadingRates: true, ratesStatus: 'loading', ratesError: null });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch('/api/funding-rates', { signal: controller.signal });
      const json = await res.json() as {
        success: boolean;
        error?: string;
        data: {
          rates: FundingRate[];
          opportunities: ArbitrageOpportunity[];
          errors: { exchange: ExchangeId; error: string }[];
        };
        timestamp: number;
      };

      if (json.success) {
        set({
          fundingRates: json.data.rates,
          opportunities: json.data.opportunities,
          lastRatesUpdate: json.timestamp,
          ratesStatus: 'success',
          ratesError: null,
        });
        get().addLog('success', `펀딩률 업데이트: ${json.data.rates.length}개 데이터`, undefined,
          `기회: ${json.data.opportunities.length}개`);

        if (json.data.errors.length > 0) {
          for (const e of json.data.errors) {
            get().addLog('warning', `${(e.exchange || '?').toUpperCase()} 펀딩률 오류`, e.exchange, e.error);
          }
        }
      } else {
        // Server returned success: false — an actual error
        const errMsg = json.error || '서버에서 펀딩률 데이터를 가져오지 못했습니다';
        set({ ratesStatus: 'error', ratesError: errMsg });
        get().addLog('error', '펀딩률 조회 실패', undefined, errMsg);
      }
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'AbortError') {
        set({ ratesStatus: 'error', ratesError: '펀딩률 조회 타임아웃 (15s)' });
        get().addLog('warning', '펀딩률 조회 타임아웃 (15s) — 10초 후 재시도', undefined);
      } else {
        const msg = (err as Error).message;
        set({ ratesStatus: 'error', ratesError: msg });
        get().addLog('error', '펀딩률 조회 실패', undefined, msg);
      }
    } finally {
      clearTimeout(timer);
      set({ isLoadingRates: false });
    }
  },

  // ── Refresh positions ─────────────────────────
  async refreshPositions() {
    const configs = get().apiConfigs;
    if (Object.keys(configs).length === 0) return;
    set({ isLoadingPositions: true });

    const allPositions: Position[] = [];

    await Promise.allSettled(
      (Object.entries(configs) as [ExchangeId, ApiConfig][]).map(async ([exchange, config]) => {
        const res = await fetch(`/api/exchanges/${exchange}/positions`, {
          headers: makeApiHeaders(config),
        });
        const json = await res.json() as { success: boolean; data: Position[] };
        if (json.success && json.data) allPositions.push(...json.data);
      }),
    );

    set({ positions: allPositions, isLoadingPositions: false, lastPositionsUpdate: Date.now() });
  },

  // ── Refresh balances ──────────────────────────
  async refreshBalances() {
    const configs = get().apiConfigs;
    if (Object.keys(configs).length === 0) return;

    const next: Partial<Record<ExchangeId, Balance>> = {};

    await Promise.allSettled(
      (Object.entries(configs) as [ExchangeId, ApiConfig][]).map(async ([exchange, config]) => {
        const res = await fetch(`/api/exchanges/${exchange}/balance`, {
          headers: makeApiHeaders(config),
        });
        const json = await res.json() as { success: boolean; data: Balance };
        if (json.success) next[exchange] = json.data;
      }),
    );

    set({ balances: next });
  },

  // ── Polling ───────────────────────────────────
  startPolling() {
    const s = get();
    if (s._ratesInterval) clearInterval(s._ratesInterval);
    if (s._positionsInterval) clearInterval(s._positionsInterval);

    const ratesInterval = setInterval(() => {
      get().refreshRates();
    }, 10_000); // 10s — faster refresh for real-time arbitrage

    const positionsInterval = setInterval(() => {
      get().refreshPositions();
      get().refreshBalances();
      get().tickSimFunding();
      get().checkAutoExit();
    }, 15_000); // 15s

    set({ _ratesInterval: ratesInterval, _positionsInterval: positionsInterval });
  },

  stopPolling() {
    const { _ratesInterval, _positionsInterval } = get();
    if (_ratesInterval) clearInterval(_ratesInterval);
    if (_positionsInterval) clearInterval(_positionsInterval);
    set({ _ratesInterval: null, _positionsInterval: null });
  },

  // ── Execute strategy ──────────────────────────
  async executeStrategy(opportunity) {
    const { apiConfigs, strategyConfig, simulationMode, simBalances, balances } = get();

    // Guard: minimum spread check
    const effectiveMinSpread = Math.max(strategyConfig.minSpreadPercent, ROUND_TRIP_FEE_PERCENT);
    if (opportunity.spreadPercent < effectiveMinSpread) {
      get().addLog('warning',
        `스프레드 ${opportunity.spreadPercent.toFixed(4)}%가 최소 기준 ${effectiveMinSpread}% 미만 — 진입 스킵`,
        undefined,
        `${opportunity.baseAsset} ${opportunity.shortExchange}↔${opportunity.longExchange} | 왕복수수료: ${ROUND_TRIP_FEE_PERCENT}%`,
      );
      return false;
    }

    // Guard: 순수익 검증 — 스프레드 수익이 왕복 수수료를 초과해야 진입
    const notionalEst = (strategyConfig.compoundInvesting
      ? Math.min(
          (simBalances[opportunity.shortExchange] ?? 0) * 0.9,
          (simBalances[opportunity.longExchange] ?? 0) * 0.9,
        )
      : strategyConfig.investmentUSDT) * strategyConfig.leverage;
    const estFundingRevenue = notionalEst * opportunity.spread;
    const estTotalFees = notionalEst * ROUND_TRIP_FEE;
    if (estFundingRevenue <= estTotalFees) {
      get().addLog('warning',
        `[수익성 검증 실패] ${opportunity.baseAsset} 펀딩수익 $${estFundingRevenue.toFixed(2)} ≤ 수수료 $${estTotalFees.toFixed(2)} — 진입 스킵`,
        undefined,
        `스프레드: ${opportunity.spreadPercent.toFixed(4)}% | 필요 최소: ${ROUND_TRIP_FEE_PERCENT}%`,
      );
      return false;
    }

    // ── Simulation branch ──────────────────────
    if (simulationMode) {
      // compoundInvesting: use proportional balance instead of fixed amount
      const margin = strategyConfig.compoundInvesting
        ? Math.min(
            (simBalances[opportunity.shortExchange] ?? 0) * 0.9,
            (simBalances[opportunity.longExchange] ?? 0) * 0.9,
          )
        : strategyConfig.investmentUSDT;
      const leverage = strategyConfig.leverage;
      const notional = margin * leverage;
      const entryFee = notional * TAKER_FEE; // per-side entry fee
      const totalCostPerSide = margin + entryFee;
      const { shortExchange, longExchange } = opportunity;

      // 시뮬레이션: 잔고 부족 시 자동 충전 (시뮬이므로 차단하지 않음)
      if ((simBalances[shortExchange] ?? 0) < totalCostPerSide) {
        const topUp = totalCostPerSide - (simBalances[shortExchange] ?? 0) + SIM_BALANCE_PER_EXCHANGE;
        set(s => ({ simBalances: { ...s.simBalances, [shortExchange]: (s.simBalances[shortExchange] ?? 0) + topUp } }));
        get().addLog('info', `[SIM] ${shortExchange.toUpperCase()} 잔고 자동 충전 +$${topUp.toFixed(0)}`, shortExchange);
      }
      if ((simBalances[longExchange] ?? 0) < totalCostPerSide) {
        const topUp = totalCostPerSide - (simBalances[longExchange] ?? 0) + SIM_BALANCE_PER_EXCHANGE;
        set(s => ({ simBalances: { ...s.simBalances, [longExchange]: (s.simBalances[longExchange] ?? 0) + topUp } }));
        get().addLog('info', `[SIM] ${longExchange.toUpperCase()} 잔고 자동 충전 +$${topUp.toFixed(0)}`, longExchange);
      }

      const ts = Date.now();
      const isSnipe = get().snipeScheduled;
      const shortPos: SimPosition = {
        simId: `sim-${ts}-short`,
        exchange: shortExchange,
        symbol: opportunity.shortSymbol,
        displaySymbol: `${opportunity.baseAsset}/USDT`,
        baseAsset: opportunity.baseAsset,
        side: 'short',
        size: notional / opportunity.shortMarkPrice,
        sizeUSD: notional,
        entryPrice: opportunity.shortMarkPrice,
        markPrice: opportunity.shortMarkPrice,
        leverage,
        margin,
        unrealizedPnl: -entryFee,
        unrealizedPnlPercent: (-entryFee / margin) * 100,
        liquidationPrice: opportunity.shortMarkPrice * (1 + (1 / leverage) * 0.9),
        fundingRate: opportunity.shortRate,
        openedAt: ts,
        positionType: 'hedge_short',
        fundingCollected: 0,
        spread: opportunity.spread,
        nextFundingTime: opportunity.nextFundingTime,
        isSnipe,
        fundingReceived: 0,
        entryFee,
      };
      const longPos: SimPosition = {
        simId: `sim-${ts}-long`,
        exchange: longExchange,
        symbol: opportunity.longSymbol,
        displaySymbol: `${opportunity.baseAsset}/USDT`,
        baseAsset: opportunity.baseAsset,
        side: 'long',
        size: notional / opportunity.longMarkPrice,
        sizeUSD: notional,
        entryPrice: opportunity.longMarkPrice,
        markPrice: opportunity.longMarkPrice,
        leverage,
        margin,
        unrealizedPnl: -entryFee,
        unrealizedPnlPercent: (-entryFee / margin) * 100,
        liquidationPrice: opportunity.longMarkPrice * (1 - (1 / leverage) * 0.9),
        fundingRate: opportunity.longRate,
        openedAt: ts,
        positionType: 'hedge_long',
        fundingCollected: 0,
        spread: opportunity.spread,
        nextFundingTime: opportunity.nextFundingTime,
        isSnipe,
        fundingReceived: 0,
        entryFee,
      };

      const perFunding = notional * opportunity.spread;
      const totalEntryFees = entryFee * 2; // 양쪽 합산 진입 수수료
      set(s => ({
        simPositions: [...s.simPositions, shortPos, longPos],
        simBalances: {
          ...s.simBalances,
          [shortExchange]: s.simBalances[shortExchange] - totalCostPerSide,
          [longExchange]: s.simBalances[longExchange] - totalCostPerSide,
        },
      }));
      // 자동화 활성화 + 통계 업데이트
      if (!get().automationActive) {
        get().startAutomation();
      }
      set(s => ({
        automationStats: {
          ...s.automationStats,
          positionsOpened: s.automationStats.positionsOpened + 1,
        },
      }));
      const totalRoundTripFees = notional * ROUND_TRIP_FEE;
      const netProfit = perFunding - totalRoundTripFees;
      get().addLog('success',
        `[SIM] ${opportunity.baseAsset} 헷징 진입 완료`,
        undefined,
        `숏:${shortExchange.toUpperCase()} 롱:${longExchange.toUpperCase()} | 8h순수익: $${netProfit.toFixed(2)} (펀딩: $${perFunding.toFixed(2)} - 수수료: $${totalRoundTripFees.toFixed(2)})`,
      );
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

    // 복리 모드: 실제 잔고 기반 투자금 계산
    let realInvestment = strategyConfig.investmentUSDT;
    if (strategyConfig.compoundInvesting) {
      const shortBal = balances[opportunity.shortExchange]?.availableUSDT ?? 0;
      const longBal = balances[opportunity.longExchange]?.availableUSDT ?? 0;
      realInvestment = Math.min(shortBal, longBal) * 0.9; // 잔고의 90%
      if (realInvestment < strategyConfig.investmentUSDT * 0.5) {
        get().addLog('warning', `[복리] 실잔고 부족 — 최소 투자금으로 대체`, undefined,
          `숏: $${shortBal.toFixed(0)} 롱: $${longBal.toFixed(0)} → 투자금: $${realInvestment.toFixed(0)}`);
        realInvestment = strategyConfig.investmentUSDT; // fallback
      }
    }

    const profit = estimateProfit(opportunity, realInvestment, strategyConfig.leverage);
    get().addLog('info',
      `전략 실행 시작: ${opportunity.baseAsset} | 숏:${opportunity.shortExchange.toUpperCase()} 롱:${opportunity.longExchange.toUpperCase()}`,
      undefined,
      `투자금: $${realInvestment.toFixed(0)} | 예상 8h순수익: $${profit.netPerFunding.toFixed(2)} (수수료: -$${profit.totalFees.toFixed(2)})`,
    );

    set({ strategyRunning: true });

    try {
      const res = await fetch('/api/strategy/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunity,
          investmentUSDT: realInvestment,
          leverage: strategyConfig.leverage,
          apiConfigs,
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

      // Refresh positions after entry
      setTimeout(() => get().refreshPositions(), 2000);
      return json.success === true;
    } catch (err) {
      get().addLog('error', '전략 실행 중 오류 발생', undefined, (err as Error).message);
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
    set((s) => ({
      logs: [makeLog(level, message, exchange, detail), ...s.logs].slice(0, 500),
    }));
  },

  clearLogs() {
    set({ logs: [] });
  },

  // ── Simulation ────────────────────────────────
  toggleSimulationMode() {
    const next = !get().simulationMode;
    set({ simulationMode: next });
    get().addLog('info', next ? `[SIM] 시뮬레이션 모드 ON — 각 거래소 $${SIM_BALANCE_PER_EXCHANGE} 가상 잔고` : '[SIM] 시뮬레이션 모드 OFF');
  },

  resetSimulation() {
    const bal = SIM_BALANCE_PER_EXCHANGE;
    set({
      simPositions: [],
      simBalances: { binance: bal, bybit: bal, okx: bal, bitget: bal, gate: bal },
      simTotalFundingEarned: 0,
    });
    get().addLog('info', `[SIM] 초기화 완료 — 각 거래소 $${bal} 리셋`);
  },

  closeSimPosition(simId) {
    const pos = get().simPositions.find(p => p.simId === simId);
    if (!pos) return;
    const exitFee = pos.sizeUSD * TAKER_FEE;
    // 반환 = 마진 + 미실현 손익 + 수령 펀딩 - 청산 수수료
    const returnAmount = pos.margin + pos.unrealizedPnl + pos.fundingCollected - exitFee;
    const netPnl = pos.unrealizedPnl + pos.fundingCollected - exitFee;
    set(s => ({
      simPositions: s.simPositions.filter(p => p.simId !== simId),
      simBalances: { ...s.simBalances, [pos.exchange]: s.simBalances[pos.exchange] + returnAmount },
    }));
    get().addLog(netPnl >= 0 ? 'success' : 'warning',
      `[SIM] 포지션 청산: ${pos.displaySymbol} ${pos.side.toUpperCase()}`,
      pos.exchange,
      `순손익: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (펀딩: $${pos.fundingCollected.toFixed(4)}, PnL: $${pos.unrealizedPnl.toFixed(2)}, 수수료: -$${exitFee.toFixed(2)})`,
    );
  },

  tickSimFunding() {
    const { simPositions, fundingRates } = get();
    if (simPositions.length === 0) return;
    const now = Date.now();
    let totalNew = 0;
    const balanceDelta: Partial<Record<ExchangeId, number>> = {};

    const updated = simPositions.map(pos => {
      if (pos.nextFundingTime > now) return pos;
      // 실시간 펀딩률 조회 (없으면 진입 시 rate fallback)
      const liveRate = fundingRates.find(
        r => r.exchange === pos.exchange && r.symbol === pos.symbol,
      );
      const currentRate = liveRate?.rate ?? pos.fundingRate;
      // Effective funding from this position's perspective
      const funding = pos.side === 'short'
        ? pos.sizeUSD * currentRate            // short: positive rate = receive
        : pos.sizeUSD * (-currentRate);         // long:  negative rate = receive
      totalNew += funding;
      balanceDelta[pos.exchange] = (balanceDelta[pos.exchange] ?? 0) + funding;
      get().addLog(
        funding >= 0 ? 'success' : 'warning',
        `[SIM] 펀딩 ${funding >= 0 ? '수령' : '지불'}: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        pos.exchange,
        `$${Math.abs(funding).toFixed(4)} (${(currentRate * 100).toFixed(4)}%${liveRate ? '' : ' [진입시rate]'})`,
      );
      return {
        ...pos,
        fundingRate: currentRate, // 최신 rate로 갱신
        fundingCollected: pos.fundingCollected + funding,
        nextFundingTime: pos.nextFundingTime + 8 * 3600 * 1000,
        fundingReceived: (pos.fundingReceived ?? 0) + 1,
      };
    });

    if (totalNew === 0) { set({ simPositions: updated }); return; }

    // 스나이핑 포지션: 펀딩 수령 후 즉시 자동 청산
    const snipeToClose = updated.filter(p => p.isSnipe && (p.fundingReceived ?? 0) >= 1);
    if (snipeToClose.length > 0) {
      setTimeout(() => {
        for (const pos of snipeToClose) {
          get().closeSimPosition(pos.simId);
        }
        get().addLog('success',
          `[스나이핑] 펀딩 수령 완료 → ${snipeToClose.length}개 포지션 자동 청산`,
          undefined,
          `총 수령: $${snipeToClose.reduce((s, p) => s + p.fundingCollected, 0).toFixed(4)}`,
        );
        // 스나이핑 상태 리셋
        set({ snipeScheduled: false, snipeTargetTime: null, _snipeTimer: null });
      }, 500); // 약간의 딜레이로 UX 자연스럽게
    }

    set(s => {
      const newBal = { ...s.simBalances };
      for (const [ex, delta] of Object.entries(balanceDelta)) {
        newBal[ex as ExchangeId] = (newBal[ex as ExchangeId] ?? 0) + (delta as number);
      }
      return {
        simPositions: updated,
        simBalances: newBal,
        simTotalFundingEarned: s.simTotalFundingEarned + totalNew,
        automationStats: {
          ...s.automationStats,
          fundingCollected: s.automationStats.fundingCollected + totalNew,
        },
      };
    });
  },

  // ── UI ────────────────────────────────────────
  setShowApiPanel: (v) => set({ showApiPanel: v }),
  setShowStrategyPanel: (v) => set({ showStrategyPanel: v }),
  setRateFilter: (v) => set({ rateFilter: v }),
  setExchangeFilter: (v) => set({ exchangeFilter: v }),
  setPositionToClose: (v) => set({ positionToClose: v }),

  // ── WebSocket ─────────────────────────────────
  setWsStatus(exchange, status) {
    set((s) => ({ wsStatuses: { ...s.wsStatuses, [exchange]: status } }));
  },

  updateFundingRateWs(update) {
    set((s) => {
      const idx = s.fundingRates.findIndex(
        (r) => r.exchange === update.exchange && r.symbol === update.symbol,
      );
      let next: FundingRate[];
      if (idx >= 0) {
        next = [...s.fundingRates];
        next[idx] = {
          ...next[idx],
          rate: update.rate,
          ratePercent: update.rate * 100,
          markPrice: update.markPrice || next[idx].markPrice,
          nextFundingTime: update.nextFundingTime,
          updatedAt: Date.now(),
        };
      } else {
        // New symbol from WS — add it
        next = [
          ...s.fundingRates,
          {
            exchange: update.exchange,
            symbol: update.symbol,
            displaySymbol: `${update.baseAsset}/USDT`,
            baseAsset: update.baseAsset,
            rate: update.rate,
            ratePercent: update.rate * 100,
            markPrice: update.markPrice,
            nextFundingTime: update.nextFundingTime,
            intervalHours: 8,
            updatedAt: Date.now(),
          },
        ];
      }

      // Debounce opportunity recalculation (1s — fast enough for real-time)
      const prev = s._recalcTimeout;
      if (prev) clearTimeout(prev);
      const timeout = setTimeout(() => {
        const { fundingRates: current } = useFundingStore.getState();
        const opps = findOpportunities(current);
        useFundingStore.setState({ opportunities: opps, _recalcTimeout: null });
      }, 1000);

      // Update sim position markPrices + unrealizedPnl (including entry fee)
      const simPositions = get().simPositions.map(pos => {
        if (pos.baseAsset !== update.baseAsset || pos.exchange !== update.exchange) return pos;
        const mp = update.markPrice || pos.markPrice;
        const pricePnl = pos.side === 'short'
          ? (pos.entryPrice - mp) * pos.size
          : (mp - pos.entryPrice) * pos.size;
        const pnl = pricePnl - (pos.entryFee ?? 0); // 진입 수수료 차감
        return { ...pos, markPrice: mp, unrealizedPnl: pnl, unrealizedPnlPercent: (pnl / pos.margin) * 100, fundingRate: update.rate };
      });

      return { fundingRates: next, simPositions, _recalcTimeout: timeout };
    });
  },

  // ── Automation ──────────────────────────────
  startAutomation() {
    set({
      automationActive: true,
      automationStartedAt: Date.now(),
      automationStats: { fundingCollected: 0, positionsOpened: 0, autoExits: 0 },
    });
    get().addLog('success', '🤖 풀 자동화 시작 — 스프레드 감시 + 자동 청산 활성화');
  },

  stopAutomation() {
    const stats = get().automationStats;
    const elapsed = get().automationStartedAt ? Date.now() - get().automationStartedAt! : 0;
    const hours = (elapsed / 3600000).toFixed(1);
    set({ automationActive: false, automationStartedAt: null });
    get().addLog('info',
      `🤖 자동화 중지 — ${hours}시간 운영`,
      undefined,
      `진입: ${stats.positionsOpened}회 | 자동청산: ${stats.autoExits}회 | 펀딩수령: $${stats.fundingCollected.toFixed(4)}`,
    );
  },

  checkAutoExit() {
    const { simPositions, fundingRates, strategyConfig, automationActive, simulationMode } = get();
    if (!automationActive) return;

    const now = Date.now();
    const positionsToClose: string[] = [];

    // 헷지 페어별로 그룹핑 (같은 baseAsset, 같은 타임스탬프 기반)
    const pairGroups = new Map<string, SimPosition[]>();
    for (const pos of simPositions) {
      // 같은 시간(±1초)에 진입한 같은 코인 = 헷지 페어
      const pairKey = `${pos.baseAsset}-${Math.floor(pos.openedAt / 1000)}`;
      const group = pairGroups.get(pairKey) ?? [];
      group.push(pos);
      pairGroups.set(pairKey, group);
    }

    for (const [, pair] of pairGroups) {
      if (pair.length < 2) continue;
      const shortPos = pair.find(p => p.side === 'short');
      const longPos = pair.find(p => p.side === 'long');
      if (!shortPos || !longPos) continue;

      // 1. 스프레드 역전 감지
      if (strategyConfig.closeOnSpreadReverse) {
        const currentShortRate = fundingRates.find(
          r => r.exchange === shortPos.exchange && r.symbol === shortPos.symbol,
        )?.rate ?? shortPos.fundingRate;
        const currentLongRate = fundingRates.find(
          r => r.exchange === longPos.exchange && r.symbol === longPos.symbol,
        )?.rate ?? longPos.fundingRate;
        const currentSpread = currentShortRate - currentLongRate;

        if (currentSpread <= 0) {
          positionsToClose.push(shortPos.simId, longPos.simId);
          get().addLog('warning',
            `🔄 [자동청산] ${shortPos.baseAsset} 스프레드 역전 감지`,
            undefined,
            `진입 스프레드: +${(shortPos.spread * 100).toFixed(4)}% → 현재: ${(currentSpread * 100).toFixed(4)}%`,
          );
          continue;
        }
      }

      // 2. 최대 보유시간 초과
      const ageHours = (now - shortPos.openedAt) / 3600000;
      if (ageHours >= strategyConfig.maxPositionAgeHours) {
        positionsToClose.push(shortPos.simId, longPos.simId);
        get().addLog('warning',
          `⏰ [자동청산] ${shortPos.baseAsset} 최대 보유시간 ${strategyConfig.maxPositionAgeHours}시간 초과`,
          undefined,
          `보유시간: ${ageHours.toFixed(1)}시간`,
        );
        continue;
      }
    }

    // 청산 실행
    if (positionsToClose.length > 0) {
      for (const simId of positionsToClose) {
        if (simulationMode) {
          get().closeSimPosition(simId);
        }
      }
      set(s => ({
        automationStats: {
          ...s.automationStats,
          autoExits: s.automationStats.autoExits + positionsToClose.length / 2,
        },
      }));
    }
  },

  // ── Snipe (펀딩 직전 진입 → 수령 → 즉시 청산) ──
  scheduleSnipe(opportunity) {
    const { _snipeTimer } = get();
    if (_snipeTimer) clearTimeout(_snipeTimer);

    const now = Date.now();
    const ENTRY_BEFORE_MS = 30_000; // 펀딩 30초 전 진입
    const targetTime = opportunity.nextFundingTime;
    const delay = Math.max(0, targetTime - now - ENTRY_BEFORE_MS);

    if (delay <= 0) {
      // 이미 펀딩 시간 임박 → 즉시 진입 (최적 기회로 전환 가능)
      const { opportunities: currentOpps } = get();
      const bestNow = currentOpps.length > 0
        ? currentOpps.reduce((best, o) => o.spread > best.spread ? o : best, currentOpps[0])
        : null;
      const target = bestNow && bestNow.spread > ROUND_TRIP_FEE ? bestNow : opportunity;
      const switched = target.baseAsset !== opportunity.baseAsset;

      // 수익성 검증: 스프레드가 왕복 수수료를 커버 못하면 진입 거부
      if (target.spread <= ROUND_TRIP_FEE) {
        get().addLog('warning',
          `[스나이핑] 스프레드 ${target.spreadPercent.toFixed(4)}%가 왕복수수료 ${ROUND_TRIP_FEE_PERCENT}% 이하 — 진입 거부`,
          undefined,
          `수수료를 커버할 수 없어 손실 확정. 더 큰 스프레드를 기다리세요.`,
        );
        set({ snipeScheduled: false, snipeTargetTime: null, _snipeTimer: null });
        return;
      }

      set({ snipeScheduled: true, snipeTargetTime: targetTime });
      if (switched) {
        get().addLog('info',
          `[스나이핑] 최적 기회 변경: ${opportunity.baseAsset} → ${target.baseAsset}`,
          undefined,
          `스프레드: +${target.spreadPercent.toFixed(4)}%`,
        );
      }
      get().executeStrategy(target).then((success) => {
        if (success) {
          set({ snipeScheduled: false, snipeTargetTime: null, _snipeTimer: null });
          get().addLog('success',
            `[스나이핑] 펀딩 임박! ${target.baseAsset} 즉시 진입`,
            undefined,
            `펀딩까지 ${((targetTime - now) / 1000).toFixed(0)}초 남음${switched ? ` [${opportunity.baseAsset}에서 전환]` : ''}`,
          );
        } else {
          set({ snipeScheduled: false, snipeTargetTime: null, _snipeTimer: null });
          get().addLog('error', `[스나이핑] ${target.baseAsset} 즉시 진입 실패 — 스나이핑 해제`);
        }
      });
      return;
    }

    // 실행 시점에 전체 opportunities에서 최적 기회를 선택 (예약 코인에 고정하지 않음)
    const capturedOpportunity = { ...opportunity };
    const timer = setTimeout(() => {
      const { opportunities } = get();
      // 전체 기회 중 스프레드가 가장 큰 최적 기회를 선택
      const bestNow = opportunities.length > 0
        ? opportunities.reduce((best, o) => o.spread > best.spread ? o : best, opportunities[0])
        : null;
      const target = bestNow && bestNow.spread > ROUND_TRIP_FEE ? bestNow : capturedOpportunity;
      const switched = target.baseAsset !== capturedOpportunity.baseAsset;

      if (target.spread <= ROUND_TRIP_FEE) {
        get().addLog('warning',
          `[스나이핑] 진입 시점 스프레드 ${target.spreadPercent.toFixed(4)}%가 왕복수수료 ${ROUND_TRIP_FEE_PERCENT}% 이하 — 손실 방지를 위해 취소`,
          undefined,
          `최적 코인: ${target.baseAsset} | 필요 최소 스프레드: ${ROUND_TRIP_FEE_PERCENT}%`,
        );
        set({ snipeScheduled: false, snipeTargetTime: null, _snipeTimer: null });
        return;
      }

      if (switched) {
        get().addLog('info',
          `[스나이핑] 최적 기회 변경: ${capturedOpportunity.baseAsset} → ${target.baseAsset}`,
          undefined,
          `스프레드: +${target.spreadPercent.toFixed(4)}%`,
        );
      }

      get().executeStrategy(target).then((success) => {
        if (success) {
          set({ snipeScheduled: false, snipeTargetTime: null, _snipeTimer: null });
          get().addLog('success',
            `[스나이핑] ${target.baseAsset} 자동 진입 완료!`,
            undefined,
            `펀딩까지 ~30초 | 스프레드: +${target.spreadPercent.toFixed(4)}%${switched ? ` [${capturedOpportunity.baseAsset}에서 전환]` : ''}`,
          );
        } else {
          // 진입 실패 시 스나이핑 상태 해제
          set({ snipeScheduled: false, snipeTargetTime: null, _snipeTimer: null });
          get().addLog('error', `[스나이핑] ${target.baseAsset} 자동 진입 실패 — 스나이핑 해제`);
        }
      });
    }, delay);

    set({ snipeScheduled: true, snipeTargetTime: targetTime, _snipeTimer: timer });
    get().addLog('info',
      `[스나이핑] ${opportunity.baseAsset} 예약 완료`,
      undefined,
      `${(delay / 60000).toFixed(1)}분 후 자동 진입 → 펀딩 수령 → 즉시 청산`,
    );
  },

  cancelSnipe() {
    const { _snipeTimer } = get();
    if (_snipeTimer) clearTimeout(_snipeTimer);
    set({ snipeScheduled: false, snipeTargetTime: null, _snipeTimer: null });
    get().addLog('info', '[스나이핑] 예약 취소됨');
  },

  async fetchFundingHistory() {
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
    set({ fundingHistory: allHistory, isLoadingHistory: false });
  },
}));
