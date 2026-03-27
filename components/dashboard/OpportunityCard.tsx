'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Zap, Crosshair, Check, Clock, TrendingDown, TrendingUp, ChevronDown, ChevronUp, Settings } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId, type ArbitrageOpportunity, type Position, type SimPosition, type FeeOverrides } from '@/lib/types';
import { estimateProfit } from '@/lib/opportunities';
import { fmtNum, fmtPctOrInfinity, fmtUsdOrInfinity, isInfiniteProfitDisplay } from '@/lib/format';
import { buildManagedOpportunityItems, type ManagedOpportunityItem } from '@/lib/managedOpportunities';

/* ─── Tiny countdown hook ─── */
function useCountdown(targetMs: number) {
  const [remaining, setRemaining] = useState(() => Math.max(0, targetMs - Date.now()));
  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, targetMs - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetMs]);
  const totalSec = Math.floor(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { remaining, text: `${pad(h)}:${pad(m)}:${pad(s)}`, totalSec, expired: totalSec === 0 && targetMs > 0 };
}

/* ─── Mini exchange badge ─── */
function ExBadge({ ex, size = 'sm' }: { ex: ExchangeId; size?: 'sm' | 'xs' }) {
  const color = EXCHANGE_COLORS[ex] || '#94a3b8';
  const name = EXCHANGE_NAMES[ex] || ex.toUpperCase();
  const fontSize = size === 'xs' ? 9 : 10;
  const pad = size === 'xs' ? '1px 5px' : '2px 7px';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: pad, borderRadius: 4, fontSize, fontWeight: 700,
      background: `${color}22`, color, border: `1px solid ${color}33`,
      letterSpacing: '0.05em', lineHeight: 1.2,
    }}>
      {name}
    </span>
  );
}

/* ─── Inline countdown for each row ─── */
function InlineCountdown({ targetMs }: { targetMs: number }) {
  const { text, totalSec, expired } = useCountdown(targetMs);
  const urgent = !expired && totalSec < 300;
  if (targetMs === 0) return <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>—</span>;
  if (expired) return <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>정산 중...</span>;
  return (
    <span className="mono" style={{
      fontSize: 13, fontWeight: 700,
      color: urgent ? '#ef4444' : '#10b981',
      animation: urgent ? 'blink 1s step-end infinite' : 'none',
    }}>
      {text}
    </span>
  );
}

