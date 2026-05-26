/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import type {
  ApiConfig,
  ExchangeId,
  FundingRate,
  Balance,
  Position,
  OrderLiquidity,
  FeeOverrides,
  PaybackOverrides,
} from '../types';
import { TRACKED_SYMBOLS } from '../types';
import { normalizeFundingRate } from './utils';
import { fetchFundingRatesViaWs, fetchOrderbookViaWs } from './wsPublicData';

export interface ExecutedOrderSummary {
  orderId: string;
  price: number;
  amount: number;
  filledNotional: number;
  liquidity: OrderLiquidity;
  estimatedFee: number;
}

export class OrderExecutionError extends Error {
  partialExecution?: ExecutedOrderSummary;

  constructor(message: string, partialExecution?: ExecutedOrderSummary) {
    super(message);
    this.name = 'OrderExecutionError';
    this.partialExecution = partialExecution;
  }
}

export function getPartialExecution(error: unknown): ExecutedOrderSummary | null {
  if (!error || typeof error !== 'object') return null;
  const partial = (error as { partialExecution?: ExecutedOrderSummary }).partialExecution;
  if (!partial || typeof partial.amount !== 'number' || partial.amount <= 0) return null;
  return partial;
}

// ── Exchange instance cache ──
const publicExchangeCache = new Map<ExchangeId, any>();
const MAX_PRIVATE_CACHE = 20;
const privateExchangeCache = new Map<string, any>();
const wsFallbackWarnAt = new Map<string, number>();
const FUNDING_WS_SOFT_TIMEOUT_MS = 1_500;

