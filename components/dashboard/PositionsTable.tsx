'use client';

import { useState } from 'react';
import { X, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId } from '@/lib/types';
import type { Position } from '@/lib/types';

function PnlCell({ value, percent }: { value: number; percent: number }) {
  const positive = value >= 0;
  const color = positive ? '#10b981' : '#ef4444';
  return (
    <div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 700, color }}>
        {positive ? '+' : ''}${Math.abs(value).toFixed(2)}
      </div>
      <div className="mono" style={{ fontSize: 10, color: `${color}aa` }}>
        {positive ? '+' : ''}{percent.toFixed(2)}%
      </div>
    </div>
  );
}

function CloseModal({ position, onClose }: { position: Position; onClose: () => void }) {
  const { closePosition } = useFundingStore();
  const [loading, setLoading] = useState(false);

  const handleClose = async () => {
    setLoading(true);
    await closePosition(position);
    setLoading(false);
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        className="glass-card animate-slide-in"
        style={{ padding: 28, minWidth: 360, maxWidth: 420 }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text)', marginBottom: 16 }}>
          포지션 청산 확인
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {[
            ['거래소', EXCHANGE_NAMES[position.exchange as ExchangeId]],
            ['코인', position.displaySymbol],
            ['방향', position.side === 'long' ? '롱 (LONG)' : '숏 (SHORT)'],
            ['수량', `${position.size.toFixed(4)} ${position.baseAsset}`],
            ['미실현 손익', `${position.unrealizedPnl >= 0 ? '+' : ''}$${position.unrealizedPnl.toFixed(2)}`],
          ].map(([label, val]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
              <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>{val}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>취소</button>
          <button
            className="btn btn-danger"
            style={{ flex: 1 }}
            onClick={handleClose}
            disabled={loading}
          >
            {loading ? (
              <div style={{ width: 14, height: 14, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            ) : null}
            청산 실행
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PositionsTable() {
  const { positions, isLoadingPositions, refreshPositions, simulationMode, simPositions, closeSimPosition, automationActive, fundingRates } = useFundingStore();
  const [closeTarget, setCloseTarget] = useState<Position | null>(null);
  const [sideFilter, setSideFilter] = useState<'all' | 'long' | 'short'>('all');

  const activePositions = simulationMode ? (simPositions as unknown as Position[]) : positions;
  const filtered = activePositions.filter(p => sideFilter === 'all' || p.side === sideFilter);

  const totalPnl = activePositions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalMargin = activePositions.reduce((s, p) => s + p.margin, 0);
  const totalFundingCollected = simulationMode
    ? simPositions.reduce((s, p) => s + p.fundingCollected, 0)
    : 0;

  const thStyle: React.CSSProperties = {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    letterSpacing: '0.05em',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--bg-card)',
    whiteSpace: 'nowrap',
  };

  return (
    <>
      <div className="glass-card" style={{ overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {simulationMode ? '[SIM] 시뮬 포지션' : '활성 포지션'}
              {automationActive && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 10,
                  background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)',
                  fontSize: 10, fontWeight: 700, color: '#10b981',
                }}>
                  <div className="automation-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
                  자동감시
                </span>
              )}
              {activePositions.length > 0 && (
                <span style={{ padding: '2px 7px', borderRadius: 10, background: 'var(--bg-accent)', fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {activePositions.length}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 1 }}>
              {activePositions.length > 0 ? '미실현 손익: ' : '포지션 없음'}
              {activePositions.length > 0 && (
                <span className="mono" style={{ fontWeight: 700, color: totalPnl >= 0 ? '#10b981' : '#ef4444' }}>
                  {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                </span>
              )}
              {activePositions.length > 0 && (
                <span style={{ color: 'var(--color-text-muted)' }}>
                  {' '}• 총 마진: <span className="mono">${totalMargin.toFixed(2)}</span>
                </span>
              )}
              {simulationMode && activePositions.length > 0 && (
                <span style={{ color: '#a78bfa' }}>
                  {' '}• 수령 펀딩: <span className="mono" style={{ fontWeight: 700 }}>
                    {totalFundingCollected >= 0 ? '+' : ''}${totalFundingCollected.toFixed(4)}
                  </span>
                </span>
              )}
            </div>
          </div>
          <div style={{ flex: 1 }} />

          {/* Side filter */}
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', 'long', 'short'] as const).map(s => (
              <button
                key={s}
                className="btn btn-ghost"
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  background: sideFilter === s ? 'var(--bg-accent2)' : 'transparent',
                  color: sideFilter === s
                    ? s === 'long' ? '#10b981' : s === 'short' ? '#ef4444' : 'var(--color-text)'
                    : 'var(--color-text-muted)',
                }}
                onClick={() => setSideFilter(s)}
              >
                {s === 'all' ? '전체' : s === 'long' ? '↑ 롱' : '↓ 숏'}
              </button>
            ))}
          </div>

          <button
            className="btn btn-ghost"
            style={{ padding: '6px 10px' }}
            onClick={() => refreshPositions()}
            disabled={isLoadingPositions}
          >
            <RefreshCw size={13} style={{ animation: isLoadingPositions ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>거래소</th>
                <th style={thStyle}>코인</th>
                <th style={thStyle}>방향</th>
                <th style={thStyle}>레버리지</th>
                <th style={thStyle}>진입가</th>
                <th style={thStyle}>현재가</th>
                <th style={thStyle}>수량</th>
                <th style={thStyle}>마진</th>
                <th style={thStyle}>미실현 손익</th>
                <th style={thStyle}>청산가</th>
                {simulationMode && <th style={thStyle}>수령 펀딩</th>}
                {simulationMode && <th style={thStyle}>스프레드</th>}
                <th style={{ ...thStyle, textAlign: 'right' }}>청산</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={simulationMode ? 13 : 11} style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
                    {!simulationMode && isLoadingPositions ? '포지션 로딩 중...' : simulationMode ? '[SIM] 진입한 포지션 없음' : '활성 포지션 없음'}
                  </td>
                </tr>
              ) : (
                filtered.map((pos, i) => {
                  const color = EXCHANGE_COLORS[pos.exchange as ExchangeId] || '#94a3b8';
                  const simPos = simulationMode ? simPositions.find(sp => (sp as unknown as Position) === pos || sp.simId === (pos as unknown as { simId: string }).simId) : undefined;
                  return (
                    <tr
                      key={simPos ? simPos.simId : `${pos.exchange}-${pos.symbol}-${pos.side}-${i}`}
                      className="table-row-hover"
                      style={{
                        borderBottom: '1px solid rgba(30,45,66,0.6)',
                        borderLeft: `3px solid ${pos.side === 'long' ? '#10b98133' : '#ef444433'}`,
                      }}
                    >
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}22`, padding: '2px 8px', borderRadius: 6 }}>
                          {EXCHANGE_NAMES[pos.exchange as ExchangeId] || pos.exchange.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>
                          {pos.displaySymbol || pos.symbol.split(':')[0]}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {pos.side === 'long'
                            ? <TrendingUp size={12} color="#10b981" />
                            : <TrendingDown size={12} color="#ef4444" />
                          }
                          <span style={{ fontSize: 12, fontWeight: 700, color: pos.side === 'long' ? '#10b981' : '#ef4444' }}>
                            {pos.side === 'long' ? '롱' : '숏'}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--color-text)' }}>{pos.leverage}x</span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--color-text)' }}>
                          ${pos.entryPrice.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--color-text)' }}>
                          ${pos.markPrice.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--color-text)' }}>
                          {pos.size.toFixed(4)}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--color-text)' }}>
                          ${pos.margin.toFixed(2)}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <PnlCell value={pos.unrealizedPnl} percent={pos.unrealizedPnlPercent} />
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span className="mono" style={{ fontSize: 12, color: '#f59e0b' }}>
                          {pos.liquidationPrice > 0
                            ? `$${pos.liquidationPrice.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : '—'
                          }
                        </span>
                      </td>
                      {simulationMode && (
                        <td style={{ padding: '10px 14px' }}>
                          <span className="mono" style={{ fontSize: 12, color: simPos && simPos.fundingCollected >= 0 ? '#a78bfa' : '#ef4444', fontWeight: 700 }}>
                            {simPos ? `${simPos.fundingCollected >= 0 ? '+' : ''}$${simPos.fundingCollected.toFixed(4)}` : '—'}
                          </span>
                        </td>
                      )}
                      {simulationMode && (
                        <td style={{ padding: '10px 14px' }}>
                          {simPos ? (() => {
                            const liveRate = fundingRates.find(r => r.exchange === pos.exchange && r.symbol === pos.symbol);
                            const currentRate = liveRate?.rate ?? pos.fundingRate;
                            // Find the paired position
                            const pairTs = Math.floor(simPos.openedAt / 1000);
                            const paired = simPositions.find(p => p.simId !== simPos.simId && p.baseAsset === simPos.baseAsset && Math.floor(p.openedAt / 1000) === pairTs);
                            if (!paired) return <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>—</span>;
                            const pairedRate = fundingRates.find(r => r.exchange === paired.exchange && r.symbol === paired.symbol)?.rate ?? paired.fundingRate;
                            const currentSpread = simPos.side === 'short' ? currentRate - pairedRate : pairedRate - currentRate;
                            const entrySpread = simPos.spread;
                            const reversed = currentSpread <= 0;
                            return (
                              <div>
                                <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: reversed ? '#ef4444' : '#10b981' }}>
                                  {reversed ? '!' : ''}{(currentSpread * 100).toFixed(4)}%
                                </div>
                                <div className="mono" style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>
                                  진입: {(entrySpread * 100).toFixed(4)}%
                                </div>
                              </div>
                            );
                          })() : '—'}
                        </td>
                      )}
                      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                        <button
                          className="btn btn-danger"
                          style={{ padding: '4px 10px', fontSize: 11 }}
                          onClick={() => simPos ? closeSimPosition(simPos.simId) : setCloseTarget(pos)}
                        >
                          <X size={11} /> 청산
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {closeTarget && (
        <CloseModal position={closeTarget} onClose={() => setCloseTarget(null)} />
      )}
    </>
  );
}
