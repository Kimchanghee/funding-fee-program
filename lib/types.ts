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
  quoteVolume24h?: number; // 24h USDT trading volume
  updatedAt: number;    // ms timestamp
}

export interface ArbitrageOpportunity {
  id: string;
  baseAsset: string;     // 'BTC'
  // Short side (high positive funding ??receive fee)
  shortExchange: ExchangeId;
  shortSymbol: string;
  shortRate: number;
  shortRatePercent: number;
  shortMarkPrice: number;
  // Long side (low/negative funding ??receive fee or pay little)
  longExchange: ExchangeId;
  longSymbol: string;
  longRate: number;
  longRatePercent: number;
  longMarkPrice: number;
  // Metrics
  spread: number;        // shortRate - longRate (per 8h)
  spreadPercent: number;
  annualReturnPercent: number; // fee/slippage-aware estimated annualized return (%)
  nextFundingTime: number;
  minutesToFunding: number;
  fundingIntervalMs: number;  // ?�??주기 (ms) ??거래??코인�??�름 (기본 8h=28800000)
  netProfit: number;          // estimated net profit per funding after configured fees/safety
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
  compoundInvesting: boolean; // true = reinvest profits (복리), false = fixed amount (?�리)
  feeOverrides?: FeeOverrides; // ?�용???�수�?override
  timingConfig?: TimingConfig; // ?�나?�프/?�??검�??�?�밍 ?�정
  maxSlippagePercent?: number; // 최�? ?�리?��? % (기본 1.5%) ?????�상?�면 ?�동??부족으�??�터�?
  minVolume24hUSD?: number; // 최소 24?�간 거래??(USD) ??기본 $7,500,000 (??00?�원)
  confirmedSnipeConfig?: ConfirmedSnipeConfig; // v2.1 — undefined = all features OFF
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
  isSnipe?: boolean;        // true = ?�???�나?�핑 (?�령 ???�동 �?��)
  fundingReceived?: number; // snipe: ?�???�령 ?�수
  entryFee: number;         // 진입 ?�수�?(WS 가�?갱신 ??PnL??반영)
  fundingIntervalMs?: number; // ?�??주기 (ms) ??코인�??�름 (기본 8h)
  entryGapPercent?: number; // ??�?체결가 �?(%) ??orderbook 기반
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

// Per-exchange fee matrix used by all profit/guard calculations.
// Baseline is the referral max-discount preset.
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
  entryLeadMs: 3_500,
  closeDelayMs: 1_000,
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

export const EXCHANGE_FEE_PRESET_ID = 'referral_max';
export const EXCHANGE_FEE_PRESET_LABEL = 'REFERRAL MAX';
export const EXCHANGE_FEE_PRESET_NOTE = 'Referral max-discount fee table is applied by default.';

// Referral max-discount default table (USDT-M futures).
// User feeOverrides still take precedence when provided.
export const EXCHANGE_FEES: Record<ExchangeId, ExchangeFees> = {
  binance: { taker: 0.00040, maker: 0.00016 },  // 0.040% / 0.016%
  bybit:   { taker: 0.00044, maker: 0.00016 },  // 0.044% / 0.016%
  okx:     { taker: 0.00040, maker: 0.00016 },  // 0.040% / 0.016%
  bitget:  { taker: 0.00048, maker: 0.00016 },  // 0.048% / 0.016%
  gate:    { taker: 0.00040, maker: 0.00016 },  // 0.040% / 0.016%
  bingx:   { taker: 0.00040, maker: 0.00016 },  // 0.040% / 0.016%
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
 * ???�합 ?�수??계산????모든 진입 ?�단/?�시?????�수�??�용
 *
 * netSpreadPct = spreadPct - entryGapPct*1.1 - hedgeFeePct - safetyMarginPct
 *
 * @param spreadPercent   - 명목 ?�프?�드 (%)
 * @param entryGapPct     - 진입 가�?�?(%) ???�수 = 진입 ?�실
 * @param hedgeFeePct     - ?�복 ?�수�?(%) ??getHedgeFees * 100
 * @param safetyMarginPct - ?�전 마진 (%) ??기본 0.015 (1.5bps)
 */
export const SAFETY_MARGIN_PCT = 0.015; // 1.5bps ???�역 ?�수 (?�리?��? 가?��? 별도 보호)

// ── v2.1 Confirmed Snipe constants ──

/** Target impact per leg in basis points (4bps = 0.04%) */
export const TARGET_IMPACT_BPS = 4;

/** Hard cap for round-trip total impact in basis points */
export const MAX_ROUND_TRIP_IMPACT_BPS = 12;

/** Maximum allowed hedge ratio deviation: 0.998 <= ratio <= 1.002 */
export const HEDGE_RATIO_MIN = 0.998;
export const HEDGE_RATIO_MAX = 1.002;

/** Maximum allowed qty mismatch percent */
export const MAX_HEDGE_MISMATCH_PCT = 0.20;

/** Maximum orphan leg exposure time in ms */
export const MAX_ORPHAN_LEG_MS = 300;

/** Minimum expected net USD profit to enter */
export const MIN_PROFIT_USD = 1.25;

/** Minimum EV ratio: expectedNetUSD / worstCaseExitUSD */
export const MIN_EV_RATIO = 1.8;

/** Maximum funding timestamp difference between two legs in ms */
export const MAX_FUNDING_TIMESTAMP_DIFF_MS = 3_000;

/** Minimum free margin percentage to maintain */
export const MIN_FREE_MARGIN_PCT = 65;

/** Default funding drift buffer minimum in basis points */
export const MIN_DRIFT_BUFFER_BPS = 1; // 0.01%

/**
 * v2.1 Confirmed Snipe configuration.
 * All features default to OFF — existing behavior is 100% preserved
 * unless explicitly enabled.
 */
export interface ConfirmedSnipeConfig {
  /** Use impact-based guards instead of maxSlippagePercent */
  useImpactGuards: boolean;
  /** Target impact per leg (bps) — default 4 */
  targetImpactBps: number;
  /** Hard cap round-trip impact (bps) — default 12 */
  maxRoundTripImpactBps: number;
  /** Use dynamic notional based on orderbook depth (no floor — skip if unviable) */
  useDynamicNotional: boolean;
  /** Max dynamic notional cap ($) */
  dynamicNotionalCap: number;
  /** Use funding drift buffers */
  useDriftBuffer: boolean;
  /** Use confirmed close (wait for funding settlement) instead of fixed delay */
  useConfirmedClose: boolean;
  /** Use IOC-limit only (no Post-Only cascade) */
  useIocLimitOnly: boolean;
  /** Use strict hedge enforcement (0.20% mismatch, hedgeRatio check) */
  useStrictHedge: boolean;
}

/** All OFF by default — opt-in per feature */
export const DEFAULT_CONFIRMED_SNIPE_CONFIG: ConfirmedSnipeConfig = {
  useImpactGuards: false,
  targetImpactBps: TARGET_IMPACT_BPS,
  maxRoundTripImpactBps: MAX_ROUND_TRIP_IMPACT_BPS,
  useDynamicNotional: false,
  dynamicNotionalCap: 2200,
  useDriftBuffer: false,
  useConfirmedClose: false,
  useIocLimitOnly: false,
  useStrictHedge: false,
};

export function calcNetSpreadPercent(
  spreadPercent: number,
  entryGapPct: number,
  hedgeFeePct: number,
  safetyMarginPct: number = SAFETY_MARGIN_PCT,
): number {
  return spreadPercent - entryGapPct * 1.1 - hedgeFeePct - safetyMarginPct;
}

/**
 * ??Equal-notional ?�나?�프 ?�수??계산
 *
 * ?�쪽 ?�일 notional ??가�?변???�징 100%, ?�??= notional × spread.
 * 거래??�?가�?괴리(basis)??같�? 거래?�에???�고 ?�으므�?비용 ?�님.
 * ?�제 비용: 개별 거래???�리?��?(?�출�? + ?�복 ?�수�?
 *
 * @param spreadPercent     - 명목 ?�프?�드 (%)
 * @param shortSlippagePct  - ??거래???�리?��? (%)
 * @param longSlippagePct   - �?거래???�리?��? (%)
 * @param hedgeFeePct       - ?�복 ?�수�?(%) ??getHedgeFees * 100
 * @param safetyMarginPct   - ?�전 마진 (%)
 */
export function calcHedgedNetSpreadPercent(
  spreadPercent: number,
  shortSlippagePct: number,
  longSlippagePct: number,
  hedgeFeePct: number,
  safetyMarginPct: number = SAFETY_MARGIN_PCT,
): number {
  // ?�리?��?: ?�구+출구 ?�쪽 = × 2
  const roundTripSlippagePct = (shortSlippagePct + longSlippagePct) * 2;
  return spreadPercent - roundTripSlippagePct - hedgeFeePct - safetyMarginPct;
}

// Popular symbols to track (top coins by OI)
export const TRACKED_SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
  'LTC', 'BCH', 'NEAR', 'ATOM', 'UNI', 'APT', 'OP', 'ARB', 'INJ', 'SUI',
  'TRX', 'MATIC', 'FIL', 'SAND', 'MANA', 'AXS', 'AAVE', 'EOS', 'XLM', 'VET',
  'ICP', 'HBAR', 'FTM', 'ALGO', 'RUNE', 'THETA', 'EGLD', 'FLOW', 'ETC', 'XMR',
];

