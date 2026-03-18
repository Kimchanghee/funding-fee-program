'use client';

import { useState, useEffect } from 'react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES } from '@/lib/types';

export default function DataStatusBar() {
  const {
    exchangeFetchStatus,
    fundingRates,
    lastRatesUpdate,
    ratesStatus,
    isLoadingRates,
    enabledExchanges,
  } = useFundingStore();

  // #10: Live-updating elapsed time
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const okCount = enabledExchanges.filter(ex => exchangeFetchStatus[ex] === 'ok').length;
  const totalRates = fundingRates.length;

  const getStatusColor = (status: string | undefined) => {
    switch (status) {
      case 'ok': return '#10b981';
      case 'error': return '#ef4444';
      case 'loading': return '#f59e0b';
      default: return '#4b5563';
    }
  };

  const getStatusLabel = (status: string | undefined) => {
    switch (status) {
      case 'ok': return '정상';
      case 'error': return '오류';
      case 'loading': return '로딩';
      default: return '대기';
    }
  };

  const globalColor = ratesStatus === 'success' ? '#10b981'
    : ratesStatus === 'loading' ? '#f59e0b'
    : ratesStatus === 'error' ? '#ef4444'
    : '#4b5563';

  const timeSinceUpdate = lastRatesUpdate
    ? Math.floor((now - lastRatesUpdate) / 1000)
    : null;

  return (
    <div
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
      {/* Global status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: globalColor,
          boxShadow: ratesStatus === 'success' ? `0 0 6px ${globalColor}` : 'none',
          animation: isLoadingRates ? 'pulse-glow 1s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-muted)' }}>
          REST API
        </span>
        <span style={{ fontSize: 11, color: okCount > 0 ? '#10b981' : 'var(--color-text-muted)' }}>
          {okCount}/{enabledExchanges.length} 정상
        </span>
      </div>

      <div style={{ width: 1, height: 16, background: 'var(--color-border)' }} />

      {/* Per-exchange status */}
      {enabledExchanges.map(ex => {
        const status = exchangeFetchStatus[ex];
        const color = getStatusColor(status);
        const exColor = EXCHANGE_COLORS[ex];
        const rateCount = fundingRates.filter(r => r.exchange === ex).length;
        return (
          <div key={ex} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: color,
              boxShadow: status === 'ok' ? `0 0 4px ${color}` : 'none',
            }} />
            <span style={{
              fontSize: 10, fontWeight: 600,
              color: status === 'ok' ? exColor : 'var(--color-text-muted)',
            }}>
              {EXCHANGE_NAMES[ex]}
            </span>
            <span style={{ fontSize: 9, color }}>
              {getStatusLabel(status)}
            </span>
            {rateCount > 0 && (
              <span className="mono" style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>
                ({rateCount})
              </span>
            )}
          </div>
        );
      })}

      <div style={{ flex: 1 }} />

      {/* Total rates + polling info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
          fontSize: 9, color: 'var(--color-text-muted)',
          padding: '2px 6px', borderRadius: 4,
          background: 'var(--bg-accent)',
        }}>
          8초 폴링
        </div>
      </div>
    </div>
  );
}
