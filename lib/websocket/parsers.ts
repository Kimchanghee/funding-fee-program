import type { ExchangeId } from '../types';

export interface WsRateUpdate {
  exchange: ExchangeId;
  symbol: string;
  baseAsset: string;
  rate: number;
  markPrice: number;
  nextFundingTime: number;
}

// ─── Binance: !markPrice@arr stream ───────────────────────────────────────────
// [{e, s, p (markPrice), r (fundingRate), T (nextFundingTime ms)}, ...]
export function parseBinanceMarkPrice(data: string): WsRateUpdate[] {
  try {
    const arr = JSON.parse(data) as Array<{
      e: string; s: string; p: string; r: string; T: number;
    }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(item => item.e === 'markPriceUpdate' && item.s.endsWith('USDT') && !item.s.includes('_'))
      .map(item => {
        const baseAsset = item.s.replace('USDT', '');
        return {
          exchange: 'binance' as ExchangeId,
          symbol: `${baseAsset}/USDT:USDT`,
          baseAsset,
          rate: parseFloat(item.r) || 0,
          markPrice: parseFloat(item.p) || 0,
          nextFundingTime: item.T || Date.now() + 8 * 3600000,
        };
      });
  } catch { return []; }
}

// ─── Bybit: tickers.SYMBOL snapshot ──────────────────────────────────────────
// {"topic":"tickers.BTCUSDT","type":"snapshot","data":{"symbol":"BTCUSDT","fundingRate":"0.0001","markPrice":"65000","nextFundingTime":"1705046400000"}}
export function parseBybitTicker(data: string): WsRateUpdate[] {
  try {
    const msg = JSON.parse(data) as {
      topic?: string;
      data?: { symbol: string; fundingRate?: string; markPrice?: string; nextFundingTime?: string };
    };
    if (!msg.topic?.startsWith('tickers.') || !msg.data?.fundingRate) return [];
    const sym = msg.data.symbol;
    if (!sym.endsWith('USDT')) return [];
    const baseAsset = sym.replace('USDT', '');
    return [{
      exchange: 'bybit' as ExchangeId,
      symbol: `${baseAsset}/USDT:USDT`,
      baseAsset,
      rate: parseFloat(msg.data.fundingRate) || 0,
      markPrice: parseFloat(msg.data.markPrice || '0') || 0,
      nextFundingTime: parseInt(msg.data.nextFundingTime || '0') || Date.now() + 8 * 3600000,
    }];
  } catch { return []; }
}

// ─── OKX: funding-rate channel ────────────────────────────────────────────────
// {"arg":{"channel":"funding-rate","instId":"BTC-USDT-SWAP"},"data":[{"instId":"BTC-USDT-SWAP","fundingRate":"0.0001","nextFundingTime":"1705046400000"}]}
export function parseOkxFundingRate(data: string): WsRateUpdate[] {
  try {
    const msg = JSON.parse(data) as {
      arg?: { channel: string };
      data?: Array<{ instId: string; fundingRate: string; nextFundingTime: string }>;
    };
    if (msg.arg?.channel !== 'funding-rate' || !msg.data) return [];
    return msg.data
      .filter(item => item.instId.endsWith('-USDT-SWAP'))
      .map(item => {
        const baseAsset = item.instId.replace('-USDT-SWAP', '');
        return {
          exchange: 'okx' as ExchangeId,
          symbol: `${baseAsset}/USDT:USDT`,
          baseAsset,
          rate: parseFloat(item.fundingRate) || 0,
          markPrice: 0,
          nextFundingTime: parseInt(item.nextFundingTime) || Date.now() + 8 * 3600000,
        };
      });
  } catch { return []; }
}

// ─── Bitget: USDT-FUTURES tickers ─────────────────────────────────────────────
// {"action":"snapshot","arg":{"instType":"USDT-FUTURES","channel":"tickers","instId":"BTCUSDT"},"data":[{"instId":"BTCUSDT","fundingRate":"0.0001","markPrice":"65000","nextFundingTime":"..."}]}
export function parseBitgetTicker(data: string): WsRateUpdate[] {
  try {
    const msg = JSON.parse(data) as {
      arg?: { channel: string; instType?: string };
      data?: Array<{ instId: string; fundingRate?: string; markPrice?: string; nextFundingTime?: string }>;
    };
    if (msg.arg?.channel !== 'tickers' || !msg.data) return [];
    return msg.data
      .filter(item => item.instId.endsWith('USDT') && item.fundingRate)
      .map(item => {
        const baseAsset = item.instId.replace('USDT', '');
        return {
          exchange: 'bitget' as ExchangeId,
          symbol: `${baseAsset}/USDT:USDT`,
          baseAsset,
          rate: parseFloat(item.fundingRate || '0') || 0,
          markPrice: parseFloat(item.markPrice || '0') || 0,
          nextFundingTime: parseInt(item.nextFundingTime || '0') || Date.now() + 8 * 3600000,
        };
      });
  } catch { return []; }
}

// ─── Gate: futures.tickers ───────────────────────────────────────────────────
// {"time":ts,"channel":"futures.tickers","event":"update","result":[{"contract":"BTC_USDT","mark_price":"65000","funding_rate":"0.0001","funding_next_apply":1705046400}]}
export function parseGateTicker(data: string): WsRateUpdate[] {
  try {
    const msg = JSON.parse(data) as {
      channel?: string;
      event?: string;
      result?: Array<{
        contract: string;
        mark_price: string;
        funding_rate: string;
        funding_next_apply: number;
      }>;
    };
    if (msg.channel !== 'futures.tickers' || msg.event === 'subscribe' || !msg.result) return [];
    return msg.result
      .filter(item => item.contract.endsWith('_USDT') && item.funding_rate)
      .map(item => {
        const baseAsset = item.contract.replace('_USDT', '');
        return {
          exchange: 'gate' as ExchangeId,
          symbol: `${baseAsset}/USDT:USDT`,
          baseAsset,
          rate: parseFloat(item.funding_rate) || 0,
          markPrice: parseFloat(item.mark_price) || 0,
          nextFundingTime: (item.funding_next_apply || 0) * 1000 || Date.now() + 8 * 3600000,
        };
      });
  } catch { return []; }
}
