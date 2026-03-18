'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_NAMES, EXCHANGE_COLORS, SUPPORTED_EXCHANGES } from '@/lib/types';
import StatusDot from '@/components/ui/StatusDot';
import Header from '@/components/dashboard/Header';
import ApiPanel from '@/components/dashboard/ApiPanel';

export default function SettingsPage() {
  const {
    strategyConfig,
    setStrategyConfig,
    connectedExchanges,
    testConnection,
    showApiPanel,
    setShowApiPanel,
    refreshBalances,
    refreshRates,
    isLoadingRates,
    lastRatesUpdate,
    opportunities,
    init,
  } = useFundingStore();

  useEffect(() => {
    init();
    return () => useFundingStore.getState().stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bestOpp = opportunities[0];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Header />
      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '24px' }}>

        {/* Back */}
        <Link href="/" style={{ textDecoration: 'none' }}>
          <button className="btn btn-ghost" style={{ marginBottom: 20 }}>
            <ArrowLeft size={14} /> 대시보드로 돌아가기
          </button>
        </Link>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* Strategy Config */}
          <div className="glass-card" style={{ padding: 24, gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20, color: 'var(--color-text)' }}>
              전략 파라미터
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
                  포지션당 투자금 (USDT)
                </label>
                <input
                  className="input-field"
                  type="number"
                  min={10}
                  step={100}
                  value={strategyConfig.investmentUSDT}
                  onChange={e => setStrategyConfig({ investmentUSDT: Number(e.target.value) })}
                />
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  총 ${(strategyConfig.investmentUSDT * 2).toLocaleString()} (롱+숏)
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
                  레버리지 ({strategyConfig.leverage}x)
                </label>
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={strategyConfig.leverage}
                  onChange={e => setStrategyConfig({ leverage: Number(e.target.value) })}
                  style={{ width: '100%', accentColor: 'var(--color-primary)', cursor: 'pointer' }}
                />
                <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>
                  {strategyConfig.leverage > 10 ? '⚠️ 고위험' : strategyConfig.leverage > 5 ? '주의 필요' : '✓ 권장 범위'}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
                  최소 진입 스프레드 (%)
                </label>
                <input
                  className="input-field"
                  type="number"
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={strategyConfig.minSpreadPercent}
                  onChange={e => setStrategyConfig({ minSpreadPercent: Number(e.target.value) })}
                />
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  이 수치 이상일 때만 진입
                </div>
              </div>

            </div>

            {/* Toggles */}
            <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap' }}>
              {[
                { key: 'autoExecute', label: '자동 진입', desc: '최적 기회 발견 시 자동으로 포지션 진입', dangerous: true },
              ].map(({ key, label, desc, dangerous }) => {
                const value = strategyConfig[key as keyof typeof strategyConfig] as boolean;
                return (
                  <div
                    key={key}
                    style={{
                      padding: '12px 16px',
                      borderRadius: 10,
                      background: value ? (dangerous ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)') : 'var(--bg-accent)',
                      border: `1px solid ${value ? (dangerous ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)') : 'var(--color-border)'}`,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      minWidth: 280,
                    }}
                    onClick={() => setStrategyConfig({ [key]: !value })}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 22,
                        borderRadius: 11,
                        background: value ? (dangerous ? '#ef4444' : '#10b981') : 'var(--bg-accent2)',
                        position: 'relative',
                        transition: 'background 0.2s',
                        flexShrink: 0,
                      }}
                    >
                      <div
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: '50%',
                          background: 'white',
                          position: 'absolute',
                          top: 3,
                          left: value ? 21 : 3,
                          transition: 'left 0.2s',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                        }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: value ? 'var(--color-text)' : 'var(--color-text-muted)' }}>{label}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Exchange Status */}
          <div className="glass-card" style={{ padding: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: 'var(--color-text)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              거래소 연결 상태
              <button
                className="btn btn-ghost"
                style={{ padding: '4px 10px', fontSize: 11 }}
                onClick={() => setShowApiPanel(true)}
              >
                + API 키 추가
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {SUPPORTED_EXCHANGES.map(ex => {
                const color = EXCHANGE_COLORS[ex];
                const connected = connectedExchanges.includes(ex);
                return (
                  <div
                    key={ex}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: connected ? `${color}0a` : 'var(--bg-accent)',
                      border: `1px solid ${connected ? `${color}33` : 'var(--color-border)'}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <StatusDot status={connected ? 'connected' : 'disconnected'} />
                      <span style={{ fontSize: 13, fontWeight: 700, color }}>{EXCHANGE_NAMES[ex]}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: connected ? '#10b981' : 'var(--color-text-muted)' }}>
                        {connected ? 'API 설정됨' : '미설정'}
                      </span>
                      {connected && (
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '3px 8px', fontSize: 10 }}
                          onClick={() => testConnection(ex)}
                        >
                          테스트
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Strategy Status */}
          <div className="glass-card" style={{ padding: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: 'var(--color-text)' }}>
              전략 현황
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>연결된 거래소</span>
                <span style={{ fontWeight: 700, color: 'var(--color-text)' }}>{connectedExchanges.length} / 5</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>발견된 기회</span>
                <span style={{ fontWeight: 700, color: 'var(--color-text)' }}>{opportunities.length}개</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>최고 스프레드</span>
                <span className="mono" style={{ fontWeight: 700, color: '#10b981' }}>
                  {bestOpp ? `+${bestOpp.spreadPercent.toFixed(4)}%` : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>마지막 업데이트</span>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  {lastRatesUpdate ? new Date(lastRatesUpdate).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '8px 0' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>투자금 (단방향)</span>
                <span className="mono" style={{ fontWeight: 700, color: 'var(--color-text)' }}>
                  ${strategyConfig.investmentUSDT.toLocaleString()}
                </span>
              </div>
              <button
                className="btn btn-ghost"
                style={{ marginTop: 8 }}
                onClick={() => { refreshRates(); refreshBalances(); }}
                disabled={isLoadingRates}
              >
                <RefreshCw size={13} style={{ animation: isLoadingRates ? 'spin 1s linear infinite' : 'none' }} />
                데이터 새로고침
              </button>
            </div>
          </div>

          {/* How it works */}
          <div className="glass-card" style={{ padding: 24, gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: 'var(--color-text)' }}>
              💡 작동 방식
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              {[
                { step: '1', title: '펀딩률 스캔', desc: '5개 거래소에서 40개+ 코인의 펀딩률을 30초마다 실시간 수집' },
                { step: '2', title: '최적 쌍 발견', desc: '동일 코인에서 가장 높은 펀딩률(숏)과 가장 낮은 펀딩률(롱) 거래소 쌍 탐색' },
                { step: '3', title: '동시 진입', desc: '숏 거래소에서 SHORT, 롱 거래소에서 LONG을 동시에 진입하여 델타 중립 구성' },
                { step: '4', title: '펀딩피 수령', desc: '8시간마다(00:00, 08:00, 16:00 UTC) 숏 포지션에서 높은 펀딩피를 수령' },
              ].map(({ step, title, desc }) => (
                <div key={step} style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--bg-accent)', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--color-primary)', marginBottom: 6 }}>0{step}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>{title}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>{desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {showApiPanel && <ApiPanel />}
    </div>
  );
}
