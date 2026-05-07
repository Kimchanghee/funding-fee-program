'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import {
  OPERABLE_EXCHANGES,
  EXCHANGE_NAMES,
  EXCHANGE_COLORS,
  getRawExchangeFee,
  getExchangeFee,
  getEffectivePaybackRates,
  getTotalPaybackRate,
} from '@/lib/types';

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

function fmtPayback(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default function FeePaybackSummary() {
  const { strategyConfig } = useFundingStore();
  const [openExchange, setOpenExchange] = useState<string | null>(null);

  const rows = useMemo(() => {
    return OPERABLE_EXCHANGES.map((exchange) => {
      const rawTaker = getRawExchangeFee(exchange, 'taker', strategyConfig.feeOverrides);
      const rawMaker = getRawExchangeFee(exchange, 'maker', strategyConfig.feeOverrides);
      const payback = getEffectivePaybackRates(exchange, strategyConfig.paybackOverrides);
      const totalPayback = getTotalPaybackRate(exchange, strategyConfig.paybackOverrides);
      const effectiveTaker = getExchangeFee(
        exchange,
        'taker',
        strategyConfig.feeOverrides,
        strategyConfig.paybackOverrides,
      );
      const effectiveMaker = getExchangeFee(
        exchange,
        'maker',
        strategyConfig.feeOverrides,
        strategyConfig.paybackOverrides,
      );
      return {
        exchange,
        rawTaker,
        rawMaker,
        accountA: payback.accountA,
        accountB: payback.accountB,
        totalPayback,
        effectiveTaker,
        effectiveMaker,
      };
    });
  }, [strategyConfig.feeOverrides, strategyConfig.paybackOverrides]);

  return (
    <div className="glass-card fee-payback-summary" style={{ padding: '14px 16px' }}>
      <div className="fee-payback-summary-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>
          거래소별 수수료/페이백 매트릭스
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          실제 계산식: 유효 수수료 = 원수수료 × (1 - 계정A - 계정B)
        </div>
      </div>

      <div className="fee-payback-summary-list" style={{ display: 'grid', gap: 8 }}>
        {rows.map((row) => {
          const open = openExchange === row.exchange;
          const panelId = `fee-payback-${row.exchange}`;
          return (
            <div
              key={row.exchange}
              style={{
                border: `1px solid ${open ? `${EXCHANGE_COLORS[row.exchange]}55` : 'rgba(30,45,66,0.72)'}`,
                borderRadius: 8,
                background: open ? `${EXCHANGE_COLORS[row.exchange]}0d` : 'rgba(15,22,35,0.58)',
                overflow: 'hidden',
              }}
            >
              <button
                className="fee-payback-summary-row"
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpenExchange(open ? null : row.exchange)}
                style={{
                  width: '100%',
                  minHeight: 48,
                  padding: '10px 12px',
                  border: 0,
                  background: 'transparent',
                  color: 'var(--color-text)',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(118px, 1fr) repeat(3, minmax(96px, auto)) 24px',
                  gap: 12,
                  alignItems: 'center',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ color: EXCHANGE_COLORS[row.exchange], fontWeight: 800, fontSize: 12 }}>
                  {EXCHANGE_NAMES[row.exchange]}
                </span>
                <SummaryMetric label="총 페이백" value={fmtPayback(row.totalPayback)} />
                <SummaryMetric label="유효 Taker" value={fmtPct(row.effectiveTaker)} accent />
                <SummaryMetric label="유효 Maker" value={fmtPct(row.effectiveMaker)} accent />
                <ChevronDown
                  size={16}
                  style={{
                    color: 'var(--color-text-muted)',
                    transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.16s ease',
                  }}
                />
              </button>

              {open && (
                <div
                  id={panelId}
                  style={{
                    borderTop: '1px solid rgba(30,45,66,0.72)',
                    padding: '10px 12px 12px',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                    gap: 8,
                  }}
                >
                  <DetailMetric label="원 Taker" value={fmtPct(row.rawTaker)} />
                  <DetailMetric label="원 Maker" value={fmtPct(row.rawMaker)} />
                  <DetailMetric label="계정A" value={fmtPayback(row.accountA)} />
                  <DetailMetric label="계정B" value={fmtPayback(row.accountB)} />
                  <DetailMetric label="총 페이백" value={fmtPayback(row.totalPayback)} />
                  <DetailMetric label="유효 Taker" value={fmtPct(row.effectiveTaker)} accent />
                  <DetailMetric label="유효 Maker" value={fmtPct(row.effectiveMaker)} accent />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryMetric({ label, value, accent = false }: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <span style={{ display: 'grid', gap: 2, justifyItems: 'end', minWidth: 0 }}>
      <span style={{ fontSize: 9, color: 'var(--color-text-muted)', fontWeight: 700, lineHeight: 1 }}>
        {label}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: accent ? '#10b981' : 'var(--color-text)', fontWeight: accent ? 800 : 700 }}>
        {value}
      </span>
    </span>
  );
}

function DetailMetric({ label, value, accent = false }: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div style={detailMetricStyle}>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: accent ? '#10b981' : 'var(--color-text)', fontWeight: accent ? 800 : 700 }}>
        {value}
      </div>
    </div>
  );
}

const detailMetricStyle: CSSProperties = {
  minWidth: 0,
  padding: '8px 10px',
  borderRadius: 6,
  background: 'rgba(10,14,23,0.42)',
  border: '1px solid rgba(30,45,66,0.58)',
};
