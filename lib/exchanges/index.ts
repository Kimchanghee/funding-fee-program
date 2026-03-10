/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import type { ApiConfig, ExchangeId, FundingRate, Balance, Position } from '../types';
import { normalizeFundingRate } from './utils';

function makeExchange(id: ExchangeId, config?: ApiConfig): any {
  const opts: Record<string, unknown> = {
    apiKey: config?.apiKey || '',
    secret: config?.secret || '',
    options: { defaultType: 'swap' },
    enableRateLimit: true,
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

function normalizeFr(id: ExchangeId, sym: string, fr: any): FundingRate | null {
  if (fr.fundingRate === undefined || fr.fundingRate === null) return null;
  return normalizeFundingRate(
    id,
    fr.fundingRate as number,
    sym,
    (fr.markPrice as number) || 0,
    fr.fundingDatetime
      ? new Date(fr.fundingDatetime as string).getTime()
      : fr.nextFundingDatetime
      ? new Date(fr.nextFundingDatetime as string).getTime()
      : Date.now() + 8 * 3600000,
  );
}

export async function fetchFundingRates(
  id: ExchangeId,
  config?: ApiConfig,
  symbols?: string[],
): Promise<FundingRate[]> {
  const ex = makeExchange(id, config);
  const symbolSet = symbols ? new Set(symbols) : null;

  try {
    // ── Bulk fetch (1 API call) with 20s timeout ──────────────────────────
    const frs = await Promise.race([
      ex.fetchFundingRates() as Promise<Record<string, any>>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`[${id}] fetchFundingRates timeout`)), 20000),
      ),
    ]);
    const results: FundingRate[] = [];
    for (const [sym, fr] of Object.entries(frs)) {
      if (!sym.includes('USDT')) continue;
      if (symbolSet && !symbolSet.has(sym)) continue;
      const normalized = normalizeFr(id, sym, fr);
      if (normalized) results.push(normalized);
    }
    return results;
  } catch {
    // ── Fallback: individual fetches in parallel ──────────────────────────
    if (!symbols || symbols.length === 0) throw new Error(`[${id}] fetchFundingRates failed`);
    const results: FundingRate[] = [];
    await Promise.allSettled(
      symbols.map(async (sym) => {
        try {
          const fr = await ex.fetchFundingRate(sym);
          const normalized = normalizeFr(id, sym, fr);
          if (normalized) results.push(normalized);
        } catch { /* skip */ }
      }),
    );
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

export async function openPosition(
  id: ExchangeId,
  config: ApiConfig,
  symbol: string,
  side: 'long' | 'short',
  amountUSDT: number,
  leverage: number,
): Promise<{ orderId: string; price: number; amount: number }> {
  const ex = makeExchange(id, config);
  try {
    // Set leverage
    await ex.setLeverage(leverage, symbol).catch(() => {});

    // Get mark price to calculate quantity
    const ticker = await ex.fetchTicker(symbol);
    const price = (ticker.last as number) || (ticker.close as number) || 0;
    if (!price) throw new Error('Could not fetch price');

    const contractAmount = (amountUSDT * leverage) / price;

    const order = await ex.createMarketOrder(
      symbol,
      side === 'long' ? 'buy' : 'sell',
      contractAmount,
      undefined,
      { reduceOnly: false },
    );

    return {
      orderId: (order.id as string) || '',
      price: (order.average as number) || price,
      amount: contractAmount,
    };
  } catch (err) {
    throw new Error(`[${id}] openPosition failed: ${(err as Error).message}`);
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
    await ex.createMarketOrder(
      symbol,
      side === 'long' ? 'sell' : 'buy',
      amount,
      undefined,
      { reduceOnly: true },
    );
  } catch (err) {
    throw new Error(`[${id}] closePosition failed: ${(err as Error).message}`);
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

    // Different exchanges have different methods
    if (typeof ex.fetchFundingHistory === 'function') {
      history = await ex.fetchFundingHistory(symbol, undefined, limit);
    } else if (typeof ex.fetchIncome === 'function') {
      // Binance-style
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

export async function testConnection(id: ExchangeId, config: ApiConfig): Promise<boolean> {
  const ex = makeExchange(id, config);
  try {
    await ex.fetchBalance();
    return true;
  } catch {
    return false;
  }
}