function warnWsFallback(key: string, message: string): void {
  const now = Date.now();
  const last = wsFallbackWarnAt.get(key) ?? 0;
  if (now - last < 30_000) return;
  wsFallbackWarnAt.set(key, now);
  console.warn(message);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function normalizeOrderbook(
  id: ExchangeId,
  symbol: string,
  orderbook: { bids?: number[][]; asks?: number[][] },
): { bids: number[][]; asks: number[][] } {
  const bids = Array.isArray(orderbook?.bids) ? orderbook.bids : [];
  const asks = Array.isArray(orderbook?.asks) ? orderbook.asks : [];
  if (bids.length === 0 || asks.length === 0) {
    throw new Error(`[${id}] empty orderbook for ${symbol}`);
  }
  return { bids, asks };
}

function getPublicExchange(id: ExchangeId): any {
  let ex = publicExchangeCache.get(id);
  if (ex) return ex;
  ex = createExchange(id);
  publicExchangeCache.set(id, ex);
  return ex;
}

function getPrivateExchange(id: ExchangeId, config: ApiConfig): any {
  const key = `${id}:${config.apiKey}:${config.secret}:${config.passphrase || ''}`;
  let ex = privateExchangeCache.get(key);
  if (ex) return ex;
  if (privateExchangeCache.size >= MAX_PRIVATE_CACHE) {
    const oldest = privateExchangeCache.keys().next().value;
    if (oldest) privateExchangeCache.delete(oldest);
  }
  ex = createExchange(id, config);
  privateExchangeCache.set(key, ex);
  return ex;
}

function makeExchange(id: ExchangeId, config?: ApiConfig): any {
  return config?.apiKey ? getPrivateExchange(id, config) : getPublicExchange(id);
}

function createExchange(id: ExchangeId, config?: ApiConfig): any {
  const opts: Record<string, unknown> = {
    apiKey: config?.apiKey || '',
    secret: config?.secret || '',
    options: { defaultType: 'swap' },
    enableRateLimit: true,
    timeout: 15000, // 15s global timeout for all requests
  };

  switch (id) {
    case 'binance':
      return new ccxt.binanceusdm({ ...opts, options: { defaultType: 'future' } });
    case 'bybit':
      return new ccxt.bybit({ ...opts, options: { defaultType: 'swap' } });
    case 'okx':
      if (config?.passphrase) opts.password = config.passphrase;
      return new ccxt.okx({ ...opts, options: { defaultType: 'swap' } });
    case 'bitget':
      if (config?.passphrase) opts.password = config.passphrase;
      return new ccxt.bitget({ ...opts, options: { defaultType: 'swap' } });
    case 'gate':
      return new ccxt.gateio({ ...opts, options: { defaultType: 'swap' } });
    case 'bingx':
      return new ccxt.bingx({ ...opts, options: { defaultType: 'swap' } });
    default:
      throw new Error(`Unsupported exchange: ${id}`);
  }
}

/** Evict a cached exchange instance so the next call creates a fresh one */
function evictExchangeCache(id: ExchangeId, config?: ApiConfig): void {
  if (config?.apiKey) {
    const key = `${id}:${config.apiKey}:${config.secret}:${config.passphrase || ''}`;
    privateExchangeCache.delete(key);
  } else {
    publicExchangeCache.delete(id);
  }
}

/** 비동기 거래량 병합 — 펀딩레이트 반환 후 백그라운드에서 실행 */
async function fetchTickersAndMergeVolume(
  ex: any,
  id: ExchangeId,
  rates: FundingRate[],
): Promise<void> {
  try {
    const tickers = await Promise.race([
      ex.fetchTickers() as Promise<Record<string, any>>,
      new Promise<Record<string, any>>((resolve) => setTimeout(() => resolve({}), 15000)),
    ]);
    for (const rate of rates) {
      const base = rate.symbol.replace(/:.*$/, '');
      const ticker = tickers[rate.symbol] ?? tickers[base + '/USDT:USDT'] ?? tickers[base + '/USDT'];
      if (ticker?.quoteVolume) rate.quoteVolume24h = ticker.quoteVolume;
    }
  } catch { /* silent */ }
}

function isPerpetualUsdtSymbol(symbol: string): boolean {
  return symbol.includes('USDT') && !/-\d{6}$/i.test(symbol);
}

function normalizeFr(id: ExchangeId, sym: string, fr: any): FundingRate | null {
  if (fr.fundingRate === undefined || fr.fundingRate === null) return null;

  // Prefer nextFundingDatetime/Timestamp (unambiguously the NEXT settlement)
  // fundingDatetime can be a past timestamp on some exchanges (e.g. Bybit)
  // Parse interval first (needed for stale time correction)
  let _intervalH = 8;
  if (fr.interval) {
    const m = String(fr.interval).match(/(\d+)h/i);
    if (m) _intervalH = parseInt(m[1], 10);
  }
  const _intervalMs = _intervalH * 3600000;

  let nextFundingTime: number;
  if (fr.nextFundingTimestamp) {
    nextFundingTime = fr.nextFundingTimestamp as number;
  } else if (fr.nextFundingDatetime) {
    nextFundingTime = new Date(fr.nextFundingDatetime as string).getTime();
  } else if (fr.fundingTimestamp && (fr.fundingTimestamp as number) > Date.now()) {
    nextFundingTime = fr.fundingTimestamp as number;
  } else if (fr.fundingDatetime && new Date(fr.fundingDatetime as string).getTime() > Date.now()) {
    nextFundingTime = new Date(fr.fundingDatetime as string).getTime();
  } else {
    nextFundingTime = Date.now() + _intervalMs;
  }

  // ★ 과거 시간 보정: 거래소가 stale nextFundingTime을 반환하면 다음 주기로 보정
  while (nextFundingTime < Date.now() - 30_000) {
    nextFundingTime += _intervalMs;
  }

  return normalizeFundingRate(
    id,
    fr.fundingRate as number,
    sym,
    (fr.markPrice as number) || 0,
    nextFundingTime,
    _intervalH,
  );
}

// ── Load markets with timeout and retry ──
// 5s per attempt (max 10s total) — loadMarkets is cached after first call
async function ensureMarkets(ex: any, id: ExchangeId, config?: ApiConfig): Promise<any> {
  try {
    await Promise.race([
      ex.loadMarkets() as Promise<unknown>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] loadMarkets timeout`)), 5000),
      ),
    ]);
    return ex;
  } catch {
    // First attempt failed — evict cache, create fresh instance, retry once
    evictExchangeCache(id, config);
    const freshEx = config?.apiKey ? getPrivateExchange(id, config) : getPublicExchange(id);
    await Promise.race([
      freshEx.loadMarkets() as Promise<unknown>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] loadMarkets retry timeout`)), 5000),
      ),
    ]);
    return freshEx;
  }
}

