export type ExchangeId = 'binance' | 'bybit' | 'okx' | 'bitget' | 'gate' | 'bingx';

export const EXCHANGE_NAMES: Record<ExchangeId, string> = {
  binance: 'BINANCE',
  bybit: 'BYBIT',
  okx: 'OKX',
  bitget: 'BITGET',
  gate: 'GATE',
  bingx: 'BINGX',
};

export const EXCHANGE_COLORS: Record<ExchangeId, string> = {
  binance: '#F0B90B',
  bybit: '#F7A600',
  okx: '#00C087',
  bitget: '#00C5C5',
  gate: '#00B2FF',
  bingx: '#2354E6',
};

export const EXCHANGE_BG: Record<ExchangeId, string> = {
  binance: 'rgba(240,185,11,0.12)',
  bybit: 'rgba(247,166,0,0.12)',
  okx: 'rgba(0,192,135,0.12)',
  bitget: 'rgba(0,197,197,0.12)',
  gate: 'rgba(0,178,255,0.12)',
  bingx: 'rgba(35,84,230,0.12)',
};

export interface FundingRate {
  exchange: ExchangeId;
  symbol: string;       // CCXT unified: 'BTC/USDT:USDT'
  displaySymbol: string; // 'BTC/USDT'
  baseAsset: string;    // 'BTC'
  rate: number;         // raw decimal e.g. 0.0001
  ratePercent: number;  // 0.01 (percent)
  nextFundingTime: number; // ms timestamp
  markPrice: number;
  intervalHours: number;  // 8
  updatedAt: number;    // ms timestamp
}

export interface ArbitrageOpportunity {
  id: string;
  baseAsset: string;     // 'BTC'
  // Short side (high positive funding → receive fee)
  shortExchange: ExchangeId;
  shortSymbol: string;
  shortRate: number;
  shortRatePercent: number;
  shortMarkPrice: number;
  // Long side (low/negative funding → receive fee or pay little)
  longExchange: ExchangeId;
  longSymbol: string;
  longRate: number;
  longRatePercent: number;
  longMarkPrice: number;
  // Metrics
  spread: number;        // shortRate - longRate (per 8h)
  spreadPercent: number;
  annualReturnPercent: number; // spread * 3 * 365 * 100
  nextFundingTime: number;
  minutesToFunding: number;
  fundingIntervalMs: number;  // 펀딩 주기 (ms) — 거래소/코인별 다름 (기본 8h=28800000)
  netProfit: number;          // 수수료 차감 후 순수익 per funding (notional*spread - notional*0.0005*4)
}

export type OrderLiquidity = 'maker' | 'taker' | 'mixed';

export interface Position {
  exchange: ExchangeId;
  symbol: string;
  displaySymbol: string;
  baseAsset: string;
  side: 'long' | 'short';
  size: number;       // in base asset
  sizeUSD: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  margin: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  liquidationPrice: number;
  fundingRate: number;
  openedAt: number;
  positionType: 'hedge_long' | 'hedge_short' | 'manual';
  pairId?: string;
  entryFee?: number;
  entryOrderLiquidity?: OrderLiquidity;
  entryFilledNotional?: number;
}

export interface Balance {
  exchange: ExchangeId;
  totalUSDT: number;
  availableUSDT: number;
  usedUSDT: number;
  unrealizedPnl: number;
  status: 'connected' | 'error' | 'disconnected';
  updatedAt: number;
}

export interface ApiConfig {
  apiKey: string;
  secret: string;
  passphrase?: string; // for OKX, Bitget
}

export interface StrategyConfig {
  investmentUSDT: number;   // per side (total = 2x for hedge)
  leverage: number;         // 1-20
  minSpreadPercent: number; // minimum spread to enter (e.g., 0.05%)
  autoExecute: boolean;     // auto enter at funding time
  compoundInvesting: boolean; // true = reinvest profits (복리), false = fixed amount (단리)
  feeOverrides?: FeeOverrides; // 사용자 수수료 override
  timingConfig?: TimingConfig; // 스나이프/펀딩 검증 타이밍 설정
}

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  exchange?: ExchangeId;
  detail?: string;
}

export interface FundingPayment {
  exchange: ExchangeId;
  symbol: string;
  amount: number;
  rate: number;
  timestamp: number;
  side: 'long' | 'short';
}

