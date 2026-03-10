'use client';

import { useState } from 'react';
import { TrendingDown, TrendingUp, Zap, AlertCircle, Play } from 'lucide-react';
import CountdownTimer from '@/components/ui/CountdownTimer';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES } from '@/lib/types';
import { estimateProfit } from '@/lib/opportunities';

function ExchangeBadge({ exchange, rate, side }: { exchange: string; rate: number; side: 'long' | 'short' }) {
  const id = exchange as keyof typeof EXCHANGE_COLORS;
  const color = EXCHANGE_COLORS[id] || '#94a3b8';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '20px 28px',
        borderRadius: 16,
        background: side === 'short'
          ? 'linear-gradient(135deg, rgba(239,68,68,0.08), rgba(239,68,68,0.03))'
          : 'linear-gradient(135deg, rgba(16,185,129,0.08), rgba(16,185,129,0.03))',
        border: `1px solid ${side === 'short' ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)'}`,
        minWidth: 180,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {side === 'short'
          ? <TrendingDown size={16} color="#ef4444" />
          : <TrendingUp size={16} color="#10b981" />
        }
        <span style={{ fontSize: 11, fontWeight: 600, color: side === 'short' ? '#ef4444' : '#10b981', letterSpacing: '0.1em' }}>
          {side === 'short' ? '숏 (SHORT)' : '롱 (LONG)'}
        </span>
      </div>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '4px 12px',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 700,
          background: `${color}22`,
          color,
          border: `1px solid ${color}44`,
          letterSpacing: '0.08em',
        }}
      >
        {EXCHANGE_NAMES[id as keyof typeof EXCHANGE_NAMES] || exchange.toUpperCase()}
      </span>
      <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--color-text)', letterSpacing: '-0.01em' }}>
        {exchange.toUpperCase().slice(0, 3)}USDT
      </span>
      {(() => {
        // 내 포지션 기준 실효 금액: 숏은 rate 그대로, 롱은 부호 반전
        const effective = side === 'short' ? rate : -rate;
        const receiving = effective >= 0;
        return (
          <>
            <span
              className="mono"
              style={{ fontSize: 22, fontWeight: 700, color: receiving ? '#10b981' : '#ef4444' }}
            >
              {receiving ? '+' : '-'}{Math.abs(rate * 100).toFixed(4)}%
            </span>
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: receiving ? '#10b981' : '#ef4444',
              background: receiving ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
              padding: '2px 8px',
              borderRadius: 4,
            }}>
              {receiving ? '▲ 수령' : '▼ 지불'}
            </span>
          </>
        );
      })()}
      <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>펀딩률 (8h): {rate >= 0 ? '+' : ''}{(rate * 100).toFixed(4)}%</span>
    </div>
  );
}