/**
 * Fetch funding rates for a single exchange.
 * Strategy: bulk fetch first → fallback to per-symbol fetch on failure.
 * Each step has its own timeout to prevent hangs.
 */
export async function fetchFundingRates(
  id: ExchangeId,
  config?: ApiConfig,
  symbols?: string[],
): Promise<FundingRate[]> {
  // Full-market scans (symbols undefined) should prefer REST bulk to avoid
  // being constrained by WS tracked symbol subsets.
  const hasExplicitSymbols = Array.isArray(symbols) && symbols.length > 0;

  if (hasExplicitSymbols) {
    try {
      const wsRates = await withTimeout(
        fetchFundingRatesViaWs(id, symbols),
        FUNDING_WS_SOFT_TIMEOUT_MS,
        `[${id}] funding WS soft timeout`,
      );
      if (wsRates.length > 0) return wsRates;
    } catch (wsErr) {
      // Symbol-targeted mode: do not wait for a full WS warm-up before REST fallback.
      warnWsFallback(`funding:${id}`, `[WS] ${id} funding fallback to REST: ${(wsErr as Error).message}`);
    }
  }

  let ex = makeExchange(id, config);
  // Build a set of base symbols (e.g. "BTC/USDT") for flexible matching
  // This handles format differences across exchanges:
  //   Binance/OKX return "BTC/USDT:USDT", Bybit/Gate may return "BTC/USDT"
  const baseSet = symbols
    ? new Set(symbols.map((s) => s.replace(/:.*$/, '')))
    : null;

  ex = await ensureMarkets(ex, id, config);

  const fetchPerSymbol = async (targetSymbols: string[]): Promise<FundingRate[]> => {
    const results: FundingRate[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < targetSymbols.length; i += 10) {
      chunks.push(targetSymbols.slice(i, i + 10));
    }

    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map(async (sym) => {
          try {
            const fr = await Promise.race([
              ex.fetchFundingRate(sym),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 8000),
              ),
            ]);
            const normalized = normalizeFr(id, sym, fr);
            if (normalized) results.push(normalized);
          } catch {
            // skip failed symbol
          }
        }),
      );
    }

    return results;
  };

  // In symbol-targeted mode, avoid full-market scans unless per-symbol fetch fails.
  if (hasExplicitSymbols && symbols) {
    const targeted = await fetchPerSymbol(symbols);
    if (targeted.length > 0) return targeted;
  }

  try {
    // ── Bulk fetch (1 API call) with 12s timeout ──
    const frs = await Promise.race([
      ex.fetchFundingRates() as Promise<Record<string, any>>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] fetchFundingRates timeout (20s)`)), 20000),
      ),
    ]);
    const results: FundingRate[] = [];
    for (const [sym, fr] of Object.entries(frs)) {
      if (!isPerpetualUsdtSymbol(sym)) continue;
      const base = sym.replace(/:.*$/, '');
      if (baseSet && !baseSet.has(base)) continue;
      const normalized = normalizeFr(id, sym, fr);
      if (normalized) results.push(normalized);
    }
    // 24h 거래량 비동기 병합 (실패해도 무시, 펀딩레이트 반환을 지연시키지 않음)
    fetchTickersAndMergeVolume(ex, id, results).catch(() => {});
    return results;
  } catch {
    // ── Fallback: per-symbol fetch ──
    // 전체 스캔 모드(symbols 미지정)에서 bulk 실패 시 → TRACKED_SYMBOLS로 fallback
    const fallbackSymbols = symbols && symbols.length > 0
      ? symbols
      : TRACKED_SYMBOLS.map((b) => `${b}/USDT:USDT`);
    if (!fallbackSymbols || fallbackSymbols.length === 0) {
      evictExchangeCache(id, config);
      throw new Error(`[${id}] fetchFundingRates bulk failed, no symbols for fallback`);
    }

    const results = await fetchPerSymbol(fallbackSymbols);

    if (results.length === 0) {
      // Last fallback for full-scan mode: allow WS tracked subset instead of empty response.
      if (!hasExplicitSymbols) {
        try {
          const wsRates = await fetchFundingRatesViaWs(id, symbols);
          if (wsRates.length > 0) return wsRates;
        } catch (wsErr) {
          warnWsFallback(`funding:${id}`, `[WS] ${id} final fallback failed: ${(wsErr as Error).message}`);
        }
      }

      evictExchangeCache(id, config);
      throw new Error(`[${id}] all fetch methods failed`);
    }
    return results;
  }
}

export async function fetchBalance(id: ExchangeId, config: ApiConfig): Promise<Balance> {
  void id;
  void config;
  throw new Error('REAL balance fetching has been removed. Use simulation balances.');
}

/**
 * Fetch actual account trading fees from exchange API.
 * Returns maker/taker fees for the account's current VIP/fee tier.
 * Falls back to null if the exchange doesn't support fee queries or if it fails.
 */
/**
 * Account fee fetching was removed with REAL trading.
 */
export async function fetchAccountFees(
  id: ExchangeId,
  config: ApiConfig,
  symbol?: string,
): Promise<{ maker: number; taker: number } | null> {
  void id;
  void config;
  void symbol;
  return null;
}

export async function fetchPositions(id: ExchangeId, config: ApiConfig): Promise<Position[]> {
  void id;
  void config;
  throw new Error('REAL position fetching has been removed. Use simulation positions.');
}

/**
 * Analyze orderbook levels to calculate weighted average fill price for a given notional.
 * Returns the expected fill price and the worst price level that would be touched.
 */
export function analyzeOrderbook(
  levels: number[][],
  notionalUSDT: number,
  side: 'buy' | 'sell' = 'buy',
): { fillPrice: number; worstPrice: number; totalQty: number } {
  if (!levels || levels.length === 0) {
    throw new Error('Empty orderbook levels');
  }

  let remainingUSD = notionalUSDT;
  let totalCost = 0;
  let totalQty = 0;
  let worstPrice = levels[0][0];

  for (const [price, qty] of levels) {
    if (remainingUSD <= 0) break;
    const levelUSD = price * qty;
    worstPrice = price;
    if (levelUSD >= remainingUSD) {
      const fillQty = remainingUSD / price;
      totalCost += fillQty * price;
      totalQty += fillQty;
      remainingUSD = 0;
    } else {
      totalCost += levelUSD;
      totalQty += qty;
      remainingUSD -= levelUSD;
    }
  }

  // Insufficient liquidity — apply 0.5% penalty per remaining percentage
  if (remainingUSD > 0) {
    const filledPct = 1 - (remainingUSD / notionalUSDT);
    const LIQUIDITY_PENALTY = 0.005; // 0.5% per unfilled fraction
    const penaltyMultiplier = 1 + LIQUIDITY_PENALTY * (1 - filledPct);
    const lastPrice = levels[levels.length - 1][0];
    // Apply penalty: buys get worse (higher) price, sells get worse (lower) price
    const penalizedPrice = side === 'sell'
      ? lastPrice * (1 - LIQUIDITY_PENALTY * (1 - filledPct))   // sell → lower price = worse
      : lastPrice * penaltyMultiplier;                           // buy → higher price = worse
    const fillQty = remainingUSD / penalizedPrice;
    totalCost += fillQty * penalizedPrice;
    totalQty += fillQty;
    worstPrice = penalizedPrice;
  }

  return {
    fillPrice: totalCost / totalQty,
    worstPrice,
    totalQty,
  };
}

/** Fetch raw orderbook from an exchange (public, cached instance) */
export async function fetchOrderbook(
  id: ExchangeId,
  symbol: string,
  depth = 50,
): Promise<{ bids: number[][]; asks: number[][] }> {
  const wsAttempt = fetchOrderbookViaWs(id, symbol, depth)
    .then((orderbook) => ({
      source: 'ws' as const,
      orderbook: normalizeOrderbook(id, symbol, orderbook),
    }));

  const restAttempt = (async () => {
    let ex = getPublicExchange(id);
    ex = await ensureMarkets(ex, id);
    const orderbook = await Promise.race([
      ex.fetchOrderBook(symbol, depth) as Promise<{ bids: number[][]; asks: number[][] }>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] fetchOrderBook timeout`)), 5000),
      ),
    ]);
    return {
      source: 'rest' as const,
      orderbook: normalizeOrderbook(id, symbol, orderbook),
    };
  })();

  try {
    const result = await Promise.any([wsAttempt, restAttempt]);
    if (result.source === 'rest') {
      warnWsFallback(
        `orderbook:${id}:${symbol}`,
        `[WS] ${id} orderbook using REST fallback (${symbol})`,
      );
    }
    return result.orderbook;
  } catch (error) {
    const reasons = error instanceof AggregateError
      ? error.errors.map((item) => (item as Error).message ?? String(item)).join(' | ')
      : (error as Error).message;
    throw new Error(`[${id}] orderbook WS/REST failed for ${symbol}: ${reasons}`);
  }
}

