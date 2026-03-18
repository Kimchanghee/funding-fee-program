'use client';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html>
      <body style={{ background: '#0a0e17', color: '#fff', fontFamily: 'system-ui', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 20, marginBottom: 12 }}>오류가 발생했습니다</h2>
          <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 16 }}>{error.message}</p>
          <button onClick={reset} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid #334155', background: '#1e293b', color: '#fff', cursor: 'pointer' }}>
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
