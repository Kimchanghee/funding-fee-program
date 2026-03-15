export type ExchangeId = 'binance' | 'bybit' | 'okx' | 'bitget' | 'gate';

export const EXCHANGE_NAMES: Record<ExchangeId, string> = {
  binance: 'BINANCE',
  bybit: 'BYBIT',
  okx: 'OKX',
  bitget: 'BITGET',
  gate: 'GATE',
};

export const EXCHANGE_COLORS: Record<ExchangeId, string> = {
  binance: '#F0B90B',
  bybit: '#F7A600',
  okx: '#00C087',
  bitget: '#00C5C5',
  gate: '#00B2FF',
};

export const EXCHANGE_BG: Record<ExchangeId, string> = {
  binance: 'rgba(240,185,11,0.12)',
  bybit: 'rgba(247,166,0,0.12)',
  okx: 'rgba(0,192,135,0.12)',
  bitget: 'rgba(0,197,197,0.12)',
  gate: 'rgba(0,178,255,0.12)',
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
}

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
  investmentUSDT: number;   // per side (total = 2x)
  leverage: number;         // 1-20
  minSpreadPercent: number; // minimum spread to enter (e.g., 0.05%)
  autoExecute: boolean;     // auto enter at funding time
  closeOnSpreadReverse: boolean;
  maxPositionAgeHours: number;
  compoundInvesting: boolean; // true = reinvest profits (복리), false = fixed amount (단리)
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
}

export const SIM_INITIAL_BALANCE = 2000;

export const SUPPORTED_EXCHANGES: ExchangeId[] = ['binance', 'bybit', 'okx', 'bitget', 'gate'];

// Popular symbols to track (top coins by OI)
export const TRACKED_SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
  'LTC', 'BCH', 'NEAR', 'ATOM', 'UNI', 'APT', 'OP', 'ARB', 'INJ', 'SUI',
  'TRX', 'MATIC', 'FIL', 'SAND', 'MANA', 'AXS', 'AAVE', 'EOS', 'XLM', 'VET',
  'ICP', 'HBAR', 'FTM', 'ALGO', 'RUNE', 'THETA', 'EGLD', 'FLOW', 'ETC', 'XMR',
];