/**
 * Calculate orderbook impact in basis points for a given notional.
 * Impact is measured from EACH exchange's own mid price — not a cross-exchange average.
 *
 * Also returns `depthCapNotional`: the max notional that stays within
 * MAX_ROUND_TRIP_IMPACT_BPS/2 per side (6bps default).
 */
export function calcOrderbookImpactBps(
  bids: number[][],
  asks: number[][],
  notionalUSDT: number,
  side: 'buy' | 'sell',
): { impactBps: number; fillPrice: number; worstPrice: number; midPrice: number; depthCapNotional: number } {
  if (!bids?.length || !asks?.length) {
    throw new Error('Empty orderbook for impact calculation');
  }

  const midPrice = (bids[0][0] + asks[0][0]) / 2;
  const levels = side === 'buy' ? asks : bids;
  const analysis = analyzeOrderbook(levels, notionalUSDT, side);
  const impactBps = Math.abs((analysis.fillPrice - midPrice) / midPrice) * 10000;

  // Walk levels to find max notional within per-side impact cap.
  // per-side 3bps × 2 legs = 6bps entry, × 2 (entry+exit) = 12bps round-trip = MAX_ROUND_TRIP_IMPACT_BPS
  const perSideCapBps = 3;
  let depthCapNotional = 0;
  for (const [price, qty] of levels) {
    const levelImpactBps = Math.abs((price - midPrice) / midPrice) * 10000;
    if (levelImpactBps > perSideCapBps) break;
    depthCapNotional += price * qty;
  }

  return {
    impactBps,
    fillPrice: analysis.fillPrice,
    worstPrice: analysis.worstPrice,
    midPrice,
    depthCapNotional,
  };
}

