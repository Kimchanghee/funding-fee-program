'use client';

import { useEffect, useState } from 'react';

interface KSTClockProps {
  showLabel?: boolean;
  compact?: boolean;
  className?: string;
}

export default function KSTClock({ showLabel = true, compact = false, className = '' }: KSTClockProps) {
  const [time, setTime] = useState('');

  useEffect(() => {
    const update = () => {
      setTime(
        new Date().toLocaleTimeString('ko-KR', {
          timeZone: 'Asia/Seoul',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
      );
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      className={`mono kst-clock ${compact ? 'kst-clock-compact' : ''} ${className}`.trim()}
      style={{ fontSize: compact ? 11 : 13, color: 'var(--color-text-muted)' }}
    >
      {showLabel ? `KST ${time}` : time}
    </span>
  );
}
