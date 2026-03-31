/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import { pathToFileURL } from 'url';
import type { ExchangeId, FundingRate } from '../types';
import { TRACKED_SYMBOLS } from '../types';
import { normalizeFundingRate } from './utils';

interface ProExchangeLike {
  markets: Record<string, any>;
  loadMarkets: () => Promise<unknown>;
  close: () => Promise<unknown>;
  watchOrderBook: (symbol: string, limit?: number) => Promise<any>;
  watchTicker?: (symbol: string) => Promise<any>;
  watchMarkPrice?: (symbol: string) => Promise<any>;
  watchFundingRate?: (symbol: string) => Promise<any>;
}

interface FundingSnapshot {
  fundingRate?: number;
  nextFundingTime?: number;
  markPrice?: number;
  intervalHours?: number;
  quoteVolume24h?: number;
  updatedAt: number;
}

interface OrderbookSnapshot {
  bids: number[][];
  asks: number[][];
  updatedAt: number;
}

const trackedBaseSet = new Set(TRACKED_SYMBOLS);

const PRO_MODULE_BY_EXCHANGE: Record<ExchangeId, string> = {
  binance: 'binanceusdm',
  bybit: 'bybit',
  okx: 'okx',
  bitget: 'bitget',
  gate: 'gateio',
  bingx: 'bingx',
};

const wsExchangeCache = new Map<ExchangeId, Promise<ProExchangeLike>>();
const fundingSymbolsCache = new Map<ExchangeId, Promise<string[]>>();
const fundingStateCache = new Map<ExchangeId, Map<string, FundingSnapshot>>();
const fundingLoopKeys = new Set<string>();
const orderbookLoopKeys = new Set<string>();
const orderbookStateCache = new Map<string, OrderbookSnapshot>();
const lastWarnAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function warnThrottled(key: string, message: string): void {
  const now = Date.now();
  const last = lastWarnAt.get(key) ?? 0;
  if (now - last < 15_000) return;
  lastWarnAt.set(key, now);
  console.warn(message);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseIntervalHours(value: unknown, fallback = 8): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const match = value.match(/(\d+)/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return fallback;
}

function resolveNextFundingTime(nextFundingTime: number | undefined, intervalHours: number): number {
  const intervalMs = intervalHours * 3_600_000;
  let next = nextFundingTime ?? (Date.now() + intervalMs);
  while (next < Date.now() - 30_000) {
    next += intervalMs;
  }
  return next;
}

function normalizeLevels(levels: any, limit: number): number[][] {
  if (!Array.isArray(levels)) return [];

  const normalized: number[][] = [];
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const price = toFiniteNumber(level[0]);
    const amount = toFiniteNumber(level[1]);
    if (price === undefined || amount === undefined) continue;
    normalized.push([price, amount]);
    if (normalized.length >= limit) break;
  }

  return normalized;
}

function upsertFundingSnapshot(id: ExchangeId, symbol: string, patch: Partial<FundingSnapshot>): void {
  let bySymbol = fundingStateCache.get(id);
  if (!bySymbol) {
    bySymbol = new Map<string, FundingSnapshot>();
    fundingStateCache.set(id, bySymbol);
  }

  const prev = bySymbol.get(symbol);
  const next: FundingSnapshot = {
    fundingRate: patch.fundingRate ?? prev?.fundingRate,
    nextFundingTime: patch.nextFundingTime ?? prev?.nextFundingTime,
    markPrice: patch.markPrice ?? prev?.markPrice,
    intervalHours: patch.intervalHours ?? prev?.intervalHours,
    quoteVolume24h: patch.quoteVolume24h ?? prev?.quoteVolume24h,
    updatedAt: Date.now(),
  };
  bySymbol.set(symbol, next);
}

function buildFundingRate(id: ExchangeId, symbol: string, snapshot: FundingSnapshot): FundingRate | null {
  if (snapshot.fundingRate === undefined || !Number.isFinite(snapshot.fundingRate)) return null;

  const intervalHours = parseIntervalHours(snapshot.intervalHours, 8);
  const nextFundingTime = resolveNextFundingTime(snapshot.nextFundingTime, intervalHours);
  const markPrice = snapshot.markPrice ?? 0;

  const normalized = normalizeFundingRate(
    id,
    snapshot.fundingRate,
    symbol,
    markPrice,
    nextFundingTime,
    intervalHours,
  );

  if (snapshot.quoteVolume24h !== undefined) {
    normalized.quoteVolume24h = snapshot.quoteVolume24h;
  }
  return normalized;
}

