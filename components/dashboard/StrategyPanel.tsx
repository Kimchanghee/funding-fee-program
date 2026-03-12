'use client';

import { X, DollarSign, TrendingUp, Info } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { estimateProfit } from '@/lib/opportunities';

export default function StrategyPanel() {
  const { strategyConfig, setStrategyConfig, setShowStrategyPanel, opportunities, simulationMode, simBalances } = useFundingStore();
  const best = opportunities[0];

  const totalPortfolio = simulationMode
    ? Object.values(simBalances).reduce((s, v) => s + v, 0)
    : undefined;
  const profit = best
    ? estimateProfit(best, strategyConfig.investmentUSDT, strategyConfig.leverage, totalPortfolio)
    : null;

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
      onClick={() => setShowStrategyPanel(false)}
    >
      <div
        className="glass-card animate-slide-in"
        style={{ width: 460, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TrendingUp size={16} color="var(--color-success)" />
            <span style={{ fontSize: 15, fontWeight: 700 }}>전략 설정</span>
          </div>
          <button className="btn btn-ghost" style={{ padding: '4px 6px' }} onClick={() => setShowStrategyPanel(false)}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Investment */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <DollarSign size={12} /> 포지션당 투자금 (USDT)
            </label>
            <input
              className="input-field"
              type="number"
              min={10}
              max={1000000}
              step={100}
              value={strategyConfig.investmentUSDT}
              onChange={e => setStrategyConfig({ investmentUSDT: Number(e.target.value) })}
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              총 투자금: <strong style={{ color: 'var(--color-text)' }}>${(strategyConfig.investmentUSDT * 2).toLocaleString()}</strong> (롱+숏 양방향)
            </div>
          </div>

          {/* Leverage */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
              레버리지: <strong style={{ color: 'var(--color-primary)' }}>{strategyConfig.leverage}x</strong>
            </label>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={strategyConfig.leverage}
              onChange={e => setStrategyConfig({ leverage: Number(e.target.value) })}
              style={{ width: '100%', accentColor: 'var(--color-primary)', cursor: 'pointer' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-muted)' }}>
              <span>1x (안전)</span>
              <span>5x (권장)</span>
              <span>20x (고위험)</span>
            </div>
            <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 6 }}>
              ⚠️ 레버리지가 높을수록 청산 위험이 증가합니다. 5x 이하를 권장합니다.
            </div>
          </div>

          {/* Min spread */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
              최소 스프레드 (%): <strong style={{ color: 'var(--color-text)' }}>{strategyConfig.minSpreadPercent}%</strong>
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
              이 값 이상일 때만 자동 진입 알림/실행
            </div>
          </div>

          {/* Auto-exit settings */}
          <div style={{ padding: 16, borderRadius: 10, background: 'var(--bg-accent)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text)', marginBottom: 12 }}>
              자동 종료 설정
            </div>

            {/* Close on spread reverse */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={strategyConfig.closeOnSpreadReverse}
                onChange={e => setStrategyConfig({ closeOnSpreadReverse: e.target.checked })}
                style={{ accentColor: '#10b981', width: 16, height: 16, cursor: 'pointer' }}
              />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>스프레드 역전 시 자동 청산</div>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
                  숏-롱 스프레드가 0% 이하로 떨어지면 즉시 양쪽 청산
                </div>
              </div>
            </label>

            {/* Max position age */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
                최대 보유시간: <strong style={{ color: 'var(--color-text)' }}>{strategyConfig.maxPositionAgeHours}시간</strong>
              </label>
              <input
                type="range"
                min={8}
                max={168}
                step={8}
                value={strategyConfig.maxPositionAgeHours}
                onChange={e => setStrategyConfig({ maxPositionAgeHours: Number(e.target.value) })}
                style={{ width: '100%', accentColor: '#f59e0b', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-muted)' }}>
                <span>8h (1회 펀딩)</span>
                <span>72h (권장)</span>
                <span>168h (1주일)</span>
              </div>
            </div>
          </div>

          {/* Compound investing toggle */}
          <div style={{ padding: 16, borderRadius: 10, background: 'var(--bg-accent)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text)', marginBottom: 12 }}>
              투자 방식
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { label: '단리 (고정 투자금)', value: false, color: '#10b981', desc: '매번 같은 금액으로 진입' },
                { label: '복리 (수익 재투자)', value: true, color: '#a78bfa', desc: '수익을 포함해 투자금 증가' },
              ] as const).map(({ label, value, color, desc }) => (
                <button
                  key={label}
                  onClick={() => setStrategyConfig({ compoundInvesting: value })}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: `1px solid ${strategyConfig.compoundInvesting === value ? color : 'var(--color-border)'}`,
                    background: strategyConfig.compoundInvesting === value ? `${color}15` : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: strategyConfig.compoundInvesting === value ? color : 'var(--color-text-muted)' }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Profit preview */}
          {profit && best && (
            <div style={{ padding: 16, borderRadius: 10, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#10b981', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Info size={12} /> 현재 최적 기회 기준 예상 수익 ({best.baseAsset})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { label: '8h 순수익', value: profit.netPerFunding },
                  { label: '일 순수익 (3회)', value: profit.perDay },
                  { label: '월 순수익', value: profit.perMonth },
                  { label: '연 순수익', value: profit.perYear },
                ].map(({ label, value }) => (
                  <div key={label} style={{ background: 'var(--bg-accent)', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{label}</div>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: '#10b981' }}>
                      ${value.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
                스프레드: <strong style={{ color: '#10b981' }}>+{best.spreadPercent.toFixed(4)}%</strong> •
                연환산: <strong style={{ color: '#10b981' }}>{best.annualReturnPercent.toFixed(1)}%</strong>
              </div>
            </div>
          )}

          <button
            className="btn btn-success"
            style={{ padding: '12px 24px', justifyContent: 'center' }}
            onClick={() => setShowStrategyPanel(false)}
          >
            저장 완료
          </button>
        </div>
      </div>
    </div>
  );
}
