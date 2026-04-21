'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DollarSign, RefreshCw } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId } from '@/lib/types';
import { formatTimestampYmdHmsMs } from '@/lib/timeFormat';

const PAGE_SIZE = 15;

interface FundingReceiptEvent {
  timestamp: number;
  timestampText?: string;
  exchange?: string;
  symbol?: string;
  side?: 'long' | 'short';
  fundingRate?: number;
  fundingAmount?: number;
  executionScope?: 'sim' | 'real';
}

interface FundingReceiptResponse {
  success?: boolean;
  total?: number;
  totalPages?: number | null;
  fromIndex?: number;
  toIndex?: number;
  totalFundingAmount?: number;
  events?: FundingReceiptEvent[];
}

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

function ReceiptRow({ event }: { event: FundingReceiptEvent }) {
  const exchange = (event.exchange ?? '').toLowerCase() as ExchangeId;
  const color = EXCHANGE_COLORS[exchange] ?? '#94a3b8';
  const amount = event.fundingAmount ?? 0;
  const rate = event.fundingRate ?? 0;

  return (
    <tr className="table-row-hover" style={{ borderBottom: '1px solid rgba(30,45,66,0.5)' }}>
      <td style={{ padding: '8px 10px' }}>
        <span className="mono" style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          {event.timestampText ?? formatTimestampYmdHmsMs(event.timestamp)}
        </span>
      </td>
      <td style={{ padding: '8px 10px' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}22`, padding: '1px 6px', borderRadius: 4 }}>
          {EXCHANGE_NAMES[exchange] ?? (event.exchange?.toUpperCase() ?? '-')}
        </span>
      </td>
      <td style={{ padding: '8px 10px' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text)' }}>
          {(event.symbol ?? '-').split('/')[0]}
        </span>
      </td>
      <td style={{ padding: '8px 10px' }}>
        <span style={{ fontSize: 10, color: event.side === 'long' ? '#10b981' : '#ef4444', fontWeight: 600 }}>
          {event.side === 'long' ? 'LONG' : 'SHORT'}
        </span>
      </td>
      <td style={{ padding: '8px 10px' }}>
        <span className="mono" style={{ fontSize: 10, color: rate >= 0 ? '#10b981' : '#ef4444' }}>
          {rate >= 0 ? '+' : ''}{(rate * 100).toFixed(4)}%
        </span>
      </td>
      <td style={{ padding: '8px 10px', textAlign: 'right' }}>
        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: amount >= 0 ? '#10b981' : '#ef4444' }}>
          {amount >= 0 ? '+' : ''}${Math.abs(amount).toFixed(4)}
        </span>
      </td>
    </tr>
  );
}

export default function FundingHistory() {
  const { simulationMode, strategyConfig, tradesClearedAt } = useFundingStore();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<FundingReceiptEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [fromIndex, setFromIndex] = useState(0);
  const [toIndex, setToIndex] = useState(0);
  const [totalFundingAmount, setTotalFundingAmount] = useState(0);

  const scope = simulationMode ? 'sim' : 'real';
  const notional = strategyConfig.investmentUSDT * strategyConfig.leverage;

  const fetchPage = useCallback(async (targetPage: number) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({
        all: 'true',
        scope,
        page: String(targetPage),
        pageSize: String(PAGE_SIZE),
      });
      if (tradesClearedAt > 0) {
        query.set('from', String(tradesClearedAt));
      }
      const res = await fetch(`/api/analysis/funding-receipts?${query.toString()}`);
      const json = await res.json() as FundingReceiptResponse;

      if (!json.success) {
        setEvents([]);
        setTotal(0);
        setTotalPages(1);
        setFromIndex(0);
        setToIndex(0);
        setTotalFundingAmount(0);
        return;
      }

      const nextEvents = Array.isArray(json.events) ? json.events : [];
      setEvents(nextEvents);
      setTotal(json.total ?? 0);
      setTotalPages(Math.max(1, json.totalPages ?? Math.ceil((json.total ?? 0) / PAGE_SIZE)));
      setFromIndex(json.fromIndex ?? 0);
      setToIndex(json.toIndex ?? 0);
      setTotalFundingAmount(json.totalFundingAmount ?? nextEvents.reduce((sum, event) => sum + (event.fundingAmount ?? 0), 0));
    } catch {
      setEvents([]);
      setTotal(0);
      setTotalPages(1);
      setFromIndex(0);
      setToIndex(0);
      setTotalFundingAmount(0);
    } finally {
      setLoading(false);
    }
  }, [scope, tradesClearedAt]);

  useEffect(() => {
    setPage(1);
  }, [scope]);

  useEffect(() => {
    void fetchPage(page);
  }, [page, fetchPage]);

  const panelTitle = simulationMode ? '[SIM] 펀딩피 수령 내역' : '[REAL] 펀딩피 수령 내역';
  const emptyMessage = loading ? '조회 중...' : '수령 내역이 없습니다';

  const avgYieldPercent = useMemo(() => {
    if (notional <= 0 || total === 0) return 0;
    return (totalFundingAmount / notional) * 100;
  }, [notional, total, totalFundingAmount]);

  return (
    <div className="glass-card funding-history-panel" style={{ overflow: 'hidden' }}>
      <div className="funding-history-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <DollarSign size={15} color="#10b981" />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>펀딩피 수령 내역</div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{panelTitle}</div>
        </div>
        <div style={{ flex: 1 }} />
        <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: totalFundingAmount >= 0 ? '#10b981' : '#ef4444' }}>
          {totalFundingAmount >= 0 ? '+' : ''}${totalFundingAmount.toFixed(4)}
        </div>
        <button
          className="btn btn-ghost"
          style={{ padding: '5px 8px' }}
          onClick={() => void fetchPage(page)}
          disabled={loading}
          title="새로고침"
        >
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      <div className="funding-history-summary" style={{ padding: '8px 12px', borderBottom: '1px solid rgba(30,45,66,0.5)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          페이지: {fromIndex}-{toIndex} / {total}
        </span>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          기준 노셔널: ${notional.toLocaleString()}
        </span>
        <span className="mono" style={{ fontSize: 10, color: avgYieldPercent >= 0 ? '#10b981' : '#ef4444' }}>
          수익률: {avgYieldPercent >= 0 ? '+' : ''}{avgYieldPercent.toFixed(4)}%
        </span>
      </div>

      <div className="funding-history-table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>시간</th>
              <th style={thStyle}>거래소</th>
              <th style={thStyle}>코인</th>
              <th style={thStyle}>방향</th>
              <th style={thStyle}>펀딩률</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>수령금액</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 11 }}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              events.map((event, index) => (
                <ReceiptRow
                  key={`${event.timestamp}-${event.exchange ?? 'na'}-${event.symbol ?? 'na'}-${index}`}
                  event={event}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="funding-history-pagination" style={{ padding: '10px 12px', borderTop: '1px solid rgba(30,45,66,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {page} / {totalPages}
          </span>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={page <= 1 || loading} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
            이전
          </button>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={page >= totalPages || loading} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}>
            다음
          </button>
        </div>
      )}
    </div>
  );
}
