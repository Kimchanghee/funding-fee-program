'use client';

import { useMemo, type CSSProperties } from 'react';
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

      <div className="fee-payback-summary-table-wrap" style={{ overflowX: 'auto' }}>
        <table className="fee-payback-summary-table" style={{ width: '100%', minWidth: 880, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              <th style={th}>거래소</th>
              <th style={th}>원 Taker</th>
              <th style={th}>원 Maker</th>
              <th style={th}>계정A</th>
              <th style={th}>계정B</th>
              <th style={th}>총 페이백</th>
              <th style={th}>유효 Taker</th>
              <th style={th}>유효 Maker</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.exchange} style={{ borderBottom: '1px solid rgba(30,45,66,0.5)' }}>
                <td style={td}>
                  <span style={{ color: EXCHANGE_COLORS[row.exchange], fontWeight: 800 }}>
                    {EXCHANGE_NAMES[row.exchange]}
                  </span>
                </td>
                <td style={tdMono}>{fmtPct(row.rawTaker)}</td>
                <td style={tdMono}>{fmtPct(row.rawMaker)}</td>
                <td style={tdMono}>{fmtPayback(row.accountA)}</td>
                <td style={tdMono}>{fmtPayback(row.accountB)}</td>
                <td style={tdMono}>{fmtPayback(row.totalPayback)}</td>
                <td style={{ ...tdMono, color: '#10b981', fontWeight: 700 }}>{fmtPct(row.effectiveTaker)}</td>
                <td style={{ ...tdMono, color: '#10b981', fontWeight: 700 }}>{fmtPct(row.effectiveMaker)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: 11,
  color: 'var(--color-text-muted)',
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

const td: CSSProperties = {
  padding: '8px 10px',
  fontSize: 12,
  color: 'var(--color-text)',
  whiteSpace: 'nowrap',
};

const tdMono: CSSProperties = {
  ...td,
  fontFamily: 'var(--font-mono)',
};
