'use client';

import { Wallet, TrendingUp, FlaskConical } from 'lucide-react';
import StatusDot from '@/components/ui/StatusDot';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, SUPPORTED_EXCHANGES, type ExchangeId } from '@/lib/types';

function Card({ exchange }: { exchange: ExchangeId }) {
  const { balances, apiConfigs, simulationMode, simBalances, simPositions } = useFundingStore();
  const color = EXCHANGE_COLORS[exchange];

  if (simulationMode) {
    const simBal = simBalances[exchange] ?? 0;
    const locked = simPositions.filter(p => p.exchange === exchange).reduce((s, p) => s + p.margin, 0);
    const fundingEarned = simPositions.filter(p => p.exchange === exchange).reduce((s, p) => s + p.fundingCollected, 0);
    return (
      <div className="glass-card" style={{ minWidth: 200, padding: '16px 20px', borderColor: `${color}44`, background: `linear-gradient(135deg, rgba(167,139,250,0.08), var(--bg-card))`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: '0.08em', padding: '2px 8px', borderRadius: 5, background: `${color}22` }}>
            {EXCHANGE_NAMES[exchange]}
          </span>
          <span style={{ fontSize: 9, fontWeight: 700, color: '#a78bfa', background: 'rgba(167,139,250,0.15)', padding: '2px 6px', borderRadius: 4 }}>SIM</span>
        </div>
        <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text)', marginBottom: 4 }}>
          ${(simBal + locked).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 8 }}>총 자산 (USDT)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: 'var(--color-text-muted)' }}>가용</span>
            <span className="mono" style={{ color: 'var(--color-text)' }}>${simBal.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: 'var(--color-text-muted)' }}>포지션 마진</span>
            <span className="mono" style={{ color: 'var(--color-text)' }}>${locked.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: 'var(--color-text-muted)' }}>수령 펀딩</span>
            <span className="mono" style={{ color: fundingEarned >= 0 ? '#10b981' : '#ef4444' }}>
              {fundingEarned >= 0 ? '+' : ''}${fundingEarned.toFixed(4)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const balance = balances[exchange];
  const hasConfig = !!apiConfigs[exchange];
  const status = !hasConfig ? 'disconnected' : balance?.status ?? 'disconnected';

  return (
    <div
      className="glass-card"
      style={{
        minWidth: 200,
        padding: '16px 20px',
        borderColor: status === 'connected' ? `${color}44` : 'var(--color-border)',
        background: status === 'connected'
          ? `linear-gradient(135deg, ${color}0a, var(--bg-card))`
          : 'var(--bg-card)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color,
            letterSpacing: '0.08em',
            padding: '2px 8px',
            borderRadius: 5,
            background: `${color}22`,
          }}
        >
          {EXCHANGE_NAMES[exchange]}
        </span>
        <StatusDot status={status} />
      </div>

      {status === 'connected' && balance ? (
        <>
          <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text)', marginBottom: 4 }}>
            ${balance.totalUSDT.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 8 }}>총 자산 (USDT)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: 'var(--color-text-muted)' }}>가용</span>
              <span className="mono" style={{ color: 'var(--color-text)' }}>
                ${balance.availableUSDT.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: 'var(--color-text-muted)' }}>사용중</span>
              <span className="mono" style={{ color: 'var(--color-text)' }}>
                ${balance.usedUSDT.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div style={{ padding: '16px 0', textAlign: 'center' }}>
          <Wallet size={20} color="var(--color-text-muted)" style={{ margin: '0 auto 8px' }} />
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {hasConfig ? '잔고 로딩 중...' : 'API 키 미설정'}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BalanceCards() {
  const { balances, simulationMode, simBalances, simPositions, simTotalFundingEarned } = useFundingStore();

  const totalUSDT = Object.values(balances)
    .filter(b => b?.status === 'connected')
    .reduce((sum, b) => sum + (b?.totalUSDT || 0), 0);

  const simTotal = Object.values(simBalances).reduce((s, v) => s + v, 0)
    + simPositions.reduce((s, p) => s + p.margin, 0);

  return (
    <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}>
      {/* Total card */}
      <div
        className="glass-card"
        style={{
          minWidth: 220,
          padding: '16px 20px',
          flexShrink: 0,
          background: simulationMode
            ? 'linear-gradient(135deg, rgba(167,139,250,0.1), var(--bg-card))'
            : 'linear-gradient(135deg, rgba(59,130,246,0.08), var(--bg-card))',
          borderColor: simulationMode ? 'rgba(167,139,250,0.3)' : 'rgba(59,130,246,0.3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {simulationMode ? <FlaskConical size={14} color="#a78bfa" /> : <TrendingUp size={14} color="#3b82f6" />}
          <span style={{ fontSize: 11, fontWeight: 700, color: simulationMode ? '#a78bfa' : '#3b82f6', letterSpacing: '0.08em' }}>
            {simulationMode ? '시뮬 총 자산' : '총 자산'}
          </span>
        </div>
        <div className="mono" style={{ fontSize: 24, fontWeight: 900, color: 'var(--color-text)', marginBottom: 4 }}>
          ${(simulationMode ? simTotal : totalUSDT).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        {simulationMode ? (
          <div style={{ fontSize: 11, color: '#a78bfa' }}>
            수령 펀딩 합계: <span className="mono" style={{ fontWeight: 700 }}>
              {simTotalFundingEarned >= 0 ? '+' : ''}${simTotalFundingEarned.toFixed(4)}
            </span>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            연결된 거래소 전체 합계 (USDT)
          </div>
        )}
      </div>

      {/* Per exchange */}
      {SUPPORTED_EXCHANGES.map(ex => (
        <Card key={ex} exchange={ex} />
      ))}
    </div>
  );
}
