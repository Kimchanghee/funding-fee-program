'use client';

import { useEffect } from 'react';
import { DollarSign, RefreshCw } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId } from '@/lib/types';

export default function FundingHistory() {
  const { fundingHistory, fetchFundingHistory, apiConfigs, isLoadingHistory } = useFundingStore();

  const apiConfigKeys = Object.keys(apiConfigs).join(',');
  useEffect(() => {
    if (apiConfigKeys.length > 0) {
      fetchFundingHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiConfigKeys]);

  const totalReceived = fundingHistory.reduce((sum, p) => sum + p.amount, 0);
  const last24h = fundingHistory
    .filter(p => Date.now() - p.timestamp < 86400000)
    .reduce((sum, p) => sum + p.amount, 0);

  const thStyle: React.CSSProperties = {
    padding: '8px 14px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    letterSpacing: '0.05em',
    borderBottom: '1px solid var(--color-border)',
    textAlign: 'left',
    background: 'var(--bg-card)',
    whiteSpace: 'nowrap',
  };

  return (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DollarSign size={15} color="#10b981" />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)' }}>
              펀딩피 수령 내역
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              8시간마다 자동 수령 확인
            </div>
          </div>
        </div>
        <div style={{ flex: 1 }} />

        {/* Summary cards */}
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ padding: '6px 12px', borderRadius: 8, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#10b981', marginBottom: 1 }}>24h 수령</div>
            <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: '#10b981' }}>
              ${last24h >= 0 ? '+' : ''}{last24h.toFixed(4)}
            </div>
          </div>
          <div style={{ padding: '6px 12px', borderRadius: 8, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#3b82f6', marginBottom: 1 }}>총 수령</div>
            <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: '#3b82f6' }}>
              ${totalReceived >= 0 ? '+' : ''}{totalReceived.toFixed(4)}
            </div>
          </div>
        </div>

        <button
          className="btn btn-ghost"
          style={{ padding: '6px 10px' }}
          onClick={() => fetchFundingHistory()}
          disabled={isLoadingHistory}
        >
          <RefreshCw size={13} style={{ animation: isLoadingHistory ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>시간</th>
              <th style={thStyle}>거래소</th>
              <th style={thStyle}>코인</th>
              <th style={thStyle}>방향</th>
              <th style={thStyle}>펀딩률</th>
              <th style={thStyle}>수령금액</th>
            </tr>
          </thead>
          <tbody>
            {fundingHistory.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '28px 14px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12 }}>
                  {isLoadingHistory
                    ? '내역 조회 중...'
                    : Object.keys(apiConfigs).length === 0
                      ? 'API 키를 설정하면 펀딩피 수령 내역이 표시됩니다'
                      : '아직 수령 내역 없음 (포지션 진입 후 8시간마다 자동 수령)'
                  }
                </td>
              </tr>
            ) : (
              fundingHistory.map((p, i) => {
                const color = EXCHANGE_COLORS[p.exchange as ExchangeId] || '#94a3b8';
                const isPositive = p.amount >= 0;
                return (
                  <tr
                    key={i}
                    className="table-row-hover"
                    style={{ borderBottom: '1px solid rgba(30,45,66,0.5)' }}
                  >
                    <td style={{ padding: '8px 14px' }}>
                      <span className="mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                        {new Date(p.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </td>
                    <td style={{ padding: '8px 14px' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}22`, padding: '2px 6px', borderRadius: 4 }}>
                        {EXCHANGE_NAMES[p.exchange as ExchangeId] || p.exchange.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '8px 14px' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text)' }}>
                        {p.symbol.split('/')[0]}
                      </span>
                    </td>
                    <td style={{ padding: '8px 14px' }}>
                      <span style={{ fontSize: 11, color: p.side === 'long' ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                        {p.side === 'long' ? '↑ 롱' : '↓ 숏'}
                      </span>
                    </td>
                    <td style={{ padding: '8px 14px' }}>
                      <span className="mono" style={{ fontSize: 11, color: isPositive ? '#10b981' : '#ef4444' }}>
                        {p.rate >= 0 ? '+' : ''}{(p.rate * 100).toFixed(4)}%
                      </span>
                    </td>
                    <td style={{ padding: '8px 14px' }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: isPositive ? '#10b981' : '#ef4444' }}>
                        {isPositive ? '+' : ''}${Math.abs(p.amount).toFixed(4)}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
