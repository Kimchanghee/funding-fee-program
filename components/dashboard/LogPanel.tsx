'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import LogBadge from '@/components/ui/LogBadge';
import { EXCHANGE_NAMES, type ExchangeId, type LogLevel } from '@/lib/types';
import { formatTimestampYmdHmsMs } from '@/lib/timeFormat';

const PAGE_SIZE = 15;
const LEVEL_FILTERS: (LogLevel | 'all')[] = ['all', 'info', 'success', 'warning', 'error'];

interface ServerLogEntry {
  timestamp: number;
  timestampText?: string;
  level: LogLevel;
  message: string;
  exchange?: string;
  detail?: string;
}

interface LogListResponse {
  success?: boolean;
  total?: number;
  totalPages?: number | null;
  fromIndex?: number;
  toIndex?: number;
  entries?: ServerLogEntry[];
}

export default function LogPanel() {
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<ServerLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [fromIndex, setFromIndex] = useState(0);
  const [toIndex, setToIndex] = useState(0);

  const fetchPage = useCallback(async (targetPage: number) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({
        all: 'true',
        page: String(targetPage),
        pageSize: String(PAGE_SIZE),
      });
      if (levelFilter !== 'all') {
        query.set('level', levelFilter);
      }
      const res = await fetch(`/api/logs/list?${query.toString()}`);
      const json = await res.json() as LogListResponse;

      if (!json.success) {
        setEntries([]);
        setTotal(0);
        setTotalPages(1);
        setFromIndex(0);
        setToIndex(0);
        return;
      }

      const nextEntries = Array.isArray(json.entries) ? json.entries : [];
      setEntries(nextEntries);
      setTotal(json.total ?? 0);
      setTotalPages(Math.max(1, json.totalPages ?? Math.ceil((json.total ?? 0) / PAGE_SIZE)));
      setFromIndex(json.fromIndex ?? 0);
      setToIndex(json.toIndex ?? 0);
    } catch {
      setEntries([]);
      setTotal(0);
      setTotalPages(1);
      setFromIndex(0);
      setToIndex(0);
    } finally {
      setLoading(false);
    }
  }, [levelFilter]);

  useEffect(() => {
    setPage(1);
  }, [levelFilter]);

  useEffect(() => {
    void fetchPage(page);
  }, [page, fetchPage]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => {
      void fetchPage(page);
    }, 2_000);
    return () => clearInterval(timer);
  }, [autoRefresh, page, fetchPage]);

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = {
      info: 0,
      success: 0,
      warning: 0,
      error: 0,
    };
    for (const entry of entries) {
      counts[entry.level] += 1;
    }
    return counts;
  }, [entries]);

  const handleDownloadCurrentPage = () => {
    const text = entries
      .map((entry) => {
        const exchangeLabel = entry.exchange ? ` [${entry.exchange.toUpperCase()}]` : '';
        const detailLabel = entry.detail ? ` | ${entry.detail}` : '';
        return `[${entry.timestampText ?? formatTimestampYmdHmsMs(entry.timestamp)}] [${entry.level.toUpperCase()}]${exchangeLabel} ${entry.message}${detailLabel}`;
      })
      .join('\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `funding-logs-page-${page}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)' }}>
          실시간 로그
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 400 }}>
            ({fromIndex}-{toIndex} / {total})
          </span>
        </div>
        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', gap: 4 }}>
          {LEVEL_FILTERS.map((level) => {
            const colors: Record<string, string> = {
              info: '#3b82f6',
              success: '#10b981',
              warning: '#f59e0b',
              error: '#ef4444',
              all: 'var(--color-text-muted)',
            };
            const count = level === 'all'
              ? entries.length
              : levelCounts[level];

            return (
              <button
                key={level}
                onClick={() => setLevelFilter(level)}
                style={{
                  background: levelFilter === level ? 'var(--bg-accent2)' : 'transparent',
                  border: `1px solid ${levelFilter === level ? 'var(--color-border)' : 'transparent'}`,
                  borderRadius: 6,
                  padding: '3px 8px',
                  fontSize: 10,
                  fontWeight: 700,
                  color: levelFilter === level ? colors[level] : 'var(--color-text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {level === 'all' ? 'ALL' : level.toUpperCase()}
                <span style={{ opacity: 0.7 }}>({count})</span>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setAutoRefresh((prev) => !prev)}
          style={{
            background: autoRefresh ? 'rgba(59,130,246,0.15)' : 'transparent',
            border: `1px solid ${autoRefresh ? 'rgba(59,130,246,0.3)' : 'var(--color-border)'}`,
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 10,
            color: autoRefresh ? '#3b82f6' : 'var(--color-text-muted)',
            cursor: 'pointer',
          }}
        >
          자동갱신 {autoRefresh ? 'ON' : 'OFF'}
        </button>

        <button
          className="btn btn-ghost"
          style={{ padding: '4px 8px' }}
          onClick={handleDownloadCurrentPage}
          title="현재 페이지 다운로드"
        >
          <Download size={12} />
        </button>

        <button
          className="btn btn-ghost"
          style={{ padding: '4px 8px' }}
          onClick={() => void fetchPage(page)}
          title="새로고침"
          disabled={loading}
        >
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      <div
        style={{
          height: 240,
          overflowY: 'auto',
          padding: '8px 0',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        }}
      >
        {entries.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12 }}>
            로그 없음
          </div>
        ) : (
          entries.map((entry, index) => (
            <div
              key={`${entry.timestamp}-${entry.level}-${entry.exchange ?? 'na'}-${index}`}
              style={{
                padding: '4px 16px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                fontSize: 11,
                lineHeight: 1.5,
                borderBottom: '1px solid rgba(30,45,66,0.3)',
              }}
            >
              <span style={{ color: 'var(--color-text-muted)', flexShrink: 0, fontSize: 10, paddingTop: 2 }}>
                {entry.timestampText ?? formatTimestampYmdHmsMs(entry.timestamp)}
              </span>
              <LogBadge level={entry.level} />
              {entry.exchange && (
                <span style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', flexShrink: 0, paddingTop: 3, letterSpacing: '0.05em' }}>
                  {(EXCHANGE_NAMES[entry.exchange as ExchangeId] ?? entry.exchange).toUpperCase()}
                </span>
              )}
              <div style={{ flex: 1 }}>
                <span style={{ color: 'var(--color-text)' }}>{entry.message}</span>
                {entry.detail && (
                  <span style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}>| {entry.detail}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid rgba(30,45,66,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
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