/* ─── Next trade hero countdown ─── */
function NextTradeCountdown({ targetMs, asset, shortEx, longEx }: {
  targetMs: number; asset: string; shortEx: ExchangeId; longEx?: ExchangeId;
}) {
  const { text, totalSec, expired } = useCountdown(targetMs);
  const urgent = !expired && totalSec < 300;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      padding: '16px 24px', borderRadius: 14,
      background: urgent
        ? 'linear-gradient(135deg, rgba(239,68,68,0.12), rgba(239,68,68,0.04))'
        : 'linear-gradient(135deg, rgba(16,185,129,0.10), rgba(59,130,246,0.06))',
      border: `1px solid ${urgent ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.2)'}`,
      minWidth: 200,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Clock size={13} color={urgent ? '#ef4444' : '#10b981'} />
        <span style={{ fontSize: 11, color: urgent ? '#ef4444' : 'var(--color-text-muted)', fontWeight: 600 }}>
          다음 거래까지
        </span>
      </div>
      {expired ? (
        <span style={{ fontSize: 28, fontWeight: 800, color: '#f59e0b' }}>정산 중...</span>
      ) : (
        <span className="mono" style={{
          fontSize: 36, fontWeight: 900, letterSpacing: '0.04em',
          color: urgent ? '#ef4444' : '#10b981',
          animation: urgent ? 'blink 1s step-end infinite' : 'none',
          lineHeight: 1,
        }}>
          {text}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-text)' }}>{asset}</span>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          <ExBadge ex={shortEx} size="xs" />
          {longEx && (
            <>
              <span style={{ margin: '0 3px', opacity: 0.5 }}>⇄</span>
              <ExBadge ex={longEx} size="xs" />
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   Main Component
   ════════════════════════════════════════════════ */
export default function OpportunityCard() {
  const {
    opportunities, strategyConfig, setShowStrategyPanel,
    apiConfigs, simulationMode, simPositions,
    simSnipeActive, realSnipeActive,
    snipeTargets, snipeAllocations, cancelSnipe,
    closeSimPosition, ratesStatus, ratesError, isLoadingRates,
    lastRatesUpdate, strategyRunning, realSpreads,
    simBalances, balances, fundingRates,
  } = useFundingStore();

  const snipeActive = simulationMode ? simSnipeActive : realSnipeActive;

  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'snipe' | 'error' } | null>(null);
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const [compoundMode, setCompoundMode] = useState(true);
  const isProcessing = strategyRunning;

  const positions = useFundingStore(s => s.positions);
  const isRunning = simulationMode ? simPositions.length > 0 : positions.length > 0;

  // Toast auto-dismiss
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  // ── Handlers ──
  const closeRealPosition = useFundingStore(s => s.closePosition);
  const handleToggle = useCallback(async () => {
    if (!isRunning || isProcessing) return;
    if (simulationMode) {
      const ids = simPositions.map(p => p.simId);
      for (const id of ids) await closeSimPosition(id);
    } else if (positions.length > 0) {
      const results = await Promise.allSettled(positions.map(p => closeRealPosition(p)));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        setToastMsg({ text: `${positions.length - failed}개 청산 완료, ${failed}개 실패`, type: 'error' });
        return;
      }
    }
    if (snipeActive) {
      if (simulationMode) {
        try {
          const res = await fetch('/api/sim-scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          setToastMsg({ text: `[SIM] 서버 시뮬 스케줄러 중지 실패: ${(err as Error).message}`, type: 'error' });
          return;
        }
      }
      cancelSnipe(simulationMode ? 'sim' : 'real');
      // 서버에 비활성 상태 저장 (모든 기기 동기화)
      try {
        await fetch('/api/snipe-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(simulationMode ? { simSnipeActive: false } : { realSnipeActive: false }),
        });
      } catch { /* silent */ }
    }
    setToastMsg({ text: '전체 포지션 청산 완료', type: 'success' });
  }, [isProcessing, isRunning, simulationMode, simPositions, closeSimPosition, snipeActive, cancelSnipe, positions, closeRealPosition]);

  const handleSnipe = useCallback(async () => {
    if (snipeActive) {
      // ── 정지 ──
      if (!simulationMode) {
        // REAL: 서버 스케줄러 정지를 먼저 확인 → 성공 후에만 상태 갱신
        try {
          const res = await fetch('/api/scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          setToastMsg({ text: `[REAL] 서버 스케줄러 정지 실패 — 재시도 필요: ${(err as Error).message}`, type: 'error' });
          return; // 서버 스케줄러가 멈추지 않았으면 상태를 OFF로 바꾸지 않음
        }
      } else {
        try {
          const res = await fetch('/api/sim-scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          setToastMsg({ text: `[SIM] 서버 시뮬 스케줄러 중지 실패: ${(err as Error).message}`, type: 'error' });
          return;
        }
      }
      cancelSnipe(simulationMode ? 'sim' : 'real');
      // cancelSnipe 내부에서 /api/snipe-state + /api/scheduler stop 호출하지만,
      // REAL은 이미 위에서 확인 완료. snipe-state만 추가 저장.
      try {
        await fetch('/api/snipe-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(simulationMode ? { simSnipeActive: false } : { realSnipeActive: false }),
        });
      } catch { /* snipe-state 저장 실패는 비치명적 */ }
      setToastMsg({ text: `${simulationMode ? '[SIM]' : '[REAL]'} 자동 투자 중지됨`, type: 'success' });
    } else {
      // ── 시작 ──
      const state = useFundingStore.getState();
      const totalCapital = state.strategyConfig.investmentUSDT * 2 * state.enabledExchanges.length;

      if (!simulationMode) {
        // REAL: 서버 스케줄러 시작을 먼저 확인 → 성공 후에만 상태를 ON으로
        try {
          const res = await fetch('/api/scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'start',
              config: {
                investmentUSDT: state.strategyConfig.investmentUSDT,
                leverage: state.strategyConfig.leverage,
                minSpreadPercent: state.strategyConfig.minSpreadPercent,
                enabledExchanges: state.enabledExchanges,
                maxConcurrentPairs: 5,
                feeOverrides: state.strategyConfig.feeOverrides,
                timingConfig: state.strategyConfig.timingConfig,
              },
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json() as { success?: boolean; error?: string };
          if (!json.success) throw new Error(json.error || 'scheduler start failed');
        } catch (err) {
          setToastMsg({ text: `[REAL] 서버 스케줄러 시작 실패: ${(err as Error).message}`, type: 'error' });
          return; // 서버 스케줄러가 안 떴으면 상태를 ON으로 바꾸지 않음
        }
        useFundingStore.setState({ realSnipeActive: true, realSnipeStartCapital: totalCapital });
        await fetch('/api/snipe-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ realSnipeActive: true }),
        }).catch(() => {});
        setToastMsg({ text: '[REAL] 스나이핑 시작! (서버 백그라운드 ON)', type: 'success' });
      } else {
        // SIM: 클라이언트 타이머 기반
        try {
          const res = await fetch('/api/sim-scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'start',
              config: {
                investmentUSDT: state.strategyConfig.investmentUSDT,
                leverage: state.strategyConfig.leverage,
                minSpreadPercent: state.strategyConfig.minSpreadPercent,
                compoundInvesting: state.strategyConfig.compoundInvesting,
                enabledExchanges: state.enabledExchanges,
                feeOverrides: state.strategyConfig.feeOverrides,
                timingConfig: state.strategyConfig.timingConfig,
              },
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json() as {
            success?: boolean;
            error?: string;
            status?: {
              snipeTargets?: Record<string, number>;
              snipeAllocations?: Record<string, number>;
            };
          };
          if (!json.success) throw new Error(json.error || 'sim scheduler start failed');
          useFundingStore.setState({
            simSnipeActive: true,
            simSnipeStartCapital: totalCapital,
            snipeTargets: {
              ...Object.fromEntries(
                Object.entries(useFundingStore.getState().snipeTargets).filter(([key]) => !key.startsWith('sim:')),
              ),
              ...(json.status?.snipeTargets ?? {}),
            },
            snipeAllocations: {
              ...Object.fromEntries(
                Object.entries(useFundingStore.getState().snipeAllocations).filter(([key]) => !key.startsWith('sim:')),
              ),
              ...(json.status?.snipeAllocations ?? {}),
            },
          });
        } catch (err) {
          setToastMsg({ text: `[SIM] 서버 시뮬 스케줄러 시작 실패: ${(err as Error).message}`, type: 'error' });
          return;
        }
        await fetch('/api/snipe-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ simSnipeActive: true }),
        }).catch(() => {});
        const count = Object.keys(useFundingStore.getState().snipeTargets).filter((key) => key.startsWith('sim:')).length;
        setToastMsg({ text: `[SIM] 스나이핑 시작! ${count}개 코인 예약`, type: 'success' });
      }
    }
  }, [snipeActive, simulationMode, cancelSnipe]);

  // ── Portfolio ──

  const perExchangeInvestment = strategyConfig.investmentUSDT;
  const best = opportunities[0];
  const hasShortConfig = best ? !!apiConfigs[best.shortExchange] : false;
  const hasLongConfig = best ? !!apiConfigs[best.longExchange] : false;
  const canExecute = simulationMode ? true : hasShortConfig && hasLongConfig;

  // ── Build scheduled list: snipe targets + active positions mapped to opportunities ──
  // ★ realSpreads 포함: 거래소 간 가격 괴리가 큰 항목은 memo 단계에서 즉시 제거
  const scheduledCoins = useMemo(
    () => {
      const items = buildManagedOpportunityItems({
        opportunities,
        snipeTargets,
        snipeAllocations,
        activePositions: (simulationMode ? simPositions : positions) as Array<Position | SimPosition>,
        simulationMode,
        defaultInvestmentUSDT: strategyConfig.investmentUSDT,
        limit: 15,
      });
      // realSpread 기반 필터: 실질 수익이 마이너스면 예약/후보 숨김
      return items.filter(item => {
        if (item.status === 'active') return true;
        const rs = realSpreads[item.id] ?? realSpreads[item.asset];
        if (!rs) return true; // realSpread 없으면 명목 스프레드 기준 (이미 netProfit>0 통과)
        // effectiveSpread로 실질 수익 직접 계산
        const perSide = item.investmentUSDT ?? strategyConfig.investmentUSDT;
        const notional = perSide * strategyConfig.leverage;
        const netPerFunding = notional * (rs.effectiveSpread / 100);
        return netPerFunding > 0;
      });
    },
    [
      opportunities,
      positions,
      simulationMode,
      simPositions,
      snipeAllocations,
      snipeTargets,
      strategyConfig.investmentUSDT,
      realSpreads,
    ],
  );

  // Nearest upcoming trade — 예약/활성 중 가장 빠른 것 (수익 무관)
  const nextTrade = useMemo(() => {
    const scheduled = scheduledCoins.filter(c => c.status === 'scheduled' || c.status === 'active');
    if (scheduled.length === 0) return null;
    return scheduled.reduce((a, b) => a.fundingTime < b.fundingTime ? a : b);
  }, [scheduledCoins]);

  // Status banner
  const statusMsg = !best
    ? ((isLoadingRates || ratesStatus === 'loading') && !lastRatesUpdate) ? '펀딩률 데이터 조회 중...'
      : (ratesStatus === 'error' && !lastRatesUpdate) ? `조회 실패 — ${ratesError || '자동 재시도 중'}`
      : lastRatesUpdate ? '유효한 헷징 기회 없음 — 스프레드 기준 미달'
      : '펀딩률 데이터 조회 중...'
    : null;

  // 실제 표시되는 항목 기준 카운트 (음수 수익으로 숨겨진 예약은 제외)
  const scheduledCount = scheduledCoins.filter(c => c.status === 'scheduled').length;
  const activeCount = scheduledCoins.filter(c => c.status === 'active').length;
  const candidateCount = scheduledCoins.filter(c => c.status === 'opportunity').length;

  // 펀딩 주기별 현황 (1h, 4h, 8h) — 예약+활성 vs 전체 펀딩 가능 코인 수
  const intervalStats = useMemo(() => {
    const buckets: Record<string, { scheduled: number; total: number; assets: string[] }> = {
      '1h': { scheduled: 0, total: 0, assets: [] },
      '4h': { scheduled: 0, total: 0, assets: [] },
      '8h': { scheduled: 0, total: 0, assets: [] },
    };
    // 전체 코인 수 (fundingRates에서 고유 baseAsset 기준)
    const seenByInterval = new Set<string>();
    for (const rate of fundingRates) {
      const key2 = `${rate.baseAsset}:${rate.intervalHours <= 1 ? '1h' : rate.intervalHours <= 4 ? '4h' : '8h'}`;
      if (seenByInterval.has(key2)) continue;
      seenByInterval.add(key2);
      const iKey = rate.intervalHours <= 1 ? '1h' : rate.intervalHours <= 4 ? '4h' : '8h';
      buckets[iKey].total++;
    }
    // 예약 + 활성 카운트
    for (const item of scheduledCoins) {
      if (item.status === 'opportunity') continue;
      const h = item.opp.fundingIntervalMs ? Math.round(item.opp.fundingIntervalMs / 3600000) : 8;
      const key = h <= 1 ? '1h' : h <= 4 ? '4h' : '8h';
      buckets[key].scheduled++;
      buckets[key].assets.push(item.asset);
    }
    return buckets;
  }, [scheduledCoins, fundingRates]);

  return (
    <>
      {/* Toast */}
      {toastMsg && (
        <div className={`toast toast-${toastMsg.type}`}>
          {toastMsg.type === 'success' ? <Check size={16} /> : toastMsg.type === 'error' ? <Zap size={16} /> : <Crosshair size={16} />}
          {toastMsg.text}
        </div>
      )}

      <div className="glass-card opportunity-glow" style={{
        padding: '20px 24px',
        background: 'linear-gradient(135deg, rgba(16,185,129,0.04), rgba(15,22,35,1) 60%)',
        borderColor: 'rgba(16,185,129,0.2)',
      }}>

        {/* ═══ SECTION 1: Status Bar + Next Trade ═══ */}
        <div className="opp-hero-section" style={{
          display: 'flex', alignItems: 'stretch', gap: 16, marginBottom: 16,
          flexWrap: 'wrap',
        }}>
          {/* Next Trade Countdown */}
          {nextTrade ? (
            <NextTradeCountdown
              targetMs={nextTrade.fundingTime}
              asset={nextTrade.asset}
              shortEx={nextTrade.opp.shortExchange}
              longEx={nextTrade.opp.longExchange}
            />
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 4, padding: '16px 24px', borderRadius: 14,
              background: 'linear-gradient(135deg, rgba(100,116,139,0.08), rgba(100,116,139,0.03))',
              border: '1px solid rgba(100,116,139,0.2)', minWidth: 200,
            }}>
              <Clock size={13} color="var(--color-text-muted)" />
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>예약된 거래 없음</span>
            </div>
          )}

          {/* Quick Stats */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, minWidth: 180 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <StatPill label="예약/기회" value={`${scheduledCount + activeCount} / ${opportunities.length}`} color="#3b82f6" active={scheduledCount + activeCount > 0} />
              <StatPill label="활성" value={`${activeCount}개`} color="#f59e0b" active={activeCount > 0} />
              <StatPill label="예약" value={`${scheduledCount}개`} color="#10b981" active={scheduledCount > 0} />
              <StatPill label="후보" value={`${candidateCount}개`} color="#64748b" active={candidateCount > 0} />
            </div>
            {/* Config summary */}
            <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--color-text-muted)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{
                color: '#3b82f6',
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: 4,
                background: 'rgba(59,130,246,0.15)',
                fontSize: 10,
              }}>
                헷징
              </span>
              <span>포지션당 <strong style={{ color: 'var(--color-text)' }}>${perExchangeInvestment.toLocaleString()}</strong></span>
              <span>거래소당 <strong style={{ color: '#f59e0b' }}>${(perExchangeInvestment * 2).toLocaleString()}</strong> <span style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>(롱+숏)</span></span>
              <span>레버리지 <strong style={{ color: 'var(--color-text)' }}>{strategyConfig.leverage}x</strong></span>
              <span style={{ color: strategyConfig.compoundInvesting ? '#a78bfa' : '#10b981', fontWeight: 700 }}>
                {strategyConfig.compoundInvesting ? '복리' : '단리'}
              </span>
              <button
                onClick={() => setShowStrategyPanel(true)}
                style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 11, padding: 0, display: 'flex', alignItems: 'center', gap: 2 }}
              >
                <Settings size={11} /> 수정
              </button>
            </div>
          </div>

          {/* Action Button */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, minWidth: 180 }}>
            {isRunning ? (
              <button
                className="btn btn-danger"
                style={{
                  padding: '12px 20px', fontSize: 13, fontWeight: 800, borderRadius: 10,
                  opacity: isProcessing ? 0.5 : 1,
                  cursor: isProcessing ? 'not-allowed' : 'pointer',
                  background: 'linear-gradient(135deg, #f59e0b, #f97316)',
                  border: '2px solid #fbbf24',
                  boxShadow: '0 0 12px rgba(245,158,11,0.3)',
                  animation: 'pulse-glow 2s ease-in-out infinite',
                  display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                }}
                disabled={isProcessing}
                onClick={handleToggle}
              >
                {isProcessing ? (
                  <>
                    <div style={{ width: 14, height: 14, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                    처리 중...
                  </>
                ) : (
                  <>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff', boxShadow: '0 0 6px #fff', animation: 'blink 1.5s ease-in-out infinite' }} />
                    {simulationMode ? '[SIM] ' : ''}실행 중 ({activeCount}개) — 청산
                  </>
                )}
              </button>
            ) : (
              <button
                className={`btn ${snipeActive ? 'snipe-scheduled' : ''}`}
                style={{
                  padding: '12px 20px', fontSize: 13, fontWeight: 800, borderRadius: 10,
                  cursor: (!canExecute || !best) ? 'not-allowed' : 'pointer',
                  opacity: (!canExecute || !best) ? 0.5 : 1,
                  background: snipeActive
                    ? 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(16,185,129,0.08))'
                    : 'linear-gradient(135deg, #10b981, #059669)',
                  border: `1px solid ${snipeActive ? 'rgba(16,185,129,0.5)' : 'rgba(16,185,129,0.5)'}`,
                  color: snipeActive ? '#10b981' : '#fff',
                  display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                }}
                disabled={!canExecute || !best}
                onClick={handleSnipe}
              >
                {snipeActive ? (
                  <>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px #10b981', animation: 'blink 1.5s ease-in-out infinite' }} />
                    {simulationMode ? '[SIM] ' : ''}자동 투자 ON — 끄기
                  </>
                ) : (
                  <>
                    <Crosshair size={14} />
                    {simulationMode ? '[SIM] ' : ''}자동 투자 시작
                  </>
                )}
              </button>
            )}
            {!canExecute && !isRunning && !simulationMode && best && (
              <div style={{ fontSize: 10, color: 'var(--color-warning)', textAlign: 'center' }}>
                {`${!hasShortConfig ? best.shortExchange.toUpperCase() : best.longExchange.toUpperCase()} API 키 필요`}
              </div>
            )}
          </div>
        </div>

        {/* Status banner */}
        {statusMsg && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '8px 16px', marginBottom: 12, borderRadius: 8,
            background: ratesStatus === 'error' && !lastRatesUpdate ? 'rgba(239,68,68,0.08)' : 'rgba(59,130,246,0.08)',
            border: `1px solid ${ratesStatus === 'error' && !lastRatesUpdate ? 'rgba(239,68,68,0.2)' : 'rgba(59,130,246,0.2)'}`,
          }}>
            {(!lastRatesUpdate && ratesStatus !== 'error') && (
              <div style={{ width: 14, height: 14, border: '2px solid var(--color-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
            )}
            <span style={{ fontSize: 12, color: ratesStatus === 'error' && !lastRatesUpdate ? '#ef4444' : 'var(--color-text-muted)' }}>
              {statusMsg}
            </span>
          </div>
        )}

        {/* ═══ Funding Interval Dashboard ═══ */}
        {snipeActive && (
          <div style={{
            display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap',
          }}>
            {(['1h', '4h', '8h'] as const).map(interval => {
              const stat = intervalStats[interval];
              const hasItems = stat.scheduled > 0;
              const colorMap = { '1h': '#06b6d4', '4h': '#8b5cf6', '8h': '#64748b' };
              const color = colorMap[interval];
              return (
                <div key={interval} style={{
                  flex: 1, minWidth: 120, padding: '8px 12px', borderRadius: 10,
                  background: hasItems ? `${color}0d` : 'rgba(100,116,139,0.04)',
                  border: `1px solid ${hasItems ? `${color}33` : 'rgba(100,116,139,0.12)'}`,
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 800, color,
                      padding: '1px 6px', borderRadius: 4,
                      background: `${color}1a`,
                    }}>
                      {interval}
                    </span>
                    <span style={{
                      fontSize: 18, fontWeight: 900, lineHeight: 1,
                      color: hasItems ? color : 'var(--color-text-muted)',
                    }}>
                      {stat.scheduled} <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.5 }}>/</span> <span style={{ fontSize: 13, fontWeight: 700, opacity: 0.6 }}>{stat.total}</span>
                    </span>
                  </div>
                  {hasItems ? (
                    <div style={{ fontSize: 10, color, opacity: 0.8, lineHeight: 1.4 }}>
                      {stat.assets.join(', ')}
                    </div>
                  ) : (
                    <div style={{ fontSize: 10, color: 'var(--color-text-muted)', opacity: 0.5 }}>
                      {stat.total > 0 ? `${stat.total}개 기회 중 예약 없음` : '해당 주기 기회 없음'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ═══ SECTION 2: Scheduled/Candidate Table ═══ */}
        {scheduledCoins.length > 0 && (
          <div style={{ marginBottom: 0 }}>
            {scheduledCount === 0 && activeCount === 0 && candidateCount > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '8px 12px', marginBottom: 10, borderRadius: 8,
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.18)',
                fontSize: 11, color: '#fbbf24',
              }}>
                <strong>예약됨</strong> = 펀딩 시간에 자동 진입 예정 (7초 전 스나이프) &nbsp;|&nbsp;
                <strong>실행 중</strong> = 현재 포지션 보유 중 &nbsp;|&nbsp;
                <strong>후보</strong> = 수익성 높은 기회 목록 (자동 투자 ON 시 다음 사이클에 예약 가능)
              </div>
            )}
            {/* Table Header */}
            <div className="opp-table-header" style={{
              display: 'grid',
              gridTemplateColumns: '32px 70px 1fr 80px 80px 90px 80px 60px 80px',
              gap: 8, padding: '6px 10px', marginBottom: 4,
              fontSize: 10, fontWeight: 600, color: 'var(--color-text-muted)',
              borderBottom: '1px solid var(--color-border)',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              <span className="opp-hide-mobile">#</span>
              <span>상태</span>
              <span>코인</span>
              <span className="opp-hide-mobile" style={{ textAlign: 'center' }}>숏</span>
              <span className="opp-hide-mobile" style={{ textAlign: 'center' }}>롱</span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>예상 투자금</span>
              <span style={{ textAlign: 'right' }}>예상 수익</span>
              <span style={{ textAlign: 'right' }}>수익률</span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>펀딩까지</span>
            </div>

            {/* Rows — 15행 고정 높이로 레이아웃 안정화 */}
            <div style={{ minHeight: 15 * 42 }}>
            {(() => {
              let visibleIdx = 0;
              // 순차적 잔고 추적: 이전 기회의 마진 사용을 반영
              const remainingBal: Record<string, number> = {};
              if (strategyConfig.compoundInvesting) {
                const allExchanges = simulationMode
                  ? Object.keys(simBalances) as ExchangeId[]
                  : Object.keys(balances) as ExchangeId[];
                for (const ex of allExchanges) {
                  remainingBal[ex] = simulationMode
                    ? (simBalances[ex] ?? 0)
                    : (balances[ex]?.availableUSDT ?? 0);
                  // 활성 포지션의 locked margin 차감
                  const locked = (simulationMode ? simPositions : positions)
                    .filter(p => p.exchange === ex).reduce((s, p) => s + p.margin, 0);
                  remainingBal[ex] = Math.max(0, remainingBal[ex] - locked);
                }
              }
              // 펀딩 시간대별 자금 복귀 추적: 이전 시간대 스나이프 완료 → 자금 반환
              let lastFundingWindow = 0; // 현재 처리 중인 펀딩 시간 윈도우
              const pendingReturns: { exchange: string; amount: number; fundingTime: number }[] = [];

              return scheduledCoins.map((item) => {
              const isExpanded = expandedAsset === item.id;
              const realSpread = realSpreads[item.id] ?? realSpreads[item.asset];
              const effectiveOpp: ArbitrageOpportunity = realSpread
                ? { ...item.opp, spread: realSpread.effectiveSpread / 100, spreadPercent: realSpread.effectiveSpread }
                : item.opp;

              // 순차 잔고 기반 투자금 계산 (복리: 이전 기회 마진 소진 반영)
              let itemPerSide = item.investmentUSDT ?? perExchangeInvestment;
              if (strategyConfig.compoundInvesting) {
                // 새 펀딩 시간대로 넘어갈 때: 이전 시간대 스나이프 자금 복귀 반영
                const currentWindow = item.fundingTime;
                if (lastFundingWindow > 0 && currentWindow - lastFundingWindow > 120_000) {
                  // 현재 시간대보다 이전에 완료될 스나이프의 자금 복귀
                  for (const ret of pendingReturns) {
                    if (ret.fundingTime < currentWindow - 60_000) { // 1분 마진
                      remainingBal[ret.exchange] = (remainingBal[ret.exchange] ?? 0) + ret.amount;
                    }
                  }
                  // 복귀 완료된 항목 제거
                  const keepIdx = pendingReturns.findIndex(r => r.fundingTime >= currentWindow - 60_000);
                  if (keepIdx > 0) pendingReturns.splice(0, keepIdx);
                }
                lastFundingWindow = currentWindow;

                if (item.investmentUSDT == null || item.status === 'opportunity') {
                  const shortBal = remainingBal[item.opp.shortExchange] ?? 0;
                  const longBal = remainingBal[item.opp.longExchange] ?? 0;
                  itemPerSide = Math.max(0, Math.min(shortBal, longBal) * 0.9);
                }
                // 이 기회가 사용할 마진을 잔고에서 순차 차감 + 복귀 예약
                if (itemPerSide > 0) {
                  remainingBal[item.opp.shortExchange] = (remainingBal[item.opp.shortExchange] ?? 0) - itemPerSide;
                  remainingBal[item.opp.longExchange] = (remainingBal[item.opp.longExchange] ?? 0) - itemPerSide;
                  // 스나이프 완료 후 자금 복귀 예약 (마진 반환)
                  pendingReturns.push({ exchange: item.opp.shortExchange, amount: itemPerSide, fundingTime: item.fundingTime });
                  pendingReturns.push({ exchange: item.opp.longExchange, amount: itemPerSide, fundingTime: item.fundingTime });
                }
              }
              // 투자금 $1 미만이면 거래 불가 — 후보는 숨김 (예약/활성은 표시)
              if (item.status === 'opportunity' && itemPerSide < 1) return null;
              // realSpread는 슬리피지+수수료 이미 반영 → skipFees=true로 이중차감 방지
              const hasRealSpread = !!realSpread;
              const profit = estimateProfit(effectiveOpp, itemPerSide, strategyConfig.leverage, {
                skipFees: hasRealSpread,
                feeOverrides: strategyConfig.feeOverrides,
              });
              // 수수료 표시용: skipFees일 때도 실제 수수료 계산
              const displayFees = hasRealSpread
                ? estimateProfit(item.opp, itemPerSide, strategyConfig.leverage, {
                    skipFees: false,
                    feeOverrides: strategyConfig.feeOverrides,
                  }).totalFees
                : profit.totalFees;
              // 마이너스 순수익: 활성 포지션만 항상 표시, 예약/후보는 숨김
              if (profit.netPerFunding <= 0 && item.status !== 'active') return null;

              visibleIdx++;

              // 펀딩 주기별 색상 (1h=cyan, 4h=purple, 8h=default)
              const intervalH = item.opp.fundingIntervalMs ? Math.round(item.opp.fundingIntervalMs / 3600000) : 8;
              const intervalColor = intervalH <= 1 ? 'rgba(6,182,212,' : intervalH <= 4 ? 'rgba(139,92,246,' : 'rgba(100,116,139,';
              const intervalBg = item.status === 'opportunity'
                ? `${intervalColor}0.03)` : undefined;
              const intervalBorder = item.status === 'opportunity'
                ? `${intervalColor}0.15)` : undefined;

              const rowBg = isExpanded
                ? 'rgba(59,130,246,0.08)'
                : item.status === 'active'
                  ? 'rgba(245,158,11,0.06)'
                  : item.status === 'scheduled'
                    ? 'rgba(16,185,129,0.04)'
                    : intervalBg || 'transparent';

              return (
                <div key={item.id}>
                  {/* Main Row */}
                  <div
                    className="opp-table-row"
                    onClick={() => setExpandedAsset(isExpanded ? null : item.id)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '32px 70px 1fr 80px 80px 90px 80px 60px 80px',
                      gap: 8, padding: '8px 10px',
                      alignItems: 'center',
                      cursor: 'pointer',
                      borderRadius: 8,
                      background: rowBg,
                      borderTop: isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent',
                      borderRight: isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent',
                      borderBottom: isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent',
                      borderLeft: intervalBorder ? `2px solid ${intervalBorder}` : (isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent'),
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                    onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = rowBg; }}
                  >
                    {/* Rank */}
                    <span className="mono opp-hide-mobile" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                      {visibleIdx}
                    </span>

                    {/* Status Badge */}
                    <StatusBadge status={item.status} />

                    {/* Coin + Interval Badge + Mobile Exchange Badges */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--color-text)' }}>
                          {item.asset}
                        </span>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                          color: intervalH <= 1 ? '#06b6d4' : intervalH <= 4 ? '#8b5cf6' : '#64748b',
                          background: intervalH <= 1 ? 'rgba(6,182,212,0.15)' : intervalH <= 4 ? 'rgba(139,92,246,0.15)' : 'rgba(100,116,139,0.12)',
                        }}>
                          {intervalH <= 1 ? '1h' : intervalH <= 4 ? '4h' : '8h'}
                        </span>
                        <span className="opp-hide-mobile" style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>/USDT</span>
                        {isExpanded ? <ChevronUp size={12} color="var(--color-text-muted)" /> : <ChevronDown size={12} color="var(--color-text-muted)" />}
                      </div>
                      {/* 모바일: 거래소 뱃지 인라인 */}
                      <div className="opp-show-mobile" style={{ display: 'none', alignItems: 'center', gap: 4, fontSize: 9 }}>
                        <ExBadge ex={item.opp.shortExchange} />
                        <span style={{ color: 'var(--color-text-muted)' }}>↔</span>
                        <ExBadge ex={item.opp.longExchange} />
                      </div>
                    </div>

                    {/* Short Exchange */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'center' }}>
                      <ExBadge ex={item.opp.shortExchange} />
                    </div>

                    {/* Long Exchange */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'center' }}>
                      <ExBadge ex={item.opp.longExchange} />
                    </div>

                    {/* Expected Investment — 복리 시 순차 잔고 기반, 단리 시 설정값 */}
                    {(() => {
                      const totalInvest = itemPerSide * 2;
                      const posSize = itemPerSide * strategyConfig.leverage;
                      return (
                        <div className="opp-hide-mobile" style={{ textAlign: 'right' }}>
                          <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa' }}>
                            ${fmtNum(totalInvest, 0)}
                          </span>
                          <div style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 1 }}>
                            {strategyConfig.leverage}x → ${fmtNum(posSize, 0)}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Net Profit */}
                    <div style={{ textAlign: 'right', opacity: item.status === 'opportunity' ? 0.5 : 1 }}>
                      <span className="mono" style={{
                        fontSize: 13, fontWeight: 700,
                        color: profit.netPerFunding > 0 ? '#10b981' : '#ef4444',
                      }}>
                        {profit.netPerFunding >= 0 ? '+' : ''}${fmtNum(profit.netPerFunding)}
                      </span>
                      <div style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 1 }}>
                        수수료 -${fmtNum(displayFees)}
                      </div>
                    </div>

                    {/* ROI % */}
                    <div style={{ textAlign: 'right', opacity: item.status === 'opportunity' ? 0.5 : 1 }}>
                      <span className="mono" style={{
                        fontSize: 13, fontWeight: 700,
                        color: profit.roiPerFunding >= 0 ? '#10b981' : '#ef4444',
                      }}>
                        {profit.roiPerFunding >= 0 ? '+' : ''}{fmtNum(profit.roiPerFunding, 3)}%
                      </span>
                    </div>

                    {/* Countdown + 주기 뱃지 — 후보는 dimmed 표시 */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'right', opacity: item.status === 'opportunity' ? 0.4 : 1 }}>
                      <InlineCountdown targetMs={item.fundingTime} />
                      {intervalH < 8 && (
                        <span style={{
                          fontSize: 8, fontWeight: 700, marginLeft: 2,
                          padding: '1px 3px', borderRadius: 3,
                          background: intervalH <= 1 ? 'rgba(6,182,212,0.15)' : 'rgba(139,92,246,0.15)',
                          color: intervalH <= 1 ? '#06b6d4' : '#8b5cf6',
                        }}>
                          {intervalH}h
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Expanded Detail */}
                  {isExpanded && (
                    <CoinDetail
                      item={item}
                      profit={profit}
                      compoundMode={compoundMode}
                      setCompoundMode={setCompoundMode}
                      simPositions={simPositions}
                      realSpread={realSpread}
                    />
                  )}
                </div>
              );
            });
            })()}
            </div>
          </div>
        )}

        {/* ═══ SECTION 3: Portfolio Profit Summary ═══ */}
        {scheduledCoins.length > 0 && (
          <PortfolioSummaryRow
            label="헷징"
            labelColor="#10b981"
            coins={scheduledCoins}
            investmentUSDT={perExchangeInvestment}
            leverage={strategyConfig.leverage}
            feeOverrides={strategyConfig.feeOverrides}
            compoundMode={compoundMode}
            setCompoundMode={setCompoundMode}
            realSpreads={realSpreads}
          />
        )}
      </div>
    </>
  );
}

