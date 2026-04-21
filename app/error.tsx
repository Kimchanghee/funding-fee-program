'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div
      className="error-screen"
      style={{ background: '#0a0e17', color: '#fff', fontFamily: 'system-ui', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 16 }}
    >
      <div className="error-card" style={{ textAlign: 'center', width: '100%', maxWidth: 560 }}>
        <h2 className="error-title" style={{ fontSize: 20, marginBottom: 12 }}>오류가 발생했습니다</h2>
        <p className="error-message" style={{ fontSize: 13, color: '#94a3b8', marginBottom: 16, wordBreak: 'break-word' }}>{error.message}</p>
        <button
          className="error-retry-btn"
          onClick={reset}
          style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid #334155', background: '#1e293b', color: '#fff', cursor: 'pointer' }}
        >
          다시 시도
        </button>
      </div>
    </div>
  );
}