export interface SimPosition extends Position {
  simId: string;
  pairId?: string;          // hedge pair identifier for robust auto-exit grouping
  fundingCollected: number;
  spread: number;           // shortRate - longRate at entry
  nextFundingTime: number;  // ms timestamp of next funding
  isSnipe?: boolean;        // true = 펀딩 스나이핑 (수령 후 자동 청산)
  fundingReceived?: number; // snipe: 펀딩 수령 횟수
  entryFee: number;         // 진입 수수료 (WS 가격 갱신 시 PnL에 반영)
  fundingIntervalMs?: number; // 펀딩 주기 (ms) — 코인별 다름 (기본 8h)
  entryGapPercent?: number; // 숏/롱 체결가 갭 (%) — orderbook 기반
}

export interface SimStateSnapshot {
  simBalances: Record<ExchangeId, number>;
  simInitialBalances: Record<ExchangeId, number>;
  simPositions: SimPosition[];
  simTotalFundingEarned: number;
  simTotalTopUps: number;
  simTotalFees: number;
  simTotalClosedPnl: number;
  simClosedPnlPerExchange: Partial<Record<ExchangeId, number>>;
  simClosedFeesPerExchange: Partial<Record<ExchangeId, number>>;
  fundingHistory: FundingPayment[];
  updatedAt: number;
}

export interface SnipeStateSnapshot {
  simSnipeActive: boolean;
  realSnipeActive: boolean;
  simulationMode: boolean;
  updatedAt: number;
}

export const SUPPORTED_EXCHANGES: ExchangeId[] = ['binance', 'bybit', 'okx', 'bitget', 'gate', 'bingx'];

// ── Per-exchange fee matrix (VIP0 / basic tier, USDT-M futures) ──
// Source: official fee schedules as of 2026-03
export interface ExchangeFees {
  taker: number;  // decimal (0.0005 = 0.05%)
  maker: number;  // decimal (0.0002 = 0.02%)
}

export type FeeOverrides = Partial<Record<ExchangeId, ExchangeFees>>;

export interface TimingConfig {
  entryLeadMs: number;
  closeDelayMs: number;
  fundingVerifyRetryMs: number;
  fundingVerifyAttempts: number;
}

export const DEFAULT_TIMING_CONFIG: TimingConfig = {
  entryLeadMs: 5_000,
  closeDelayMs: 2_000,
  fundingVerifyRetryMs: 5_000,
  fundingVerifyAttempts: 3,
};

const MAX_REASONABLE_FEE_RATE = 0.1;

function isValidFeeRate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_REASONABLE_FEE_RATE;
}

function isValidTimingMs(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= min
    && value <= max;
}

function isValidTimingCount(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= min
    && value <= max;
}

export function hasValidFeeOverrides(overrides: unknown): overrides is FeeOverrides {
  if (overrides == null) return true;
  if (typeof overrides !== 'object') return false;

  for (const [exchange, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!SUPPORTED_EXCHANGES.includes(exchange as ExchangeId)) return false;
    if (!value || typeof value !== 'object') return false;

    const fees = value as Record<string, unknown>;
    if (!isValidFeeRate(fees.maker) || !isValidFeeRate(fees.taker)) return false;
  }

  return true;
}

