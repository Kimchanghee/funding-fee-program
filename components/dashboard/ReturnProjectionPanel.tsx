'use client';

import { useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { fmtNum } from '@/lib/format';
import { getHedgeFees } from '@/lib/types';

const TIME_PERIODS = [
  { key: '1h', label: '1시간' },
  { key: '4h', label: '4시간' },
  { key: '8h', label: '8시간' },
  { key: 'day', label: '하루' },
  { key: 'week', label: '일주일' },
  { key: 'month', label: '1개월' },
  { key: '3month', label: '3개월' },
  { key: '6month', label: '6개월' },
] as const;

type PeriodKey = typeof TIME_PERIODS[number]['key'];

export default function ReturnProjectionPanel() {
  const { opportunities, strategyConfig, enabledExchanges, simulationMode, simSnipeActive, realSnipeActive, simSnipeStartCapital, realSnipeStartCapital, realSpreads } = useFundingStore();
  const snipeActive = simulationMode ? simSnipeActive : realSnipeActive;
  const snipeStartCapital = simulationMode ? simSnipeStartCapital : realSnipeStartCapital;
  const [compoundMode, setCompoundMode] = useState(false);

  // 총 투입 자본 = 거래소 수 × 포지션당 투자금 × 2 (롱+숏)
  const totalCapital = strategyConfig.investmentUSDT * 2 * enabledExchanges.length;
  // 자동투자 ON 상태면 ON 시점 자본 기준, 아니면 현재 설정 기준
  const portfolio = (snipeActive && snipeStartCapital > 0) ? snipeStartCapital : totalCapital;

  // 1쌍 기준 투입 자본 (롱+숏 양쪽 마진)
  const pairCapital = strategyConfig.investmentUSDT * 2;

  const projection = useMemo(() => {
    const best = opportunities[0];
    if (!best) return null;

    const notional = strategyConfig.investmentUSDT * strategyConfig.leverage;

    // 오더북 실측 스프레드가 있으면 사용 (슬리피지 반영), 없으면 이론값
    const rs = realSpreads[best.baseAsset];
    const hasRealSpread = rs && Date.now() - rs.updatedAt < 30_000;
    const effectiveSpread = hasRealSpread ? rs.effectiveSpread / 100 : best.spread;
    // realSpread는 슬리피지(수수료 포함) 반영 완료 → 추가 수수료 불필요
    const roundTripFee = hasRealSpread ? 0 : getHedgeFees(best.shortExchange, best.longExchange, 'taker');

    const perFunding = notional * effectiveSpread;
    const feesPerCycle = notional * roundTripFee;
    const netPerFunding = perFunding - feesPerCycle;

    const intervalMs = best.fundingIntervalMs ?? 8 * 3600000;
    const intervalH = intervalMs / 3600000;
    // 단리: 매 사이클마다 수수료 차감된 순수익 × 기간 내 펀딩 횟수
    const simpleCalc = (hours: number) => netPerFunding * (hours / intervalH);
    const simple: Record<PeriodKey, number> = {
      '1h': simpleCalc(1),
      '4h': simpleCalc(4),
      '8h': simpleCalc(8),
      day: simpleCalc(24),
      week: simpleCalc(24 * 7),
      month: simpleCalc(24 * 30),
      '3month': simpleCalc(24 * 90),
      '6month': simpleCalc(24 * 180),
    };

    // 복리: 1쌍 투입자본 기준 이산 복리 (펀딩 주기 단위로만 복리 적용)
    // — 1회 펀딩 수익률 = netPerFunding / pairCapital
    // — n회 복리 수익 = pairCapital × ((1 + r)^n - 1)
    // — 펀딩 주기 미만 시간은 단리로 프로레이트 (부분 복리 불가)
    const netRatePerFunding = netPerFunding / pairCapital;
    const compoundCalc = (hours: number) => {
      const totalFundings = hours / intervalH;
      const wholeFundings = Math.floor(totalFundings);
      const remainder = totalFundings - wholeFundings;

      if (wholeFundings === 0) {
        // 1회 펀딩 미만 → 단리 프로레이트
        return netPerFunding * remainder;
      }

      if (netRatePerFunding <= -1) return -pairCapital;
      const compoundPart = pairCapital * (Math.pow(1 + netRatePerFunding, wholeFundings) - 1);
      // 나머지 시간은 복리 후 자본 기준 단리
      const grownCapital = pairCapital + compoundPart;
      const remainderPart = remainder > 0 ? grownCapital * netRatePerFunding * remainder : 0;
      const raw = compoundPart + remainderPart;

      if (!isFinite(raw)) return pairCapital * 1e6;
      return Math.max(-pairCapital, raw);
    };
    const compound: Record<PeriodKey, number> = {
      '1h': compoundCalc(1),
      '4h': compoundCalc(4),
      '8h': compoundCalc(8),
      day: compoundCalc(24),
      week: compoundCalc(24 * 7),
      month: compoundCalc(24 * 30),
      '3month': compoundCalc(24 * 90),
      '6month': compoundCalc(24 * 180),
    };

    const displaySpreadPercent = hasRealSpread ? rs.effectiveSpread : best.spreadPercent;
    return { best, simple, compound, perFunding, totalFees: feesPerCycle, intervalH, displaySpreadPercent, hasRealSpread };
  }, [opportunities, strategyConfig.investmentUSDT, strategyConfig.leverage, pairCapital, realSpreads]);

  if (!projection) return null;

  const { best, simple, compound, perFunding, totalFees, intervalH, displaySpreadPercent, hasRealSpread } = projection;
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
          <span className="mono" style={{ fontWeight: 800, color: '#10b981' }}>+{fmtNum(displaySpreadPercent, 4)}%{hasRealSpread ? ' (실측)' : ''}</span>
          <span>({intervalH}h 주기)</span>
          <span>• 1쌍 투입 ${pairCapital.toLocaleString()} (총 ${portfolio.toLocaleString()})</span>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 8 }}>
          {TIME_PERIODS.map(({ key: periodKey, label }) => {
            const value = data[periodKey];
            const roi = (value / pairCapital) * 100;
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