/**
 * Check if funding has been settled by querying recent funding history.
 * Returns true if a funding payment matching the expected time is found.
 * Only call on exchanges where profile.supportsFundingSettlementCheck === true.
 */
export async function checkFundingSettled(
  id: ExchangeId,
  config: ApiConfig,
  symbol: string,
  expectedFundingTime: number,
  toleranceMs = 60_000,
): Promise<{ settled: boolean; payment?: { amount: number; rate: number; timestamp: number } }> {
  void id;
  void config;
  void symbol;
  void expectedFundingTime;
  void toleranceMs;
  return { settled: false };
}

/**
 * Open position using Post-Only maker order at best bid/ask.
 * Strategy: Post-Only → rejected (crossing) → IOC taker fallback.
 * This saves ~60% on fees vs pure taker (0.02% maker vs 0.05% taker).
 */
export async function openPosition(
  id: ExchangeId,
  config: ApiConfig,
  symbol: string,
  side: 'long' | 'short',
  amountUSDT: number,
  leverage: number,
  feeOverrides?: FeeOverrides,
  paybackOverrides?: PaybackOverrides,
): Promise<ExecutedOrderSummary> {
  void id;
  void config;
  void symbol;
  void side;
  void amountUSDT;
  void leverage;
  void feeOverrides;
  void paybackOverrides;
  throw new Error('REAL position opening has been removed. Use simulation execution.');
}

/**
 * Close position using limit IOC order with orderbook analysis.
 * Falls back to market order if limit IOC doesn't fill sufficiently.
 */
/**
 * Open position with pre-computed quantity.
 *
 * When useIocLimitOnly=false (default): Post-Only maker → IOC taker fallback (existing behavior).
 * When useIocLimitOnly=true (v2.1): IOC-limit only — no Post-Only, no market fallback.
 *
 * Used for coordinated hedge execution where both sides' quantities
 * are calculated together for equal notional exposure (100% hedge).
 */
