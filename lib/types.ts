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
  feeOverrides?: Partial<Record<ExchangeId, ExchangeFees>>; // 사용자 수수료 override
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

export const SUPPORTED_EXCHANGES: ExchangeId[] = ['binance', 'bybit', 'okx', 'bitget', 'gate', 'bingx'];

// ── Per-exchange fee matrix (VIP0 / basic tier, USDT-M futures) ──
// Source: official fee schedules as of 2026-03
export interface ExchangeFees {
  taker: number;  // decimal (0.0005 = 0.05%)
  maker: number;  // decimal (0.0002 = 0.02%)
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
  overrides?: Partial<Record<ExchangeId, ExchangeFees>>,
): number {
  const fees = overrides?.[exchange] ?? EXCHANGE_FEES[exchange];
  return fees[orderType];
}

/** Get effective fees considering user overrides */
export function getEffectiveExchangeFees(
  exchange: ExchangeId,
  overrides?: Partial<Record<ExchangeId, ExchangeFees>>,
): ExchangeFees {
  return overrides?.[exchange] ?? EXCHANGE_FEES[exchange];
}

/** Get round-trip hedge fees with optional overrides */
export function getHedgeFeesWithOverrides(
  shortEx: ExchangeId,
  longEx: ExchangeId,
  orderType: 'taker' | 'maker' = 'taker',
  overrides?: Partial<Record<ExchangeId, ExchangeFees>>,
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
