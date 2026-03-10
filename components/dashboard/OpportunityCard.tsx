'use client';

import { useState, useEffect, useCallback } from 'react';
import { TrendingDown, TrendingUp, Zap, Play, Crosshair, Check, Clock } from 'lucide-react';
import CountdownTimer from '@/components/ui/CountdownTimer';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, SIM_INITIAL_BALANCE } from '@/lib/types';
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
  const { opportunities, strategyConfig, executeStrategy, setShowStrategyPanel, apiConfigs, simulationMode, simBalances, automationActive, automationStartedAt, automationStats, simPositions, stopAutomation, snipeScheduled, snipeTargetTime, scheduleSnipe, cancelSnipe, closeSimPosition, ratesStatus, ratesError, isLoadingRates, lastRatesUpdate } = useFundingStore();
  const [compoundMode, setCompoundMode] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'snipe' } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false); // 진입/청산 처리 중 방지
  const best = opportunities[0];

  // 진행 중 상태 = 시뮬 포지션이 있음
  const isRunning = simulationMode ? simPositions.length > 0 : automationActive;

  // Toast auto-dismiss
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  // 토글 핸들러: 진입하기 ↔ 전체 청산
  const handleToggle = useCallback(async () => {
    if (!best || isProcessing) return;
    setIsProcessing(true);

    if (isRunning) {
      // 진행 중 → 전체 청산
      if (simulationMode) {
        const ids = simPositions.map(p => p.simId);
        for (const id of ids) closeSimPosition(id);
      }
      if (automationActive) stopAutomation();
      setToastMsg({ text: '전체 포지션 청산 완료', type: 'success' });
    } else {
      // 대기 중 → 진입
      await executeStrategy(best);
      setToastMsg({ text: `${best.baseAsset} 헷징 진입 완료!`, type: 'success' });
    }

    // 잠깐 대기 후 버튼 재활성화 (더블클릭 방지)
    setTimeout(() => setIsProcessing(false), 500);
  }, [best, isProcessing, isRunning, simulationMode, simPositions, closeSimPosition, automationActive, stopAutomation, executeStrategy]);

  const handleSnipe = useCallback(() => {
    if (!best) return;
    if (snipeScheduled) {
      cancelSnipe();
      setToastMsg({ text: '스나이핑 예약 취소됨', type: 'snipe' });
    } else {
      scheduleSnipe(best);
      const mins = ((best.nextFundingTime - Date.now()) / 60000).toFixed(0);
      setToastMsg({ text: `${best.baseAsset} 스나이핑 예약! (${mins}분 후)`, type: 'snipe' });
    }
  }, [best, snipeScheduled, scheduleSnipe, cancelSnipe]);

  // 로딩 중 (첫 로딩 or 아직 데이터 없음)
  const isFirstLoading = isLoadingRates && !lastRatesUpdate;
  // 에러 상태 (데이터도 없고 에러 발생)
  const isErrorState = ratesStatus === 'error' && !best;
  // 빈 결과 (로딩 완료했지만 기회 없음)
  const isEmptyResult = !best && ratesStatus === 'success';

  if (!best) {
    return (
      <div
        className="glass-card"
        style={{
          padding: 32,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          minHeight: 200,
        }}
      >
        {isFirstLoading ? (
          /* 첫 로딩 중 */
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 20, height: 20, border: '2px solid var(--color-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <span style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
              5개 거래소 펀딩률 데이터 조회 중...
            </span>
          </div>
        ) : isErrorState ? (
          /* 에러 발생 */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 24 }}>⚠</span>
            <span style={{ color: '#ef4444', fontSize: 14, fontWeight: 600 }}>
              펀딩률 데이터 조회 실패
            </span>
            {ratesError && (
              <span style={{ color: 'var(--color-text-muted)', fontSize: 12, textAlign: 'center', maxWidth: 300 }}>
                {ratesError}
              </span>
            )}
            <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>
              30초 후 자동 재시도됩니다
            </span>
          </div>
        ) : isEmptyResult ? (
          /* 데이터는 왔지만 기회 없음 */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 24 }}>📊</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 14, fontWeight: 600 }}>
              현재 유효한 헷징 기회가 없습니다
            </span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
              스프레드가 최소 기준 미만이거나 데이터가 부족합니다
            </span>
            {lastRatesUpdate && (
              <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>
                마지막 업데이트: {new Date(lastRatesUpdate).toLocaleTimeString('ko-KR')}
              </span>
            )}
          </div>
        ) : (
          /* 기본 로딩 (재시도 중 등) */
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 20, height: 20, border: '2px solid var(--color-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <span style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
              펀딩률 데이터 갱신 중...
            </span>
          </div>
        )}
        {simulationMode && (
          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--color-text-muted)' }}>
            <span style={{ color: '#a78bfa' }}>SIM 모드 활성</span>
            <span>•</span>
            <span>거래소당 <strong style={{ color: 'var(--color-text)' }}>${SIM_INITIAL_BALANCE.toLocaleString()}</strong></span>
            <span>•</span>
            <span>총 <strong style={{ color: '#f59e0b' }}>${(SIM_INITIAL_BALANCE * 5).toLocaleString()}</strong></span>
          </div>
        )}
      </div>
    );
  }

  // 실제 총 자산 계산 (시뮬: 전체 거래소 잔고 합산, 실거래: 잔고 합산)
  const totalPortfolio = simulationMode
    ? Object.values(simBalances).reduce((s, v) => s + v, 0)
    : undefined;
  const profit = estimateProfit(best, strategyConfig.investmentUSDT, strategyConfig.leverage, totalPortfolio);
  const hasShortConfig = !!apiConfigs[best.shortExchange];
  const hasLongConfig = !!apiConfigs[best.longExchange];
  const canExecute = simulationMode
    ? (simBalances[best.shortExchange] ?? 0) >= strategyConfig.investmentUSDT &&
      (simBalances[best.longExchange] ?? 0) >= strategyConfig.investmentUSDT
    : hasShortConfig && hasLongConfig;

  return (
    <>
    {/* Toast notification */}
    {toastMsg && (
      <div className={`toast toast-${toastMsg.type}`}>
        {toastMsg.type === 'success' ? <Check size={16} /> : <Crosshair size={16} />}
        {toastMsg.text}
      </div>
    )}
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

          {/* Portfolio base info */}
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'center' }}>
            수익률 기준: <strong style={{ color: 'var(--color-text)' }}>
              {simulationMode ? `시뮬 총 자산 $${profit.actualPortfolio.toLocaleString('en', { maximumFractionDigits: 0 })}` : `투자금 $${profit.totalCapital.toLocaleString()}`}
            </strong>
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
              { label: '8h 수익', value: profit.perFunding, compoundValue: profit.perFunding, roi: profit.roiPerFunding, compoundRoi: profit.roiPerFunding },
              { label: '일 수익', value: profit.perDay, compoundValue: profit.compound.perDay, roi: profit.roiPerDay, compoundRoi: profit.compound.roiPerDay },
              { label: '월 수익', value: profit.perMonth, compoundValue: profit.compound.perMonth, roi: profit.roiPerMonth, compoundRoi: profit.compound.roiPerMonth },
              { label: '연 수익', value: profit.perYear, compoundValue: profit.compound.perYear, roi: profit.roiPerYear, compoundRoi: profit.compound.roiPerYear },
            ].map(({ label, value, compoundValue, roi, compoundRoi }) => {
              const displayValue = compoundMode ? compoundValue : value;
              const displayRoi = compoundMode ? compoundRoi : roi;
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
                    +{displayRoi.toFixed(2)}%
                  </div>
                </div>
              );
            })}
          </div>

          {/* 메인 토글 버튼: 진입하기 ↔ 진행 중 (전체 청산) */}
          <button
            className={`btn ${isRunning ? 'btn-danger' : 'btn-success'}`}
            style={{
              width: '100%',
              padding: '14px 24px',
              fontSize: 15,
              fontWeight: 800,
              borderRadius: 12,
              opacity: (!canExecute && !isRunning) || isProcessing ? 0.5 : 1,
              cursor: (!canExecute && !isRunning) || isProcessing ? 'not-allowed' : 'pointer',
              background: isRunning
                ? 'linear-gradient(135deg, #f59e0b, #f97316)'
                : simulationMode ? 'linear-gradient(135deg, #7c3aed, #a78bfa)' : undefined,
              border: isRunning ? '2px solid #fbbf24' : undefined,
              boxShadow: isRunning ? '0 0 16px rgba(245, 158, 11, 0.4)' : undefined,
              transition: 'all 0.3s ease',
              position: 'relative',
              overflow: 'hidden',
              animation: isRunning ? 'pulse-glow 2s ease-in-out infinite' : undefined,
            }}
            disabled={(!canExecute && !isRunning) || isProcessing}
            onClick={handleToggle}
            title={!canExecute && !isRunning ? (simulationMode ? '시뮬 잔고 부족' : '두 거래소 모두 API 키가 필요합니다') : isRunning ? '클릭하면 전체 청산' : ''}
          >
            {isProcessing ? (
              <>
                <div style={{ width: 16, height: 16, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                처리 중...
              </>
            ) : isRunning ? (
              <>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', boxShadow: '0 0 6px #fff', animation: 'blink 1.5s ease-in-out infinite' }} />
                {simulationMode ? '[SIM] ' : ''}투자 실행 중 ({simPositions.length}개) — 청산하기
              </>
            ) : (
              <>
                <Play size={16} fill="white" />
                {simulationMode ? '[SIM] 지금 진입하기' : '지금 진입하기'}
              </>
            )}
          </button>

          {/* 진행 중일 때: 간단한 상태 요약 */}
          {isRunning && (
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, width: '100%',
            }}>
              {[
                { label: '포지션', value: `${simPositions.length}개`, color: '#3b82f6' },
                { label: '수령 펀딩', value: `$${automationStats.fundingCollected.toFixed(4)}`, color: '#10b981' },
                { label: '경과', value: automationStartedAt ? `${((Date.now() - automationStartedAt) / 60000).toFixed(0)}분` : '-', color: '#f59e0b' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ textAlign: 'center', padding: '6px 8px', borderRadius: 8, background: 'var(--bg-accent)', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{label}</div>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 700, color }}>{value}</div>
                </div>
              ))}
            </div>
          )}

          {/* 펀딩 스나이핑 버튼 */}
          {!isRunning && (
            <>
              <button
                className={`btn ${snipeScheduled ? 'snipe-scheduled' : ''}`}
                style={{
                  width: '100%',
                  padding: '10px 24px',
                  fontSize: 13,
                  borderRadius: 10,
                  cursor: !canExecute ? 'not-allowed' : 'pointer',
                  opacity: !canExecute ? 0.5 : 1,
                  background: snipeScheduled
                    ? 'linear-gradient(135deg, rgba(245,158,11,0.15), rgba(217,119,6,0.1))'
                    : 'linear-gradient(135deg, rgba(245,158,11,0.08), rgba(15,22,35,1))',
                  border: `1px solid ${snipeScheduled ? 'rgba(245,158,11,0.5)' : 'rgba(245,158,11,0.2)'}`,
                  color: snipeScheduled ? '#fbbf24' : '#f59e0b',
                  transition: 'all 0.3s ease',
                }}
                disabled={!canExecute}
                onClick={handleSnipe}
              >
                {snipeScheduled ? (
                  <>
                    <Clock size={14} />
                    스나이핑 대기 중... (취소하려면 클릭)
                  </>
                ) : (
                  <>
                    <Crosshair size={14} />
                    {simulationMode ? '[SIM] ' : ''}펀딩 직전 스나이핑
                  </>
                )}
              </button>
              {!snipeScheduled && (
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'center', marginTop: -4 }}>
                  펀딩 30초 전 자동 진입 → 펀딩피 수령 → 즉시 청산
                </div>
              )}
              {snipeScheduled && snipeTargetTime && (
                <div style={{ fontSize: 11, color: '#fbbf24', textAlign: 'center', marginTop: -4 }}>
                  예정: {new Date(snipeTargetTime).toLocaleTimeString('ko-KR')} 직전 진입
                </div>
              )}
            </>
          )}

          {!canExecute && !isRunning && (
            <div style={{ fontSize: 11, color: 'var(--color-warning)', textAlign: 'center' }}>
              {simulationMode
                ? `시뮬 잔고 부족 (필요: $${strategyConfig.investmentUSDT})`
                : `${!hasShortConfig ? best.shortExchange.toUpperCase() : best.longExchange.toUpperCase()} API 키 필요`}
            </div>
          )}

          {/* Config summary */}
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--color-text-muted)', flexWrap: 'wrap' }}>
            <span>거래소당: <strong style={{ color: 'var(--color-text)' }}>${strategyConfig.investmentUSDT.toLocaleString()}</strong></span>
            <span>총 투자금: <strong style={{ color: '#f59e0b' }}>${(strategyConfig.investmentUSDT * 2).toLocaleString()}</strong></span>
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
    </>
  );
}
