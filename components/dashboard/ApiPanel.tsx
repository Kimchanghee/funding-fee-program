'use client';

import { useState } from 'react';
import { X, Eye, EyeOff, CheckCircle, Loader, Key } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_NAMES, EXCHANGE_COLORS, OPERABLE_EXCHANGES, type ExchangeId } from '@/lib/types';
import { hasRequiredApiCredentials, requiresPassphrase } from '@/lib/apiCredentials';

export default function ApiPanel() {
  const { apiConfigs, setApiConfig, removeApiConfig, testConnection, setShowApiPanel, refreshBalances } = useFundingStore();
  const [activeTab, setActiveTab] = useState<ExchangeId>('binance');
  const [form, setForm] = useState({ apiKey: '', secret: '', passphrase: '' });
  const [showSecret, setShowSecret] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);

  const existing = apiConfigs[activeTab];

  const handleTabChange = (tab: ExchangeId) => {
    setActiveTab(tab);
    const cfg = apiConfigs[tab];
    setForm({ apiKey: cfg?.apiKey || '', secret: cfg?.secret || '', passphrase: cfg?.passphrase || '' });
    setTestResult(null);
  };

  const handleSave = () => {
    const draftConfig = { apiKey: form.apiKey, secret: form.secret, passphrase: form.passphrase || undefined };
    if (!hasRequiredApiCredentials(activeTab, draftConfig)) return;
    setApiConfig(activeTab, draftConfig);
    setTimeout(() => refreshBalances(), 500);
  };

  const handleTest = async () => {
    const draftConfig = { apiKey: form.apiKey, secret: form.secret, passphrase: form.passphrase || undefined };
    if (!hasRequiredApiCredentials(activeTab, draftConfig)) return;
    setApiConfig(activeTab, draftConfig);
    setTesting(true);
    const ok = await testConnection(activeTab);
    setTestResult(ok);
    setTesting(false);
  };

  const handleRemove = () => {
    removeApiConfig(activeTab);
    setForm({ apiKey: '', secret: '', passphrase: '' });
    setTestResult(null);
  };

  const color = EXCHANGE_COLORS[activeTab];
  const needsPass = requiresPassphrase(activeTab);
  const canSubmit = hasRequiredApiCredentials(activeTab, {
    apiKey: form.apiKey,
    secret: form.secret,
    passphrase: form.passphrase || undefined,
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={() => setShowApiPanel(false)}
    >
      <div
        className="glass-card animate-slide-in"
        style={{ width: 520, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title bar */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Key size={16} color="var(--color-primary)" />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)' }}>API 키 설정</span>
          </div>
          <button className="btn btn-ghost" style={{ padding: '4px 6px' }} onClick={() => setShowApiPanel(false)}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', overflowX: 'auto' }}>
          {OPERABLE_EXCHANGES.map(ex => {
            const c = EXCHANGE_COLORS[ex];
            const connected = !!apiConfigs[ex];
            const active = activeTab === ex;
            return (
              <button
                key={ex}
                onClick={() => handleTabChange(ex)}
                style={{
                  flex: 1,
                  padding: '12px 8px',
                  background: active ? `${c}15` : 'transparent',
                  border: 'none',
                  borderBottom: active ? `2px solid ${c}` : '2px solid transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  transition: 'all 0.15s',
                  minWidth: 80,
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: active ? c : 'var(--color-text-muted)', letterSpacing: '0.05em' }}>
                  {EXCHANGE_NAMES[ex]}
                </span>
                <span style={{ fontSize: 9, color: connected ? '#10b981' : 'var(--color-text-muted)' }}>
                  {connected ? '● 설정됨' : '○ 미설정'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Form */}
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ padding: 12, borderRadius: 8, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', fontSize: 12, color: '#94a3b8' }}>
            💡 API 키는 브라우저 로컬스토리지에만 저장됩니다. <strong style={{ color: 'var(--color-primary)' }}>선물 거래 권한</strong>이 있어야 하며, IP 화이트리스트 설정을 권장합니다.
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>API Key</label>
            <input
              className="input-field"
              placeholder={`${EXCHANGE_NAMES[activeTab]} API Key`}
              value={form.apiKey}
              onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>Secret Key</label>
            <div style={{ position: 'relative' }}>
              <input
                className="input-field"
                type={showSecret ? 'text' : 'password'}
                placeholder="Secret Key"
                value={form.secret}
                onChange={e => setForm(f => ({ ...f, secret: e.target.value }))}
                style={{ paddingRight: 40 }}
              />
              <button
                onClick={() => setShowSecret(v => !v)}
                style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)' }}
              >
                {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {needsPass && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
                Passphrase {activeTab === 'okx' ? '(OKX 필수)' : '(Bitget 필수)'}
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input-field"
                  type={showPassphrase ? 'text' : 'password'}
                  placeholder="Passphrase"
                  value={form.passphrase}
                  onChange={e => setForm(f => ({ ...f, passphrase: e.target.value }))}
                  style={{ paddingRight: 40 }}
                />
                <button
                  onClick={() => setShowPassphrase(v => !v)}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)' }}
                >
                  {showPassphrase ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          )}

          {testResult !== null && (
            <div style={{
              padding: '10px 14px',
              borderRadius: 8,
              background: testResult ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
              border: `1px solid ${testResult ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: testResult ? '#10b981' : '#ef4444',
            }}>
              <CheckCircle size={14} />
              {testResult ? '연결 성공! API 키가 유효합니다.' : '연결 실패. API 키를 확인해주세요.'}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button
              className="btn btn-ghost"
              style={{ flex: 1 }}
              onClick={handleTest}
              disabled={!canSubmit || testing}
            >
              {testing ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : null}
              연결 테스트
            </button>
            <button
              className="btn"
              style={{
                flex: 2,
                background: color,
                color: 'white',
                opacity: canSubmit ? 1 : 0.5,
              }}
              disabled={!canSubmit}
              onClick={handleSave}
            >
              저장 & 연결
            </button>
            {existing && (
              <button className="btn btn-danger" style={{ flex: 1 }} onClick={handleRemove}>
                삭제
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
