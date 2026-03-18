'use client';

import { useEffect, useState } from 'react';

interface Props {
  targetTime: number; // ms timestamp
  label?: string;
  fundingIntervalMs?: number; // funding interval in ms (e.g. 4h, 8h)
}

export default function CountdownTimer({ targetTime, label = '다음 펀딩까지', fundingIntervalMs }: Props) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const update = () => {
      // Don't snap forward with hardcoded 8h — next API refresh (every 8s)
      // will provide the correct next funding time. Show "정산 중..." when past.
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

  const noTarget = targetTime === 0;
  const expired = !noTarget && totalSeconds === 0;
  const urgency = !expired && !noTarget && totalSeconds < 300; // less than 5 min

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
        {label}
        {fundingIntervalMs != null && (
          <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 600, color: fundingIntervalMs < 8 * 3600000 ? '#10b981' : 'var(--color-text-muted)' }}>
            ({Math.round(fundingIntervalMs / 3600000)}h 주기)
          </span>
        )}
      </span>
      {noTarget ? (
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-muted)' }}>
          조회 중...
        </span>
      ) : expired ? (
        <span style={{ fontSize: 14, fontWeight: 600, color: '#f59e0b' }}>
          펀딩 정산 중...
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
