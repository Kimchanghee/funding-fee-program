'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, History, RefreshCw } from 'lucide-react';
import { fmtNum } from '@/lib/format';
import { formatTimestampYmdHmsMs } from '@/lib/timeFormat';
import {
  EXECUTED_TRADE_EVENT_TYPES,
  REASON_TRADE_EVENT_TYPES,
  buildTradePairsFromEvents,
  getExecutionModeLabel,
  type TradeEventLike,
  type TradePairSummary,
} from '@/lib/tradeEvents';
import { useFundingStore } from '@/store/fundingStore';

const HISTORY_SCROLL_HEIGHT = 240;
const PAGE_SIZE = 15;

function PairRow({ pair }: { pair: TradePairSummary }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = pair.status === 'closed' ? '#64748b' : pair.status === 'partial' ? '#f59e0b' : '#3b82f6';
  const statusLabel = pair.status === 'closed' ? '완료' : pair.status === 'partial' ? '부분' : '진행';
  const totalFee = pair.totalFees;
  const roi = pair.status === 'closed' ? pair.realizedRoiPercent : pair.expectedRoiPercent;

  return (
    <div className="trade-pair-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div
        className="trade-pair-row-main"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          display: 'grid',
          gridTemplateColumns: '50px 80px 1fr 90px 90px 90px 80px 170px 30px',
          alignItems: 'center',
          padding: '10px 12px',
          cursor: 'pointer',
          fontSize: 12,
          background: expanded ? 'rgba(255,255,255,0.03)' : 'transparent',
        }}
      >
        <span style={{ color: statusColor, fontSize: 10, fontWeight: 700 }}>{statusLabel}</span>
        <span style={{ fontWeight: 700, color: '#e2e8f0' }}>
          {pair.baseAsset}
          <span
            style={{
              marginLeft: 6,
              fontSize: 8,
              fontWeight: 700,
              padding: '1px 4px',
              borderRadius: 3,
              background: pair.simulation ? 'rgba(139,92,246,0.2)' : 'rgba(239,68,68,0.2)',
              color: pair.simulation ? '#a78bfa' : '#ef4444',
            }}
          >
          {getExecutionModeLabel(pair.simulation)}
          </span>
        </span>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>
          숏:{pair.shortExchange.toUpperCase()} / 롱:{pair.longExchange.toUpperCase()}
        </span>
        <span className="mono" style={{ color: '#a78bfa', textAlign: 'right' }}>
          ${fmtNum(pair.totalMargin, 0)}
        </span>
        <span className="mono" style={{ color: pair.totalFunding >= 0 ? '#10b981' : '#ef4444', textAlign: 'right' }}>
          {pair.totalFunding >= 0 ? '+' : ''}{fmtNum(pair.totalFunding, 2)}
        </span>
        <span className="mono" style={{ color: pair.totalPnl >= 0 ? '#10b981' : '#ef4444', textAlign: 'right', fontWeight: 700 }}>
          {pair.totalPnl >= 0 ? '+' : ''}{fmtNum(pair.totalPnl, 2)}
        </span>
        <span className="mono" style={{ color: roi >= 0 ? '#10b981' : '#ef4444', textAlign: 'right', fontWeight: 700 }}>
          {roi >= 0 ? '+' : ''}{fmtNum(roi, 2)}%
        </span>
        <span style={{ color: '#64748b', fontSize: 10, textAlign: 'right' }}>
          {formatTimestampYmdHmsMs(pair.entryTime)}
        </span>
        {expanded ? <ChevronUp size={14} color="#64748b" /> : <ChevronDown size={14} color="#64748b" />}
      </div>

      {expanded && (
        <div className="trade-pair-expanded" style={{ padding: '0 12px 12px', display: 'grid', gap: 8 }}>
          <div className="trade-pair-summary-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', fontSize: 11 }}>
            <div>
              <div style={{ color: '#64748b' }}>투입금</div>
              <div className="mono" style={{ color: '#a78bfa', fontWeight: 700 }}>${fmtNum(pair.totalMargin, 0)}</div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>노셔널</div>
              <div className="mono" style={{ color: '#e2e8f0', fontWeight: 600 }}>${fmtNum(pair.notional, 0)}</div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>진입 스프레드</div>
              <div className="mono" style={{ color: '#e2e8f0', fontWeight: 600 }}>{fmtNum(pair.spreadPercent, 4)}%</div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>수수료</div>
              <div className="mono" style={{ color: '#ef4444', fontWeight: 600 }}>-${fmtNum(totalFee, 2)}</div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>예상순익</div>
              <div className="mono" style={{ color: '#94a3b8', fontWeight: 600 }}>${fmtNum(pair.expectedProfit, 2)}</div>
            </div>
          </div>

          <div className="trade-pair-result-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', fontSize: 11 }}>
            <div>
              <div style={{ color: '#64748b' }}>숏 가격PnL</div>
              <div className="mono" style={{ color: pair.shortPricePnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                ${fmtNum(pair.shortPricePnl, 2)}
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>롱 가격PnL</div>
              <div className="mono" style={{ color: pair.longPricePnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                ${fmtNum(pair.longPricePnl, 2)}
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>총 펀딩</div>
              <div className="mono" style={{ color: pair.totalFunding >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                ${fmtNum(pair.totalFunding, 2)}
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>최종 PnL</div>
              <div className="mono" style={{ color: pair.totalPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 800 }}>
                {pair.totalPnl >= 0 ? '+' : ''}${fmtNum(pair.totalPnl, 2)}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', fontSize: 11 }}>
            <div>
              <div style={{ color: '#64748b' }}>예상 수익률</div>
              <div className="mono" style={{ color: pair.expectedRoiPercent >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                {pair.expectedRoiPercent >= 0 ? '+' : ''}{fmtNum(pair.expectedRoiPercent, 2)}%
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>실현 수익률</div>
              <div className="mono" style={{ color: pair.realizedRoiPercent >= 0 ? '#10b981' : '#ef4444', fontWeight: 800 }}>
                {pair.realizedRoiPercent >= 0 ? '+' : ''}{fmtNum(pair.realizedRoiPercent, 2)}%
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TradeHistory() {
  const [events, setEvents] = useState<TradeEventLike[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [page, setPage] = useState(1);
  const simulationMode = useFundingStore((state) => state.simulationMode);
  const tradesClearedAt = useFundingStore((state) => state.tradesClearedAt);

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    try {
      const executedTypeQuery = 'type=snipe_entry,snipe_exit,entry,exit,auto_exit,snipe_complete,funding';
      const reasonTypeQuery = 'type=guard_block,schedule_probe';
      const scope = simulationMode ? 'sim_executed' : 'real_executed';
      const fromQuery = tradesClearedAt > 0 ? `&from=${tradesClearedAt}` : '';
      const simulationQuery = `simulation=${simulationMode ? 'true' : 'false'}`;
      const [executedRes, reasonRes] = await Promise.all([
        fetch(`/api/trades/list?all=true&scope=${scope}&${executedTypeQuery}${fromQuery}`),
        fetch(`/api/trades/list?all=true&scope=all&${simulationQuery}&${reasonTypeQuery}${fromQuery}`),
      ]);
      const executedJson = await executedRes.json() as { success?: boolean; events?: TradeEventLike[] };
      const reasonJson = await reasonRes.json() as { success?: boolean; events?: TradeEventLike[] };
      if (!executedJson.success || !Array.isArray(executedJson.events)) {
        setEvents([]);
        return;
      }
      const reasonEvents = reasonJson.success && Array.isArray(reasonJson.events) ? reasonJson.events : [];
      setEvents([...executedJson.events, ...reasonEvents].sort((a, b) => b.timestamp - a.timestamp));
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [simulationMode, tradesClearedAt]);

  useEffect(() => {
    void fetchTrades();
  }, [fetchTrades, tradesClearedAt, simulationMode]);

  const pairs = useMemo(() => buildTradePairsFromEvents(events.filter((event) => EXECUTED_TRADE_EVENT_TYPES.has(event.type))), [events]);
  const reasonEvents = useMemo(() => events.filter((event) => REASON_TRADE_EVENT_TYPES.has(event.type)), [events]);
  const latestReasonEvents = useMemo(() => reasonEvents.slice(0, 40), [reasonEvents]);
  const reasonSummary = useMemo(() => {
    const byReason = new Map<string, number>();
    for (const event of reasonEvents) {
      const key = `${event.type}:${event.reason ?? 'unknown'}`;
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    return Array.from(byReason.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => ({ key, count }));
  }, [reasonEvents]);
  const closedPairs = pairs.filter((pair) => pair.status === 'closed');
  const totalPnl = closedPairs.reduce((sum, pair) => sum + pair.totalPnl, 0);
  const totalFunding = closedPairs.reduce((sum, pair) => sum + pair.totalFunding, 0);
  const totalPages = Math.max(1, Math.ceil(pairs.length / PAGE_SIZE));
  const pagedPairs = pairs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const fromIndex = pairs.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toIndex = pairs.length === 0 ? 0 : Math.min(page * PAGE_SIZE, pairs.length);
  const panelTitle = simulationMode ? '[SIM] 거래 내역' : '[REAL] 거래 내역';

  useEffect(() => {
    setPage(1);
  }, [pairs.length, tradesClearedAt]);

  if (pairs.length === 0 && reasonEvents.length === 0 && !loading) return null;

  return (
    <div className="glass-card trade-history-panel" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        className="trade-history-header"
        onClick={() => setCollapsed((prev) => !prev)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 16px',
          cursor: 'pointer',
          borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <History size={16} color="#f59e0b" />
        <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{panelTitle}</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{closedPairs.length}건 완료</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{reasonEvents.length} reason</span>
        <span style={{ fontSize: 10, color: '#64748b' }}>{fromIndex}-{toIndex} / {pairs.length}</span>
        {closedPairs.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 4 }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: totalPnl >= 0 ? '#10b981' : '#ef4444' }}>
              순손익 {totalPnl >= 0 ? '+' : ''}${fmtNum(totalPnl, 2)}
            </span>
            <span style={{ fontSize: 10, color: '#64748b' }}>
              (펀딩 <span style={{ color: totalFunding >= 0 ? '#10b981' : '#ef4444' }}>{totalFunding >= 0 ? '+' : ''}${fmtNum(totalFunding, 2)}</span>)
            </span>
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={(event) => {
              event.stopPropagation();
              void fetchTrades();
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
            title="새로고침"
          >
            <RefreshCw size={13} color="#64748b" className={loading ? 'spin' : ''} />
          </button>
          {collapsed ? <ChevronDown size={16} color="#64748b" /> : <ChevronUp size={16} color="#64748b" />}
        </div>
      </div>

      {!collapsed && (
        <>
          {reasonSummary.length > 0 && (
            <div className="trade-history-reason-summary" style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>미진행 사유 요약</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {reasonSummary.map((entry) => (
                  <span
                    key={entry.key}
                    style={{
                      fontSize: 10,
                      borderRadius: 999,
                      padding: '2px 8px',
                      background: 'rgba(59,130,246,0.1)',
                      color: '#93c5fd',
                    }}
                  >
                    {entry.key} ({entry.count})
                  </span>
                ))}
              </div>
            </div>
          )}

          {latestReasonEvents.length > 0 && (
            <div className="trade-history-reason-events" style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>최근 미진행 이벤트</div>
              <div className="trade-history-reason-list" style={{ maxHeight: 180, overflowY: 'auto', fontSize: 11, display: 'grid', gap: 6 }}>
                {latestReasonEvents.map((event, index) => (
                  <div
                    key={`${event.type}-${event.timestamp}-${index}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '140px 120px 1fr',
                      gap: 8,
                      border: '1px solid rgba(59,130,246,0.2)',
                      borderRadius: 6,
                      padding: 8,
                      background: 'rgba(59,130,246,0.06)',
                    }}
                  >
                    <span style={{ color: '#93c5fd', whiteSpace: 'nowrap' }}>
                      {formatTimestampYmdHmsMs(event.timestamp)}
                    </span>
                    <span style={{ color: '#f59e0b' }}>
                      {event.type}:{event.reason ?? 'unknown'}
                    </span>
                    <span style={{ color: '#cbd5e1', wordBreak: 'break-all' }}>
                      {event.detail ?? 'no detail'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="trade-history-table-wrap" style={{ maxHeight: HISTORY_SCROLL_HEIGHT, overflowY: 'auto' }}>
            <div
              className="trade-history-table-header"
              style={{
                display: 'grid',
                gridTemplateColumns: '50px 80px 1fr 90px 90px 90px 80px 170px 30px',
                padding: '6px 12px',
                fontSize: 10,
                color: '#64748b',
                fontWeight: 600,
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              <span>상태</span>
              <span>코인</span>
              <span>거래소</span>
              <span style={{ textAlign: 'right' }}>투입금</span>
              <span style={{ textAlign: 'right' }}>펀딩</span>
              <span style={{ textAlign: 'right' }}>PnL</span>
              <span style={{ textAlign: 'right' }}>수익률</span>
              <span style={{ textAlign: 'right' }}>시간</span>
              <span />
            </div>

            {pagedPairs.map((pair) => (
              <PairRow key={pair.pairId} pair={pair} />
            ))}

            {pairs.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
                거래 내역이 없습니다
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div style={{ padding: '10px 12px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>{page} / {totalPages}</span>
              <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={page <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                이전
              </button>
              <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={page >= totalPages} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}>
                다음
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