export default function OpportunityCard() {
  const { opportunities, strategyConfig, strategyRunning, executeStrategy, setShowStrategyPanel, apiConfigs, simulationMode, simBalances } = useFundingStore();
  const [compoundMode, setCompoundMode] = useState(false);
  const best = opportunities[0];

  if (!best) {
    return (
      <div
        className="glass-card"
        style={{
          padding: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          minHeight: 200,
        }}
      >
        <AlertCircle size={20} color="var(--color-text-muted)" />
        <span style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
          펀딩률 데이터 로딩 중... 잠시 기다려 주세요.
        </span>
      </div>
    );
  }

  const profit = estimateProfit(best, strategyConfig.investmentUSDT, strategyConfig.leverage);
  const hasShortConfig = !!apiConfigs[best.shortExchange];
  const hasLongConfig = !!apiConfigs[best.longExchange];
  const canExecute = simulationMode
    ? (simBalances[best.shortExchange] ?? 0) >= strategyConfig.investmentUSDT &&
      (simBalances[best.longExchange] ?? 0) >= strategyConfig.investmentUSDT
    : hasShortConfig && hasLongConfig;

  return (
    <div
      className="glass-card opportunity-glow"
      style={{
        padding: '28px 32px',
        background: 'linear-gradient(135deg, rgba(16,185,129,0.04), rgba(15,22,35,1) 60%)',
        borderColor: 'rgba(16,185,129,0.2)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #10b981, #3b82f6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Zap size={18} color="white" fill="white" />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>
              최적 헷징 기회
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              실시간 최고 스프레드 • 델타 뉴트럴
            </div>
          </div>
        </div>

        <CountdownTimer targetTime={best.nextFundingTime} />
      </div>

      {/* Main content */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        {/* Short side */}
        <ExchangeBadge
          exchange={best.shortExchange}
          rate={best.shortRate}
          side="short"
        />

        {/* Center metrics */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, minWidth: 220 }}>
          {/* Spread */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>8시간 스프레드</div>
            <div
              className="mono gradient-text-green"
              style={{ fontSize: 48, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.02em' }}
            >
              +{best.spreadPercent.toFixed(4)}%
            </div>
          </div>

          {/* Annual return */}
          <div
            style={{
              padding: '8px 20px',
              borderRadius: 24,
              background: 'rgba(16,185,129,0.12)',
              border: '1px solid rgba(16,185,129,0.3)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 11, color: '#10b981', marginBottom: 2 }}>예상 연간 수익률</div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: '#10b981' }}>
              ~{best.annualReturnPercent.toFixed(1)}%
            </div>
          </div>

          {/* Coin */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>대상 코인</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--color-text)' }}>
              {best.baseAsset}
            </div>
          </div>

          {/* Simple / Compound toggle */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--bg-accent)', borderRadius: 8, padding: 3 }}>
            {(['단리', '복리'] as const).map((label, i) => {
              const active = compoundMode === (i === 1);
              return (
                <button
                  key={label}
                  onClick={() => setCompoundMode(i === 1)}
                  style={{
                    flex: 1,
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: 'none',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    background: active ? (i === 1 ? 'rgba(139,92,246,0.3)' : 'rgba(16,185,129,0.2)') : 'transparent',
                    color: active ? (i === 1 ? '#a78bfa' : '#10b981') : 'var(--color-text-muted)',
                    transition: 'all 0.15s',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Profit estimates */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              width: '100%',
            }}
          >
            {[
              { label: '8h 수익', value: profit.perFunding, compoundValue: profit.perFunding },
              { label: '일 수익', value: profit.perDay, compoundValue: profit.compound.perDay },
              { label: '월 수익', value: profit.perMonth, compoundValue: profit.compound.perMonth },
              { label: '연 수익', value: profit.perYear, compoundValue: profit.compound.perYear },
            ].map(({ label, value, compoundValue }) => {
              const displayValue = compoundMode ? compoundValue : value;
              const roi = (displayValue / strategyConfig.investmentUSDT) * 100;
              return (
                <div
                  key={label}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'var(--bg-accent)',
                    border: `1px solid ${compoundMode ? 'rgba(139,92,246,0.2)' : 'var(--color-border)'}`,
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 2 }}>{label}</div>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: compoundMode ? '#a78bfa' : '#10b981' }}>
                    ${displayValue.toFixed(2)}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: compoundMode ? '#c4b5fd' : '#6ee7b7', marginTop: 2 }}>
                    +{roi.toFixed(2)}%
                  </div>
                </div>
              );
            })}
          </div>

          {/* Execute button */}
          <button
            className="btn btn-success"
            style={{
              width: '100%',
              padding: '12px 24px',
              fontSize: 14,
              borderRadius: 10,
              opacity: (!canExecute || strategyRunning) ? 0.5 : 1,
              cursor: (!canExecute || strategyRunning) ? 'not-allowed' : 'pointer',
              background: simulationMode ? 'linear-gradient(135deg, #7c3aed, #a78bfa)' : undefined,
            }}
            disabled={!canExecute || strategyRunning}
            onClick={() => executeStrategy(best)}
            title={!canExecute ? (simulationMode ? '시뮬 잔고 부족' : '두 거래소 모두 API 키가 필요합니다') : ''}
          >
            {strategyRunning ? (
              <>
                <div style={{ width: 14, height: 14, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                실행 중...
              </>
            ) : (
              <>
                <Play size={14} fill="white" />
                {simulationMode ? '[SIM] 지금 진입하기' : '지금 진입하기'}
              </>
            )}
          </button>

          {!canExecute && (
            <div style={{ fontSize: 11, color: 'var(--color-warning)', textAlign: 'center' }}>
              {simulationMode
                ? `⚠️ 시뮬 잔고 부족 (필요: $${strategyConfig.investmentUSDT})`
                : `⚠️ ${!hasShortConfig ? best.shortExchange.toUpperCase() : best.longExchange.toUpperCase()} API 키 필요`}
            </div>
          )}

          {/* Config summary */}
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--color-text-muted)' }}>
            <span>투자금: <strong style={{ color: 'var(--color-text)' }}>${strategyConfig.investmentUSDT.toLocaleString()}</strong></span>
            <span>레버리지: <strong style={{ color: 'var(--color-text)' }}>{strategyConfig.leverage}x</strong></span>
            <button
              onClick={() => setShowStrategyPanel(true)}
              style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 11, padding: 0 }}
            >
              수정
            </button>
          </div>
        </div>

        {/* Long side */}
        <ExchangeBadge
          exchange={best.longExchange}
          rate={best.longRate}
          side="long"
        />
      </div>
    </div>
  );
}
