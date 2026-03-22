'use client';

import { useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { fmtNum } from '@/lib/format';

const TIME_PERIODS = [
  { key: '1h', label: '1시간' },
  { key: '4h', label: '4시간' },
  { key: '8h', label: '8시간' },
  { key: 'day', label: '하루' },
  { key: 'week', label: '일주일' },
  { key: 'month', label: '월간' },
] as const;

type PeriodKey = typeof TIME_PERIODS[number]['key'];

export default function ReturnProjectionPanel() {
  const { opportunities, strategyConfig, simulationMode, simBalances, simPositions, balances } = useFundingStore();
  const [compoundMode, setCompoundMode] = useState(false);

  const totalPortfolio = simulationMode
    ? Object.values(simBalances).reduce((s, v) => s + v, 0) + simPositions.reduce((s, p) => s + p.margin, 0)
    : Object.values(balances).filter(b => b?.status === 'connected').reduce((sum, b) => sum + (b?.totalUSDT || 0), 0);

  const portfolio = totalPortfolio || strategyConfig.investmentUSDT * 2;

  const projection = useMemo(() => {
    const best = opportunities[0];
    if (!best) return null;

    const notional = strategyConfig.investmentUSDT * strategyConfig.leverage;
    const perFunding = notional * best.spread;
    const TAKER_FEE = 0.0005;
    const feesPerCycle = notional * TAKER_FEE * 4; // 매 스나이프 사이클 왕복 수수료
    const netPerFunding = perFunding - feesPerCycle;

    const intervalMs = best.fundingIntervalMs ?? 8 * 3600000;
    const intervalH = intervalMs / 3600000;
    const fundingsPerDay = 24 / intervalH;

    // 단리: 매 사이클마다 수수료 차감된 순수익 기준
    const simple: Record<PeriodKey, number> = {
      '1h': netPerFunding / intervalH,
      '4h': netPerFunding * (4 / intervalH),
      '8h': netPerFunding * (8 / intervalH),
      day: netPerFunding * fundingsPerDay,
      week: netPerFunding * fundingsPerDay * 7,
      month: netPerFunding * fundingsPerDay * 30,
    };

    // 복리: 순수익률 기준 복리 계산
    const netRatePerFunding = netPerFunding / portfolio;
    const compound: Record<PeriodKey, number> = {
      '1h': portfolio * (Math.pow(1 + netRatePerFunding, 1 / intervalH) - 1),
      '4h': portfolio * (Math.pow(1 + netRatePerFunding, 4 / intervalH) - 1),
      '8h': portfolio * (Math.pow(1 + netRatePerFunding, 8 / intervalH) - 1),
      day: portfolio * (Math.pow(1 + netRatePerFunding, fundingsPerDay) - 1),
      week: portfolio * (Math.pow(1 + netRatePerFunding, fundingsPerDay * 7) - 1),
      month: portfolio * (Math.pow(1 + netRatePerFunding, fundingsPerDay * 30) - 1),
    };

    return { best, simple, compound, perFunding, totalFees: feesPerCycle, intervalH };
  }, [opportunities, strategyConfig.investmentUSDT, strategyConfig.leverage, portfolio]);

  if (!projection) return null;

  const { best, simple, compound, perFunding, totalFees, intervalH } = projection;
  const data = compoundMode ? compound : simple;

  return (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--color-border)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TrendingUp size={16} color="#10b981" />
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)' }}>
            예상 수익 시뮬레이션
          </span>
        </div>

        {/* Best opp info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--color-text-muted)' }}>
          <span style={{ fontWeight: 700, color: 'var(--color-text)' }}>{best.baseAsset}</span>
          <span>{best.shortExchange.toUpperCase()} ⇄ {best.longExchange.toUpperCase()}</span>
          <span className="mono" style={{ fontWeight: 800, color: '#10b981' }}>+{fmtNum(best.spreadPercent, 4)}%</span>
          <span>({intervalH}h 주기)</span>
          <span>• 투자금 ${portfolio.toLocaleString()}</span>
        </div>

        <div style={{ flex: 1 }} />

        {/* 단리/복리 토글 */}
        <div style={{
          display: 'flex', background: 'var(--bg-accent)',
          borderRadius: 8, padding: 3, border: '1px solid var(--color-border)',
        }}>
          {(['단리', '복리'] as const).map((label, i) => {
            const active = compoundMode === (i === 1);
            return (
              <button key={label} onClick={() => setCompoundMode(i === 1)} style={{
                padding: '4px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: active ? (i === 1 ? 'rgba(139,92,246,0.25)' : 'rgba(16,185,129,0.2)') : 'transparent',
                color: active ? (i === 1 ? '#a78bfa' : '#10b981') : 'var(--color-text-muted)',
                transition: 'all 0.15s',
              }}>
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Projections Grid */}
      <div style={{ padding: '14px 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
          {TIME_PERIODS.map(({ key: periodKey, label }) => {
            const value = data[periodKey];
            const roi = (value / portfolio) * 100;
            const isNeg = value < 0;
            const profitColor = isNeg ? '#ef4444' : (compoundMode ? '#a78bfa' : '#10b981');
            const roiColor = isNeg ? '#fca5a5' : (compoundMode ? '#c4b5fd' : '#6ee7b7');

            return (
              <div key={periodKey} style={{
                padding: '12px 8px', borderRadius: 10, textAlign: 'center',
                background: 'rgba(15,22,35,0.5)',
                border: `1px solid ${isNeg ? 'rgba(239,68,68,0.2)' : (compoundMode ? 'rgba(139,92,246,0.15)' : 'rgba(16,185,129,0.15)')}`,
              }}>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4, fontWeight: 600 }}>
                  {label}
                </div>
                <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: profitColor, lineHeight: 1.2 }}>
                  {value >= 0 ? '+' : ''}{value >= 1000 ? `$${fmtNum(value, 0)}` : `$${fmtNum(value)}`}
                </div>
                <div className="mono" style={{ fontSize: 11, color: roiColor, marginTop: 3, fontWeight: 600 }}>
                  {roi >= 0 ? '+' : ''}{fmtNum(roi, roi >= 100 ? 1 : 3)}%
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer: 펀딩 수익 + 수수료 + 단리 vs 복리 비교 */}
        <div style={{
          marginTop: 10, padding: '6px 12px', borderRadius: 6,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 10, color: 'var(--color-text-muted)',
          background: 'rgba(255,255,255,0.02)',
        }}>
          <span>
            1회 펀딩: <span className="mono" style={{ color: '#10b981', fontWeight: 700 }}>${fmtNum(perFunding)}</span>
            {' '}/ 수수료(1회): <span className="mono" style={{ color: '#ef4444' }}>-${fmtNum(totalFees)}</span>
          </span>
          <span>
            단리 월: <span className="mono" style={{ color: '#10b981', fontWeight: compoundMode ? 400 : 700 }}>${fmtNum(simple.month)}</span>
            {' | '}복리 월: <span className="mono" style={{ color: '#a78bfa', fontWeight: compoundMode ? 700 : 400 }}>${fmtNum(compound.month)}</span>
            {compound.month > simple.month && (
              <span style={{ color: '#f59e0b', marginLeft: 4 }}>
                (+{fmtNum(((compound.month - simple.month) / Math.max(simple.month, 0.01)) * 100, 1)}%)
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
