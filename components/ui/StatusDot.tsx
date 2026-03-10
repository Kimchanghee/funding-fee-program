'use client';

interface StatusDotProps {
  status: 'connected' | 'error' | 'disconnected';
  size?: number;
}

export default function StatusDot({ status, size = 8 }: StatusDotProps) {
  const color =
    status === 'connected' ? '#10b981' :
    status === 'error' ? '#ef4444' :
    '#4b5563';

  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: status === 'connected' ? `0 0 6px ${color}` : 'none',
        animation: status === 'connected' ? 'pulse-glow 2s ease-in-out infinite' : 'none',
        flexShrink: 0,
      }}
    />
  );
}