async function importProExchangeCtor(id: ExchangeId): Promise<new (config?: Record<string, unknown>) => ProExchangeLike> {
  const moduleId = PRO_MODULE_BY_EXCHANGE[id];
  const modulePath = path.join(
    process.cwd(),
    'node_modules',
    'ccxt',
    'js',
    'src',
    'pro',
    `${moduleId}.js`,
  );
  const moduleUrl = pathToFileURL(modulePath).href;
  const mod = await import(/* webpackIgnore: true */ moduleUrl) as { default: new (config?: Record<string, unknown>) => ProExchangeLike };
  return mod.default;
}

async function getWsExchange(id: ExchangeId): Promise<ProExchangeLike> {
  let cached = wsExchangeCache.get(id);
  if (!cached) {
    cached = (async () => {
      const Ctor = await importProExchangeCtor(id);
      const exchange = new Ctor({
        enableRateLimit: true,
        timeout: 15_000,
        options: { defaultType: id === 'binance' ? 'future' : 'swap' },
      });
      await exchange.loadMarkets();
      return exchange;
    })();

    cached.catch(() => wsExchangeCache.delete(id));
    wsExchangeCache.set(id, cached);
  }

  return cached;
}

function isEligibleFundingMarket(market: any): boolean {
  if (!market) return false;
  if (market.active === false) return false;
  if (!market.swap || !market.linear) return false;
  if (market.quote !== 'USDT' || market.settle !== 'USDT') return false;
  if (market.expiry) return false;
  if (!market.base || !trackedBaseSet.has(market.base)) return false;
  return typeof market.symbol === 'string';
}

async function getDefaultFundingSymbols(id: ExchangeId): Promise<string[]> {
  let cached = fundingSymbolsCache.get(id);
  if (!cached) {
    cached = (async () => {
      const ex = await getWsExchange(id);
      const byBase = new Map<string, string>();

      for (const market of Object.values(ex.markets ?? {})) {
        if (!isEligibleFundingMarket(market)) continue;
        const base = market.base as string;
        if (!byBase.has(base)) byBase.set(base, market.symbol as string);
      }

      const symbols: string[] = [];
      for (const base of TRACKED_SYMBOLS) {
        const symbol = byBase.get(base);
        if (symbol) symbols.push(symbol);
      }
      return symbols;
    })();

    cached.catch(() => fundingSymbolsCache.delete(id));
    fundingSymbolsCache.set(id, cached);
  }

  return cached;
}

function symbolToBase(symbol: string): string {
  return symbol.replace(/:.*$/, '').split('/')[0] ?? symbol;
}

async function resolveRequestedSymbols(id: ExchangeId, requested?: string[]): Promise<string[]> {
  const defaults = await getDefaultFundingSymbols(id);
  if (!requested || requested.length === 0) return defaults;

  const defaultByBase = new Map<string, string>();
  for (const symbol of defaults) {
    defaultByBase.set(symbolToBase(symbol), symbol);
  }

  const ex = await getWsExchange(id);
  const resolved = new Set<string>();

  for (const input of requested) {
    const base = symbolToBase(input);
    const preferred = defaultByBase.get(base);
    if (preferred) {
      resolved.add(preferred);
      continue;
    }

    if (ex.markets?.[input]) {
      resolved.add(input);
      continue;
    }

    const withSettle = `${base}/USDT:USDT`;
    if (ex.markets?.[withSettle]) {
      resolved.add(withSettle);
      continue;
    }

    const withoutSettle = `${base}/USDT`;
    if (ex.markets?.[withoutSettle]) {
      resolved.add(withoutSettle);
      continue;
    }
  }

  return Array.from(resolved);
}

function getWatchDepth(id: ExchangeId, requestedDepth: number): number {
  const depth = Math.max(5, requestedDepth);
  switch (id) {
    case 'bybit': {
      if (depth <= 1) return 1;
      if (depth <= 50) return 50;
      if (depth <= 200) return 200;
      return 1000;
    }
    case 'bitget':
    case 'okx':
      // 50 can route to restricted channels in some WS implementations.
      return depth <= 5 ? 5 : 20;
    case 'gate':
      return depth <= 50 ? 50 : 100;
    case 'bingx':
      return depth <= 50 ? 50 : 100;
    case 'binance':
    default:
      return depth;
  }
}

