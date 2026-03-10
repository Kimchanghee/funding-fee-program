'use client';

import { useEffect, useState } from 'react';

interface Props {
  targetTime: number; // ms timestamp
  label?: string;
}

export default function CountdownTimer({ targetTime, label = '다음 펀딩까지' }: Props) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const update = () => {
      const diff = Math.max(0, targetTime - Date.now());
      setRemaining(diff);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [targetTime]);

  const totalSeconds = Math.floor(remaining / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  const pad = (n: number) => String(n).padStart(2, '0');

  const urgency = totalSeconds < 300; // less than 5 min

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</span>
      <span
        className="mono"
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: urgency ? '#ef4444' : '#10b981',
          animation: urgency ? 'blink 1s step-end infinite' : 'none',
          letterSpacing: '0.05em',
        }}
      >
        {pad(h)}:{pad(m)}:{pad(s)}
      </span>
    </div>
  );
}
