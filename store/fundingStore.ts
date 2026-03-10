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

  // Simulation
  simulationMode: boolean;
  simBalances: Record<ExchangeId, number>;
  simPositions: SimPosition[];
  simTotalFundingEarned: number;

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

  executeStrategy: (opportunity: ArbitrageOpportunity) => Promise<void>;
  closePosition: (position: Position) => Promise<void>;
  testConnection: (exchange: ExchangeId) => Promise<boolean>;

  addLog: (level: LogLevel, message: string, exchange?: ExchangeId, detail?: string) => void;
  clearLogs: () => void;

  // Simulation actions
  toggleSimulationMode: () => void;
  resetSimulation: () => void;
  closeSimPosition: (simId: string) => void;
  tickSimFunding: () => void;

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
    minSpreadPercent: 0.05,
    autoExecute: false,
    closeOnSpreadReverse: false,
    maxPositionAgeHours: 72,
  },
  fundingHistory: [],
  simulationMode: true,
  simBalances: { binance: 1000, bybit: 1000, okx: 1000, bitget: 1000, gate: 1000 },
  simPositions: [],
  simTotalFundingEarned: 0,
  isLoadingRates: false,
  isLoadingPositions: false,
  isLoadingHistory: false,
  strategyRunning: false,
  connectedExchanges: [],
  lastRatesUpdate: null,
  lastPositionsUpdate: null,
  wsStatuses: {},
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
      // 투자금 변경 시 시뮬 잔고 자동 동기화
      if (config.investmentUSDT !== undefined && config.investmentUSDT !== s.strategyConfig.investmentUSDT) {
        const bal = config.investmentUSDT;
        return {
          strategyConfig: next,
          simBalances: { binance: bal, bybit: bal, okx: bal, bitget: bal, gate: bal },
          simPositions: [],
          simTotalFundingEarned: 0,
        };
      }
      return { strategyConfig: next };
    });
  },

  // ── Refresh rates ─────────────────────────────
  async refreshRates() {
    set({ isLoadingRates: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch('/api/funding-rates', { signal: controller.signal });
      const json = await res.json() as {
        success: boolean;
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
        });
        get().addLog('success', `펀딩률 업데이트: ${json.data.rates.length}개 데이터`, undefined,
          `기회: ${json.data.opportunities.length}개`);

        if (json.data.errors.length > 0) {
          for (const e of json.data.errors) {
            get().addLog('warning', `${(e.exchange || '?').toUpperCase()} 펀딩률 오류`, e.exchange, e.error);
          }
        }
      }
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'AbortError') {
        get().addLog('warning', '펀딩률 조회 타임아웃 (30s) — 재시도 예정', undefined);
      } else {
        get().addLog('error', '펀딩률 조회 실패', undefined, (err as Error).message);
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
    }, 30_000); // 30s

    const positionsInterval = setInterval(() => {
      get().refreshPositions();
      get().refreshBalances();
      get().tickSimFunding();
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
    const { apiConfigs, strategyConfig, simulationMode, simBalances } = get();

    // ── Simulation branch ──────────────────────
    if (simulationMode) {
      const margin = strategyConfig.investmentUSDT;
      const leverage = strategyConfig.leverage;
      const notional = margin * leverage;
      const { shortExchange, longExchange } = opportunity;

      if ((simBalances[shortExchange] ?? 0) < margin) {
        get().addLog('error', `[SIM] ${shortExchange.toUpperCase()} 시뮬 잔고 부족 ($${simBalances[shortExchange]?.toFixed(2)})`, shortExchange);
        return;
      }
      if ((simBalances[longExchange] ?? 0) < margin) {
        get().addLog('error', `[SIM] ${longExchange.toUpperCase()} 시뮬 잔고 부족 ($${simBalances[longExchange]?.toFixed(2)})`, longExchange);
        return;
      }

      const ts = Date.now();
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
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        liquidationPrice: opportunity.shortMarkPrice * (1 + (1 / leverage) * 0.9),
        fundingRate: opportunity.shortRate,
        openedAt: ts,
        positionType: 'hedge_short',
        fundingCollected: 0,
        spread: opportunity.spread,
        nextFundingTime: opportunity.nextFundingTime,
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
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        liquidationPrice: opportunity.longMarkPrice * (1 - (1 / leverage) * 0.9),
        fundingRate: opportunity.longRate,
        openedAt: ts,
        positionType: 'hedge_long',
        fundingCollected: 0,
        spread: opportunity.spread,
        nextFundingTime: opportunity.nextFundingTime,
      };

      const perFunding = notional * opportunity.spread;
      set(s => ({
        simPositions: [...s.simPositions, shortPos, longPos],
        simBalances: {
          ...s.simBalances,
          [shortExchange]: s.simBalances[shortExchange] - margin,
          [longExchange]: s.simBalances[longExchange] - margin,
        },
      }));
      get().addLog('success',
        `[SIM] ${opportunity.baseAsset} 헷징 진입 완료`,
        undefined,
        `숏:${shortExchange.toUpperCase()} 롱:${longExchange.toUpperCase()} | 8h예상수익: $${perFunding.toFixed(2)}`,
      );
      return;
    }

    // ── Real trading branch ────────────────────
    const shortConfig = apiConfigs[opportunity.shortExchange];
    const longConfig = apiConfigs[opportunity.longExchange];

    if (!shortConfig) {
      get().addLog('error', `${opportunity.shortExchange.toUpperCase()} API 키 없음`, opportunity.shortExchange);
      return;
    }
    if (!longConfig) {
      get().addLog('error', `${opportunity.longExchange.toUpperCase()} API 키 없음`, opportunity.longExchange);
      return;
    }

    const profit = estimateProfit(opportunity, strategyConfig.investmentUSDT, strategyConfig.leverage);
    get().addLog('info',
      `전략 실행 시작: ${opportunity.baseAsset} | 숏:${opportunity.shortExchange.toUpperCase()} 롱:${opportunity.longExchange.toUpperCase()}`,
      undefined,
      `예상 8h수익: $${profit.perFunding.toFixed(2)}`,
    );

    set({ strategyRunning: true });

    try {
      const res = await fetch('/api/strategy/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunity,
          investmentUSDT: strategyConfig.investmentUSDT,
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
    } catch (err) {
      get().addLog('error', '전략 실행 중 오류 발생', undefined, (err as Error).message);
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
      return;
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
      }
    } catch (err) {
      get().addLog('error', '청산 중 오류', position.exchange, (err as Error).message);
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
    const bal = get().strategyConfig.investmentUSDT;
    set({ simulationMode: next });
    get().addLog('info', next ? `[SIM] 시뮬레이션 모드 ON — 각 거래소 $${bal.toLocaleString()} 가상 잔고` : '[SIM] 시뮬레이션 모드 OFF');
  },

  resetSimulation() {
    const bal = get().strategyConfig.investmentUSDT;
    set({
      simPositions: [],
      simBalances: { binance: bal, bybit: bal, okx: bal, bitget: bal, gate: bal },
      simTotalFundingEarned: 0,
    });
    get().addLog('info', `[SIM] 초기화 완료 — 각 거래소 $${bal.toLocaleString()} 리셋`);
  },

  closeSimPosition(simId) {
    const pos = get().simPositions.find(p => p.simId === simId);
    if (!pos) return;
    const returnAmount = pos.margin + pos.fundingCollected;
    set(s => ({
      simPositions: s.simPositions.filter(p => p.simId !== simId),
      simBalances: { ...s.simBalances, [pos.exchange]: s.simBalances[pos.exchange] + returnAmount },
    }));
    get().addLog('info',
      `[SIM] 포지션 청산: ${pos.displaySymbol} ${pos.side.toUpperCase()}`,
      pos.exchange,
      `마진 반환: $${pos.margin.toFixed(2)} | 수령 펀딩: $${pos.fundingCollected.toFixed(4)}`,
    );
  },

  tickSimFunding() {
    const { simPositions } = get();
    if (simPositions.length === 0) return;
    const now = Date.now();
    let totalNew = 0;
    const balanceDelta: Partial<Record<ExchangeId, number>> = {};

    const updated = simPositions.map(pos => {
      if (pos.nextFundingTime > now) return pos;
      // Effective funding from this position's perspective
      const funding = pos.side === 'short'
        ? pos.sizeUSD * pos.fundingRate          // short: positive rate = receive
        : pos.sizeUSD * (-pos.fundingRate);       // long:  negative rate = receive
      totalNew += funding;
      balanceDelta[pos.exchange] = (balanceDelta[pos.exchange] ?? 0) + funding;
      get().addLog(
        funding >= 0 ? 'success' : 'warning',
        `[SIM] 펀딩 ${funding >= 0 ? '수령' : '지불'}: ${pos.baseAsset} ${pos.side.toUpperCase()}`,
        pos.exchange,
        `$${Math.abs(funding).toFixed(4)} (${(pos.fundingRate * 100).toFixed(4)}%)`,
      );
      return {
        ...pos,
        fundingCollected: pos.fundingCollected + funding,
        nextFundingTime: pos.nextFundingTime + 8 * 3600 * 1000,
      };
    });

    if (totalNew === 0) { set({ simPositions: updated }); return; }

    set(s => {
      const newBal = { ...s.simBalances };
      for (const [ex, delta] of Object.entries(balanceDelta)) {
        newBal[ex as ExchangeId] = (newBal[ex as ExchangeId] ?? 0) + (delta as number);
      }
      return { simPositions: updated, simBalances: newBal, simTotalFundingEarned: s.simTotalFundingEarned + totalNew };
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

      // Debounce opportunity recalculation (3s)
      const prev = s._recalcTimeout;
      if (prev) clearTimeout(prev);
      const timeout = setTimeout(() => {
        const { fundingRates: current } = useFundingStore.getState();
        const opps = findOpportunities(current);
        useFundingStore.setState({ opportunities: opps, _recalcTimeout: null });
      }, 3000);

      // Update sim position markPrices + unrealizedPnl
      const simPositions = get().simPositions.map(pos => {
        if (pos.baseAsset !== update.baseAsset || pos.exchange !== update.exchange) return pos;
        const mp = update.markPrice || pos.markPrice;
        const pnl = pos.side === 'short'
          ? (pos.entryPrice - mp) * pos.size
          : (mp - pos.entryPrice) * pos.size;
        return { ...pos, markPrice: mp, unrealizedPnl: pnl, unrealizedPnlPercent: (pnl / pos.margin) * 100, fundingRate: update.rate };
      });

      return { fundingRates: next, simPositions, _recalcTimeout: timeout };
    });
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
