'use client';

import { useState, useEffect, useCallback } from 'react';
import { History, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { fmtNum } from '@/lib/format';
import { useFundingStore } from '@/store/fundingStore';

const HISTORY_SCROLL_HEIGHT = 240;

interface TradeEvent {
  timestamp: number;
  type: string;
  simulation: boolean;
  baseAsset: string;
  // entry fields
  shortExchange?: string;
  longExchange?: string;
  spread?: number;
  spreadPercent?: number;
  margin?: number;
  leverage?: number;
  notional?: number;
  entryFee?: number;
  netProfit?: number;
  perFunding?: number;
  totalRoundTripFees?: number;
  pairId?: string;
  shortPrice?: number;
  longPrice?: number;
  shortLiquidity?: string;
  longLiquidity?: string;
  // exit fields
  exchange?: string;
  side?: string;
  symbol?: string;
  pnl?: number;
  fundingAmount?: number;
  fundingCollected?: number | null;
  exitFee?: number;
  pricePnl?: number;
  exitPrice?: number;
  liquidity?: string;
  detail?: string;
  success?: boolean;
}

interface HedgePair {
  pairId: string;
  baseAsset: string;
  entryTime: number;
  exitTime: number | null;
  shortExchange: string;
  longExchange: string;
  margin: number;
  leverage: number;
  notional: number;
  spreadPercent: number;
  expectedProfit: number;
  // exit breakdown
  shortExit: TradeEvent | null;
  longExit: TradeEvent | null;
  shortPnl: number;
  longPnl: number;
  totalPnl: number;
  shortFunding: number;
  longFunding: number;
  totalFunding: number;
  shortPricePnl: number;
  longPricePnl: number;
  status: 'open' | 'partial' | 'closed';
  completion?: TradeEvent | null;
  fundingVerified?: boolean | null; // null = 미확인, true = 검증됨, false = 검증 실패
  simulation: boolean;
}

function buildPairs(events: TradeEvent[]): HedgePair[] {
  const pairs = new Map<string, HedgePair>();

  // First pass: entries
  for (const ev of events) {
    if ((ev.type === 'snipe_entry' || ev.type === 'entry') && ev.pairId) {
      pairs.set(ev.pairId, {
        pairId: ev.pairId,
        baseAsset: ev.baseAsset,
        entryTime: ev.timestamp,
        exitTime: null,
        shortExchange: ev.shortExchange || '?',
        longExchange: ev.longExchange || '?',
        margin: ev.margin || 0,
        leverage: ev.leverage || 1,
        notional: ev.notional || 0,
        spreadPercent: ev.spreadPercent || 0,
        expectedProfit: ev.netProfit || 0,
        shortExit: null,
        longExit: null,
        shortPnl: 0,
        longPnl: 0,
        totalPnl: 0,
        shortFunding: 0,
        longFunding: 0,
        totalFunding: 0,
        shortPricePnl: 0,
        longPricePnl: 0,
        status: 'open',
        completion: null,
        simulation: ev.simulation ?? false,
      });
    }
  }

  // Second pass: exits — match by baseAsset + exchange + side + timestamp proximity
  const exits = events.filter(ev => ev.type === 'snipe_exit' || ev.type === 'exit');

  for (const ex of exits) {
    // Find the matching pair
    let matchedPair: HedgePair | null = null;
    if (ex.pairId && pairs.has(ex.pairId)) {
      matchedPair = pairs.get(ex.pairId) ?? null;
    }
    for (const pair of pairs.values()) {
      if (matchedPair) break;
      if (pair.baseAsset !== ex.baseAsset) continue;

      if (ex.side === 'short' && ex.exchange === pair.shortExchange && !pair.shortExit) {
        matchedPair = pair;
        break;
      }
      if (ex.side === 'long' && ex.exchange === pair.longExchange && !pair.longExit) {
        matchedPair = pair;
        break;
      }
    }

    if (!matchedPair) continue;

    if (ex.side === 'short') {
      matchedPair.shortExit = ex;
      matchedPair.shortPnl = ex.pnl ?? 0;
      matchedPair.shortFunding = ex.fundingAmount ?? 0;
      matchedPair.shortPricePnl = ex.pricePnl ?? 0;
    } else {
      matchedPair.longExit = ex;
      matchedPair.longPnl = ex.pnl ?? 0;
      matchedPair.longFunding = ex.fundingAmount ?? 0;
      matchedPair.longPricePnl = ex.pricePnl ?? 0;
    }

    matchedPair.exitTime = ex.timestamp;
    matchedPair.totalPnl = matchedPair.shortPnl + matchedPair.longPnl;
    matchedPair.totalFunding = matchedPair.shortFunding + matchedPair.longFunding;

    if (matchedPair.shortExit && matchedPair.longExit) {
      matchedPair.status = 'closed';
    } else {
      matchedPair.status = 'partial';
    }
  }

  // Third pass: pair completion events — prefer verified aggregate PnL/funding when present
  const completions = events.filter(ev => ev.type === 'snipe_complete');
  for (const completion of completions) {
    let matchedPair: HedgePair | null = null;
    if (completion.pairId && pairs.has(completion.pairId)) {
      matchedPair = pairs.get(completion.pairId) ?? null;
    }
    if (!matchedPair) {
      matchedPair = Array.from(pairs.values()).find(pair =>
        pair.baseAsset === completion.baseAsset
        && pair.shortExchange === completion.shortExchange
        && pair.longExchange === completion.longExchange
        && pair.status === 'closed',
      ) ?? null;
    }
    if (!matchedPair) continue;

    matchedPair.completion = completion;
    if (completion.fundingCollected != null) {
      matchedPair.totalFunding = completion.fundingCollected;
    }
    if (completion.pnl != null) {
      matchedPair.totalPnl = completion.pnl;
    }
    // detail 필드에서 fundingVerified 상태 파싱
    if (completion.detail) {
      const verifiedMatch = completion.detail.match(/fundingVerified:(true|false)/);
      if (verifiedMatch) {
        matchedPair.fundingVerified = verifiedMatch[1] === 'true';
      }
    }
  }

  return Array.from(pairs.values()).sort((a, b) => b.entryTime - a.entryTime);
}

function PairRow({ pair }: { pair: HedgePair }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(pair.entryTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const pnlColor = pair.totalPnl >= 0 ? '#10b981' : '#ef4444';
  const statusColor = pair.status === 'closed' ? '#6b7280' : pair.status === 'partial' ? '#f59e0b' : '#3b82f6';
  const statusLabel = pair.status === 'closed' ? '완료' : pair.status === 'partial' ? '일부' : '진행중';

  const investmentUSDT = pair.margin * 2; // 숏+롱 양쪽 마진
  const actualTotalFees = (pair.shortExit?.entryFee ?? 0) + (pair.shortExit?.exitFee ?? 0)
    + (pair.longExit?.entryFee ?? 0) + (pair.longExit?.exitFee ?? 0);
  const displayTotalFees = pair.status === 'closed' && actualTotalFees > 0
    ? actualTotalFees
    : pair.notional * 0.002;

  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      {/* Summary row */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'grid',
          gridTemplateColumns: '50px 70px 1fr 80px 80px 80px 80px 30px',
          alignItems: 'center',
          padding: '10px 12px',
          cursor: 'pointer',
          fontSize: 12,
          transition: 'background 0.15s',
          background: expanded ? 'rgba(255,255,255,0.03)' : 'transparent',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
        onMouseLeave={e => (e.currentTarget.style.background = expanded ? 'rgba(255,255,255,0.03)' : 'transparent')}
      >
        <span style={{ color: statusColor, fontSize: 10, fontWeight: 700 }}>
          {statusLabel}
          {pair.status === 'closed' && pair.fundingVerified === true && (
            <span title="펀딩 검증 완료" style={{ color: '#10b981', marginLeft: 2 }}>&#10003;</span>
          )}
          {pair.status === 'closed' && pair.fundingVerified === false && (
            <span title="펀딩 미검증 — 거래소 정산 내역 확인 필요" style={{ color: '#f59e0b', marginLeft: 2 }}>?</span>
          )}
        </span>
        <span style={{ fontWeight: 700, color: '#e2e8f0' }}>
          {pair.baseAsset}
          <span style={{
            fontSize: 8, fontWeight: 700, marginLeft: 4, padding: '1px 4px', borderRadius: 3,
            background: pair.simulation ? 'rgba(139,92,246,0.2)' : 'rgba(239,68,68,0.2)',
            color: pair.simulation ? '#a78bfa' : '#ef4444',
          }}>
            {pair.simulation ? '[SIM]실체결' : '[REAL]실체결'}
          </span>
        </span>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>
          {`숏:${pair.shortExchange.toUpperCase()} / 롱:${pair.longExchange.toUpperCase()}`}
        </span>
        <span className="mono" style={{ color: '#a78bfa', fontSize: 10, fontWeight: 600, textAlign: 'right' }}>
          ${fmtNum(investmentUSDT, 0)}
        </span>
        <span className="mono" style={{ color: pair.totalFunding >= 0 ? '#10b981' : '#ef4444', fontWeight: 600, textAlign: 'right' }}>
          {pair.totalFunding >= 0 ? '+' : ''}{fmtNum(pair.totalFunding, 2)}
        </span>
        <span className="mono" style={{ color: pnlColor, fontWeight: 700, textAlign: 'right' }}>
          {pair.totalPnl >= 0 ? '+' : ''}{fmtNum(pair.totalPnl, 2)}
        </span>
        <span style={{ color: '#64748b', fontSize: 10, textAlign: 'right' }}>{time}</span>
        {expanded ? <ChevronUp size={14} color="#64748b" /> : <ChevronDown size={14} color="#64748b" />}
      </div>

      {/* Detail rows */}
      {expanded && (
        <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Entry info */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr',
            gap: 8, padding: '8px 12px', borderRadius: 8,
            background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)',
            fontSize: 11,
          }}>
            <div>
              <div style={{ color: '#64748b', marginBottom: 2 }}>투자금</div>
              <div className="mono" style={{ color: '#a78bfa', fontWeight: 700 }}>${fmtNum(investmentUSDT, 0)}</div>
              <div style={{ color: '#64748b', fontSize: 9, marginTop: 1 }}>숏+롱 각 ${fmtNum(pair.margin, 0)}</div>
            </div>
            <div>
              <div style={{ color: '#64748b', marginBottom: 2 }}>노셔널</div>
              <div className="mono" style={{ color: '#e2e8f0', fontWeight: 600 }}>${fmtNum(pair.notional, 0)}</div>
              <div style={{ color: '#64748b', fontSize: 9, marginTop: 1 }}>{pair.leverage}x 레버리지</div>
            </div>
            <div>
              <div style={{ color: '#64748b', marginBottom: 2 }}>스프레드</div>
              <div className="mono" style={{ color: '#e2e8f0', fontWeight: 600 }}>{fmtNum(pair.spreadPercent, 4)}%</div>
            </div>
            <div>
              <div style={{ color: '#64748b', marginBottom: 2 }}>수수료 (왕복)</div>
              <div className="mono" style={{ color: '#ef4444', fontWeight: 600 }}>-${fmtNum(displayTotalFees, 2)}</div>
              <div style={{ color: '#64748b', fontSize: 9, marginTop: 1 }}>
                {pair.status === 'closed' && actualTotalFees > 0 ? '실체결 추정치' : '하드코딩 기준'}
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b', marginBottom: 2 }}>체결 효율</div>
              {(() => {
                const totalFees = displayTotalFees;
                const grossProfit = pair.totalPnl + totalFees;
                const expected = pair.expectedProfit + totalFees;
                const efficiency = expected > 0 ? (grossProfit / expected) * 100 : 0;
                const effColor = efficiency >= 90 ? '#10b981' : efficiency >= 70 ? '#f59e0b' : '#ef4444';
                return pair.status === 'closed' ? (
                  <>
                    <div className="mono" style={{ color: effColor, fontWeight: 700 }}>{fmtNum(efficiency, 1)}%</div>
                    <div style={{ color: '#64748b', fontSize: 9, marginTop: 1 }}>실제/예상 비율</div>
                  </>
                ) : (
                  <div className="mono" style={{ color: '#64748b' }}>—</div>
                );
              })()}
            </div>
          </div>

          {/* Short side */}
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
            fontSize: 11,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ color: '#ef4444', fontWeight: 700, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)' }}>SHORT</span>
              <span style={{ color: '#94a3b8' }}>{pair.shortExchange.toUpperCase()}</span>
              {pair.shortExit && (
                <span className="mono" style={{ marginLeft: 'auto', color: pair.shortPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                  {pair.shortPnl >= 0 ? '+' : ''}${fmtNum(pair.shortPnl, 2)}
                </span>
              )}
            </div>
            {pair.shortExit ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, color: '#94a3b8' }}>
                <div>가격손익: <span className="mono" style={{ color: pair.shortPricePnl >= 0 ? '#10b981' : '#ef4444' }}>${fmtNum(pair.shortPricePnl, 2)}</span></div>
                <div>펀딩: <span className="mono" style={{ color: pair.shortFunding >= 0 ? '#10b981' : '#ef4444' }}>${fmtNum(pair.shortFunding, 4)}</span></div>
                <div>수수료: <span className="mono" style={{ color: '#ef4444' }}>-${fmtNum((pair.shortExit.entryFee ?? 0) + (pair.shortExit.exitFee ?? 0), 2)}</span></div>
              </div>
            ) : (
              <div style={{ color: '#64748b' }}>아직 청산되지 않음</div>
            )}
          </div>

          {/* Long side */}
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)',
            fontSize: 11,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ color: '#10b981', fontWeight: 700, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.15)' }}>LONG</span>
              <span style={{ color: '#94a3b8' }}>{pair.longExchange.toUpperCase()}</span>
              {pair.longExit && (
                <span className="mono" style={{ marginLeft: 'auto', color: pair.longPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                  {pair.longPnl >= 0 ? '+' : ''}${fmtNum(pair.longPnl, 2)}
                </span>
              )}
            </div>
            {pair.longExit ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, color: '#94a3b8' }}>
                <div>가격손익: <span className="mono" style={{ color: pair.longPricePnl >= 0 ? '#10b981' : '#ef4444' }}>${fmtNum(pair.longPricePnl, 2)}</span></div>
                <div>펀딩: <span className="mono" style={{ color: pair.longFunding >= 0 ? '#10b981' : '#ef4444' }}>${fmtNum(pair.longFunding, 4)}</span></div>
                <div>수수료: <span className="mono" style={{ color: '#ef4444' }}>-${fmtNum((pair.longExit.entryFee ?? 0) + (pair.longExit.exitFee ?? 0), 2)}</span></div>
              </div>
            ) : (
              <div style={{ color: '#64748b' }}>아직 청산되지 않음</div>
            )}
          </div>

          {/* Combined summary */}
          {pair.status === 'closed' && (
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr',
              gap: 8, padding: '8px 12px', borderRadius: 8,
              background: pair.totalPnl >= 0 ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${pair.totalPnl >= 0 ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
              fontSize: 11,
            }}>
              <div>
                <div style={{ color: '#64748b', marginBottom: 2 }}>총 가격손익</div>
                <div className="mono" style={{ color: (pair.shortPricePnl + pair.longPricePnl) >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                  ${fmtNum(pair.shortPricePnl + pair.longPricePnl, 2)}
                </div>
              </div>
              <div>
                <div style={{ color: '#64748b', marginBottom: 2 }}>총 펀딩</div>
                <div className="mono" style={{ color: pair.totalFunding >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                  ${fmtNum(pair.totalFunding, 2)}
                </div>
              </div>
              <div>
                <div style={{ color: '#64748b', marginBottom: 2 }}>예상수익</div>
                <div className="mono" style={{ color: '#94a3b8', fontWeight: 600 }}>
                  ${fmtNum(pair.expectedProfit, 2)}
                </div>
              </div>
              <div>
                <div style={{ color: '#64748b', marginBottom: 2 }}>실제 합산</div>
                <div className="mono" style={{ color: pair.totalPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 800, fontSize: 13 }}>
                  {pair.totalPnl >= 0 ? '+' : ''}${fmtNum(pair.totalPnl, 2)}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TradeHistory() {
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const tradesClearedAt = useFundingStore(s => s.tradesClearedAt);

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    try {
      const typeQuery = 'type=snipe_entry,snipe_exit,entry,exit,snipe_complete';
      const res = await fetch(`/api/trades/list?all=true&${typeQuery}`);
      const json = await res.json() as { success?: boolean; events?: TradeEvent[] };
      if (!json.success || !Array.isArray(json.events)) {
        setEvents([]);
        return;
      }
      setEvents(json.events);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTrades(); }, [fetchTrades, tradesClearedAt]);

  const pairs = buildPairs(events);
  const closedPairs = pairs.filter(p => p.status === 'closed');
  const totalPnl = closedPairs.reduce((s, p) => s + p.totalPnl, 0);
  const totalFunding = closedPairs.reduce((s, p) => s + p.totalFunding, 0);
  const closedCount = closedPairs.length;

  if (pairs.length === 0 && !loading) return null;

  return (
    <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 16px', cursor: 'pointer',
          borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <History size={16} color="#f59e0b" />
        <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>
          거래 내역
        </span>
        <span style={{ fontSize: 11, color: '#64748b' }}>
          {closedCount}건 완료
        </span>
        {closedCount > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 4 }}>
            <span className="mono" style={{
              fontSize: 12, fontWeight: 700,
              color: totalPnl >= 0 ? '#10b981' : '#ef4444',
            }}>
              순손익: {totalPnl >= 0 ? '+' : ''}${fmtNum(totalPnl, 2)}
            </span>
            <span style={{ fontSize: 10, color: '#64748b' }}>
              (펀딩: <span style={{ color: totalFunding >= 0 ? '#10b981' : '#ef4444' }}>{totalFunding >= 0 ? '+' : ''}${fmtNum(totalFunding, 2)}</span>
              {' '}| 가격+수수료: <span style={{ color: (totalPnl - totalFunding) >= 0 ? '#10b981' : '#ef4444' }}>{(totalPnl - totalFunding) >= 0 ? '+' : ''}${fmtNum(totalPnl - totalFunding, 2)}</span>)
            </span>
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={e => { e.stopPropagation(); fetchTrades(); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
            title="새로고침"
          >
            <RefreshCw size={13} color="#64748b" className={loading ? 'spin' : ''} />
          </button>
          {collapsed ? <ChevronDown size={16} color="#64748b" /> : <ChevronUp size={16} color="#64748b" />}
        </div>
      </div>

      {/* Table header + rows */}
      {!collapsed && (
        <div style={{ maxHeight: HISTORY_SCROLL_HEIGHT, overflowY: 'auto' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '50px 70px 1fr 80px 80px 80px 80px 30px',
            padding: '6px 12px',
            fontSize: 10,
            color: '#64748b',
            fontWeight: 600,
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            background: 'rgba(255,255,255,0.02)',
          }}>
            <span>상태</span>
            <span>코인</span>
            <span>거래소</span>
            <span style={{ textAlign: 'right' }}>투자금</span>
            <span style={{ textAlign: 'right' }}>펀딩</span>
            <span style={{ textAlign: 'right' }}>합산 PnL</span>
            <span style={{ textAlign: 'right' }}>시각</span>
            <span></span>
          </div>
          {pairs.map(pair => (
            <PairRow key={pair.pairId} pair={pair} />
          ))}
          {pairs.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
              거래 내역이 없습니다
            </div>
          )}
        </div>
      )}
    </div>
  );
}