/* ─── Portfolio Profit Summary Row ─── */
function PortfolioSummaryRow({ label, labelColor, coins, investmentUSDT, leverage, feeOverrides, compoundMode, setCompoundMode, realSpreads }: {
  label: string;
  labelColor: string;
  coins: ManagedOpportunityItem[];
  investmentUSDT: number;
  leverage: number;
  feeOverrides?: FeeOverrides;
  compoundMode: boolean;
  setCompoundMode: (v: boolean) => void;
  realSpreads?: Record<string, { effectiveSpread: number; shortSlippage: number; longSlippage: number; updatedAt: number }>;
}) {
  const activeCoins = coins.filter(c => c.status === 'active' || c.status === 'scheduled');

  const totalCapital = activeCoins.reduce(
    (sum, coin) => sum + ((coin.investmentUSDT ?? investmentUSDT) * 2),
    0,
  );

  const byInterval = useMemo(() => {
    const groups: Record<string, typeof activeCoins> = { '1h': [], '4h': [], '8h': [] };
    for (const c of activeCoins) {
      const h = (c.opp.fundingIntervalMs ?? 8 * 3600000) / 3600000;
      const bucket = h <= 1.5 ? '1h' : h <= 5 ? '4h' : '8h';
      groups[bucket].push(c);
    }
    return groups;
  }, [activeCoins]);

  const totals = useMemo(() => {
    let perDay = 0, per2Day = 0, per3Day = 0, per4Day = 0, per5Day = 0, per6Day = 0;
    let perWeek = 0, per2Week = 0, per3Week = 0, perMonth = 0, per3Month = 0, per6Month = 0;
    let cDay = 0, c2Day = 0, c3Day = 0, c4Day = 0, c5Day = 0, c6Day = 0;
    let cWeek = 0, c2Week = 0, c3Week = 0, cMonth = 0, c3Month = 0, c6Month = 0;

    for (const c of activeCoins) {
      const rs = realSpreads?.[c.id] ?? realSpreads?.[c.asset];
      const perSideInvestment = c.investmentUSDT ?? investmentUSDT;
      // realSpread에 슬리피지+베이시스+수수료 모두 반영됨 → 수수료 0인 더미 거래소로 이중차감 방지
      const opp = rs
        ? { ...c.opp, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread, shortExchange: c.opp.shortExchange, longExchange: c.opp.longExchange }
        : c.opp;
      const profit = rs
        ? estimateProfit({ ...opp, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread }, perSideInvestment, leverage, {
          skipFees: true,
          feeOverrides,
        })
        : estimateProfit(opp, perSideInvestment, leverage, { feeOverrides });
      // 마이너스 수익 항목은 합산에서 제외
      if (profit.netPerFunding <= 0) continue;
      perDay += profit.perDay; per2Day += profit.per2Day; per3Day += profit.per3Day;
      per4Day += profit.per4Day; per5Day += profit.per5Day; per6Day += profit.per6Day;
      perWeek += profit.perWeek; per2Week += profit.per2Week; per3Week += profit.per3Week; perMonth += profit.perMonth;
      per3Month += profit.per3Month; per6Month += profit.per6Month;
      cDay += profit.compound.perDay; c2Day += profit.compound.per2Day; c3Day += profit.compound.per3Day;
      c4Day += profit.compound.per4Day; c5Day += profit.compound.per5Day; c6Day += profit.compound.per6Day;
      cWeek += profit.compound.perWeek; c2Week += profit.compound.per2Week; c3Week += profit.compound.per3Week; cMonth += profit.compound.perMonth;
      c3Month += profit.compound.per3Month; c6Month += profit.compound.per6Month;
    }
    return { perDay, per2Day, per3Day, per4Day, per5Day, per6Day, perWeek, per2Week, per3Week, perMonth, per3Month, per6Month,
             cDay, c2Day, c3Day, c4Day, c5Day, c6Day, cWeek, c2Week, c3Week, cMonth, c3Month, c6Month };
  }, [activeCoins, feeOverrides, investmentUSDT, leverage, realSpreads]);

  if (activeCoins.length === 0) return null;

  const bgColor = 'rgba(16,185,129,0.04)';
  const borderColor = 'rgba(16,185,129,0.15)';

  return (
    <div style={{ marginTop: 12, padding: '14px 16px', borderRadius: 10, background: bgColor, border: `1px solid ${borderColor}` }}>
      {/* Header */}
      <div className="portfolio-summary-header" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 11, fontWeight: 800, color: labelColor,
          padding: '2px 8px', borderRadius: 4,
          background: `${labelColor}20`, border: `1px solid ${labelColor}33`,
        }}>
          {label}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>예상 수익</span>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg-accent)', borderRadius: 6, padding: 2 }}>
          {(['단리', '복리'] as const).map((lb, i) => {
            const active = compoundMode === (i === 1);
            return (
              <button key={lb} onClick={() => setCompoundMode(i === 1)} style={{
                padding: '2px 8px', borderRadius: 4, border: 'none', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                background: active ? (i === 1 ? 'rgba(139,92,246,0.3)' : 'rgba(16,185,129,0.2)') : 'transparent',
                color: active ? (i === 1 ? '#a78bfa' : '#10b981') : 'var(--color-text-muted)',
              }}>{lb}</button>
            );
          })}
        </div>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          투입: ${totalCapital.toLocaleString()} ({activeCoins.length}쌍)
        </span>
        <div className="interval-badges" style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {Object.entries(byInterval).map(([interval, list]) => list.length > 0 && (
            <span key={interval} style={{
              fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: interval === '1h' ? 'rgba(16,185,129,0.15)' : interval === '4h' ? 'rgba(59,130,246,0.15)' : 'rgba(139,92,246,0.15)',
              color: interval === '1h' ? '#10b981' : interval === '4h' ? '#3b82f6' : '#a78bfa',
            }}>
              {interval} ×{list.length}
            </span>
          ))}
        </div>
      </div>

      {/* Profit Grid — 2행: 상단 6일, 하단 1주/2주/1달 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {[
          { label: '1일', simple: totals.perDay, compound: totals.cDay },
          { label: '2일', simple: totals.per2Day, compound: totals.c2Day },
          { label: '3일', simple: totals.per3Day, compound: totals.c3Day },
          { label: '4일', simple: totals.per4Day, compound: totals.c4Day },
          { label: '5일', simple: totals.per5Day, compound: totals.c5Day },
          { label: '6일', simple: totals.per6Day, compound: totals.c6Day },
        ].map(({ label: lb, simple, compound }) => {
          const value = compoundMode ? compound : simple;
          const roi = totalCapital > 0 ? (value / totalCapital) * 100 : 0;
          const color = compoundMode ? '#a78bfa' : labelColor;
          const negColor = '#ef4444';
          return (
            <div key={lb} style={{
              padding: '8px 6px', borderRadius: 8, textAlign: 'center',
              background: 'var(--bg-accent)',
              border: `1px solid ${compoundMode ? 'rgba(139,92,246,0.15)' : 'var(--color-border)'}`,
            }}>
              <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>{lb}</div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 800, color: value >= 0 ? color : negColor }}>
                {fmtUsdOrInfinity(value)}
              </div>
              <div className="mono" style={{ fontSize: 10, color: roi >= 0 ? (compoundMode ? '#c4b5fd' : '#6ee7b7') : '#fca5a5', marginTop: 2 }}>
                {fmtPctOrInfinity(roi, 2, { forceInfinity: isInfiniteProfitDisplay(value) })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, marginTop: 4 }}>
        {[
          { label: '1주', simple: totals.perWeek, compound: totals.cWeek },
          { label: '2주', simple: totals.per2Week, compound: totals.c2Week },
          { label: '3주', simple: totals.per3Week, compound: totals.c3Week },
          { label: '1달', simple: totals.perMonth, compound: totals.cMonth },
          { label: '3달', simple: totals.per3Month, compound: totals.c3Month },
          { label: '6달', simple: totals.per6Month, compound: totals.c6Month },
        ].map(({ label: lb, simple, compound }) => {
          const value = compoundMode ? compound : simple;
          const roi = totalCapital > 0 ? (value / totalCapital) * 100 : 0;
          const color = compoundMode ? '#a78bfa' : labelColor;
          const negColor = '#ef4444';
          return (
            <div key={lb} style={{
              padding: '8px 6px', borderRadius: 8, textAlign: 'center',
              background: 'var(--bg-accent)',
              border: `1px solid ${compoundMode ? 'rgba(139,92,246,0.15)' : 'var(--color-border)'}`,
            }}>
              <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>{lb}</div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 800, color: value >= 0 ? color : negColor }}>
                {fmtUsdOrInfinity(value)}
              </div>
              <div className="mono" style={{ fontSize: 10, color: roi >= 0 ? (compoundMode ? '#c4b5fd' : '#6ee7b7') : '#fca5a5', marginTop: 2 }}>
                {fmtPctOrInfinity(roi, 2, { forceInfinity: isInfiniteProfitDisplay(value) })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Status Badge ─── */
function StatusBadge({ status }: { status: 'scheduled' | 'active' | 'opportunity' }) {
  const config = {
    active: { label: '실행 중', bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: 'rgba(245,158,11,0.3)', dot: true },
    scheduled: { label: '예약됨', bg: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'rgba(16,185,129,0.25)', dot: true },
    opportunity: { label: '후보', bg: 'rgba(100,116,139,0.1)', color: '#94a3b8', border: 'rgba(100,116,139,0.2)', dot: false },
  }[status];

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700,
      background: config.bg, color: config.color, border: `1px solid ${config.border}`,
    }}>
      {config.dot && (
        <span style={{
          width: 5, height: 5, borderRadius: '50%', background: config.color,
          boxShadow: `0 0 4px ${config.color}`,
          animation: status === 'active' ? 'blink 1.5s ease-in-out infinite' : 'none',
        }} />
      )}
      {config.label}
    </span>
  );
}

