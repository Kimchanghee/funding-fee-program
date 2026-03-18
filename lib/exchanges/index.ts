/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import type { ApiConfig, ExchangeId, FundingRate, Balance, Position } from '../types';
import { TRACKED_SYMBOLS } from '../types';
import { normalizeFundingRate } from './utils';

// ── Exchange instance cache ──
const publicExchangeCache = new Map<ExchangeId, any>();
const MAX_PRIVATE_CACHE = 20;
const privateExchangeCache = new Map<string, any>();

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

function normalizeFr(id: ExchangeId, sym: string, fr: any): FundingRate | null {
  if (fr.fundingRate === undefined || fr.fundingRate === null) return null;

  // Prefer nextFundingDatetime/Timestamp (unambiguously the NEXT settlement)
  // fundingDatetime can be a past timestamp on some exchanges (e.g. Bybit)
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
    nextFundingTime = Date.now() + 8 * 3600000;
  }

  // Parse actual funding interval from CCXT (e.g. "8h", "4h", "1h")
  let intervalHours = 8;
  if (fr.interval) {
    const match = String(fr.interval).match(/(\d+)h/i);
    if (match) intervalHours = parseInt(match[1], 10);
  }

  return normalizeFundingRate(
    id,
    fr.fundingRate as number,
    sym,
    (fr.markPrice as number) || 0,
    nextFundingTime,
    intervalHours,
  );
}

// ── Load markets with timeout and retry ──
async function ensureMarkets(ex: any, id: ExchangeId, config?: ApiConfig): Promise<any> {
  try {
    await Promise.race([
      ex.loadMarkets() as Promise<unknown>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] loadMarkets timeout (10s)`)), 10000),
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
        setTimeout(() => reject(new Error(`[${id}] loadMarkets retry timeout (10s)`)), 10000),
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
  let ex = makeExchange(id, config);
  // Build a set of base symbols (e.g. "BTC/USDT") for flexible matching
  // This handles format differences across exchanges:
  //   Binance/OKX return "BTC/USDT:USDT", Bybit/Gate may return "BTC/USDT"
  const baseSet = symbols
    ? new Set(symbols.map((s) => s.replace(/:.*$/, '')))
    : null;

  console.log(`[CCXT] ${id}: loadMarkets 시작`);
  ex = await ensureMarkets(ex, id, config);
  console.log(`[CCXT] ${id}: loadMarkets 완료`);

  try {
    // ── Bulk fetch (1 API call) with 12s timeout ──
    console.log(`[CCXT] ${id}: fetchFundingRates 시작`);
    const frs = await Promise.race([
      ex.fetchFundingRates() as Promise<Record<string, any>>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] fetchFundingRates timeout (20s)`)), 20000),
      ),
    ]);
    const results: FundingRate[] = [];
    for (const [sym, fr] of Object.entries(frs)) {
      if (!sym.includes('USDT')) continue;
      const base = sym.replace(/:.*$/, '');
      if (baseSet && !baseSet.has(base)) continue;
      const normalized = normalizeFr(id, sym, fr);
      if (normalized) results.push(normalized);
    }
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

    const results: FundingRate[] = [];
    // Batch symbols into chunks of 10 to avoid overwhelming
    const chunks: string[][] = [];
    for (let i = 0; i < fallbackSymbols.length; i += 10) {
      chunks.push(fallbackSymbols.slice(i, i + 10));
    }

    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map(async (sym) => {
          try {
            const fr = await Promise.race([
              ex.fetchFundingRate(sym),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`timeout`)), 8000),
              ),
            ]);
            const normalized = normalizeFr(id, sym, fr);
            if (normalized) results.push(normalized);
          } catch { /* skip failed symbol */ }
        }),
      );
    }

    if (results.length === 0) {
      evictExchangeCache(id, config);
      throw new Error(`[${id}] all fetch methods failed`);
    }
    return results;
  }
}

export async function fetchBalance(id: ExchangeId, config: ApiConfig): Promise<Balance> {
  const ex = makeExchange(id, config);
  try {
    const bal = await ex.fetchBalance();
    const usdt = bal['USDT'] ?? bal['usdt'];
    return {
      exchange: id,
      totalUSDT: (usdt?.total as number) || 0,
      availableUSDT: (usdt?.free as number) || 0,
      usedUSDT: (usdt?.used as number) || 0,
      unrealizedPnl: 0,
      status: 'connected',
      updatedAt: Date.now(),
    };
  } catch {
    return {
      exchange: id,
      totalUSDT: 0,
      availableUSDT: 0,
      usedUSDT: 0,
      unrealizedPnl: 0,
      status: 'error',
      updatedAt: Date.now(),
    };
  }
}

