'use client';

import { ArrowRightLeft, MoveRight, Scale, Wallet } from 'lucide-react';
import { useMemo } from 'react';
import { buildBalanceEqualizationPlan } from '@/lib/balanceEqualization';
import { fmtNum } from '@/lib/format';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId } from '@/lib/types';
import { useFundingStore } from '@/store/fundingStore';

function ExchangeDeltaChip({
  exchange,
  averageBalanceUSDT,
  actualBalanceUSDT,
}: {
  exchange: ExchangeId;
  averageBalanceUSDT: number;
  actualBalanceUSDT: number;
}) {
  const deltaUSDT = actualBalanceUSDT - averageBalanceUSDT;
  const color = EXCHANGE_COLORS[exchange];
  const status = deltaUSDT > 25 ? 'SURPLUS' : deltaUSDT < -25 ? 'DEFICIT' : 'EVEN';
  const tone = status === 'SURPLUS'
    ? 'rgba(16,185,129,0.14)'
    : status === 'DEFICIT'
      ? 'rgba(239,68,68,0.14)'
      : 'rgba(148,163,184,0.12)';
  const toneBorder = status === 'SURPLUS'
    ? 'rgba(16,185,129,0.3)'
    : status === 'DEFICIT'
      ? 'rgba(239,68,68,0.3)'
      : 'rgba(148,163,184,0.25)';
  const toneText = status === 'SURPLUS'
    ? '#10b981'
    : status === 'DEFICIT'
      ? '#ef4444'
      : '#94a3b8';

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 10,
        background: tone,
        border: `1px solid ${toneBorder}`,
        minWidth: 128,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color }}>
          {EXCHANGE_NAMES[exchange]}
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 800,
            color: toneText,
            letterSpacing: '0.06em',
          }}
        >
          {status}
        </span>
      </div>
      <div className="mono" style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-text)' }}>
        ${fmtNum(actualBalanceUSDT, 0)}
      </div>
      <div style={{ fontSize: 10, color: toneText, marginTop: 3 }}>
        {deltaUSDT >= 0 ? '+' : '-'}${fmtNum(Math.abs(deltaUSDT), 0)} vs avg
      </div>
    </div>
  );
}