/* ─── Stat Pill ─── */
function StatPill({ label, value, color, active }: { label: string; value: string; color: string; active: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 8,
      background: active ? `${color}15` : 'var(--bg-accent)',
      border: `1px solid ${active ? `${color}30` : 'var(--color-border)'}`,
    }}>
      <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: active ? color : 'var(--color-text-muted)' }}>
        {value}
      </span>
    </div>
  );
}

/* ─── Expanded Coin Detail ─── */
function CoinDetail({ item, profit, compoundMode, setCompoundMode, simPositions, realSpread }: {
  item: ManagedOpportunityItem;
  profit: ReturnType<typeof estimateProfit>;
  compoundMode: boolean;
  setCompoundMode: (v: boolean) => void;
  simPositions?: SimPosition[];
  realSpread?: { effectiveSpread: number; shortSlippage: number; longSlippage: number; updatedAt: number } | null;
}) {
  const opp = item.opp;
  const activeSimPos = simPositions?.filter((position) => {
    if (item.pairId && position.pairId) return position.pairId === item.pairId;
    return position.baseAsset === item.asset
      && (position.exchange === opp.shortExchange || position.exchange === opp.longExchange);
  }) ?? [];
  const simShort = activeSimPos.find(p => p.side === 'short');
  const simLong = activeSimPos.find(p => p.side === 'long');
  const entryGap = simShort?.entryGapPercent ?? simLong?.entryGapPercent;

  return (
    <div style={{
      margin: '0 0 8px 0', padding: '14px 16px', borderRadius: '0 0 10px 10px',
      background: 'rgba(59,130,246,0.04)',
      border: '1px solid rgba(59,130,246,0.15)',
      borderTop: 'none',
    }}>
      {/* Exchange pair detail */}
      <div className="opp-hero-section" style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        {/* Short */}
        <div style={{
          flex: 1, minWidth: 150, padding: '10px 14px', borderRadius: 10,
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <TrendingDown size={12} color="#ef4444" />
            <span style={{ fontSize: 10, fontWeight: 600, color: '#ef4444' }}>SHORT</span>
            <ExBadge ex={opp.shortExchange} size="xs" />
          </div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: opp.shortRate >= 0 ? '#10b981' : '#ef4444' }}>
            {opp.shortRate >= 0 ? '+' : ''}{fmtNum(opp.shortRate * 100, 4)}%
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            {opp.shortRate >= 0 ? '▲ 수령' : '▼ 지불'} (8h 펀딩률)
          </div>
        </div>
        {/* Long */}
        <div style={{
          flex: 1, minWidth: 150, padding: '10px 14px', borderRadius: 10,
          background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <TrendingUp size={12} color="#10b981" />
            <span style={{ fontSize: 10, fontWeight: 600, color: '#10b981' }}>LONG</span>
            <ExBadge ex={opp.longExchange} size="xs" />
          </div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: -opp.longRate >= 0 ? '#10b981' : '#ef4444' }}>
            {-opp.longRate >= 0 ? '+' : ''}{fmtNum(Math.abs(opp.longRate) * 100, 4)}%
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            {-opp.longRate >= 0 ? '▲ 수령' : '▼ 지불'} (8h 펀딩률)
          </div>
        </div>
        {/* Spread summary */}
        <div style={{
          flex: 1, minWidth: 150, padding: '10px 14px', borderRadius: 10,
          background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>8h 스프레드</div>
          <div className="mono gradient-text-green" style={{ fontSize: 24, fontWeight: 900 }}>
            +{fmtNum(opp.spreadPercent, 4)}%
          </div>
          <div style={{ fontSize: 10, color: '#8b5cf6', marginTop: 2 }}>
            연 ~{fmtNum(opp.annualReturnPercent, 0)}%
          </div>
        </div>
      </div>

      {/* Profit grid */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)' }}>수익 예측</span>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg-accent)', borderRadius: 6, padding: 2 }}>
          {(['단리', '복리'] as const).map((label, i) => {
            const active = compoundMode === (i === 1);
            return (
              <button
                key={label}
                onClick={() => setCompoundMode(i === 1)}
                style={{
                  padding: '2px 8px', borderRadius: 4, border: 'none', fontSize: 10, fontWeight: 700,
                  cursor: 'pointer',
                  background: active ? (i === 1 ? 'rgba(139,92,246,0.3)' : 'rgba(16,185,129,0.2)') : 'transparent',
                  color: active ? (i === 1 ? '#a78bfa' : '#10b981') : 'var(--color-text-muted)',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          기준: ${profit.totalCapital.toLocaleString()}
        </span>
      </div>

      <div className="coin-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {[
          { label: '8h', value: profit.netPerFunding, compoundValue: profit.netPerFunding, roi: profit.roiPerFunding, compoundRoi: profit.roiPerFunding },
          { label: '일', value: profit.perDay, compoundValue: profit.compound.perDay, roi: profit.roiPerDay, compoundRoi: profit.compound.roiPerDay },
          { label: '주', value: profit.perWeek, compoundValue: profit.compound.perWeek, roi: profit.roiPerWeek, compoundRoi: profit.compound.roiPerWeek },
          { label: '월', value: profit.perMonth, compoundValue: profit.compound.perMonth, roi: profit.roiPerMonth, compoundRoi: profit.compound.roiPerMonth },
        ].map(({ label, value, compoundValue, roi, compoundRoi }) => {
          const dv = compoundMode ? compoundValue : value;
          const dr = compoundMode ? compoundRoi : roi;
          return (
            <div key={label} style={{
              padding: '6px 8px', borderRadius: 6, textAlign: 'center',
              background: 'var(--bg-accent)', border: `1px solid ${compoundMode ? 'rgba(139,92,246,0.15)' : 'var(--color-border)'}`,
            }}>
              <div style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>{label}</div>
              <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: dv >= 0 ? (compoundMode ? '#a78bfa' : '#10b981') : '#ef4444' }}>
                {fmtUsdOrInfinity(dv)}
              </div>
              <div className="mono" style={{ fontSize: 9, color: dr >= 0 ? (compoundMode ? '#c4b5fd' : '#6ee7b7') : '#fca5a5' }}>
                {fmtPctOrInfinity(dr, 2, { forceInfinity: isInfiniteProfitDisplay(dv) })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Fee info */}
      <div style={{
        marginTop: 8, padding: '4px 8px', borderRadius: 4,
        display: 'flex', justifyContent: 'space-between',
        fontSize: 10, color: 'var(--color-text-muted)',
        background: 'rgba(255,255,255,0.02)',
      }}>
        <span>수수료 1회: <span className="mono" style={{ color: '#ef4444' }}>-${fmtNum(profit.totalFees)}</span></span>
        <span>8h 펀딩: <span className="mono" style={{ fontWeight: 700, color: profit.netPerFunding > 0 ? '#10b981' : '#ef4444' }}>
          {profit.netPerFunding > 0 ? '+' : ''}${fmtNum(profit.netPerFunding)}
        </span></span>
      </div>

      {/* Entry gap & slippage analysis */}
      {(entryGap !== undefined || realSpread) && (
        <div style={{
          marginTop: 6, padding: '4px 8px', borderRadius: 4,
          display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4,
          fontSize: 10, color: 'var(--color-text-muted)',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.04)',
        }}>
          {entryGap !== undefined && (
            <span>
              진입갭:{' '}
              <span className="mono" style={{ fontWeight: 700, color: Math.abs(entryGap) > 0.1 ? '#f59e0b' : '#10b981' }}>
                {entryGap >= 0 ? '+' : ''}{fmtNum(entryGap, 4)}%
              </span>
              {' '}
              <span style={{ color: 'var(--color-text-muted)' }}>
                (숏${simShort ? fmtNum(simShort.entryPrice, 2) : '—'} / 롱${simLong ? fmtNum(simLong.entryPrice, 2) : '—'})
              </span>
            </span>
          )}
          {realSpread && (
            <span>
              슬리피지:{' '}
              <span className="mono" style={{ color: '#ef4444' }}>숏 {fmtNum(realSpread.shortSlippage, 4)}%</span>
              {' / '}
              <span className="mono" style={{ color: '#10b981' }}>롱 {fmtNum(realSpread.longSlippage, 4)}%</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
