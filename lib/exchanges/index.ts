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
import { TRACKED_SYMBOLS, getExchangeFee } from '../types';
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

const MIN_EXECUTION_FILL_RATIO = 0.9;

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

function buildExecutionSummary(
  orderId: string,
  price: number,
  amount: number,
  filledNotional: number,
  liquidity: OrderLiquidity,
  estimatedFee: number,
): ExecutedOrderSummary {
  return {
    orderId,
    price,
    amount,
    filledNotional,
    liquidity,
    estimatedFee,
  };
}

// ── Exchange instance cache ──
const publicExchangeCache = new Map<ExchangeId, any>();
const MAX_PRIVATE_CACHE = 20;
const privateExchangeCache = new Map<string, any>();
const wsFallbackWarnAt = new Map<string, number>();

function warnWsFallback(key: string, message: string): void {
  const now = Date.now();
  const last = wsFallbackWarnAt.get(key) ?? 0;
  if (now - last < 30_000) return;
  wsFallbackWarnAt.set(key, now);
  console.warn(message);
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
      const wsRates = await fetchFundingRatesViaWs(id, symbols);
      if (wsRates.length > 0) return wsRates;
    } catch (wsErr) {
      // Symbol-targeted mode: keep REST fallback when WS channel is unavailable.
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
  const ex = makeExchange(id, config);
  const toFiniteNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const pickNumber = (...values: unknown[]): number => {
    for (const value of values) {
      const parsed = toFiniteNumber(value);
      if (parsed !== undefined) return parsed;
    }
    return 0;
  };
  try {
    const bal = await ex.fetchBalance();
    const usdt = bal['USDT'] ?? bal['usdt'];
    const totalUSDT = pickNumber(
      usdt?.total,
      bal?.total?.USDT,
      bal?.total?.usdt,
      bal?.USDT?.total,
      bal?.usdt?.total,
    );
    const availableUSDT = pickNumber(
      usdt?.free,
      bal?.free?.USDT,
      bal?.free?.usdt,
      bal?.USDT?.free,
      bal?.usdt?.free,
    );
    const usedUSDT = pickNumber(
      usdt?.used,
      bal?.used?.USDT,
      bal?.used?.usdt,
      bal?.USDT?.used,
      bal?.usdt?.used,
    );
    return {
      exchange: id,
      totalUSDT,
      availableUSDT,
      usedUSDT,
      unrealizedPnl: 0,
      status: 'connected',
      updatedAt: Date.now(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[${id}] fetchBalance failed: ${message}`);
  }
}

/**
 * Fetch actual account trading fees from exchange API.
 * Returns maker/taker fees for the account's current VIP/fee tier.
 * Falls back to null if the exchange doesn't support fee queries or if it fails.
 */
export async function fetchAccountFees(
  id: ExchangeId,
  config: ApiConfig,
  symbol?: string,
): Promise<{ maker: number; taker: number } | null> {
  const ex = makeExchange(id, config);
  try {
    await ensureMarkets(ex, id, config);
    // CCXT's fetchTradingFee returns { maker, taker } for the account's tier
    const fee = await Promise.race([
      symbol
        ? ex.fetchTradingFee(symbol) as Promise<any>
        : ex.fetchTradingFees() as Promise<any>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);

    if (!fee) return null;

    // fetchTradingFees returns a map; pick a representative symbol or first entry
    if (!symbol && typeof fee === 'object') {
      const firstKey = Object.keys(fee).find(k => k.includes('USDT'));
      const entry = firstKey ? fee[firstKey] : Object.values(fee)[0];
      if (entry && typeof entry === 'object') {
        const maker = (entry as any).maker;
        const taker = (entry as any).taker;
        if (typeof maker === 'number' && typeof taker === 'number') {
          return { maker, taker };
        }
      }
      return null;
    }

    if (typeof fee.maker === 'number' && typeof fee.taker === 'number') {
      return { maker: fee.maker, taker: fee.taker };
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchPositions(id: ExchangeId, config: ApiConfig): Promise<Position[]> {
  const ex = makeExchange(id, config);
  try {
    const raw: any[] = await ex.fetchPositions();
    return raw
      .filter((p: any) => p.contracts && (p.contracts as number) > 0)
      .map((p: any) => {
        const contracts = (p.contracts as number) || 0;
        const contractSize = (p.contractSize as number) || 1;
        return {
        exchange: id,
        symbol: (p.symbol as string) || '',
        displaySymbol: ((p.symbol as string) || '').replace(':USDT', '').replace(':USD', ''),
        baseAsset: ((p.symbol as string) || '').split('/')[0] || '',
        side: (p.side === 'long' ? 'long' : 'short') as 'long' | 'short',
        size: contracts * contractSize, // contracts → base asset 수량 변환
        sizeUSD: (p.notional as number) || 0,
        entryPrice: (p.entryPrice as number) || 0,
        markPrice: (p.markPrice as number) || 0,
        leverage: (p.leverage as number) || 1,
        margin: (p.initialMargin as number) || 0,
        unrealizedPnl: (p.unrealizedPnl as number) || 0,
        unrealizedPnlPercent:
          (p.initialMargin as number) > 0
            ? ((p.unrealizedPnl as number) / (p.initialMargin as number)) * 100
            : 0,
        liquidationPrice: (p.liquidationPrice as number) || 0,
        fundingRate: 0,
        openedAt: Date.now(),
        positionType: 'manual' as const,
      };
      });
  } catch {
    return [];
  }
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
  try {
    return await fetchOrderbookViaWs(id, symbol, depth);
  } catch (wsErr) {
    warnWsFallback(
      `orderbook:${id}:${symbol}`,
      `[WS] ${id} orderbook fallback to REST (${symbol}): ${(wsErr as Error).message}`,
    );
  }

  let ex = getPublicExchange(id);
  ex = await ensureMarkets(ex, id);
  return await Promise.race([
    ex.fetchOrderBook(symbol, depth) as Promise<{ bids: number[][]; asks: number[][] }>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[${id}] fetchOrderBook timeout`)), 5000),
    ),
  ]);
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
  const ex = makeExchange(id, config);
  try {
    const history = await Promise.race([
      ex.fetchFundingHistory(symbol, undefined, 5) as Promise<any[]>,
      new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 5000)),
    ]);

    for (const entry of history) {
      const ts = (entry.timestamp as number) || new Date(entry.datetime as string).getTime();
      if (Math.abs(ts - expectedFundingTime) <= toleranceMs) {
        return {
          settled: true,
          payment: {
            amount: (entry.amount as number) || 0,
            rate: (entry.rate as number) || (entry.fundingRate as number) || 0,
            timestamp: ts,
          },
        };
      }
    }

    return { settled: false };
  } catch {
    return { settled: false };
  }
}