function parseFundingFromTicker(id: ExchangeId, ticker: any): Partial<FundingSnapshot> {
  const info = (ticker && typeof ticker === 'object') ? (ticker.info ?? {}) : {};

  let fundingRate = toFiniteNumber(ticker?.fundingRate)
    ?? toFiniteNumber(info.fundingRate)
    ?? toFiniteNumber(info.funding_rate);

  let nextFundingTime = toFiniteNumber(ticker?.nextFundingTimestamp)
    ?? toFiniteNumber(ticker?.fundingTimestamp)
    ?? toFiniteNumber(info.nextFundingTime)
    ?? toFiniteNumber(info.nextFundingTimestamp)
    ?? toFiniteNumber(info.T);

  let intervalHours = parseIntervalHours(
    info.fundingIntervalHour
      ?? ticker?.interval
      ?? info.interval,
    8,
  );

  const markPrice = toFiniteNumber(ticker?.markPrice)
    ?? toFiniteNumber(info.markPrice)
    ?? toFiniteNumber(info.mark_price)
    ?? toFiniteNumber(ticker?.last)
    ?? toFiniteNumber(info.last)
    ?? toFiniteNumber(info.c)
    ?? toFiniteNumber(info.p);

  const quoteVolume24h = toFiniteNumber(ticker?.quoteVolume)
    ?? toFiniteNumber(info.turnover24h)
    ?? toFiniteNumber(info.quoteVolume)
    ?? toFiniteNumber(info.volume_24h_quote)
    ?? toFiniteNumber(info.volume_24h_settle)
    ?? toFiniteNumber(info.q);

  if (id === 'bingx') {
    // BingX public WS does not expose funding rates in ticker/mark channels.
    fundingRate = undefined;
    nextFundingTime = undefined;
    intervalHours = 8;
  }

  return {
    fundingRate,
    nextFundingTime,
    markPrice,
    intervalHours,
    quoteVolume24h,
  };
}

function parseFundingFromMarkPrice(mark: any): Partial<FundingSnapshot> {
  const info = (mark && typeof mark === 'object') ? (mark.info ?? {}) : {};
  return {
    fundingRate: toFiniteNumber(info.r),
    nextFundingTime: toFiniteNumber(info.T),
    markPrice: toFiniteNumber(mark?.markPrice)
      ?? toFiniteNumber(info.p)
      ?? toFiniteNumber(mark?.last),
    intervalHours: 8,
  };
}

function parseFundingFromFundingRate(funding: any): Partial<FundingSnapshot> {
  const intervalHours = parseIntervalHours(funding?.interval, 8);
  const fundingTimestamp = toFiniteNumber(funding?.fundingTimestamp);
  const nextFundingTimestamp = toFiniteNumber(funding?.nextFundingTimestamp);

  return {
    fundingRate: toFiniteNumber(funding?.fundingRate),
    nextFundingTime:
      (fundingTimestamp && fundingTimestamp > Date.now())
        ? fundingTimestamp
        : nextFundingTimestamp,
    markPrice: toFiniteNumber(funding?.markPrice),
    intervalHours,
  };
}

function startFundingLoop(
  loopKey: string,
  runner: () => Promise<void>,
): void {
  if (fundingLoopKeys.has(loopKey)) return;
  fundingLoopKeys.add(loopKey);

  void (async () => {
    let retries = 0;
    for (;;) {
      try {
        await runner();
        retries = 0;
      } catch (err) {
        retries += 1;
        warnThrottled(loopKey, `[WS] ${loopKey} failed: ${(err as Error).message}`);
        const waitMs = Math.min(5_000, 300 * 2 ** Math.min(retries, 4));
        await sleep(waitMs);
      }
    }
  })();
}

