'use client';

import { RefreshCw, Key, Settings, Zap, FlaskConical } from 'lucide-react';
import KSTClock from '@/components/ui/KSTClock';
import { useFundingStore } from '@/store/fundingStore';
import {
  EXCHANGE_NAMES,
  EXCHANGE_COLORS,
  OPERABLE_EXCHANGES,
  EXCHANGE_FEE_PRESET_LABEL,
  EXCHANGE_FEE_PRESET_NOTE,
  EXCHANGE_PAYBACK_PRESET_LABEL,
  EXCHANGE_PAYBACK_PRESET_NOTE,
} from '@/lib/types';
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
    openApiPanelFor,
    simulationMode,
    toggleSimulationMode,
    resetSimulation,
    simSnipeActive,
    realSnipeActive,
    simPositions,
    positions,
    simBalances,
    apiConfigs,
  } = useFundingStore();

  const anySnipeActive = simSnipeActive || realSnipeActive;
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';
  const appBuildDateRaw = process.env.NEXT_PUBLIC_APP_BUILD_DATE;
  const appBuildDateCompact = appBuildDateRaw
    ? new Date(appBuildDateRaw).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    : '-';
  const lastUpdateTime = lastRatesUpdate
    ? new Date(lastRatesUpdate).toLocaleTimeString('ko-KR', {
      timeZone: 'Asia/Seoul',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    : '-';

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
        borderBottom: `2px solid ${simulationMode ? 'rgba(167,139,250,0.4)' : 'rgba(239,68,68,0.6)'}`,
        padding: '0 24px',
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      {/* Logo */}
      <div className="header-brand" style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 8 }}>
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

      {/* Desktop status */}
      <div
        className="header-hide-mobile"
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        <div className="header-status-block" title={appBuildDateRaw ? `build: ${appBuildDateRaw}` : 'build: unknown'}>
          <div className="header-status-main"><KSTClock /></div>
          <div className="header-status-sub">업데이트 {lastUpdateTime}</div>
          <div className="header-status-sub mono">v{appVersion} · {appBuildDateCompact}</div>
        </div>
      </div>

      {/* Mobile status */}
      <div className="header-mobile-status" title={appBuildDateRaw ? `build: ${appBuildDateRaw}` : 'build: unknown'}>
        <KSTClock compact />
        <span className="mono">v{appVersion}</span>
      </div>

      <div
        className="header-fee-pill"
        title={EXCHANGE_FEE_PRESET_NOTE}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderRadius: 999,
          border: '1px solid rgba(16,185,129,0.35)',
          background: 'rgba(16,185,129,0.12)',
          color: '#10b981',
          fontSize: 10,
          fontWeight: 800,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 700 }}>FEE</span>
        <span>{EXCHANGE_FEE_PRESET_LABEL}</span>
      </div>

      <div
        className="header-payback-pill"
        title={EXCHANGE_PAYBACK_PRESET_NOTE}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderRadius: 999,
          border: '1px solid rgba(34,211,238,0.35)',
          background: 'rgba(34,211,238,0.12)',
          color: '#22d3ee',
          fontSize: 10,
          fontWeight: 800,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 700 }}>PAYBACK</span>
        <span>{EXCHANGE_PAYBACK_PRESET_LABEL}</span>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Exchange ON/OFF toggles (+ REAL mode: click unconfigured = open API-key popup) */}
      <div className="header-exchanges" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {OPERABLE_EXCHANGES.map((ex) => {
          const enabled = enabledExchanges.includes(ex);
          const color = EXCHANGE_COLORS[ex];
          const hasApiKey = !!apiConfigs[ex];
          // In REAL mode, if the exchange has no API key, clicking the pill opens the API-key
          // popup pre-selected for that exchange instead of toggling ON/OFF. In SIM mode or
          // when a key is already configured, keep the existing toggle behavior.
          const clickOpensApiPanel = !simulationMode && !hasApiKey;
          const handleClick = clickOpensApiPanel
            ? () => openApiPanelFor(ex)
            : () => toggleExchange(ex);
          const titleText = clickOpensApiPanel
            ? `${EXCHANGE_NAMES[ex]} API 키 미설정 — 클릭해서 입력`
            : `${EXCHANGE_NAMES[ex]} ${enabled ? 'OFF' : 'ON'} (클릭하여 전환)${enabled && simulationMode ? `\n잔고: $${fmtNum(simBalances[ex] ?? 0, 0)}` : ''}`;
          return (
            <button
              key={ex}
              onClick={handleClick}
              title={titleText}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 6,
                background: clickOpensApiPanel ? `${color}12` : enabled ? `${color}18` : 'var(--bg-accent)',
                border: `1px solid ${clickOpensApiPanel ? `${color}66` : enabled ? `${color}55` : 'var(--color-border)'}`,
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
              {clickOpensApiPanel && (
                <span
                  aria-label="API 키 미설정"
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    marginLeft: 2,
                    padding: '0 4px',
                    borderRadius: 4,
                    background: `${color}33`,
                    color,
                  }}
                >
                  + 키
                </span>
              )}
            </button>
          );
        })}
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', marginLeft: 2 }}>
          {enabledExchanges.length}/{OPERABLE_EXCHANGES.length}
        </span>
      </div>

      <div className="header-hide-mobile" style={{ width: 1, height: 24, background: 'var(--color-border)' }} />

      {/* Mode + Status 그룹 */}
      <div className="header-mode-group" style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {/* SIM / REAL 세그먼트 */}
        <div style={{
          display: 'flex', alignItems: 'center',
          borderRadius: 8, overflow: 'hidden',
          border: `2px solid ${simulationMode ? '#a78bfa' : '#ef4444'}`,
          background: 'rgba(0,0,0,0.3)',
          flexShrink: 0,
        }}>
          <button
            onClick={() => { if (!simulationMode) void toggleSimulationMode(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', border: 'none', cursor: 'pointer',
              background: simulationMode ? '#a78bfa' : 'transparent',
              color: simulationMode ? '#fff' : 'var(--color-text-muted)',
              fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap',
            }}
          >
            <FlaskConical size={11} />
            SIM
          </button>
          <button
            onClick={() => { if (simulationMode) void toggleSimulationMode(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', border: 'none', cursor: 'pointer',
              background: !simulationMode ? '#ef4444' : 'transparent',
              color: !simulationMode ? '#fff' : 'var(--color-text-muted)',
              fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap',
            }}
          >
            <Zap size={11} />
            REAL
          </button>
        </div>

        {/* Snipe status — 컴팩트 (양쪽 모드 표시) */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 8px', borderRadius: 6, flexShrink: 0,
          background: anySnipeActive ? 'rgba(16,185,129,0.12)' : 'transparent',
          border: `1px solid ${anySnipeActive ? 'rgba(16,185,129,0.3)' : 'var(--color-border)'}`,
        }}>
          {anySnipeActive && (
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 4px #10b981', animation: 'blink 1.5s ease-in-out infinite', flexShrink: 0 }} />
          )}
          <span style={{ fontSize: 10, fontWeight: 700, color: anySnipeActive ? '#10b981' : 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
            {anySnipeActive ? (() => {
              const parts: string[] = [];
              if (simSnipeActive) {
                const simCount = simPositions.length;
                parts.push(`SIM${simCount > 0 ? ` ${simCount}P` : ''}`);
              }
              if (realSnipeActive) {
                const realCount = positions.filter(p => p.positionType !== 'manual').length;
                parts.push(`REAL${realCount > 0 ? ` ${realCount}P` : ''}`);
              }
              return `투자중 ${parts.join(' | ')}`;
            })() : '대기'}
          </span>
        </div>

        {simulationMode && (
          <button
            onClick={resetSimulation}
            title={`시뮬레이션 초기화 ($${(strategyConfig.investmentUSDT * 2).toLocaleString()} 리셋)`}
            style={{
              padding: '4px 8px', borderRadius: 6, flexShrink: 0,
              border: '1px solid rgba(167,139,250,0.3)',
              background: 'transparent',
              color: '#a78bfa', fontSize: 10, fontWeight: 700,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            리셋
          </button>
        )}
      </div>

      {/* Action buttons */}
      <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
      </div>
    </header>
  );
}