function estimateExecutionFee(
  exchange: ExchangeId,
  parts: Array<{ notional: number; liquidity: Exclude<OrderLiquidity, 'mixed'> }>,
  feeOverrides?: FeeOverrides,
  paybackOverrides?: PaybackOverrides,
): number {
  return parts.reduce(
    (sum, part) => sum + (part.notional * getExchangeFee(exchange, part.liquidity, feeOverrides, paybackOverrides)),
    0,
  );
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
  let ex = makeExchange(id, config);
  try {
    ex = await ensureMarkets(ex, id, config);
    await ex.setLeverage(leverage, symbol).catch(() => {});

    // 1. Fetch orderbook for price analysis
    const ob = await fetchOrderbook(id, symbol, 50);

    const levels = side === 'long' ? ob.asks : ob.bids;
    if (!levels || levels.length === 0) {
      throw new Error(`[${id}] Empty orderbook for ${symbol} (${side})`);
    }

    const notional = amountUSDT * leverage;
    const obSide = side === 'long' ? 'buy' : 'sell';
    const analysis = analyzeOrderbook(levels, notional, obSide);

    // 2. Calculate contract amount
    let contractAmount = notional / analysis.fillPrice;
    if (ex.markets && ex.markets[symbol]) {
      const market = ex.markets[symbol];
      if (market.contractSize && market.contractSize !== 1) {
        contractAmount = contractAmount / market.contractSize;
      }
      contractAmount = parseFloat(ex.amountToPrecision(symbol, contractAmount));
    }

    const cSize = (ex.markets && ex.markets[symbol]?.contractSize) || 1;
    const orderSide = side === 'long' ? 'buy' : 'sell';

    // 3. Try Post-Only maker order at best bid/ask (0% spread from BBO)
    //    Long: place at best bid (we join the bid), Short: place at best ask (we join the ask)
    const bestBid = ob.bids?.[0]?.[0];
    const bestAsk = ob.asks?.[0]?.[0];
    const makerPrice = side === 'long' ? bestBid : bestAsk;

    if (makerPrice && makerPrice > 0) {
      try {
        console.log(
          `[${id}] ${symbol} ${side} POST-ONLY: price=${makerPrice.toFixed(4)}, ` +
          `qty=${contractAmount.toFixed(6)}, notional=$${notional.toFixed(2)}`,
        );

        const makerOrder = await Promise.race([
          ex.createOrder(symbol, 'limit', orderSide, contractAmount, makerPrice, {
            postOnly: true,
            reduceOnly: false,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Post-Only timeout')), 3000),
          ),
        ]);

        const filledAmount = (makerOrder.filled as number) || 0;
        const filledPrice = (makerOrder.average as number) || makerPrice;

        // Post-Only succeeded and filled (at least partially)
        if (filledAmount >= contractAmount * 0.90) {
          const filledNotional = filledAmount * cSize * filledPrice;
          console.log(
            `[${id}] ${symbol} ${side} MAKER FILLED: price=${filledPrice.toFixed(4)}, ` +
            `qty=${filledAmount.toFixed(6)}, notional=$${filledNotional.toFixed(2)}, fee=MAKER`,
          );
          return {
            orderId: (makerOrder.id as string) || '',
            price: filledPrice,
            amount: filledAmount * cSize,
            filledNotional,
            liquidity: 'maker',
            estimatedFee: estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'maker' }], feeOverrides, paybackOverrides),
          };
        }

        // Partial or zero fill — cancel resting maker order before IOC fallback
        if (filledAmount < contractAmount * 0.90) {
          // Cancel any resting portion of the maker order
          if (makerOrder.id) {
            try {
              await ex.cancelOrder(makerOrder.id, symbol);
              console.log(`[${id}] ${symbol} ${side} cancelled resting maker order ${makerOrder.id}`);
            } catch { /* already filled or cancelled */ }
          }

          if (filledAmount > 0) {
            const remaining = contractAmount - filledAmount;
            const iocPrice = side === 'long'
              ? analysis.worstPrice * 1.0005
              : analysis.worstPrice * 0.9995;

            console.log(
              `[${id}] ${symbol} ${side} MAKER partial ${((filledAmount / contractAmount) * 100).toFixed(1)}%, ` +
              `IOC-filling remaining ${remaining.toFixed(6)}`,
            );

            const iocOrder = await Promise.race([
              ex.createOrder(symbol, 'limit', orderSide, remaining, iocPrice, {
                timeInForce: 'IOC', reduceOnly: false,
              }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('IOC fallback timeout')), 3000),
              ),
            ]);

            const iocFilled = (iocOrder.filled as number) || 0;
            const iocFilledPrice = (iocOrder.average as number) || iocPrice;
            const totalFilled = filledAmount + iocFilled;
            const avgPrice = totalFilled > 0
              ? (filledAmount * filledPrice + iocFilled * iocFilledPrice) / totalFilled
              : filledPrice;

            return {
              orderId: (makerOrder.id as string) || (iocOrder.id as string) || '',
              price: avgPrice,
              amount: totalFilled * cSize,
              filledNotional: totalFilled * cSize * avgPrice,
              liquidity: 'mixed',
              estimatedFee: estimateExecutionFee(id, [
                { notional: filledAmount * cSize * filledPrice, liquidity: 'maker' },
                { notional: iocFilled * cSize * iocFilledPrice, liquidity: 'taker' },
              ], feeOverrides, paybackOverrides),
            };
          }
          // filledAmount === 0 → order cancelled, fall through to IOC
        }
      } catch (makerErr) {
        // Post-Only rejected (crossing book) or timeout — fall through to IOC
        console.log(
          `[${id}] ${symbol} ${side} Post-Only rejected/timeout: ${(makerErr as Error).message} — falling back to IOC`,
        );
      }
    }

    // 4. Fallback: IOC taker order (original strategy)
    const PRICE_BUFFER = 0.0005;
    const limitPrice = side === 'long'
      ? analysis.worstPrice * (1 + PRICE_BUFFER)
      : analysis.worstPrice * (1 - PRICE_BUFFER);

    console.log(
      `[${id}] ${symbol} ${side} IOC FALLBACK: limit=${limitPrice.toFixed(4)}, ` +
      `qty=${contractAmount.toFixed(6)}, notional=$${notional.toFixed(2)}`,
    );

    const order = await Promise.race([
      ex.createOrder(symbol, 'limit', orderSide, contractAmount, limitPrice, {
        timeInForce: 'IOC', reduceOnly: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] IOC order timeout`)), 3000),
      ),
    ]);

    const filledAmount = (order.filled as number) || 0;
    const filledPrice = (order.average as number) || limitPrice;
    const filledNotional = filledAmount * cSize * filledPrice;

    if (filledAmount < contractAmount * 0.90) {
      const remaining = contractAmount - filledAmount;
      console.log(
        `[${id}] ${symbol} ${side} IOC partial fill ${((filledAmount / contractAmount) * 100).toFixed(1)}%, ` +
        `market-filling remaining ${remaining.toFixed(6)}`,
      );
      const mktOrder = await Promise.race([
        ex.createMarketOrder(symbol, orderSide, remaining, undefined, { reduceOnly: false }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Market order timeout')), 3000)),
      ]);
      const mktFilled = (mktOrder.filled as number) || remaining;
      const mktPrice = (mktOrder.average as number) || limitPrice;
      const totalFilled = filledAmount + mktFilled;
      const avgPrice = (filledAmount * filledPrice + mktFilled * mktPrice) / totalFilled;

      return {
        orderId: (order.id as string) || (mktOrder.id as string) || '',
        price: avgPrice,
        amount: totalFilled * cSize,
        filledNotional: totalFilled * cSize * avgPrice,
        liquidity: 'taker',
        estimatedFee: estimateExecutionFee(id, [{ notional: totalFilled * cSize * avgPrice, liquidity: 'taker' }], feeOverrides, paybackOverrides),
      };
    }

    return {
      orderId: (order.id as string) || '',
      price: filledPrice,
      amount: filledAmount * cSize,
      filledNotional,
      liquidity: 'taker',
      estimatedFee: estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'taker' }], feeOverrides, paybackOverrides),
    };
  } catch (err) {
    throw new Error(`[${id}] openPosition failed: ${(err as Error).message}`);
  }
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
  let ex = makeExchange(id, config);
  try {
    ex = await ensureMarkets(ex, id, config);
    await ex.setLeverage(leverage, symbol).catch(() => {});

    if (ex.markets && ex.markets[symbol]) {
      const market = ex.markets[symbol];
      if (market.contractSize && market.contractSize !== 1) {
        qty = qty / market.contractSize;
      }
      qty = parseFloat(ex.amountToPrecision(symbol, qty));
    }

    const cSize = (ex.markets && ex.markets[symbol]?.contractSize) || 1;
    const orderSide = side === 'long' ? 'buy' : 'sell';
    const minFilledQty = qty * MIN_EXECUTION_FILL_RATIO;

    // ── v2.1: IOC-limit only path (no Post-Only, no market fallback) ──
    if (useIocLimitOnly) {
      console.log(
        `[${id}] ${symbol} ${side} IOC-LIMIT-ONLY: limit=${limitPrice.toFixed(4)}, qty=${qty.toFixed(6)}`,
      );

      const order = await Promise.race([
        ex.createOrder(symbol, 'limit', orderSide, qty, limitPrice, {
          timeInForce: 'IOC', reduceOnly: false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`[${id}] IOC order timeout`)), 5000),
        ),
      ]);

      const filledAmount = (order.filled as number) || 0;
      const filledPrice = (order.average as number) || limitPrice;

      if (filledAmount < minFilledQty) {
        const partialExecution = filledAmount > 0
          ? buildExecutionSummary(
              (order.id as string) || '',
              filledPrice,
              filledAmount * cSize,
              filledAmount * cSize * filledPrice,
              'taker',
              estimateExecutionFee(id, [{ notional: filledAmount * cSize * filledPrice, liquidity: 'taker' }], feeOverrides, paybackOverrides),
            )
          : undefined;

        throw new OrderExecutionError(
          `[${id}] ${symbol} ${side} IOC insufficient fill: ` +
          `${((filledAmount / qty) * 100).toFixed(1)}% filled (min ${(MIN_EXECUTION_FILL_RATIO * 100).toFixed(0)}%)`,
          partialExecution,
        );
      }

      const filledNotional = filledAmount * cSize * filledPrice;
      console.log(
        `[${id}] ${symbol} ${side} IOC FILLED: price=${filledPrice.toFixed(4)}, ` +
        `qty=${filledAmount.toFixed(6)}, notional=$${filledNotional.toFixed(2)}`,
      );

      return buildExecutionSummary(
        (order.id as string) || '',
        filledPrice,
        filledAmount * cSize,
        filledNotional,
        'taker',
        estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'taker' }], feeOverrides, paybackOverrides),
      );
    }

    // ── Legacy path: Post-Only maker → IOC taker fallback ──

    // 1. Try Post-Only maker at the provided limit price (best bid/ask from caller)
    try {
      // Post-Only maker price: for buy, use slightly below limitPrice; for sell, slightly above
      // This ensures we're providing liquidity, not taking it
      const ob = await fetchOrderbook(id, symbol, 5);

      const makerPrice = side === 'long'
        ? Math.min(ob.bids?.[0]?.[0] || limitPrice * 0.999, limitPrice)
        : Math.max(ob.asks?.[0]?.[0] || limitPrice * 1.001, limitPrice);

      console.log(
        `[${id}] ${symbol} ${side} EXACT POST-ONLY: price=${makerPrice.toFixed(4)}, qty=${qty.toFixed(6)}`,
      );

      const makerOrder = await Promise.race([
        ex.createOrder(symbol, 'limit', orderSide, qty, makerPrice, {
          postOnly: true, reduceOnly: false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Post-Only timeout')), 3000),
        ),
      ]);

      const filledAmount = (makerOrder.filled as number) || 0;
      const filledPrice = (makerOrder.average as number) || makerPrice;

      if (filledAmount >= minFilledQty) {
        const filledNotional = filledAmount * cSize * filledPrice;
        console.log(
          `[${id}] ${symbol} ${side} EXACT MAKER FILLED: price=${filledPrice.toFixed(4)}, ` +
          `qty=${filledAmount.toFixed(6)}, notional=$${filledNotional.toFixed(2)}`,
        );
        return buildExecutionSummary(
          (makerOrder.id as string) || '',
          filledPrice,
          filledAmount * cSize,
          filledNotional,
          'maker',
          estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'maker' }], feeOverrides, paybackOverrides),
        );
      }

      // Partial or zero fill — cancel resting maker order before IOC fallback
      if (filledAmount < minFilledQty) {
        if (makerOrder.id) {
          try {
            await ex.cancelOrder(makerOrder.id, symbol);
            console.log(`[${id}] ${symbol} ${side} cancelled resting maker order ${makerOrder.id}`);
          } catch { /* already filled or cancelled */ }
        }

        if (filledAmount > 0) {
          const remaining = qty - filledAmount;
          console.log(
            `[${id}] ${symbol} ${side} EXACT MAKER partial ${((filledAmount / qty) * 100).toFixed(1)}%, IOC remaining`,
          );
          const iocOrder = await Promise.race([
            ex.createOrder(symbol, 'limit', orderSide, remaining, limitPrice, {
              timeInForce: 'IOC', reduceOnly: false,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('IOC timeout')), 3000),
            ),
          ]);
          const iocFilled = (iocOrder.filled as number) || 0;
          const iocPrice = (iocOrder.average as number) || limitPrice;
          const totalFilled = filledAmount + iocFilled;
          const avgPrice = totalFilled > 0
            ? (filledAmount * filledPrice + iocFilled * iocPrice) / totalFilled
            : filledPrice;
          const partialExecution = totalFilled > 0
            ? buildExecutionSummary(
                (makerOrder.id as string) || (iocOrder.id as string) || '',
                avgPrice,
                totalFilled * cSize,
                totalFilled * cSize * avgPrice,
                iocFilled > 0 ? 'mixed' : 'maker',
                estimateExecutionFee(id, [
                  { notional: filledAmount * cSize * filledPrice, liquidity: 'maker' },
                  { notional: iocFilled * cSize * iocPrice, liquidity: 'taker' },
                ], feeOverrides, paybackOverrides),
              )
            : undefined;

          if (totalFilled < minFilledQty) {
            throw new OrderExecutionError(
              `[${id}] ${symbol} ${side} insufficient fill within limit price: ` +
              `${((totalFilled / qty) * 100).toFixed(1)}% filled`,
              partialExecution,
            );
          }

          return partialExecution!;
        }
        // filledAmount === 0 → cancelled, fall through to IOC
      }
    } catch (makerErr) {
      if (makerErr instanceof OrderExecutionError) throw makerErr;
      console.log(
        `[${id}] ${symbol} ${side} EXACT Post-Only failed: ${(makerErr as Error).message} — IOC fallback`,
      );
    }

    // 2. Fallback: IOC taker
    console.log(
      `[${id}] ${symbol} ${side} EXACT IOC FALLBACK: limit=${limitPrice.toFixed(4)}, qty=${qty.toFixed(6)}`,
    );

    const order = await Promise.race([
      ex.createOrder(symbol, 'limit', orderSide, qty, limitPrice, {
        timeInForce: 'IOC', reduceOnly: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] IOC order timeout`)), 3000),
      ),
    ]);

    const filledAmount = (order.filled as number) || 0;
    const filledPrice = (order.average as number) || limitPrice;

    if (filledAmount < minFilledQty) {
      const remaining = qty - filledAmount;
      // 슬리피지 제한: market order 대신 limitPrice 기준 limit IOC로 재시도
      // limitPrice는 사전 오더북 스캔의 worst level + 0.05% 버퍼 — 이 가격 이상 체결 방지
      console.log(
        `[${id}] ${symbol} ${side} IOC partial fill ${((filledAmount / qty) * 100).toFixed(1)}%, ` +
        `limit-IOC remaining ${remaining.toFixed(6)} @${limitPrice.toFixed(4)} (no market fallback)`,
      );
      const retryOrder = await Promise.race([
        ex.createOrder(symbol, 'limit', orderSide, remaining, limitPrice, {
          timeInForce: 'IOC', reduceOnly: false,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Retry IOC timeout')), 3000)),
      ]);
      const retryFilled = (retryOrder.filled as number) || 0;
      const retryPrice = (retryOrder.average as number) || limitPrice;
      const totalFilled = filledAmount + retryFilled;
      if (totalFilled === 0) {
        throw new Error(`[${id}] ${symbol} ${side} 체결 실패: IOC + retry 모두 0 filled`);
      }
      const avgPrice = totalFilled > 0
        ? (filledAmount * filledPrice + retryFilled * retryPrice) / totalFilled
        : filledPrice;

      const partialExecution = buildExecutionSummary(
        (order.id as string) || (retryOrder.id as string) || '',
        avgPrice,
        totalFilled * cSize,
        totalFilled * cSize * avgPrice,
        'taker',
        estimateExecutionFee(id, [{ notional: totalFilled * cSize * avgPrice, liquidity: 'taker' }], feeOverrides, paybackOverrides),
      );

      if (totalFilled < minFilledQty) {
        throw new OrderExecutionError(
          `[${id}] ${symbol} ${side} insufficient fill within limit price: ` +
          `${((totalFilled / qty) * 100).toFixed(1)}% filled`,
          partialExecution,
        );
      }

      return partialExecution;
    }

    const filledNotional = filledAmount * cSize * filledPrice;
    return buildExecutionSummary(
      (order.id as string) || '',
      filledPrice,
      filledAmount * cSize,
      filledNotional,
      'taker',
      estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'taker' }], feeOverrides, paybackOverrides),
    );
  } catch (err) {
    if (err instanceof OrderExecutionError) throw err;
    throw new Error(`[${id}] openPositionExact failed: ${(err as Error).message}`);
  }
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
  let ex = makeExchange(id, config);
  let cSize = 1;
  try {
    ex = await ensureMarkets(ex, id, config);
    const ob = await fetchOrderbook(id, symbol, 50);

    const levels = side === 'long' ? ob.bids : ob.asks;
    if (!levels || levels.length === 0) throw new Error('empty orderbook');

    if (ex.markets && ex.markets[symbol]) {
      const market = ex.markets[symbol];
      if (market.contractSize && market.contractSize !== 1) {
        amount = amount / market.contractSize;
      }
      amount = parseFloat(ex.amountToPrecision(symbol, amount));
    }
    cSize = (ex.markets && ex.markets[symbol]?.contractSize) || 1;

    const closeSide: 'buy' | 'sell' = side === 'long' ? 'sell' : 'buy';
    const estimatedNotional = amount * levels[0][0];
    const analysis = analyzeOrderbook(levels, estimatedNotional, closeSide);

    // 1. Try Post-Only maker close at best bid/ask
    const makerPrice = side === 'long'
      ? (ob.bids?.[0]?.[0] || analysis.fillPrice)   // close long = sell at best bid
      : (ob.asks?.[0]?.[0] || analysis.fillPrice);   // close short = buy at best ask

    try {
      console.log(`[${id}] ${symbol} CLOSE ${side} POST-ONLY: price=${makerPrice.toFixed(4)}, qty=${amount.toFixed(6)}`);

      const makerOrder = await Promise.race([
        ex.createOrder(symbol, 'limit', closeSide, amount, makerPrice, {
          postOnly: true, reduceOnly: true,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Close Post-Only timeout')), 3000),
        ),
      ]);

      const filledAmount = (makerOrder.filled as number) || 0;
      if (filledAmount >= amount * 0.90) {
        const filledPrice = (makerOrder.average as number) || makerPrice;
        const filledNotional = filledAmount * cSize * filledPrice;
        console.log(`[${id}] ${symbol} CLOSE ${side} MAKER complete`);
        return {
          orderId: (makerOrder.id as string) || '',
          price: filledPrice,
          amount: filledAmount * cSize,
          filledNotional,
          liquidity: 'maker',
          estimatedFee: estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'maker' }], feeOverrides, paybackOverrides),
        };
      }

      // Partial or zero fill — cancel resting maker order before fallback
      if (filledAmount < amount * 0.90) {
        if (makerOrder.id) {
          try {
            await ex.cancelOrder(makerOrder.id, symbol);
            console.log(`[${id}] ${symbol} CLOSE ${side} cancelled resting maker order ${makerOrder.id}`);
          } catch { /* already filled or cancelled */ }
        }

        if (filledAmount > 0) {
          const remaining = amount - filledAmount;
          const PRICE_BUFFER = 0.0005;
          const iocPrice = side === 'long'
            ? analysis.worstPrice * (1 - PRICE_BUFFER)
            : analysis.worstPrice * (1 + PRICE_BUFFER);
          const iocOrder = await Promise.race([
            ex.createOrder(symbol, 'limit', closeSide, remaining, iocPrice, {
              timeInForce: 'IOC', reduceOnly: true,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Close IOC timeout')), 3000),
            ),
          ]);
          const makerPriceFilled = (makerOrder.average as number) || makerPrice;
          const iocFilled = (iocOrder.filled as number) || 0;
          const iocFilledPrice = (iocOrder.average as number) || iocPrice;
          const totalFilled = filledAmount + iocFilled;
          const avgPrice = totalFilled > 0
            ? (filledAmount * makerPriceFilled + iocFilled * iocFilledPrice) / totalFilled
            : makerPriceFilled;
          const makerNotional = filledAmount * cSize * makerPriceFilled;
          const iocNotional = iocFilled * cSize * iocFilledPrice;
          console.log(`[${id}] ${symbol} CLOSE ${side} MAKER+IOC complete`);
          return {
            orderId: (makerOrder.id as string) || (iocOrder.id as string) || '',
            price: avgPrice,
            amount: totalFilled * cSize,
            filledNotional: makerNotional + iocNotional,
            liquidity: 'mixed',
            estimatedFee: estimateExecutionFee(id, [
              { notional: makerNotional, liquidity: 'maker' },
              { notional: iocNotional, liquidity: 'taker' },
            ], feeOverrides, paybackOverrides),
          };
        }
        // filledAmount === 0 → cancelled, fall through to IOC
      }
    } catch (makerErr) {
      console.log(`[${id}] ${symbol} CLOSE ${side} Post-Only failed: ${(makerErr as Error).message} — IOC fallback`);
    }

    // 2. Fallback: IOC taker close
    const PRICE_BUFFER = 0.0005;
    const limitPrice = side === 'long'
      ? analysis.worstPrice * (1 - PRICE_BUFFER)
      : analysis.worstPrice * (1 + PRICE_BUFFER);

    console.log(`[${id}] ${symbol} CLOSE ${side} IOC: limit=${limitPrice.toFixed(4)}, qty=${amount.toFixed(6)}`);

    const order = await Promise.race([
      ex.createOrder(symbol, 'limit', closeSide, amount, limitPrice, {
        timeInForce: 'IOC', reduceOnly: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Close IOC timeout`)), 3000),
      ),
    ]);

    const filledAmount = (order.filled as number) || 0;
    if (filledAmount < amount * 0.90) {
      const remaining = amount - filledAmount;
      const mktOrder = await Promise.race([
        ex.createMarketOrder(symbol, closeSide, remaining, undefined, { reduceOnly: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Close market timeout')), 3000)),
      ]);
      const filledPrice = (order.average as number) || limitPrice;
      const marketFilled = (mktOrder.filled as number) || remaining;
      const marketPrice = (mktOrder.average as number) || limitPrice;
      const totalFilled = filledAmount + marketFilled;
      const avgPrice = totalFilled > 0
        ? (filledAmount * filledPrice + marketFilled * marketPrice) / totalFilled
        : filledPrice;
      const filledNotional = (filledAmount * cSize * filledPrice) + (marketFilled * cSize * marketPrice);
      console.log(`[${id}] ${symbol} CLOSE ${side} complete`);
      return {
        orderId: (order.id as string) || (mktOrder.id as string) || '',
        price: avgPrice,
        amount: totalFilled * cSize,
        filledNotional,
        liquidity: 'taker',
        estimatedFee: estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'taker' }], feeOverrides, paybackOverrides),
      };
    }
    const filledPrice = (order.average as number) || limitPrice;
    const filledNotional = filledAmount * cSize * filledPrice;
    console.log(`[${id}] ${symbol} CLOSE ${side} complete`);
    return {
      orderId: (order.id as string) || '',
      price: filledPrice,
      amount: filledAmount * cSize,
      filledNotional,
      liquidity: 'taker',
      estimatedFee: estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'taker' }], feeOverrides, paybackOverrides),
    };
  } catch (err) {
    console.error(`[${id}] closePosition failed, fallback to market: ${(err as Error).message}`);
    const marketOrder = await Promise.race([
      ex.createMarketOrder(
        symbol,
        side === 'long' ? 'sell' : 'buy',
        amount,
        undefined,
        { reduceOnly: true },
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Emergency close timeout')), 3000)),
    ]);
    const filledAmount = (marketOrder.filled as number) || amount;
    const filledPrice = (marketOrder.average as number) || 0;
    const filledNotional = filledAmount * cSize * filledPrice;
    return {
      orderId: (marketOrder.id as string) || '',
      price: filledPrice,
      amount: filledAmount * cSize,
      filledNotional,
      liquidity: 'taker',
      estimatedFee: estimateExecutionFee(id, [{ notional: filledNotional, liquidity: 'taker' }], feeOverrides, paybackOverrides),
    };
  }
}

export async function fetchFundingHistory(
  id: ExchangeId,
  config: ApiConfig,
  symbol?: string,
  limit = 20,
): Promise<import('../types').FundingPayment[]> {
  const ex = makeExchange(id, config);
  let history: any[] = [];

  if (typeof ex.fetchFundingHistory !== 'function' && typeof ex.fetchIncome !== 'function') {
    return [];
  }

  try {
    if (typeof ex.fetchFundingHistory === 'function') {
      history = await ex.fetchFundingHistory(symbol, undefined, limit);
    } else if (typeof ex.fetchIncome === 'function') {
      history = await ex.fetchIncome({ incomeType: 'FUNDING_FEE', limit });
    }
  } catch (err) {
    throw new Error(`[${id}] fetchFundingHistory failed: ${(err as Error).message}`);
  }

  return history.slice(0, limit).map((item: any) => ({
    exchange: id,
    symbol: (item.symbol as string) || symbol || '',
    amount: (item.amount as number) || 0,
    rate: (item.fundingRate as number) || 0,
    timestamp: (item.timestamp as number) || Date.now(),
    side: ((item.side as string) || 'long') as 'long' | 'short',
  }));
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
  const ex = makeExchange(id, config);
  try {
    await ex.fetchBalance();
    return true;
  } catch {
    return false;
  }
}
