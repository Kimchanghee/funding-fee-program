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
      let target = targetTime;
      // If target is in the past, snap forward to next 8h funding window
      if (target > 0 && target < Date.now()) {
        const EIGHT_H = 8 * 3600000;
        const elapsed = Date.now() - target;
        target = target + Math.ceil(elapsed / EIGHT_H) * EIGHT_H;
      }
      const diff = Math.max(0, target - Date.now());
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

  const expired = totalSeconds === 0;
  const urgency = !expired && totalSeconds < 300; // less than 5 min

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</span>
      {expired ? (
        <span style={{ fontSize: 14, fontWeight: 600, color: '#f59e0b' }}>
          갱신 대기...
        </span>
      ) : (
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
      )}
    </div>
  );
}
