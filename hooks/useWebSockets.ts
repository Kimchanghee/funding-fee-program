'use client';

/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect } from 'react';
import { useFundingStore } from '@/store/fundingStore';
import type { ExchangeId } from '@/lib/types';
import {
  parseBinanceMarkPrice,
  parseBybitTicker,
  parseOkxFundingRate,
  parseBitgetTicker,
  parseGateTicker,
} from '@/lib/websocket/parsers';

const TOP_ASSETS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
  'LTC', 'BCH', 'NEAR', 'ATOM', 'UNI', 'APT', 'OP', 'ARB', 'INJ', 'SUI',
];

type WsStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

interface WsConfig {
  url: string;
  exchange: ExchangeId;
  onOpen: (ws: WebSocket) => void;
  onMessage: (data: string) => void;
  getPing?: () => string;
  pingInterval?: number;
}

function createManagedWs(
  config: WsConfig,
  setStatus: (status: WsStatus) => void,
  addLog: (msg: string) => void,
): () => void {
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let backoff = 2000;

  const cleanup = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  };

  const connect = () => {
    if (destroyed) return;
    setStatus('connecting');
    ws = new WebSocket(config.url);

    ws.onopen = () => {
      backoff = 2000;
      setStatus('connected');
      config.onOpen(ws!);
      if (config.getPing) {
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            try { ws.send(config.getPing!()); } catch { /* ignore */ }
          }
        }, config.pingInterval ?? 20000);
      }
    };

    ws.onmessage = (e) => {
      const d = e.data as string;
      if (d === 'pong' || d.includes('"pong"') || d.includes('"op":"pong"')) return;
      config.onMessage(d);
    };

    ws.onerror = () => setStatus('error');

    ws.onclose = () => {
      cleanup();
      if (!destroyed) {
        setStatus('disconnected');
        reconnectTimer = setTimeout(() => {
          addLog(`${config.exchange.toUpperCase()} WS 재연결 (${backoff / 1000}s)`);
          backoff = Math.min(backoff * 1.5, 30000);
          connect();
        }, backoff);
      }
    };
  };

  connect();

  return () => {
    destroyed = true;
    cleanup();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}

export function useWebSockets() {
  const updateFundingRateWs = useFundingStore(s => s.updateFundingRateWs);
  const setWsStatus = useFundingStore(s => s.setWsStatus);
  const addLog = useFundingStore(s => s.addLog);

  // ── BINANCE ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    return createManagedWs(
      {
        url: 'wss://fstream.binance.com/ws/!markPrice@arr@1s',
        exchange: 'binance',
        onOpen: () => addLog('success', 'BINANCE WebSocket 실시간 연결됨', 'binance'),
        onMessage: (data) => parseBinanceMarkPrice(data).forEach(u => updateFundingRateWs(u)),
        getPing: () => JSON.stringify({ method: 'ping' }),
        pingInterval: 180000, // Binance streams stay alive longer
      },
      (status) => setWsStatus('binance', status),
      (msg) => addLog('info', msg, 'binance'),
    );
  }, []);

  // ── BYBIT ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const symbols = TOP_ASSETS.map(a => `${a}USDT`);
    return createManagedWs(
      {
        url: 'wss://stream.bybit.com/v5/public/linear',
        exchange: 'bybit',
        onOpen: (ws) => {
          addLog('success', 'BYBIT WebSocket 실시간 연결됨', 'bybit');
          // Subscribe in 2 chunks to stay under per-message limits
          const chunk1 = symbols.slice(0, 10).map(s => `tickers.${s}`);
          const chunk2 = symbols.slice(10).map(s => `tickers.${s}`);
          ws.send(JSON.stringify({ op: 'subscribe', args: chunk1 }));
          setTimeout(() => ws.readyState === WebSocket.OPEN &&
            ws.send(JSON.stringify({ op: 'subscribe', args: chunk2 })), 200);
        },
        onMessage: (data) => parseBybitTicker(data).forEach(u => updateFundingRateWs(u)),
        getPing: () => JSON.stringify({ op: 'ping' }),
        pingInterval: 20000,
      },
      (status) => setWsStatus('bybit', status),
      (msg) => addLog('info', msg, 'bybit'),
    );
  }, []);

  // ── OKX ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instruments = TOP_ASSETS.map(a => `${a}-USDT-SWAP`);
    return createManagedWs(
      {
        url: 'wss://ws.okx.com:8443/ws/v5/public',
        exchange: 'okx',
        onOpen: (ws) => {
          addLog('success', 'OKX WebSocket 실시간 연결됨', 'okx');
          const args = instruments.map(instId => ({ channel: 'funding-rate', instId }));
          ws.send(JSON.stringify({ op: 'subscribe', args }));
        },
        onMessage: (data) => parseOkxFundingRate(data).forEach(u => updateFundingRateWs(u)),
        getPing: () => 'ping',
        pingInterval: 25000,
      },
      (status) => setWsStatus('okx', status),
      (msg) => addLog('info', msg, 'okx'),
    );
  }, []);

  // ── BITGET ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instruments = TOP_ASSETS.map(a => `${a}USDT`);
    return createManagedWs(
      {
        url: 'wss://ws.bitget.com/v2/ws/public',
        exchange: 'bitget',
        onOpen: (ws) => {
          addLog('success', 'BITGET WebSocket 실시간 연결됨', 'bitget');
          const args = instruments.map(instId => ({
            instType: 'USDT-FUTURES',
            channel: 'tickers',
            instId,
          }));
          ws.send(JSON.stringify({ op: 'subscribe', args }));
        },
        onMessage: (data) => parseBitgetTicker(data).forEach(u => updateFundingRateWs(u)),
        getPing: () => 'ping',
        pingInterval: 30000,
      },
      (status) => setWsStatus('bitget', status),
      (msg) => addLog('info', msg, 'bitget'),
    );
  }, []);

  // ── GATE ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const contracts = TOP_ASSETS.map(a => `${a}_USDT`);
    return createManagedWs(
      {
        url: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
        exchange: 'gate',
        onOpen: (ws) => {
          addLog('success', 'GATE WebSocket 실시간 연결됨', 'gate');
          ws.send(JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: 'futures.tickers',
            event: 'subscribe',
            payload: contracts,
          }));
        },
        onMessage: (data) => parseGateTicker(data).forEach(u => updateFundingRateWs(u)),
        getPing: () => JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          channel: 'futures.ping',
          event: 'api',
        }),
        pingInterval: 20000,
      },
      (status) => setWsStatus('gate', status),
      (msg) => addLog('info', msg, 'gate'),
    );
  }, []);
}
