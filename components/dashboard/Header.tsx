'use client';

import { RefreshCw, Key, Settings, Zap, Activity, FlaskConical } from 'lucide-react';
import KSTClock from '@/components/ui/KSTClock';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_NAMES, EXCHANGE_COLORS, SUPPORTED_EXCHANGES } from '@/lib/types';
import Link from 'next/link';
import { fmtNum } from '@/lib/format';

export default function Header() {
  const {
    enabledExchanges,
    toggleExchange,
    isLoadingRates,
    strategyConfig,
    lastRatesUpdate,
    refreshRates,
    refreshPositions,
    refreshBalances,
    setShowApiPanel,
    simulationMode,
    toggleSimulationMode,
    resetSimulation,
    snipeActive,
    simPositions,
    simBalances,
  } = useFundingStore();

  const handleRefresh = async () => {
    await Promise.all([refreshRates(), refreshPositions(), refreshBalances()]);
  };

  return (
    <header
      className="app-header"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'rgba(10,14,23,0.95)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--color-border)',
        padding: '0 24px',
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 8 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: 'linear-gradient(135deg, #10b981, #3b82f6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Zap size={18} color="white" fill="white" />
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
            펀딩피 헷징
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', lineHeight: 1 }}>
            FUNDING FEE ARBITRAGE
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="header-hide-mobile" style={{ width: 1, height: 24, background: 'var(--color-border)', flexShrink: 0 }} />

      {/* Clock */}
      <div className="header-hide-mobile"><KSTClock /></div>

      {/* Last update */}
      {lastRatesUpdate && (
        <span className="header-hide-mobile" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          마지막 업데이트: {new Date(lastRatesUpdate).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Exchange ON/OFF toggles */}
      <div className="header-exchanges" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {SUPPORTED_EXCHANGES.map((ex) => {
          const enabled = enabledExchanges.includes(ex);
          const color = EXCHANGE_COLORS[ex];
          return (
            <button
              key={ex}
              onClick={() => toggleExchange(ex)}
              title={`${EXCHANGE_NAMES[ex]} ${enabled ? 'OFF' : 'ON'} (클릭하여 전환)${enabled && simulationMode ? `\n잔고: $${fmtNum(simBalances[ex] ?? 0, 0)}` : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 6,
                background: enabled ? `${color}18` : 'var(--bg-accent)',
                border: `1px solid ${enabled ? `${color}55` : 'var(--color-border)'}`,
                cursor: 'pointer',
                opacity: enabled ? 1 : 0.4,
                transition: 'all 0.2s ease',
              }}
            >
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: enabled ? color : 'var(--color-text-muted)',
                boxShadow: enabled ? `0 0 4px ${color}` : 'none',
              }} />
              <span style={{ fontSize: 10, fontWeight: 600, color: enabled ? color : 'var(--color-text-muted)' }}>
                {EXCHANGE_NAMES[ex]}
              </span>
            </button>
          );
        })}
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', marginLeft: 2 }}>
          {enabledExchanges.length}/{SUPPORTED_EXCHANGES.length}
        </span>
      </div>

      <div className="header-hide-mobile" style={{ width: 1, height: 24, background: 'var(--color-border)' }} />

      {/* Snipe status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          borderRadius: 20,
          background: snipeActive ? 'rgba(16,185,129,0.15)' : 'var(--bg-accent)',
          border: `1px solid ${snipeActive ? 'rgba(16,185,129,0.4)' : 'var(--color-border)'}`,
        }}
      >
        {snipeActive && (
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 4px #10b981', animation: 'blink 1.5s ease-in-out infinite' }} />
        )}
        <Activity size={12} color={snipeActive ? '#10b981' : 'var(--color-text-muted)'} />
        <span style={{ fontSize: 12, fontWeight: 600, color: snipeActive ? '#10b981' : 'var(--color-text-muted)' }}>
          {snipeActive ? '자동 투자 중' : '대기중'}
        </span>
        {snipeActive && simPositions.length > 0 && (
          <span className="mono" style={{ fontSize: 10, color: '#6ee7b7' }}>
            {simPositions.length}P
          </span>
        )}
      </div>

      {/* Simulation toggle */}
      <button
        onClick={toggleSimulationMode}
        title={simulationMode ? '시뮬레이션 모드 OFF' : `시뮬레이션 모드 ON (각 거래소 $${strategyConfig.investmentUSDT.toLocaleString()} 가상 잔고)`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px',
          borderRadius: 8,
          border: `1px solid ${simulationMode ? '#a78bfa' : 'var(--color-border)'}`,
          background: simulationMode ? 'rgba(167,139,250,0.15)' : 'transparent',
          color: simulationMode ? '#a78bfa' : 'var(--color-text-muted)',
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        <FlaskConical size={13} />
        {simulationMode ? 'SIM ON' : 'SIM'}
      </button>

      {simulationMode && (
        <button
          onClick={resetSimulation}
          title={`시뮬레이션 초기화 ($${strategyConfig.investmentUSDT.toLocaleString()} 리셋)`}
          style={{
            padding: '5px 10px',
            borderRadius: 8,
            border: '1px solid rgba(167,139,250,0.3)',
            background: 'transparent',
            color: '#a78bfa',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          리셋
        </button>
      )}

      {/* Action buttons */}
      <button
        className="btn btn-ghost"
        style={{ padding: '6px 10px' }}
        onClick={handleRefresh}
        disabled={isLoadingRates}
        title="새로고침"
      >
        <RefreshCw size={14} style={{ animation: isLoadingRates ? 'spin 1s linear infinite' : 'none' }} />
      </button>

      <button
        className="btn btn-ghost"
        style={{ padding: '6px 10px' }}
        onClick={() => setShowApiPanel(true)}
        title="API 키 설정"
      >
        <Key size={14} />
      </button>

      <Link href="/settings">
        <button className="btn btn-ghost" style={{ padding: '6px 10px' }} title="전략 설정">
          <Settings size={14} />
        </button>
      </Link>
    </header>
  );
}
