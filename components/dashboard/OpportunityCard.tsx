'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Zap, Crosshair, Check, Clock, TrendingDown, TrendingUp, ChevronDown, ChevronUp, Settings } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId, type ArbitrageOpportunity, type SimPosition } from '@/lib/types';
import { estimateProfit } from '@/lib/opportunities';
import { fmtNum } from '@/lib/format';

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
    snipeActive, snipeTargets, scheduleAllSnipes, cancelSnipe,
    closeSimPosition, ratesStatus, ratesError, isLoadingRates,
    lastRatesUpdate, strategyRunning, realSpreads,
  } = useFundingStore();

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
    if (snipeActive) cancelSnipe();
    setToastMsg({ text: '전체 포지션 청산 완료', type: 'success' });
  }, [isProcessing, isRunning, simulationMode, simPositions, closeSimPosition, snipeActive, cancelSnipe, positions, closeRealPosition]);

  const handleSnipe = useCallback(() => {
    if (snipeActive) {
      cancelSnipe();
      setToastMsg({ text: '자동 투자 중지됨', type: 'success' });
    } else {
      useFundingStore.setState({ snipeActive: true });
      scheduleAllSnipes();
      const count = Object.keys(useFundingStore.getState().snipeTargets).length;
      setToastMsg({ text: `스나이핑 시작! ${count}개 코인 예약`, type: 'success' });
    }
  }, [snipeActive, scheduleAllSnipes, cancelSnipe]);

  // ── Portfolio ──

  const perExchangeInvestment = strategyConfig.investmentUSDT;
  const best = opportunities[0];
  const hasShortConfig = best ? !!apiConfigs[best.shortExchange] : false;
  const hasLongConfig = best ? !!apiConfigs[best.longExchange] : false;
  const canExecute = simulationMode ? true : hasShortConfig && hasLongConfig;

  // ── Build scheduled list: snipe targets + active positions mapped to opportunities ──
  const scheduledCoins = useMemo(() => {
    const items: Array<{
      asset: string;
      opp: ArbitrageOpportunity;
      fundingTime: number;
      status: 'scheduled' | 'active' | 'opportunity';
    }> = [];

    // Track by baseAsset only (for deduplication)
    const seenAssets = new Set<string>();

    // 1) Snipe targets (scheduled) — key is baseAsset
    for (const [snipeKey, time] of Object.entries(snipeTargets)) {
      const baseAsset = snipeKey.split(':')[0];
      if (seenAssets.has(baseAsset)) continue;
      const opp = opportunities.find(o => o.baseAsset === baseAsset);
      if (!opp) continue;
      items.push({ asset: baseAsset, opp, fundingTime: time, status: 'scheduled' });
      seenAssets.add(baseAsset);
    }

    // 2) Active positions
    const activePositions = simulationMode ? simPositions : positions;
    for (const pos of activePositions) {
      const opp = opportunities.find(o => o.baseAsset === pos.baseAsset);
      if (!opp) continue;
      const existing = items.find(i => i.asset === pos.baseAsset);
      if (existing) {
        existing.status = 'active';
      } else {
        items.push({ asset: pos.baseAsset, opp, fundingTime: opp.nextFundingTime, status: 'active' });
        seenAssets.add(pos.baseAsset);
      }
    }

    // 3) Top opportunities (not yet scheduled, show top 5)
    for (const opp of opportunities) {
      if (seenAssets.has(opp.baseAsset)) continue;
      if (items.length >= 10) break;
      items.push({ asset: opp.baseAsset, opp, fundingTime: opp.nextFundingTime, status: 'opportunity' });
      seenAssets.add(opp.baseAsset);
    }

    // 마이너스 순수익 필터링 (활성 포지션은 유지)
    const profitable = items.filter(i => i.status === 'active' || i.opp.netProfit > 0);

    // Sort: active first, then by 가장 빠른 시간 + 높은 순수익
    return profitable.sort((a, b) => {
      const priority = { active: 0, scheduled: 1, opportunity: 2 };
      if (priority[a.status] !== priority[b.status]) return priority[a.status] - priority[b.status];
      // 같은 상태면: 빠른 시간 우선, 같은 시간이면 순수익 높은 순
      const timeDiff = a.fundingTime - b.fundingTime;
      if (Math.abs(timeDiff) > 120_000) return timeDiff; // 2분 이상 차이나면 시간 우선
      return b.opp.netProfit - a.opp.netProfit; // 비슷한 시간이면 순수익 우선
    });
  }, [opportunities, snipeTargets, simPositions, positions, simulationMode]);

  // Nearest upcoming trade
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

  const scheduledCount = Object.keys(snipeTargets).length;
  const activeCount = simulationMode ? simPositions.length : positions.length;

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
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <StatPill label="예약" value={`${scheduledCount}개`} color="#3b82f6" active={scheduledCount > 0} />
              <StatPill label="활성 포지션" value={`${activeCount}개`} color="#f59e0b" active={activeCount > 0} />
              <StatPill label="기회" value={`${opportunities.length}개`} color="#8b5cf6" active={opportunities.length > 0} />
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
              <span>거래소당 <strong style={{ color: 'var(--color-text)' }}>${perExchangeInvestment.toLocaleString()}</strong></span>
              <span>총 <strong style={{ color: '#f59e0b' }}>${(perExchangeInvestment * 2).toLocaleString()}</strong></span>
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

        {/* ═══ SECTION 2: Scheduled Trades Table ═══ */}
        {scheduledCoins.length > 0 && (
          <div style={{ marginBottom: 0 }}>
            {/* Table Header */}
            <div className="opp-table-header" style={{
              display: 'grid',
              gridTemplateColumns: '32px 70px 1fr 90px 90px 80px 80px',
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
              <span style={{ textAlign: 'right' }}>예상 수익</span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>카운트다운</span>
            </div>

            {/* Rows — 실효스프레드 기반 순수익 마이너스 자동 필터링 */}
            {(() => {
              let visibleIdx = 0;
              return scheduledCoins.map((item) => {
              const isExpanded = expandedAsset === item.asset;
              const realSpread = realSpreads[item.asset];
              const effectiveOpp: ArbitrageOpportunity = realSpread
                ? { ...item.opp, spread: realSpread.effectiveSpread / 100, spreadPercent: realSpread.effectiveSpread }
                : item.opp;
              const profit = estimateProfit(effectiveOpp, perExchangeInvestment, strategyConfig.leverage);
              // 마이너스 순수익은 활성 포지션 외 숨김
              if (item.status !== 'active' && profit.netPerFunding <= 0) return null;

              visibleIdx++;

              return (
                <div key={item.asset}>
                  {/* Main Row */}
                  <div
                    className="opp-table-row"
                    onClick={() => setExpandedAsset(isExpanded ? null : item.asset)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '32px 70px 1fr 90px 90px 80px 80px',
                      gap: 8, padding: '8px 10px',
                      alignItems: 'center',
                      cursor: 'pointer',
                      borderRadius: 8,
                      background: isExpanded
                        ? 'rgba(59,130,246,0.08)'
                        : item.status === 'active'
                          ? 'rgba(245,158,11,0.06)'
                          : item.status === 'scheduled'
                            ? 'rgba(16,185,129,0.04)'
                            : 'transparent',
                      border: isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                    onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = item.status === 'active' ? 'rgba(245,158,11,0.06)' : item.status === 'scheduled' ? 'rgba(16,185,129,0.04)' : 'transparent'; }}
                  >
                    {/* Rank */}
                    <span className="mono opp-hide-mobile" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                      {visibleIdx}
                    </span>

                    {/* Status Badge */}
                    <StatusBadge status={item.status} />

                    {/* Coin */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--color-text)' }}>
                        {item.asset}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>/USDT</span>
                      {isExpanded ? <ChevronUp size={12} color="var(--color-text-muted)" /> : <ChevronDown size={12} color="var(--color-text-muted)" />}
                    </div>

                    {/* Short Exchange */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'center' }}>
                      <ExBadge ex={item.opp.shortExchange} />
                    </div>

                    {/* Long Exchange */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'center' }}>
                      <ExBadge ex={item.opp.longExchange} />
                    </div>

                    {/* Net Profit */}
                    <div style={{ textAlign: 'right' }}>
                      <span className="mono" style={{
                        fontSize: 13, fontWeight: 700,
                        color: profit.netPerFunding > 0 ? '#10b981' : '#ef4444',
                      }}>
                        {profit.netPerFunding >= 0 ? '+' : ''}${fmtNum(profit.netPerFunding)}
                      </span>
                      <div style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 1 }}>
                        수수료 -${fmtNum(profit.totalFees)}
                      </div>
                    </div>

                    {/* Countdown */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'right' }}>
                      <InlineCountdown targetMs={item.fundingTime} />
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
        )}

        {/* ═══ SECTION 3: Portfolio Profit Summary ═══ */}
        {scheduledCoins.length > 0 && (
          <PortfolioSummaryRow
            label="헷징"
            labelColor="#10b981"
            coins={scheduledCoins.map(c => ({ ...c, mode: 'hedge' as const }))}
            investmentUSDT={perExchangeInvestment}
            leverage={strategyConfig.leverage}
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
function PortfolioSummaryRow({ label, labelColor, coins, investmentUSDT, leverage, compoundMode, setCompoundMode, realSpreads }: {
  label: string;
  labelColor: string;
  coins: Array<{ asset: string; opp: ArbitrageOpportunity; status: string; mode: 'hedge' }>;
  investmentUSDT: number;
  leverage: number;
  compoundMode: boolean;
  setCompoundMode: (v: boolean) => void;
  realSpreads?: Record<string, { effectiveSpread: number; shortSlippage: number; longSlippage: number; updatedAt: number }>;
}) {
  const activeCoins = coins.filter(c => c.status === 'active' || c.status === 'scheduled');

  const capitalPerPosition = investmentUSDT * 2;
  const deployedCapital = activeCoins.length * capitalPerPosition;

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
    let per1h = 0, per4h = 0, per8h = 0, perDay = 0, perWeek = 0, perMonth = 0;
    let c1h = 0, c4h = 0, c8h = 0, cDay = 0, cWeek = 0, cMonth = 0;

    for (const c of activeCoins) {
      const rs = realSpreads?.[c.asset];
      const opp = rs
        ? { ...c.opp, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread }
        : c.opp;
      const profit = estimateProfit(opp, investmentUSDT, leverage);
      per1h += profit.per1h; per4h += profit.per4h; per8h += profit.netPerFunding;
      perDay += profit.perDay; perWeek += profit.perWeek; perMonth += profit.perMonth;
      c1h += profit.compound.per1h; c4h += profit.compound.per4h; c8h += profit.netPerFunding;
      cDay += profit.compound.perDay; cWeek += profit.compound.perWeek; cMonth += profit.compound.perMonth;
    }
    return { per1h, per4h, per8h, perDay, perWeek, perMonth, c1h, c4h, c8h, cDay, cWeek, cMonth };
  }, [activeCoins, investmentUSDT, leverage, realSpreads]);

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
          투입: ${deployedCapital.toLocaleString()} ({activeCoins.length}개 × ${capitalPerPosition.toLocaleString()})
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

      {/* Profit Grid */}
      <div className="profit-grid-6" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
        {[
          { label: '1h', simple: totals.per1h, compound: totals.c1h },
          { label: '4h', simple: totals.per4h, compound: totals.c4h },
          { label: '8h', simple: totals.per8h, compound: totals.c8h },
          { label: '일', simple: totals.perDay, compound: totals.cDay },
          { label: '주', simple: totals.perWeek, compound: totals.cWeek },
          { label: '월', simple: totals.perMonth, compound: totals.cMonth },
        ].map(({ label: lb, simple, compound }) => {
          const value = compoundMode ? compound : simple;
          const roi = deployedCapital > 0 ? (value / deployedCapital) * 100 : 0;
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
                {value >= 0 ? '+' : ''}${fmtNum(value)}
              </div>
              <div className="mono" style={{ fontSize: 10, color: roi >= 0 ? (compoundMode ? '#c4b5fd' : '#6ee7b7') : '#fca5a5', marginTop: 2 }}>
                {roi >= 0 ? '+' : ''}{fmtNum(roi, 2)}%
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
    opportunity: { label: '대기', bg: 'rgba(100,116,139,0.1)', color: '#94a3b8', border: 'rgba(100,116,139,0.2)', dot: false },
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
  item: { asset: string; opp: ArbitrageOpportunity; status: string };
  profit: ReturnType<typeof estimateProfit>;
  compoundMode: boolean;
  setCompoundMode: (v: boolean) => void;
  simPositions?: SimPosition[];
  realSpread?: { effectiveSpread: number; shortSlippage: number; longSlippage: number; updatedAt: number } | null;
}) {
  const opp = item.opp;
  const activeSimPos = simPositions?.filter(p => p.baseAsset === item.asset) ?? [];
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
                {dv >= 0 ? '+' : ''}${fmtNum(dv)}
              </div>
              <div className="mono" style={{ fontSize: 9, color: dr >= 0 ? (compoundMode ? '#c4b5fd' : '#6ee7b7') : '#fca5a5' }}>
                {dr >= 0 ? '+' : ''}{fmtNum(dr)}%
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