export async function fetchPositions(id: ExchangeId, config: ApiConfig): Promise<Position[]> {
  const ex = makeExchange(id, config);
  try {
    const raw: any[] = await ex.fetchPositions();
    return raw
      .filter((p: any) => p.contracts && (p.contracts as number) > 0)
      .map((p: any) => ({
        exchange: id,
        symbol: (p.symbol as string) || '',
        displaySymbol: ((p.symbol as string) || '').replace(':USDT', '').replace(':USD', ''),
        baseAsset: ((p.symbol as string) || '').split('/')[0] || '',
        side: (p.side === 'long' ? 'long' : 'short') as 'long' | 'short',
        size: (p.contracts as number) || 0,
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
      }));
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

  // Insufficient liquidity — extrapolate from last level
  if (remainingUSD > 0) {
    const lastPrice = levels[levels.length - 1][0];
    const fillQty = remainingUSD / lastPrice;
    totalCost += fillQty * lastPrice;
    totalQty += fillQty;
    worstPrice = lastPrice;
  }

  return {
    fillPrice: totalCost / totalQty,
    worstPrice,
    totalQty,
  };
}

/**
 * Open position using limit IOC order based on orderbook analysis.
 * Provides precise notional control and slippage protection vs market orders.
 * Falls back to market order if limit IOC fill is insufficient.
 */
export async function openPosition(
  id: ExchangeId,
  config: ApiConfig,
  symbol: string,
  side: 'long' | 'short',
  amountUSDT: number,
  leverage: number,
): Promise<{ orderId: string; price: number; amount: number; filledNotional: number }> {
  const ex = makeExchange(id, config);
  try {
    await ex.setLeverage(leverage, symbol).catch(() => {});

    // 1. Fetch orderbook for price analysis
    const ob = await Promise.race([
      ex.fetchOrderBook(symbol, 20) as Promise<{ asks: number[][]; bids: number[][] }>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] fetchOrderBook timeout`)), 8000),
      ),
    ]);

    // Buy (long) eats asks, Sell (short) eats bids
    const levels = side === 'long' ? ob.asks : ob.bids;
    if (!levels || levels.length === 0) {
      throw new Error(`[${id}] Empty orderbook for ${symbol} (${side})`);
    }

    const notional = amountUSDT * leverage;
    const analysis = analyzeOrderbook(levels, notional);

    // 2. Set limit price with small buffer beyond worst level to ensure full fill
    //    Buy: slightly above worst ask level, Sell: slightly below worst bid level
    const PRICE_BUFFER = 0.0005; // 0.05%
    const limitPrice = side === 'long'
      ? analysis.worstPrice * (1 + PRICE_BUFFER)
      : analysis.worstPrice * (1 - PRICE_BUFFER);

    // 3. Calculate contract amount from expected fill price for precise notional
    const contractAmount = notional / analysis.fillPrice;

    console.log(
      `[${id}] ${symbol} ${side} LIMIT IOC: limit=${limitPrice.toFixed(4)}, ` +
      `qty=${contractAmount.toFixed(6)}, expectedFill=${analysis.fillPrice.toFixed(4)}, ` +
      `worst=${analysis.worstPrice.toFixed(4)}, notional=$${notional.toFixed(2)}`,
    );

    // 4. Place limit IOC order
    const order = await ex.createOrder(
      symbol,
      'limit',
      side === 'long' ? 'buy' : 'sell',
      contractAmount,
      limitPrice,
      { timeInForce: 'IOC', reduceOnly: false },
    );

    const filledAmount = (order.filled as number) || 0;
    const filledPrice = (order.average as number) || limitPrice;
    const filledNotional = filledAmount * filledPrice;

    // 5. If IOC fill < 90%, supplement with market order for remaining
    if (filledAmount < contractAmount * 0.90) {
      const remaining = contractAmount - filledAmount;
      console.log(
        `[${id}] ${symbol} ${side} IOC partial fill ${((filledAmount / contractAmount) * 100).toFixed(1)}%, ` +
        `market-filling remaining ${remaining.toFixed(6)}`,
      );
      const mktOrder = await ex.createMarketOrder(
        symbol,
        side === 'long' ? 'buy' : 'sell',
        remaining,
        undefined,
        { reduceOnly: false },
      );
      const mktFilled = (mktOrder.filled as number) || remaining;
      const mktPrice = (mktOrder.average as number) || limitPrice;
      const totalFilled = filledAmount + mktFilled;
      const avgPrice = (filledAmount * filledPrice + mktFilled * mktPrice) / totalFilled;

      console.log(
        `[${id}] ${symbol} ${side} COMBINED: avgPrice=${avgPrice.toFixed(4)}, ` +
        `totalQty=${totalFilled.toFixed(6)}, notional=$${(totalFilled * avgPrice).toFixed(2)}`,
      );

      return {
        orderId: (order.id as string) || (mktOrder.id as string) || '',
        price: avgPrice,
        amount: totalFilled,
        filledNotional: totalFilled * avgPrice,
      };
    }

    console.log(
      `[${id}] ${symbol} ${side} FILLED: price=${filledPrice.toFixed(4)}, ` +
      `qty=${filledAmount.toFixed(6)}, notional=$${filledNotional.toFixed(2)}`,
    );

    return {
      orderId: (order.id as string) || '',
      price: filledPrice,
      amount: filledAmount,
      filledNotional,
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
 * Open position with pre-computed quantity and limit price.
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
): Promise<{ orderId: string; price: number; amount: number; filledNotional: number }> {
  const ex = makeExchange(id, config);
  try {
    await ex.setLeverage(leverage, symbol).catch(() => {});

    console.log(
      `[${id}] ${symbol} ${side} EXACT LIMIT IOC: limit=${limitPrice.toFixed(4)}, qty=${qty.toFixed(6)}`,
    );

    const order = await ex.createOrder(
      symbol,
      'limit',
      side === 'long' ? 'buy' : 'sell',
      qty,
      limitPrice,
      { timeInForce: 'IOC', reduceOnly: false },
    );

    const filledAmount = (order.filled as number) || 0;
    const filledPrice = (order.average as number) || limitPrice;

    // If IOC fill < 90%, supplement with market order
    if (filledAmount < qty * 0.90) {
      const remaining = qty - filledAmount;
      console.log(
        `[${id}] ${symbol} ${side} IOC partial fill ${((filledAmount / qty) * 100).toFixed(1)}%, ` +
        `market-filling remaining ${remaining.toFixed(6)}`,
      );
      const mktOrder = await ex.createMarketOrder(
        symbol,
        side === 'long' ? 'buy' : 'sell',
        remaining,
        undefined,
        { reduceOnly: false },
      );
      const mktFilled = (mktOrder.filled as number) || remaining;
      const mktPrice = (mktOrder.average as number) || limitPrice;
      const totalFilled = filledAmount + mktFilled;
      const avgPrice = (filledAmount * filledPrice + mktFilled * mktPrice) / totalFilled;

      console.log(
        `[${id}] ${symbol} ${side} EXACT COMBINED: avgPrice=${avgPrice.toFixed(4)}, ` +
        `totalQty=${totalFilled.toFixed(6)}, notional=$${(totalFilled * avgPrice).toFixed(2)}`,
      );

      return {
        orderId: (order.id as string) || (mktOrder.id as string) || '',
        price: avgPrice,
        amount: totalFilled,
        filledNotional: totalFilled * avgPrice,
      };
    }

    const filledNotional = filledAmount * filledPrice;
    console.log(
      `[${id}] ${symbol} ${side} EXACT FILLED: price=${filledPrice.toFixed(4)}, ` +
      `qty=${filledAmount.toFixed(6)}, notional=$${filledNotional.toFixed(2)}`,
    );

    return {
      orderId: (order.id as string) || '',
      price: filledPrice,
      amount: filledAmount,
      filledNotional,
    };
  } catch (err) {
    throw new Error(`[${id}] openPositionExact failed: ${(err as Error).message}`);
  }
}

export async function closePosition(
  id: ExchangeId,
  config: ApiConfig,
  symbol: string,
  side: 'long' | 'short',
  amount: number,
): Promise<void> {
  const ex = makeExchange(id, config);
  try {
    // 1. Fetch orderbook for price analysis
    const ob = await Promise.race([
      ex.fetchOrderBook(symbol, 20) as Promise<{ asks: number[][]; bids: number[][] }>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] fetchOrderBook timeout`)), 8000),
      ),
    ]);

    // Close long = sell into bids, Close short = buy from asks
    const levels = side === 'long' ? ob.bids : ob.asks;
    if (!levels || levels.length === 0) {
      throw new Error('empty orderbook');
    }

    const estimatedNotional = amount * levels[0][0];
    const analysis = analyzeOrderbook(levels, estimatedNotional);

    // Set limit price with buffer
    const PRICE_BUFFER = 0.0005;
    const limitPrice = side === 'long'
      ? analysis.worstPrice * (1 - PRICE_BUFFER) // selling: slightly below worst bid
      : analysis.worstPrice * (1 + PRICE_BUFFER); // buying: slightly above worst ask

    console.log(
      `[${id}] ${symbol} CLOSE ${side} LIMIT IOC: limit=${limitPrice.toFixed(4)}, qty=${amount.toFixed(6)}`,
    );

    // 2. Place limit IOC order
    const order = await ex.createOrder(
      symbol,
      'limit',
      side === 'long' ? 'sell' : 'buy',
      amount,
      limitPrice,
      { timeInForce: 'IOC', reduceOnly: true },
    );

    const filledAmount = (order.filled as number) || 0;

    // 3. If IOC didn't fill enough, market close the remainder
    if (filledAmount < amount * 0.90) {
      const remaining = amount - filledAmount;
      console.log(
        `[${id}] ${symbol} close IOC partial (${((filledAmount / amount) * 100).toFixed(1)}%), ` +
        `market-closing remaining ${remaining.toFixed(6)}`,
      );
      await ex.createMarketOrder(
        symbol,
        side === 'long' ? 'sell' : 'buy',
        remaining,
        undefined,
        { reduceOnly: true },
      );
    }

    console.log(`[${id}] ${symbol} CLOSE ${side} complete`);
  } catch (err) {
    // Fallback: market close on any limit order failure
    console.error(`[${id}] closePosition limit failed, fallback to market: ${(err as Error).message}`);
    await ex.createMarketOrder(
      symbol,
      side === 'long' ? 'sell' : 'buy',
      amount,
      undefined,
      { reduceOnly: true },
    );
  }
}

