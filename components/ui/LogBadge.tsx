'use client';

import type { LogLevel } from '@/lib/types';

const CONFIG: Record<LogLevel, { bg: string; color: string; label: string }> = {
  info:    { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6', label: 'INFO' },
  success: { bg: 'rgba(16,185,129,0.15)',  color: '#10b981', label: 'SUCCESS' },
  warning: { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b', label: 'WARN' },
  error:   { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444', label: 'ERROR' },
};

export default function LogBadge({ level }: { level: LogLevel }) {
  const { bg, color, label } = CONFIG[level];
  return (
    <span
      className="log-badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: 'monospace',
        letterSpacing: '0.05em',
        background: bg,
        color,
        flexShrink: 0,
        minWidth: 56,
        justifyContent: 'center',
      }}
    >
      {label}
    </span>
  );
}
