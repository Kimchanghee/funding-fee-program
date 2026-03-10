'use client';

import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, SUPPORTED_EXCHANGES } from '@/lib/types';

const STATUS_LABELS = {
  connected: '실시간',
  connecting: '연결중',
  disconnected: '끊김',
  error: '오류',
};

const STATUS_COLORS = {
  connected: '#10b981',
  connecting: '#f59e0b',
  disconnected: '#4b5563',
  error: '#ef4444',
};

export default function WsStatusBar() {
  const { wsStatuses, fundingRates } = useFundingStore();
  const wsConnectedCount = Object.values(wsStatuses).filter(s => s === 'connected').length;
  const liveRateCount = fundingRates.filter(r => Date.now() - r.updatedAt < 10000).length;

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: wsConnectedCount > 0 ? '#10b981' : '#4b5563',
          boxShadow: wsConnectedCount > 0 ? '0 0 6px #10b981' : 'none',
          animation: wsConnectedCount > 0 ? 'pulse-glow 2s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-muted)' }}>
          WebSocket
        </span>
        <span style={{ fontSize: 11, color: wsConnectedCount > 0 ? '#10b981' : 'var(--color-text-muted)' }}>
          {wsConnectedCount}/5 연결
        </span>
      </div>

      <div style={{ width: 1, height: 16, background: 'var(--color-border)' }} />

      {SUPPORTED_EXCHANGES.map(ex => {
        const status = wsStatuses[ex] ?? 'disconnected';
        const color = STATUS_COLORS[status];
        const exColor = EXCHANGE_COLORS[ex];
        return (
          <div key={ex} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: color,
              boxShadow: status === 'connected' ? `0 0 4px ${color}` : 'none',
              animation: status === 'connecting' ? 'blink 0.8s step-end infinite' : 'none',
            }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: status === 'connected' ? exColor : 'var(--color-text-muted)' }}>
              {EXCHANGE_NAMES[ex]}
            </span>
            <span style={{ fontSize: 9, color }}>
              {STATUS_LABELS[status]}
            </span>
          </div>
        );
      })}

      <div style={{ flex: 1 }} />

      {liveRateCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#10b981' }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#10b981',
            animation: 'pulse-glow 1s ease-in-out infinite',
          }} />
          <span className="mono">{liveRateCount}</span>
          <span style={{ color: 'var(--color-text-muted)' }}>실시간 업데이트</span>
        </div>
      )}
    </div>
  );
}
