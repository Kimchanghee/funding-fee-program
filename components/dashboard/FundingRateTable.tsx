'use client';

import { useState, useMemo } from 'react';
import { Search, ChevronUp, ChevronDown, ArrowUpDown } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId } from '@/lib/types';
import { estimateProfit } from '@/lib/opportunities';
import { fmtNum } from '@/lib/format';

type SortField = 'netProfit' | 'spread' | 'annualReturn' | 'baseAsset' | 'minutesToFunding';
type SortDir = 'asc' | 'desc';

function RateBadge({ rate, size = 'md' }: { rate: number; size?: 'sm' | 'md' }) {
  const color = rate > 0.001 ? '#ef4444' : rate > 0 ? '#f59e0b' : rate < -0.001 ? '#10b981' : '#94a3b8';
  const fontSize = size === 'sm' ? 11 : 13;
  return (
    <span className="mono" style={{ fontSize, fontWeight: 700, color }}>
      {rate >= 0 ? '+' : ''}{(rate * 100).toFixed(4)}%
    </span>
  );
}

function ExchangeTag({ exchange }: { exchange: ExchangeId }) {
  const color = EXCHANGE_COLORS[exchange] || '#94a3b8';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 700,
        background: `${color}22`,
        color,
        border: `1px solid ${color}33`,
        letterSpacing: '0.05em',
        whiteSpace: 'nowrap',
      }}
    >
      {EXCHANGE_NAMES[exchange]}
    </span>
  );
}

export default function FundingRateTable() {
  const { opportunities, strategyConfig, isLoadingRates } = useFundingStore();
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('netProfit');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
    setPage(0);
  };

  const filtered = useMemo(() => {
    let list = opportunities.filter(o => o.netProfit > 0);
    if (search) {
      list = list.filter(o => o.baseAsset.toLowerCase().includes(search.toLowerCase()));
    }
    list.sort((a, b) => {
      const mul = sortDir === 'asc' ? 1 : -1;
      if (sortField === 'netProfit') return (a.netProfit - b.netProfit) * mul;
      if (sortField === 'spread') return (a.spread - b.spread) * mul;
      if (sortField === 'annualReturn') return (a.annualReturnPercent - b.annualReturnPercent) * mul;
      if (sortField === 'baseAsset') return a.baseAsset.localeCompare(b.baseAsset) * mul;
      if (sortField === 'minutesToFunding') return (a.minutesToFunding - b.minutesToFunding) * mul;
      return 0;
    });
    return list;
  }, [opportunities, search, sortField, sortDir]);

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={11} style={{ opacity: 0.4 }} />;
    return sortDir === 'desc' ? <ChevronDown size={11} /> : <ChevronUp size={11} />;
  };

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
    cursor: 'pointer',
    userSelect: 'none',
  };

  return (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)' }}>펀딩률 기회 목록</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {filtered.length}개 아비트라지 쌍 • 10초마다 업데이트
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {/* Search */}
        <div style={{ position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)' }} />
          <input
            className="input-field"
            style={{ width: 180, paddingLeft: 30, paddingTop: 7, paddingBottom: 7 }}
            placeholder="코인 검색 (BTC, ETH...)"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
          />
        </div>
        {isLoadingRates && (
          <div style={{ width: 16, height: 16, border: '2px solid var(--color-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 40 }}>#</th>
              <th style={thStyle} onClick={() => handleSort('baseAsset')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>코인 <SortIcon field="baseAsset" /></div>
              </th>
              <th style={thStyle}>숏 거래소</th>
              <th style={thStyle}>숏 펀딩률</th>
              <th style={thStyle}>롱 거래소</th>
              <th style={thStyle}>롱 펀딩률</th>
              <th style={thStyle} onClick={() => handleSort('spread')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>스프레드 <SortIcon field="spread" /></div>
              </th>
              <th style={thStyle} onClick={() => handleSort('annualReturn')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>연수익률 <SortIcon field="annualReturn" /></div>
              </th>
              <th style={{ ...thStyle }}>
                {`8h 수익 (총 $${(strategyConfig.investmentUSDT * 2).toLocaleString()} x${strategyConfig.leverage})`}
              </th>
              <th style={thStyle} onClick={() => handleSort('minutesToFunding')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>다음 펀딩 <SortIcon field="minutesToFunding" /></div>
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
                  {isLoadingRates && opportunities.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                      <div style={{ width: 16, height: 16, border: '2px solid var(--color-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                      5개 거래소 펀딩률 데이터 조회 중...
                    </div>
                  ) : '조건에 맞는 기회 없음'}
                </td>
              </tr>
            ) : (
              paged.map((opp, i) => {
                const profit = estimateProfit(opp, strategyConfig.investmentUSDT, strategyConfig.leverage);
                const rank = page * PAGE_SIZE + i + 1;
                const isTop = rank <= 3;
                return (
                  <tr
                    key={opp.id}
                    className="table-row-hover"
                    style={{
                      borderBottom: '1px solid rgba(30,45,66,0.6)',
                      background: rank === 1 ? 'rgba(16,185,129,0.04)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                      <span className="mono" style={{ fontSize: 11, color: isTop ? '#10b981' : 'var(--color-text-muted)', fontWeight: isTop ? 700 : 400 }}>
                        {rank}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {rank === 1 && <span style={{ fontSize: 12 }}>⭐</span>}
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)' }}>{opp.baseAsset}</span>
                        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>/USDT</span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <ExchangeTag exchange={opp.shortExchange} />
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <RateBadge rate={opp.shortRate} />
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <ExchangeTag exchange={opp.longExchange} />
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <RateBadge rate={opp.longRate} />
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 800, color: '#10b981' }}>
                        +{opp.spreadPercent.toFixed(4)}%
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: profit.roiPerYear > 100 ? '#10b981' : profit.roiPerYear > 30 ? '#f59e0b' : 'var(--color-text-muted)' }}>
                        {profit.roiPerYear.toFixed(1)}%
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: profit.netPerFunding > 0 ? '#10b981' : '#ef4444' }}>
                        ${fmtNum(profit.netPerFunding)}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--color-text-muted)', display: 'block' }}>
                        수수료 -${fmtNum(profit.totalFees)}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {(() => {
                        const intervalH = opp.fundingIntervalMs ? Math.round(opp.fundingIntervalMs / 3600000) : 8;
                        const isShortInterval = intervalH < 8;
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 12, color: opp.minutesToFunding < 60 ? '#f59e0b' : 'var(--color-text-muted)' }}>
                              {opp.minutesToFunding < 60
                                ? `${opp.minutesToFunding}분`
                                : `${Math.floor(opp.minutesToFunding / 60)}h ${opp.minutesToFunding % 60}m`}
                            </span>
                            <span style={{
                              fontSize: 9,
                              fontWeight: 600,
                              color: isShortInterval ? '#10b981' : 'var(--color-text-muted)',
                              opacity: isShortInterval ? 1 : 0.6,
                            }}>
                              {intervalH}h 주기{isShortInterval ? ' ⚡' : ''}
                            </span>
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}
          </span>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={page === 0} onClick={() => setPage(p => p - 1)}>
            ← 이전
          </button>
          <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
            다음 →
          </button>
        </div>
      )}
    </div>
  );
}
