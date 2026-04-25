'use client';

import { useState, useEffect } from 'react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES } from '@/lib/types';
import { RATES_POLL_INTERVAL_MS } from '@/lib/polling';

type ExchangeLoopSummary = {
  loops: number;
  healthyLoops: number;
  errorLoops: number;
  lastSuccessAgeMs: number | null;
  lastError?: string;
};

type FundingHealth = {
  status: 'idle' | 'ok' | 'error';
  source: 'none' | 'live' | 'fresh-cache' | 'stale-cache';
  stale: boolean;
  ageMs: number | null;
  ratesCount: number;
  lastError?: string;
};

type MarketDataHealth = {
  funding?: Record<string, FundingHealth>;
  orderbook?: {
    entries: number;
    inFlight: number;
    freshEntries: number;
    staleEntries: number;
    oldestAgeMs: number | null;
  };
  ws?: {
    fundingByExchange?: Record<string, ExchangeLoopSummary>;
    orderbookByExchange?: Record<string, ExchangeLoopSummary>;
  };
};

const WS_HEALTHY_MAX_AGE_MS = 15_000;
const REST_HEALTHY_MAX_AGE_MS = 90_000;

export default function DataStatusBar() {
  const {
    exchangeFetchStatus,
    fundingRates,
    lastRatesUpdate,
    ratesStatus,
    isLoadingRates,
    enabledExchanges,
  } = useFundingStore();

  const [now, setNow] = useState(Date.now());
  const [marketHealth, setMarketHealth] = useState<MarketDataHealth | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let canceled = false;
    const loadHealth = async () => {
      try {
        const response = await fetch('/api/market-data-health', { cache: 'no-store' });
        const payload = await response.json() as { success?: boolean; data?: MarketDataHealth };
        if (!canceled && payload.success && payload.data) {
          setMarketHealth(payload.data);
        }
      } catch {
        if (!canceled) setMarketHealth(null);
      }
    };
    void loadHealth();
    const id = setInterval(() => void loadHealth(), 5_000);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, []);

  const getWsHealthy = (exchange: string) => {
    const fundingWs = marketHealth?.ws?.fundingByExchange?.[exchange];
    const orderbookWs = marketHealth?.ws?.orderbookByExchange?.[exchange];
    return [fundingWs, orderbookWs].some((summary) => (
      !!summary
      && summary.healthyLoops > 0
      && summary.lastSuccessAgeMs != null
      && summary.lastSuccessAgeMs <= WS_HEALTHY_MAX_AGE_MS
    ));
  };

  const getRestHealthy = (exchange: string) => {
    const funding = marketHealth?.funding?.[exchange];
    const uiOk = exchangeFetchStatus[exchange as keyof typeof exchangeFetchStatus] === 'ok';
    const cacheOk = !!funding
      && funding.ratesCount > 0
      && funding.ageMs != null
      && funding.ageMs <= REST_HEALTHY_MAX_AGE_MS;
    return uiOk || cacheOk;
  };

  const getHybridState = (exchange: string) => {
    const ws = getWsHealthy(exchange);
    const rest = getRestHealthy(exchange);
    if (ws && rest) return 'hybrid';
    if (ws) return 'ws';
    if (rest) return 'rest';
    return exchangeFetchStatus[exchange as keyof typeof exchangeFetchStatus] === 'loading' ? 'loading' : 'error';
  };

  const healthyCount = enabledExchanges.filter(ex => getWsHealthy(ex) || getRestHealthy(ex)).length;
  const hybridCount = enabledExchanges.filter(ex => getWsHealthy(ex) && getRestHealthy(ex)).length;
  const totalRates = fundingRates.length;
  const pollingSeconds = Math.max(1, Math.round(RATES_POLL_INTERVAL_MS / 1000));

  const getStatusColor = (status: string | undefined, hybridState?: string) => {
    if (hybridState === 'hybrid') return '#10b981';
    if (hybridState === 'ws') return '#38bdf8';
    if (hybridState === 'rest') return '#a78bfa';
    switch (status) {
      case 'ok': return '#10b981';
      case 'error': return '#ef4444';
      case 'loading': return '#f59e0b';
      default: return '#4b5563';
    }
  };

  const getStatusLabel = (status: string | undefined, hybridState: string) => {
    if (hybridState === 'hybrid') return 'WS+REST';
    if (hybridState === 'ws') return 'WS';
    if (hybridState === 'rest') return 'REST';
    if (status === 'loading') return '로딩';
    return '대기';
  };

  const globalColor = hybridCount > 0 ? '#10b981'
    : healthyCount > 0 ? '#38bdf8'
    : ratesStatus === 'success' ? '#10b981'
    : ratesStatus === 'loading' ? '#f59e0b'
    : ratesStatus === 'error' ? '#ef4444'
    : '#4b5563';

  const timeSinceUpdate = lastRatesUpdate
    ? Math.floor((now - lastRatesUpdate) / 1000)
    : null;

  return (
    <div
      className="data-status-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 20px',
        background: 'var(--bg-card)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: globalColor,
          boxShadow: ratesStatus === 'success' ? `0 0 6px ${globalColor}` : 'none',
          animation: isLoadingRates ? 'pulse-glow 1s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-muted)' }}>
          WS + REST
        </span>
        <span style={{ fontSize: 11, color: healthyCount > 0 ? '#10b981' : 'var(--color-text-muted)' }}>
          {healthyCount}/{enabledExchanges.length} 정상
        </span>
        {hybridCount > 0 && (
          <span style={{ fontSize: 10, color: '#38bdf8' }}>
            {hybridCount}개 이중화
          </span>
        )}
        {marketHealth?.orderbook && (
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            오더북 {marketHealth.orderbook.freshEntries + marketHealth.orderbook.staleEntries}/{marketHealth.orderbook.entries}
          </span>
        )}
      </div>

      <div className="data-status-divider" style={{ width: 1, height: 16, background: 'var(--color-border)' }} />

      {enabledExchanges.map(ex => {
        const status = exchangeFetchStatus[ex];
        const hybridState = getHybridState(ex);
        const color = getStatusColor(status, hybridState);
        const exColor = EXCHANGE_COLORS[ex];
        const rateCount = fundingRates.filter(r => r.exchange === ex).length;
        return (
          <div key={ex} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: color,
              boxShadow: status === 'ok' ? `0 0 4px ${color}` : 'none',
            }} />
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              color: status === 'ok' ? exColor : 'var(--color-text-muted)',
            }}>
              {EXCHANGE_NAMES[ex]}
            </span>
            <span style={{ fontSize: 9, color }}>
              {getStatusLabel(status, hybridState)}
            </span>
            {rateCount > 0 && (
              <span className="mono" style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>
                ({rateCount})
              </span>
            )}
          </div>
        );
      })}

      <div className="data-status-spacer" style={{ flex: 1 }} />

      <div className="data-status-meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {totalRates > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <span className="mono" style={{ color: '#10b981', fontWeight: 600 }}>{totalRates}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>종목</span>
          </div>
        )}
        {timeSinceUpdate !== null && (
          <div style={{ fontSize: 10, color: timeSinceUpdate > 15 ? '#f59e0b' : 'var(--color-text-muted)' }}>
            {timeSinceUpdate}초 전
          </div>
        )}
        <div style={{
          fontSize: 9,
          color: 'var(--color-text-muted)',
          padding: '2px 6px',
          borderRadius: 4,
          background: 'var(--bg-accent)',
        }}>
          {pollingSeconds}초 폴링
        </div>
      </div>
    </div>
  );
}
