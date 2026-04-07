'use client';

import { useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { fmtNum, fmtPctOrInfinity, fmtUsdOrInfinity, isInfiniteProfitDisplay } from '@/lib/format';
import { estimateProfit } from '@/lib/opportunities';
import { buildManagedOpportunityItems } from '@/lib/managedOpportunities';
import { MAX_ROUND_TRIP_IMPACT_BPS } from '@/lib/types';

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
  const {
    opportunities, strategyConfig, simulationMode,
    realSpreads, snipeTargets, snipeAllocations, simPositions, positions,
  } = useFundingStore();
  const [compoundMode, setCompoundMode] = useState(false);
  const resolveImpactPercent = useMemo(() => {
    return (rs?: { shortSlippage: number; longSlippage: number }) => {
      const measured = rs ? Math.max(0, (rs.shortSlippage ?? 0) + (rs.longSlippage ?? 0)) : 0;
      if (measured > 0) return measured;
      const snipeCfg = strategyConfig.confirmedSnipeConfig;
      return snipeCfg?.useImpactGuards
        ? ((snipeCfg.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 200)
        : ((snipeCfg?.targetImpactBps ?? 4) / 100);
    };
  }, [strategyConfig.confirmedSnipeConfig]);

  // 예약 + 활성 중인 코인 목록 → 기회 매핑
  const scheduledOpps = useMemo(() => {
    const managedItems = buildManagedOpportunityItems({
      opportunities,
      snipeTargets,
      snipeAllocations,
      activePositions: simulationMode ? simPositions : positions,
      simulationMode,
      defaultInvestmentUSDT: strategyConfig.investmentUSDT,
      leverage: strategyConfig.leverage,
      feeOverrides: strategyConfig.feeOverrides,
      paybackOverrides: strategyConfig.paybackOverrides,
      useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
      limit: 200,
    });

    return managedItems
      .filter((item) => item.status === 'scheduled' || item.status === 'active')
      .map((item) => {
        const rs = realSpreads[item.id] ?? realSpreads[item.asset];
        const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
        const investmentUSDT = item.investmentUSDT ?? strategyConfig.investmentUSDT;
        const intervalH = (item.opp.fundingIntervalMs ?? 8 * 3600000) / 3600000;
        const effectiveOpp = hasRS
          ? { ...item.opp, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread }
          : item.opp;
        const impactPercent = resolveImpactPercent(hasRS ? rs : undefined);
        const profit = estimateProfit(effectiveOpp, investmentUSDT, strategyConfig.leverage, {
          skipFees: false,
          feeOverrides: strategyConfig.feeOverrides,
          paybackOverrides: strategyConfig.paybackOverrides,
          useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
          entryImpactPercent: impactPercent,
          exitImpactPercent: impactPercent,
        });
        return { ...item, investmentUSDT, intervalH, netPerFunding: profit.netPerFunding };
      })
      .filter((item) => item.netPerFunding > 0);
  }, [opportunities, positions, realSpreads, simulationMode, simPositions, snipeAllocations, snipeTargets, strategyConfig.feeOverrides, strategyConfig.paybackOverrides, strategyConfig.confirmedSnipeConfig, strategyConfig.investmentUSDT, strategyConfig.leverage, resolveImpactPercent]);
  useMemo(() => {
    const modePrefix = simulationMode ? 'sim' : 'real';
    const activePositions = simulationMode ? simPositions : positions;
    const assets = new Set<string>();
    // snipeTargets에서 현재 모드 키 추출
    for (const key of Object.keys(snipeTargets)) {
      if (key.startsWith(`${modePrefix}:`)) {
        assets.add(key.slice(modePrefix.length + 1));
      }
    }
    // 활성 포지션
    for (const p of activePositions) assets.add(p.baseAsset);

    const result: { opp: typeof opportunities[0]; intervalH: number; netPerFunding: number }[] = [];
    for (const asset of assets) {
      const opp = opportunities.find(o => o.baseAsset === asset);
      if (!opp) continue;
      const rs = realSpreads[opp.id ?? ''] ?? realSpreads[asset];
      const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
      const intervalH = (opp.fundingIntervalMs ?? 8 * 3600000) / 3600000;
      const effectiveOpp = hasRS
        ? { ...opp, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread }
        : opp;
      const impactPercent = resolveImpactPercent(hasRS ? rs : undefined);
      const profit = estimateProfit(effectiveOpp, strategyConfig.investmentUSDT, strategyConfig.leverage, {
        skipFees: false,
        feeOverrides: strategyConfig.feeOverrides,
        paybackOverrides: strategyConfig.paybackOverrides,
        useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
        entryImpactPercent: impactPercent,
        exitImpactPercent: impactPercent,
      });
      if (profit.netPerFunding > 0) result.push({ opp, intervalH, netPerFunding: profit.netPerFunding });
    }
    return result;
  }, [opportunities, snipeTargets, simPositions, positions, simulationMode, realSpreads, strategyConfig.feeOverrides, strategyConfig.paybackOverrides, strategyConfig.confirmedSnipeConfig, strategyConfig.investmentUSDT, strategyConfig.leverage, resolveImpactPercent]);

  // 예약된 쌍이 있으면 합산 기준, 없으면 best 1개 기준
  const activePairs = scheduledOpps.length > 0 ? scheduledOpps : (() => {
    const best = opportunities[0];
    if (!best) return [];
    const rs = realSpreads[best.id ?? ''] ?? realSpreads[best.baseAsset];
    const hasRS = rs && Date.now() - rs.updatedAt < 30_000;
    const investmentUSDT = strategyConfig.investmentUSDT;
    const intervalH = (best.fundingIntervalMs ?? 8 * 3600000) / 3600000;
    const effectiveBest = hasRS
      ? { ...best, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread }
      : best;
    const impactPercent = resolveImpactPercent(hasRS ? rs : undefined);
    const profit = estimateProfit(effectiveBest, investmentUSDT, strategyConfig.leverage, {
      skipFees: false,
      feeOverrides: strategyConfig.feeOverrides,
      paybackOverrides: strategyConfig.paybackOverrides,
      useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
      entryImpactPercent: impactPercent,
      exitImpactPercent: impactPercent,
    });
    return [{ id: best.id, asset: best.baseAsset, opp: best, intervalH, netPerFunding: profit.netPerFunding, investmentUSDT }];
  })();

  const projection = useMemo(() => {
    if (activePairs.length === 0) return null;
    const numPairs = activePairs.length;
    const deployedCapital = activePairs.reduce(
      (sum, pair) => sum + ((pair.investmentUSDT ?? strategyConfig.investmentUSDT) * 2),
      0,
    );

    // 단리: 각 쌍의 시간당 수익 합산
    const totalSimple = (hours: number) =>
      activePairs.reduce((sum, p) => sum + p.netPerFunding * (hours / p.intervalH), 0);

    const simple: Record<PeriodKey, number> = {
      '1h': totalSimple(1),
      '4h': totalSimple(4),
      '8h': totalSimple(8),
      day: totalSimple(24),
      week: totalSimple(24 * 7),
      month: totalSimple(24 * 30),
      '3month': totalSimple(24 * 90),
      '6month': totalSimple(24 * 180),
    };

    // 복리: 각 쌍 독립적으로 이산 복리 → 합산
    const totalCompound = (hours: number) =>
      activePairs.reduce((sum, p) => {
        const pairCapital = (p.investmentUSDT ?? strategyConfig.investmentUSDT) * 2;
        const rate = p.netPerFunding / pairCapital;
        const totalFundings = hours / p.intervalH;
        const whole = Math.floor(totalFundings);
        const frac = totalFundings - whole;
        if (whole === 0) return sum + p.netPerFunding * frac;
        if (rate <= -1) return sum - pairCapital;
        const compPart = pairCapital * (Math.pow(1 + rate, whole) - 1);
        const grownCap = pairCapital + compPart;
        const fracPart = frac > 0 ? grownCap * rate * frac : 0;
        const raw = compPart + fracPart;
        if (!isFinite(raw)) return sum + pairCapital * 1e6;
        return sum + Math.max(-pairCapital, raw);
      }, 0);

    const compound: Record<PeriodKey, number> = {
      '1h': totalCompound(1),
      '4h': totalCompound(4),
      '8h': totalCompound(8),
      day: totalCompound(24),
      week: totalCompound(24 * 7),
      month: totalCompound(24 * 30),
      '3month': totalCompound(24 * 90),
      '6month': totalCompound(24 * 180),
    };

    // 헤더 표시용: 총 펀딩 수익 / 총 수수료
    const totalPerFunding = activePairs.reduce((s, p) => s + p.netPerFunding, 0);
    const bestItem = activePairs[0];
    const best = bestItem.opp;
    const rs = realSpreads[bestItem.id] ?? realSpreads[best.baseAsset];
    const hasRealSpread = rs && Date.now() - rs.updatedAt < 30_000;
    const displaySpreadPercent = hasRealSpread ? rs.effectiveSpread : best.spreadPercent;

    return {
      best, simple, compound, numPairs, deployedCapital,
      totalPerFunding, displaySpreadPercent, hasRealSpread,
    };
  }, [activePairs, realSpreads, strategyConfig.investmentUSDT]);

  if (!projection) return null;

  const { best, simple, compound, numPairs, deployedCapital, totalPerFunding, displaySpreadPercent, hasRealSpread } = projection;
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

        {/* Active pairs info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--color-text-muted)', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, color: '#10b981' }}>{numPairs}쌍 예약</span>
          <span>• 베스트: <strong style={{ color: 'var(--color-text)' }}>{best.baseAsset}</strong> +{fmtNum(displaySpreadPercent, 4)}%{hasRealSpread ? ' (실측)' : ''}</span>
          <span>• 투입 <strong style={{ color: '#a78bfa' }}>${deployedCapital.toLocaleString()}</strong> ({numPairs}쌍)</span>
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
            const roi = (value / deployedCapital) * 100;
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
                  {fmtUsdOrInfinity(value, value >= 1000 ? 0 : 2)}
                </div>
                <div className="mono" style={{ fontSize: 11, color: roiColor, marginTop: 3, fontWeight: 600 }}>
                  {fmtPctOrInfinity(roi, roi >= 100 ? 1 : 3, { forceInfinity: isInfiniteProfitDisplay(value) })}
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
            {numPairs}쌍 합산 순수익/사이클: <span className="mono" style={{ color: '#10b981', fontWeight: 700 }}>{fmtUsdOrInfinity(totalPerFunding, 2, { showPlus: false })}</span>
          </span>
          <span>
            단리 월: <span className="mono" style={{ color: '#10b981', fontWeight: compoundMode ? 400 : 700 }}>{fmtUsdOrInfinity(simple.month, 2, { showPlus: false })}</span>
            {' | '}복리 월: <span className="mono" style={{ color: '#a78bfa', fontWeight: compoundMode ? 700 : 400 }}>{fmtUsdOrInfinity(compound.month, 2, { showPlus: false })}</span>
            {compound.month > simple.month && (
              <span style={{ color: '#f59e0b', marginLeft: 4 }}>
                ({fmtPctOrInfinity(((compound.month - simple.month) / Math.max(simple.month, 0.01)) * 100, 1, { forceInfinity: isInfiniteProfitDisplay(compound.month) || isInfiniteProfitDisplay(simple.month) })})
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
