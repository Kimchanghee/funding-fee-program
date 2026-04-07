'use client';

import { AlertTriangle } from 'lucide-react';

type ConfirmTone = 'danger' | 'warning' | 'info';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
}

const TONE_STYLES: Record<ConfirmTone, {
  border: string;
  title: string;
  glow: string;
  confirmBg: string;
  confirmBorder: string;
  confirmText: string;
}> = {
  danger: {
    border: 'rgba(239,68,68,0.38)',
    title: '#f87171',
    glow: 'rgba(239,68,68,0.14)',
    confirmBg: 'linear-gradient(135deg, rgba(239,68,68,0.28), rgba(220,38,38,0.18))',
    confirmBorder: 'rgba(239,68,68,0.45)',
    confirmText: '#fecaca',
  },
  warning: {
    border: 'rgba(245,158,11,0.38)',
    title: '#fbbf24',
    glow: 'rgba(245,158,11,0.14)',
    confirmBg: 'linear-gradient(135deg, rgba(245,158,11,0.28), rgba(217,119,6,0.18))',
    confirmBorder: 'rgba(245,158,11,0.45)',
    confirmText: '#fde68a',
  },
  info: {
    border: 'rgba(59,130,246,0.38)',
    title: '#60a5fa',
    glow: 'rgba(59,130,246,0.14)',
    confirmBg: 'linear-gradient(135deg, rgba(59,130,246,0.28), rgba(37,99,235,0.18))',
    confirmBorder: 'rgba(59,130,246,0.45)',
    confirmText: '#bfdbfe',
  },
};

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '확인',
  cancelLabel = '취소',
  tone = 'warning',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  const style = TONE_STYLES[tone];

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(2,6,23,0.72)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, 100%)',
          borderRadius: 14,
          border: `1px solid ${style.border}`,
          background: 'linear-gradient(180deg, rgba(15,23,42,0.98), rgba(2,6,23,0.96))',
          boxShadow: `0 22px 60px rgba(2,6,23,0.65), 0 0 0 1px ${style.glow}`,
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '16px 16px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              border: `1px solid ${style.border}`,
              background: style.glow,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <AlertTriangle size={16} color={style.title} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 800, color: style.title }}>{title}</div>
        </div>

        <div style={{ padding: '0 16px 14px', fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
          {description}
        </div>

        <div
          style={{
            borderTop: '1px solid rgba(148,163,184,0.16)',
            padding: 12,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            className="btn btn-ghost"
            onClick={onCancel}
            style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700 }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${style.confirmBorder}`,
              background: style.confirmBg,
              color: style.confirmText,
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

