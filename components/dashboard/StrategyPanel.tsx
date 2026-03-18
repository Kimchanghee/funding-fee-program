'use client';

import { X, DollarSign, TrendingUp, Info } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { estimateProfit, estimateProfitShortOnly } from '@/lib/opportunities';
import { fmtNum } from '@/lib/format';

export default function StrategyPanel() {
  const { strategyConfig, setStrategyConfig, setShowStrategyPanel, opportunities, simulationMode, simPositions, positions, snipeActive } = useFundingStore();
  const hasOpenPositions = simulationMode ? simPositions.length > 0 : positions.length > 0;
  const canSwitchMode = !hasOpenPositions && !snipeActive;
  const best = opportunities[0];

  const profit = best
    ? (strategyConfig.strategyMode === 'shortOnly'
      ? estimateProfitShortOnly(best, strategyConfig.investmentUSDT, strategyConfig.leverage)
      : estimateProfit(best, strategyConfig.investmentUSDT, strategyConfig.leverage))
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
          {/* Strategy Mode */}
          <div style={{ padding: 16, borderRadius: 10, background: 'var(--bg-accent)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text)', marginBottom: 12 }}>
              전략 모드
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { label: '헷징 (숏+롱)', value: 'hedge' as const, color: '#3b82f6', desc: '델타 뉴트럴, 스프레드 수익' },
                { label: '숏온리', value: 'shortOnly' as const, color: '#ef4444', desc: '숏만 진입, 펀딩 전액 수령' },
              ]).map(({ label, value, color, desc }) => (
                <button
                  key={value}
                  onClick={() => canSwitchMode && setStrategyConfig({ strategyMode: value })}
                  disabled={!canSwitchMode && strategyConfig.strategyMode !== value}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: `1px solid ${strategyConfig.strategyMode === value ? color : 'var(--color-border)'}`,
                    background: strategyConfig.strategyMode === value ? `${color}15` : 'transparent',
                    cursor: (!canSwitchMode && strategyConfig.strategyMode !== value) ? 'not-allowed' : 'pointer',
                    opacity: (!canSwitchMode && strategyConfig.strategyMode !== value) ? 0.4 : 1,
                    textAlign: 'left',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: strategyConfig.strategyMode === value ? color : 'var(--color-text-muted)' }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>{desc}</div>
                </button>
              ))}
            </div>
            {!canSwitchMode && (
              <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 6 }}>
                포지션이 열려있거나 자동투자 실행 중에는 모드를 변경할 수 없습니다.
              </div>
            )}
          </div>

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
              {strategyConfig.strategyMode === 'shortOnly'
                ? <>투자금: <strong style={{ color: 'var(--color-text)' }}>${strategyConfig.investmentUSDT.toLocaleString()}</strong> (숏 단일)</>
                : <>총 투자금: <strong style={{ color: 'var(--color-text)' }}>${(strategyConfig.investmentUSDT * 2).toLocaleString()}</strong> (롱+숏 양방향)</>
              }
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

          {/* Min spread / Min funding rate */}
          {strategyConfig.strategyMode === 'shortOnly' ? (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
                최소 펀딩레이트 (%): <strong style={{ color: '#ef4444' }}>{((strategyConfig.minFundingRate ?? 0.003) * 100).toFixed(2)}%</strong>
              </label>
              <input
                className="input-field"
                type="number"
                min={0.01}
                max={5}
                step={0.01}
                value={((strategyConfig.minFundingRate ?? 0.003) * 100)}
                onChange={e => setStrategyConfig({ minFundingRate: Number(e.target.value) / 100 })}
              />
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                이 펀딩레이트 이상인 코인만 숏 진입 (0.3% 이상 권장)
              </div>
            </div>
          ) : (
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
          )}

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
                  { label: '1h 순수익', value: profit.per1h },
                  { label: '4h 순수익', value: profit.per4h },
                  { label: '8h 순수익', value: profit.netPerFunding },
                  { label: '일 순수익 (3회)', value: profit.perDay },
                  { label: '주 순수익', value: profit.perWeek },
                  { label: '월 순수익', value: profit.perMonth },
                ].map(({ label, value }) => (
                  <div key={label} style={{ background: 'var(--bg-accent)', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{label}</div>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: '#10b981' }}>
                      ${fmtNum(value)}
                    </div>
                  </div>
                ))}
                <div style={{ gridColumn: '1 / -1', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>연 순수익</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: '#10b981' }}>
                    ${fmtNum(profit.perYear)}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
                스프레드: <strong style={{ color: '#10b981' }}>+{fmtNum(best.spreadPercent, 4)}%</strong> •
                연환산: <strong style={{ color: '#10b981' }}>{fmtNum(profit.roiPerYear, 1)}%</strong>
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
