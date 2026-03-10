'use client';

import { RefreshCw, Key, Settings, Zap, Activity, FlaskConical } from 'lucide-react';
import KSTClock from '@/components/ui/KSTClock';
import StatusDot from '@/components/ui/StatusDot';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_NAMES } from '@/lib/types';
import Link from 'next/link';

export default function Header() {
  const {
    connectedExchanges,
    isLoadingRates,
    strategyRunning,
    strategyConfig,
    lastRatesUpdate,
    refreshRates,
    refreshPositions,
    refreshBalances,
    setShowApiPanel,
    simulationMode,
    toggleSimulationMode,
    resetSimulation,
  } = useFundingStore();

  const handleRefresh = async () => {
    await Promise.all([refreshRates(), refreshPositions(), refreshBalances()]);
  };

  return (
    <header
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
      <div style={{ width: 1, height: 24, background: 'var(--color-border)', flexShrink: 0 }} />

      {/* Clock */}
      <KSTClock />

      {/* Last update */}
      {lastRatesUpdate && (
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          마지막 업데이트: {new Date(lastRatesUpdate).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Exchange connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {(['binance', 'bybit', 'okx', 'bitget', 'gate'] as const).map((ex) => {
          const connected = connectedExchanges.includes(ex);
          return (
            <div
              key={ex}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 6,
                background: connected ? 'rgba(16,185,129,0.1)' : 'var(--bg-accent)',
                border: `1px solid ${connected ? 'rgba(16,185,129,0.3)' : 'var(--color-border)'}`,
              }}
            >
              <StatusDot status={connected ? 'connected' : 'disconnected'} size={6} />
              <span style={{ fontSize: 10, fontWeight: 600, color: connected ? '#10b981' : 'var(--color-text-muted)' }}>
                {EXCHANGE_NAMES[ex]}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ width: 1, height: 24, background: 'var(--color-border)' }} />

      {/* Strategy status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          borderRadius: 20,
          background: strategyRunning ? 'rgba(16,185,129,0.15)' : 'var(--bg-accent)',
          border: `1px solid ${strategyRunning ? 'rgba(16,185,129,0.4)' : 'var(--color-border)'}`,
        }}
      >
        <Activity size={12} color={strategyRunning ? '#10b981' : 'var(--color-text-muted)'} />
        <span style={{ fontSize: 12, fontWeight: 600, color: strategyRunning ? '#10b981' : 'var(--color-text-muted)' }}>
          {strategyRunning ? '실행중' : '대기중'}
        </span>
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
