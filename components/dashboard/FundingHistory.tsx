'use client';

import { useEffect } from 'react';
import { DollarSign, RefreshCw, RotateCcw } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId, type FundingPayment } from '@/lib/types';

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--color-text-muted)',
  letterSpacing: '0.05em',
  borderBottom: '1px solid var(--color-border)',
  textAlign: 'left',
  background: 'var(--bg-card)',
  whiteSpace: 'nowrap',
};

function FundingRow({ p }: { p: FundingPayment }) {
  const color = EXCHANGE_COLORS[p.exchange as ExchangeId] || '#94a3b8';
  const isPositive = p.amount >= 0;
  return (
    <tr className="table-row-hover" style={{ borderBottom: '1px solid rgba(30,45,66,0.5)' }}>
      <td style={{ padding: '8px 10px' }}>
        <span className="mono" style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          {new Date(p.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </td>
      <td style={{ padding: '8px 10px' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}22`, padding: '1px 6px', borderRadius: 4 }}>
          {EXCHANGE_NAMES[p.exchange as ExchangeId] || p.exchange.toUpperCase()}
        </span>
      </td>
      <td style={{ padding: '8px 10px' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text)' }}>
          {p.symbol.split('/')[0]}
        </span>
      </td>
      <td style={{ padding: '8px 10px' }}>
        <span style={{ fontSize: 10, color: p.side === 'long' ? '#10b981' : '#ef4444', fontWeight: 600 }}>
          {p.side === 'long' ? '롱' : '숏'}
        </span>
      </td>
      <td style={{ padding: '8px 10px' }}>
        <span className="mono" style={{ fontSize: 10, color: isPositive ? '#10b981' : '#ef4444' }}>
          {p.rate >= 0 ? '+' : ''}{(p.rate * 100).toFixed(4)}%
        </span>
      </td>
      <td style={{ padding: '8px 10px', textAlign: 'right' }}>
        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: isPositive ? '#10b981' : '#ef4444' }}>
          {isPositive ? '+' : ''}${Math.abs(p.amount).toFixed(4)}
        </span>
      </td>
    </tr>
  );
}

function ModePanel({ title, color, entries, total, emptyMsg }: {
  title: string; color: string; entries: FundingPayment[]; total: number; emptyMsg: string;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      {/* Mode header */}
      <div style={{
        padding: '10px 14px',
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: `2px solid ${color}44`,
        background: `${color}08`,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color }}>{title}</span>
        <span className="mono" style={{
          marginLeft: 'auto', fontSize: 13, fontWeight: 800,
          color: total >= 0 ? '#10b981' : '#ef4444',
        }}>
          {total >= 0 ? '+' : ''}${total.toFixed(4)}
        </span>
      </div>

      {/* Table */}
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>시간</th>
              <th style={thStyle}>거래소</th>
              <th style={thStyle}>코인</th>
              <th style={thStyle}>방향</th>
              <th style={thStyle}>펀딩률</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>금액</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 11 }}>
                  {emptyMsg}
                </td>
              </tr>
            ) : (
              entries.map((p, i) => <FundingRow key={i} p={p} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FundingHistory() {
  const { fundingHistory, fetchFundingHistory, apiConfigs, isLoadingHistory, simulationMode, clearSimFundingHistory } = useFundingStore();

  const apiConfigKeys = Object.keys(apiConfigs).join(',');
  useEffect(() => {
    if (!simulationMode && apiConfigKeys.length > 0) {
      fetchFundingHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiConfigKeys, simulationMode]);

  const hedgeEntries = fundingHistory.filter(p => p.mode !== 'shortOnly');
  const shortOnlyEntries = fundingHistory.filter(p => p.mode === 'shortOnly');
  const hedgeTotal = hedgeEntries.reduce((s, p) => s + p.amount, 0);
  const shortOnlyTotal = shortOnlyEntries.reduce((s, p) => s + p.amount, 0);

  const emptyMsg = isLoadingHistory
    ? '조회 중...'
    : simulationMode
      ? '아직 수령 내역 없음'
      : Object.keys(apiConfigs).length === 0
        ? 'API 키 미설정'
        : '수령 내역 없음';

  return (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <DollarSign size={15} color="#10b981" />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>펀딩피 수령 내역</div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            {simulationMode ? '[SIM] 시뮬레이션 기록' : '자동 수령 확인'}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {simulationMode && fundingHistory.length > 0 && (
          <button
            className="btn btn-ghost"
            style={{ padding: '5px 8px', color: '#ef4444' }}
            onClick={() => { if (confirm('펀딩 수령 내역을 초기화하시겠습니까?')) clearSimFundingHistory(); }}
          >
            <RotateCcw size={12} />
          </button>
        )}
        <button
          className="btn btn-ghost"
          style={{ padding: '5px 8px' }}
          onClick={() => fetchFundingHistory()}
          disabled={isLoadingHistory}
        >
          <RefreshCw size={12} style={{ animation: isLoadingHistory ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      {/* Side by side panels */}
      <div style={{ display: 'flex', gap: 0 }}>
        <ModePanel
          title="헷징 (숏+롱)"
          color="#3b82f6"
          entries={hedgeEntries}
          total={hedgeTotal}
          emptyMsg={emptyMsg}
        />
        <div style={{ width: 1, background: 'var(--color-border)', flexShrink: 0 }} />
        <ModePanel
          title="숏온리"
          color="#ef4444"
          entries={shortOnlyEntries}
          total={shortOnlyTotal}
          emptyMsg={emptyMsg}
        />
      </div>
    </div>
  );
}
