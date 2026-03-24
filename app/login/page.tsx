'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.push('/');
        router.refresh();
      } else {
        setError('비밀번호가 올바르지 않습니다.');
        setPassword('');
      }
    } catch {
      setError('서버 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0e17',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#141926',
          border: '1px solid #1e293b',
          borderRadius: '12px',
          padding: '40px',
          width: '100%',
          maxWidth: '360px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}
      >
        <h1
          style={{
            fontSize: '20px',
            fontWeight: 700,
            color: '#e2e8f0',
            textAlign: 'center',
            margin: 0,
          }}
        >
          🔒 접근 인증
        </h1>

        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="비밀번호 입력"
          autoFocus
          style={{
            background: '#0f1420',
            border: '1px solid #334155',
            borderRadius: '8px',
            padding: '12px 16px',
            fontSize: '16px',
            color: '#e2e8f0',
            outline: 'none',
            textAlign: 'center',
            letterSpacing: '8px',
          }}
        />

        {error && (
          <p style={{ color: '#f87171', fontSize: '14px', textAlign: 'center', margin: 0 }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          style={{
            background: loading || !password ? '#334155' : '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            padding: '12px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: loading || !password ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '확인 중...' : '입장'}
        </button>
      </form>
    </div>
  );
}