function ensureFundingLoops(id: ExchangeId, symbol: string): void {
  if (id === 'binance') {
    startFundingLoop(`${id}:${symbol}:mark`, async () => {
      const ex = await getWsExchange(id);
      if (typeof ex.watchMarkPrice !== 'function') {
        throw new Error('watchMarkPrice unsupported');
      }
      const mark = await ex.watchMarkPrice(symbol);
      upsertFundingSnapshot(id, symbol, parseFundingFromMarkPrice(mark));
    });
    return;
  }

  if (id === 'okx') {
    startFundingLoop(`${id}:${symbol}:funding`, async () => {
      const ex = await getWsExchange(id);
      if (typeof ex.watchFundingRate !== 'function') {
        throw new Error('watchFundingRate unsupported');
      }
      const funding = await ex.watchFundingRate(symbol);
      upsertFundingSnapshot(id, symbol, parseFundingFromFundingRate(funding));
    });

    startFundingLoop(`${id}:${symbol}:ticker`, async () => {
      const ex = await getWsExchange(id);
      if (typeof ex.watchTicker !== 'function') {
        throw new Error('watchTicker unsupported');
      }
      const ticker = await ex.watchTicker(symbol);
      upsertFundingSnapshot(id, symbol, parseFundingFromTicker(id, ticker));
    });
    return;
  }

  startFundingLoop(`${id}:${symbol}:ticker`, async () => {
    const ex = await getWsExchange(id);
    if (typeof ex.watchTicker !== 'function') {
      throw new Error('watchTicker unsupported');
    }
    const ticker = await ex.watchTicker(symbol);
    upsertFundingSnapshot(id, symbol, parseFundingFromTicker(id, ticker));
  });
}

function ensureOrderbookLoop(id: ExchangeId, symbol: string, depth: number): void {
  const loopKey = `${id}:${symbol}:orderbook`;
  if (orderbookLoopKeys.has(loopKey)) return;
  orderbookLoopKeys.add(loopKey);

  const watchDepth = getWatchDepth(id, depth);

  void (async () => {
    let retries = 0;
    for (;;) {
      try {
        const ex = await getWsExchange(id);
        const ob = await ex.watchOrderBook(symbol, watchDepth);
        const bids = normalizeLevels(ob?.bids, 500);
        const asks = normalizeLevels(ob?.asks, 500);

        if (bids.length === 0 || asks.length === 0) {
          throw new Error('empty orderbook snapshot');
        }

        orderbookStateCache.set(`${id}:${symbol}`, {
          bids,
          asks,
          updatedAt: Date.now(),
        });
        retries = 0;
      } catch (err) {
        retries += 1;
        warnThrottled(loopKey, `[WS] ${loopKey} failed: ${(err as Error).message}`);
        const waitMs = Math.min(5_000, 300 * 2 ** Math.min(retries, 4));
        await sleep(waitMs);
      }
    }
  })();
}

function collectFundingRates(id: ExchangeId, symbols: string[]): FundingRate[] {
  const bySymbol = fundingStateCache.get(id);
  if (!bySymbol) return [];

  const out: FundingRate[] = [];
  for (const symbol of symbols) {
    const snapshot = bySymbol.get(symbol);
    if (!snapshot) continue;
    const normalized = buildFundingRate(id, symbol, snapshot);
    if (normalized) out.push(normalized);
  }
  return out;
}

export async function fetchFundingRatesViaWs(
  id: ExchangeId,
  symbols?: string[],
): Promise<FundingRate[]> {
  const targetSymbols = await resolveRequestedSymbols(id, symbols);
  if (targetSymbols.length === 0) {
    throw new Error(`[${id}] no WS symbols available`);
  }

  for (const symbol of targetSymbols) {
    ensureFundingLoops(id, symbol);
  }

  const waitUntil = Date.now() + 8_000;
  let rates = collectFundingRates(id, targetSymbols);

  // Wait for initial warm-up if cache is empty.
  while (rates.length === 0 && Date.now() < waitUntil) {
    await sleep(120);
    rates = collectFundingRates(id, targetSymbols);
  }

  if (rates.length === 0) {
    throw new Error(`[${id}] funding WS warm-up timeout`);
  }

  return rates;
}

export async function fetchOrderbookViaWs(
  id: ExchangeId,
  symbol: string,
  depth = 50,
): Promise<{ bids: number[][]; asks: number[][] }> {
  ensureOrderbookLoop(id, symbol, depth);

  const key = `${id}:${symbol}`;
  const deadline = Date.now() + 6_000;

  while (Date.now() < deadline) {
    const snapshot = orderbookStateCache.get(key);
    if (snapshot && snapshot.bids.length > 0 && snapshot.asks.length > 0) {
      return {
        bids: snapshot.bids.slice(0, depth),
        asks: snapshot.asks.slice(0, depth),
      };
    }
    await sleep(80);
  }

  const stale = orderbookStateCache.get(key);
  if (stale && stale.bids.length > 0 && stale.asks.length > 0) {
    return {
      bids: stale.bids.slice(0, depth),
      asks: stale.asks.slice(0, depth),
    };
  }

  throw new Error(`[${id}] watchOrderBook timeout`);
}
