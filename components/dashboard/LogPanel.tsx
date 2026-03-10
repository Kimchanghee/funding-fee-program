'use client';

import { useState, useRef, useEffect } from 'react';
import { Trash2, Download } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import LogBadge from '@/components/ui/LogBadge';
import { EXCHANGE_NAMES, type LogLevel, type ExchangeId } from '@/lib/types';

const LEVEL_FILTERS: (LogLevel | 'all')[] = ['all', 'info', 'success', 'warning', 'error'];

export default function LogPanel() {
  const { logs, clearLogs } = useFundingStore();
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [logs, autoScroll]);

  const filtered = levelFilter === 'all' ? logs : logs.filter(l => l.level === levelFilter);

  const handleDownload = () => {
    const text = logs
      .map(l => `[${new Date(l.timestamp).toISOString()}] [${l.level.toUpperCase()}]${l.exchange ? ` [${l.exchange.toUpperCase()}]` : ''} ${l.message}${l.detail ? ` | ${l.detail}` : ''}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `funding-logs-${Date.now()}.txt`;
    a.click();
  };

  return (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>
          실시간 로그
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 400 }}>
            ({logs.length}개)
          </span>
        </div>
        <div style={{ flex: 1 }} />

        {/* Level filters */}
        <div style={{ display: 'flex', gap: 4 }}>
          {LEVEL_FILTERS.map(level => {
            const count = level === 'all' ? logs.length : logs.filter(l => l.level === level).length;
            const colors: Record<string, string> = { info: '#3b82f6', success: '#10b981', warning: '#f59e0b', error: '#ef4444', all: 'var(--color-text-muted)' };
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

        {/* Auto scroll toggle */}
        <button
          onClick={() => setAutoScroll(v => !v)}
          style={{
            background: autoScroll ? 'rgba(59,130,246,0.15)' : 'transparent',
            border: `1px solid ${autoScroll ? 'rgba(59,130,246,0.3)' : 'var(--color-border)'}`,
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 10,
            color: autoScroll ? '#3b82f6' : 'var(--color-text-muted)',
            cursor: 'pointer',
          }}
        >
          자동스크롤 {autoScroll ? 'ON' : 'OFF'}
        </button>

        <button className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={handleDownload} title="로그 다운로드">
          <Download size={12} />
        </button>
        <button className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={clearLogs} title="로그 지우기">
          <Trash2 size={12} />
        </button>
      </div>

      {/* Log entries */}
      <div
        ref={scrollContainerRef}
        style={{
          height: 240,
          overflowY: 'auto',
          padding: '8px 0',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12 }}>
            로그 없음
          </div>
        ) : (
          [...filtered].reverse().map(log => (
            <div
              key={log.id}
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
                {new Date(log.timestamp).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
              </span>
              <LogBadge level={log.level} />
              {log.exchange && (
                <span style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', flexShrink: 0, paddingTop: 3, letterSpacing: '0.05em' }}>
                  {(EXCHANGE_NAMES[log.exchange as ExchangeId] || log.exchange).toUpperCase()}
                </span>
              )}
              <div style={{ flex: 1 }}>
                <span style={{ color: 'var(--color-text)' }}>{log.message}</span>
                {log.detail && (
                  <span style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}>| {log.detail}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