export function sanitizeFeeOverrides(overrides: unknown): FeeOverrides | undefined {
  if (overrides == null || typeof overrides !== 'object') return undefined;

  const sanitized: FeeOverrides = {};
  for (const exchange of SUPPORTED_EXCHANGES) {
    const rawValue = (overrides as Record<string, unknown>)[exchange];
    if (!rawValue || typeof rawValue !== 'object') continue;

    const fees = rawValue as Record<string, unknown>;
    if (!isValidFeeRate(fees.maker) || !isValidFeeRate(fees.taker)) continue;

    sanitized[exchange] = {
      maker: fees.maker,
      taker: fees.taker,
    };
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function hasValidTimingConfig(config: unknown): config is TimingConfig {
  if (config == null) return true;
  if (!config || typeof config !== 'object') return false;

  const timing = config as Record<string, unknown>;
  return isValidTimingMs(timing.entryLeadMs, 0, 60_000)
    && isValidTimingMs(timing.closeDelayMs, 0, 60_000)
    && isValidTimingMs(timing.fundingVerifyRetryMs, 1_000, 120_000)
    && isValidTimingCount(timing.fundingVerifyAttempts, 1, 20);
}

export function sanitizeTimingConfig(config: unknown): TimingConfig | undefined {
  if (!hasValidTimingConfig(config)) return undefined;
  if (config == null) return undefined;

  const timing = config as TimingConfig;
  return {
    entryLeadMs: timing.entryLeadMs,
    closeDelayMs: timing.closeDelayMs,
    fundingVerifyRetryMs: timing.fundingVerifyRetryMs,
    fundingVerifyAttempts: timing.fundingVerifyAttempts,
  };
}

export function getResolvedTimingConfig(config?: Partial<TimingConfig> | null): TimingConfig {
  const sanitized = sanitizeTimingConfig(config);
  return sanitized ? sanitized : { ...DEFAULT_TIMING_CONFIG };
}

export const EXCHANGE_FEES: Record<ExchangeId, ExchangeFees> = {
  binance: { taker: 0.00050, maker: 0.00020 },  // 0.050% / 0.020%
  bybit:   { taker: 0.00055, maker: 0.00020 },  // 0.055% / 0.020%
  okx:     { taker: 0.00050, maker: 0.00020 },  // 0.050% / 0.020%
  bitget:  { taker: 0.00060, maker: 0.00020 },  // 0.060% / 0.020%
  gate:    { taker: 0.00050, maker: 0.00020 },  // 0.050% / 0.020%
  bingx:   { taker: 0.00050, maker: 0.00020 },  // 0.050% / 0.020%
};

/** Get round-trip fee for a hedge pair (entry + exit on both sides) */
export function getHedgeFees(
  shortEx: ExchangeId,
  longEx: ExchangeId,
  orderType: 'taker' | 'maker' = 'taker',
): number {
  const shortFee = EXCHANGE_FEES[shortEx][orderType];
  const longFee = EXCHANGE_FEES[longEx][orderType];
  // Round trip = 4 trades: open short + open long + close short + close long
  return (shortFee + longFee) * 2;
}

/** Get single-side fee */
export function getExchangeFee(
  exchange: ExchangeId,
  orderType: 'taker' | 'maker' = 'taker',
  overrides?: FeeOverrides,
): number {
  const overrideFees = overrides?.[exchange];
  const fees = overrideFees
    && isValidFeeRate(overrideFees.maker)
    && isValidFeeRate(overrideFees.taker)
    ? overrideFees
    : EXCHANGE_FEES[exchange];
  return fees[orderType];
}

/** Get effective fees considering user overrides */
export function getEffectiveExchangeFees(
  exchange: ExchangeId,
  overrides?: FeeOverrides,
): ExchangeFees {
  const overrideFees = overrides?.[exchange];
  return overrideFees
    && isValidFeeRate(overrideFees.maker)
    && isValidFeeRate(overrideFees.taker)
    ? overrideFees
    : EXCHANGE_FEES[exchange];
}

/** Get round-trip hedge fees with optional overrides */
export function getHedgeFeesWithOverrides(
  shortEx: ExchangeId,
  longEx: ExchangeId,
  orderType: 'taker' | 'maker' = 'taker',
  overrides?: FeeOverrides,
): number {
  const shortFee = getExchangeFee(shortEx, orderType, overrides);
  const longFee = getExchangeFee(longEx, orderType, overrides);
  return (shortFee + longFee) * 2;
}

/**
 * ★ 통합 순수익 계산식 — 모든 진입 판단/표시에 이 함수를 사용
 *
 * netSpreadPct = spreadPct - entryGapPct*1.5 - hedgeFeePct - safetyMarginPct
 *
 * @param spreadPercent   - 명목 스프레드 (%)
 * @param entryGapPct     - 진입 가격 갭 (%) — 양수 = 진입 손실
 * @param hedgeFeePct     - 왕복 수수료 (%) — getHedgeFees * 100
 * @param safetyMarginPct - 안전 마진 (%) — 기본 0.03 (3bps)
 */
export const SAFETY_MARGIN_PCT = 0.03; // 3bps — 전역 상수

export function calcNetSpreadPercent(
  spreadPercent: number,
  entryGapPct: number,
  hedgeFeePct: number,
  safetyMarginPct: number = SAFETY_MARGIN_PCT,
): number {
  return spreadPercent - entryGapPct * 1.5 - hedgeFeePct - safetyMarginPct;
}

// Popular symbols to track (top coins by OI)
export const TRACKED_SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
  'LTC', 'BCH', 'NEAR', 'ATOM', 'UNI', 'APT', 'OP', 'ARB', 'INJ', 'SUI',
  'TRX', 'MATIC', 'FIL', 'SAND', 'MANA', 'AXS', 'AAVE', 'EOS', 'XLM', 'VET',
  'ICP', 'HBAR', 'FTM', 'ALGO', 'RUNE', 'THETA', 'EGLD', 'FLOW', 'ETC', 'XMR',
];