export async function fetchFundingHistory(
  id: ExchangeId,
  config: ApiConfig,
  symbol?: string,
  limit = 20,
): Promise<import('../types').FundingPayment[]> {
  const ex = makeExchange(id, config);
  try {
    let history: any[] = [];

    if (typeof ex.fetchFundingHistory === 'function') {
      history = await ex.fetchFundingHistory(symbol, undefined, limit);
    } else if (typeof ex.fetchIncome === 'function') {
      history = await ex.fetchIncome({ incomeType: 'FUNDING_FEE', limit });
    }

    return history.slice(0, limit).map((item: any) => ({
      exchange: id,
      symbol: (item.symbol as string) || symbol || '',
      amount: (item.amount as number) || 0,
      rate: (item.fundingRate as number) || 0,
      timestamp: (item.timestamp as number) || Date.now(),
      side: ((item.side as string) || 'long') as 'long' | 'short',
    }));
  } catch {
    return [];
  }
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
): Promise<{ fillPrice: number; slippagePercent: number; midPrice: number }> {
  const ex = getPublicExchange(id);
  await ensureMarkets(ex, id);

  const ob = await Promise.race([
    ex.fetchOrderBook(symbol, 20) as Promise<{ asks: number[][]; bids: number[][] }>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[${id}] fetchOrderBook timeout`)), 8000),
    ),
  ]);

  // buy (long) eats asks, sell (short) eats bids
  const levels = side === 'buy' ? ob.asks : ob.bids;
  if (!levels || levels.length === 0) {
    throw new Error(`[${id}] empty orderbook for ${symbol}`);
  }

  const midPrice = (ob.asks[0][0] + ob.bids[0][0]) / 2;
  let remainingUSD = notionalUSDT;
  let totalCost = 0;
  let totalQty = 0;

  for (const [price, qty] of levels) {
    const levelUSD = price * qty;
    if (remainingUSD <= 0) break;
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
    // Not enough liquidity — use last level price for remainder
    const lastPrice = levels[levels.length - 1][0];
    const fillQty = remainingUSD / lastPrice;
    totalCost += fillQty * lastPrice;
    totalQty += fillQty;
  }

  const fillPrice = totalCost / totalQty;
  const slippagePercent = Math.abs((fillPrice - midPrice) / midPrice) * 100;

  return { fillPrice, slippagePercent, midPrice };
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