export async function openPositionExact(
  id: ExchangeId,
  config: ApiConfig,
  symbol: string,
  side: 'long' | 'short',
  qty: number,
  limitPrice: number,
  leverage: number,
  feeOverrides?: FeeOverrides,
  useIocLimitOnly = false,
  paybackOverrides?: PaybackOverrides,
): Promise<ExecutedOrderSummary> {
  void id;
  void config;
  void symbol;
  void side;
  void qty;
  void limitPrice;
  void leverage;
  void feeOverrides;
  void useIocLimitOnly;
  void paybackOverrides;
  throw new Error('REAL exact position opening has been removed. Use simulation execution.');
}

export async function closePosition(
  id: ExchangeId,
  config: ApiConfig,
  symbol: string,
  side: 'long' | 'short',
  amount: number,
  feeOverrides?: FeeOverrides,
  paybackOverrides?: PaybackOverrides,
): Promise<ExecutedOrderSummary> {
  void id;
  void config;
  void symbol;
  void side;
  void amount;
  void feeOverrides;
  void paybackOverrides;
  throw new Error('REAL position closing has been removed. Use simulation execution.');
}

export async function closePositionIocOnly(
  id: ExchangeId,
  config: ApiConfig,
  symbol: string,
  side: 'long' | 'short',
  amount: number,
  feeOverrides?: FeeOverrides,
  paybackOverrides?: PaybackOverrides,
): Promise<ExecutedOrderSummary> {
  void id;
  void config;
  void symbol;
  void side;
  void amount;
  void feeOverrides;
  void paybackOverrides;
  throw new Error('REAL IOC-only position closing has been removed. Use simulation execution.');
}

export async function fetchFundingHistory(
  id: ExchangeId,
  config: ApiConfig,
  symbol?: string,
  limit = 20,
): Promise<import('../types').FundingPayment[]> {
  void id;
  void config;
  void symbol;
  void limit;
  throw new Error('REAL funding history fetching has been removed. Use SIM trade history.');
}

/**
 * Fetch orderbook and calculate weighted average fill price for a market order.
 * Returns the actual fill price considering orderbook depth (slippage).
 */
export async function fetchMarketFillPrice(
  id: ExchangeId,
  symbol: string,
  side: 'buy' | 'sell',
  notionalUSDT: number,
): Promise<{ fillPrice: number; slippagePercent: number; midPrice: number; worstPrice: number }> {
  const ob = await fetchOrderbook(id, symbol, 50);

  // buy (long) eats asks, sell (short) eats bids
  const levels = side === 'buy' ? ob.asks : ob.bids;
  if (!levels || levels.length === 0) {
    throw new Error(`[${id}] empty orderbook for ${symbol}`);
  }

  const midPrice = (ob.asks[0][0] + ob.bids[0][0]) / 2;
  let remainingUSD = notionalUSDT;
  let totalCost = 0;
  let totalQty = 0;
  let worstPrice = levels[0][0];

  for (const [price, qty] of levels) {
    if (remainingUSD <= 0) break;
    worstPrice = price;
    const levelUSD = price * qty;
    if (levelUSD >= remainingUSD) {
      const fillQty = remainingUSD / price;
      totalCost += fillQty * price;
      totalQty += fillQty;
      remainingUSD = 0;
    } else {
      totalCost += levelUSD;
      totalQty += qty;
      remainingUSD -= levelUSD;
    }
  }

  if (remainingUSD > 0) {
    // Insufficient liquidity — apply penalty instead of naive extrapolation
    const filledPct = 1 - (remainingUSD / notionalUSDT);
    const LIQUIDITY_PENALTY = 0.005;
    const penaltyFraction = LIQUIDITY_PENALTY * (1 - filledPct);
    const lastPrice = levels[levels.length - 1][0];
    // sell → lower price is worse; buy → higher price is worse
    const penalizedPrice = side === 'sell'
      ? lastPrice * (1 - penaltyFraction)
      : lastPrice * (1 + penaltyFraction);
    const fillQty = remainingUSD / penalizedPrice;
    totalCost += fillQty * penalizedPrice;
    totalQty += fillQty;
    worstPrice = penalizedPrice;
  }

  const fillPrice = totalCost / totalQty;
  const slippagePercent = Math.abs((fillPrice - midPrice) / midPrice) * 100;

  return { fillPrice, slippagePercent, midPrice, worstPrice };
}

export async function testConnection(id: ExchangeId, config: ApiConfig): Promise<boolean> {
  void id;
  void config;
  return false;
}