function ModeBalancePlanCard({
  label,
  active,
  accentColor,
  plan,
}: {
  label: 'SIM' | 'REAL';
  active: boolean;
  accentColor: string;
  plan: ReturnType<typeof buildBalanceEqualizationPlan>;
}) {
  const exchanges = plan.enabledExchanges
    .map((exchange) => ({
      exchange,
      balance: plan.actualBalances[exchange] ?? 0,
      delta: (plan.actualBalances[exchange] ?? 0) - plan.averageBalanceUSDT,
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const deficits = exchanges.filter((item) => item.delta < -25);
  const surpluses = exchanges.filter((item) => item.delta > 25);
  const topTransfers = plan.transfers.slice(0, 3);

  return (
    <div
      className="glass-card"
      style={{
        flex: 1,
        minWidth: 320,
        padding: 18,
        borderColor: active ? `${accentColor}55` : 'var(--color-border)',
        background: active
          ? `linear-gradient(135deg, ${accentColor}18, rgba(15,23,42,0.94))`
          : 'linear-gradient(135deg, rgba(15,23,42,0.92), rgba(15,23,42,0.84))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              background: `${accentColor}22`,
              border: `1px solid ${accentColor}44`,
            }}
          >
            {label === 'SIM' ? <Scale size={14} color={accentColor} /> : <Wallet size={14} color={accentColor} />}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: active ? accentColor : 'var(--color-text)' }}>
              {label} Balance Flow
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
              {active ? 'current mode' : 'background view'}
            </div>
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            padding: '4px 8px',
            borderRadius: 999,
            color: active ? accentColor : 'var(--color-text-muted)',
            border: `1px solid ${active ? `${accentColor}55` : 'var(--color-border)'}`,
            background: active ? `${accentColor}18` : 'rgba(148,163,184,0.08)',
          }}
        >
          AVG ${fmtNum(plan.averageBalanceUSDT, 0)}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
        <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(15,23,42,0.45)', border: '1px solid rgba(148,163,184,0.12)' }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>Total</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-text)' }}>
            ${fmtNum(plan.totalBalanceUSDT, 0)}
          </div>
        </div>
        <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.18)' }}>
          <div style={{ fontSize: 10, color: '#10b981' }}>Surplus</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: '#10b981' }}>
            {surpluses.length}
          </div>
        </div>
        <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.18)' }}>
          <div style={{ fontSize: 10, color: '#ef4444' }}>Deficit</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: '#ef4444' }}>
            {deficits.length}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        {exchanges.map((item) => (
          <ExchangeDeltaChip
            key={item.exchange}
            exchange={item.exchange}
            averageBalanceUSDT={plan.averageBalanceUSDT}
            actualBalanceUSDT={item.balance}
          />
        ))}
      </div>

      <div
        style={{
          padding: '12px 14px',
          borderRadius: 12,
          background: 'rgba(15,23,42,0.5)',
          border: '1px solid rgba(148,163,184,0.12)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <ArrowRightLeft size={14} color={accentColor} />
          <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--color-text)' }}>
            Recommended Flow
          </span>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            planning only
          </span>
        </div>

        {topTransfers.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {topTransfers.map((transfer, index) => (
              <div
                key={`${transfer.fromExchange}-${transfer.toExchange}-${index}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(148,163,184,0.12)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: EXCHANGE_COLORS[transfer.fromExchange] }}>
                    {EXCHANGE_NAMES[transfer.fromExchange]}
                  </span>
                  <MoveRight size={13} color="var(--color-text-muted)" />
                  <span style={{ fontSize: 10, fontWeight: 800, color: EXCHANGE_COLORS[transfer.toExchange] }}>
                    {EXCHANGE_NAMES[transfer.toExchange]}
                  </span>
                </div>
                <span className="mono" style={{ fontSize: 12, fontWeight: 800, color: '#f8fafc' }}>
                  ${fmtNum(transfer.amountUSDT, 0)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            현재 기준으로 평균 잔고와 크게 어긋난 거래소가 없습니다.
          </div>
        )}
      </div>
    </div>
  );
}

export default function BalanceEqualizationPanel() {
  const { enabledExchanges, simulationMode, simBalances, balances } = useFundingStore();

  const realBalanceMap = useMemo(() => {
    const next = {} as Partial<Record<ExchangeId, number>>;
    for (const exchange of enabledExchanges) {
      next[exchange] = balances[exchange]?.availableUSDT ?? 0;
    }
    return next;
  }, [balances, enabledExchanges]);

  const simPlan = useMemo(
    () => buildBalanceEqualizationPlan(enabledExchanges, simBalances),
    [enabledExchanges, simBalances],
  );
  const realPlan = useMemo(
    () => buildBalanceEqualizationPlan(enabledExchanges, realBalanceMap),
    [enabledExchanges, realBalanceMap],
  );

  return (
    <section
      className="glass-card"
      style={{
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--color-text)' }}>
            Exchange Balance Flow
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
            실제 송금이 아니라 평균 잔고 기준의 계획 배분과 우선순위 요약입니다.
          </div>
        </div>
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 800,
            color: simulationMode ? '#a78bfa' : '#ef4444',
            border: `1px solid ${simulationMode ? 'rgba(167,139,250,0.35)' : 'rgba(239,68,68,0.35)'}`,
            background: simulationMode ? 'rgba(167,139,250,0.12)' : 'rgba(239,68,68,0.12)',
          }}
        >
          viewing {simulationMode ? 'SIM' : 'REAL'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <ModeBalancePlanCard
          label="SIM"
          active={simulationMode}
          accentColor="#a78bfa"
          plan={simPlan}
        />
        <ModeBalancePlanCard
          label="REAL"
          active={!simulationMode}
          accentColor="#ef4444"
          plan={realPlan}
        />
      </div>
    </section>
  );
}
