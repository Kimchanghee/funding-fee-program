'use client';

import { useState, useEffect, useCallback } from 'react';
import { Wallet, TrendingUp, FlaskConical, RotateCcw } from 'lucide-react';
import StatusDot from '@/components/ui/StatusDot';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId } from '@/lib/types';
import { fmtNum } from '@/lib/format';

/** 거래소 미니 카드 (통합 잔고) */
function ExchangeMiniCard({ exchange }: { exchange: ExchangeId }) {
  const { simBalances, simPositions, fundingHistory } = useFundingStore();
  const color = EXCHANGE_COLORS[exchange];

  const bal = simBalances[exchange] ?? 0;
  const exPositions = simPositions.filter(p => p.exchange === exchange);
  const margin = exPositions.reduce((s, p) => s + p.margin, 0);
  const funding = fundingHistory
    .filter(p => p.exchange === exchange)
    .reduce((s, p) => s + p.amount, 0);

  return (
    <div style={{
      padding: '8px 12px', borderRadius: 8,
      background: `${color}08`, border: `1px solid ${color}22`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: '0.05em' }}>
          {EXCHANGE_NAMES[exchange]}
        </span>
        <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: 'var(--color-text)' }}>
          ${fmtNum(bal + margin)}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b' }}>
        <span>가용 ${fmtNum(bal)}</span>
        <span>마진 ${fmtNum(margin)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 2 }}>
        <span style={{ fontSize: 10, color: '#64748b' }}>펀딩</span>
        <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: funding >= 0 ? '#10b981' : '#ef4444' }}>
          {funding >= 0 ? '+' : ''}${fmtNum(funding, 4)}
        </span>
      </div>
    </div>
  );
}

/** 실거래 모드 거래소 카드 */
function RealCard({ exchange }: { exchange: ExchangeId }) {
  const { balances, apiConfigs } = useFundingStore();
  const color = EXCHANGE_COLORS[exchange];
  const balance = balances[exchange];
  const hasConfig = !!apiConfigs[exchange];
  const status = !hasConfig ? 'disconnected' : balance?.status ?? 'disconnected';

  return (
    <div className="glass-card" style={{
      minWidth: 200, padding: '16px 20px',
      borderColor: status === 'connected' ? `${color}44` : 'var(--color-border)',
      background: status === 'connected' ? `linear-gradient(135deg, ${color}0a, var(--bg-card))` : 'var(--bg-card)',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: '0.08em', padding: '2px 8px', borderRadius: 6, background: `${color}22` }}>
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
              <span className="mono">${balance.availableUSDT.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: 'var(--color-text-muted)' }}>사용중</span>
              <span className="mono">${balance.usedUSDT.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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

/** 거래 이벤트에서 총 PnL 집계 */
function useTotalPnl() {
  const [pnl, setPnl] = useState({ total: 0, count: 0, funding: 0 });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/trades/list');
      const json = await res.json();
      if (!json.success) return;
      const events = json.events || [];

      let total = 0, count = 0, funding = 0;
      for (const ev of events) {
        if (ev.type === 'snipe_exit' || ev.type === 'exit' || ev.type === 'shortonly_exit') {
          total += ev.pnl ?? 0;
          funding += ev.fundingAmount ?? 0;
          count++;
        }
      }
      setPnl({ total, count, funding });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [refresh]);

  return pnl;
}

export default function BalanceCards() {
  const { balances, simulationMode, simBalances, simPositions, simTotalFundingEarned, simTotalFees, enabledExchanges, strategyConfig, resetSimulation } = useFundingStore();
  const pnl = useTotalPnl();

  const totalUSDT = Object.values(balances)
    .filter(b => b?.status === 'connected')
    .reduce((sum, b) => sum + (b?.totalUSDT || 0), 0);

  if (!simulationMode) {
    // 실거래: 기존 가로 레이아웃
    return (
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}>
        <div className="glass-card" style={{
          minWidth: 220, padding: '16px 20px', flexShrink: 0,
          background: 'linear-gradient(135deg, rgba(59,130,246,0.08), var(--bg-card))',
          borderColor: 'rgba(59,130,246,0.3)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <TrendingUp size={13} color="#3b82f6" />
            <span style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6' }}>총 자산</span>
          </div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 900, color: 'var(--color-text)' }}>
            ${totalUSDT.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        {enabledExchanges.map(ex => <RealCard key={ex} exchange={ex} />)}
      </div>
    );
  }

  // 시뮬: 통합 단일 풀
  const simTotal = Object.values(simBalances).reduce((s, v) => s + v, 0)
    + simPositions.reduce((s, p) => s + p.margin, 0);
  const simInitial = enabledExchanges.length * strategyConfig.investmentUSDT * 2;
  const netProfit = simTotal - simInitial;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 초기화 버튼 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => { if (confirm('시뮬레이션을 초기화하시겠습니까?')) resetSimulation(); }}
          style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 10, fontWeight: 700, color: '#ef4444',
          }}
        >
          <RotateCcw size={11} /> 전체 초기화
        </button>
      </div>

      {/* 통합 요약 카드 */}
      <div className="glass-card" style={{
        padding: '14px 16px',
        background: 'linear-gradient(135deg, rgba(59,130,246,0.12), var(--bg-card))',
        borderColor: 'rgba(59,130,246,0.4)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <FlaskConical size={13} color="#3b82f6" />
          <span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6' }}>시뮬레이션 (통합)</span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: '#3b82f6', background: 'rgba(59,130,246,0.15)', padding: '2px 6px', borderRadius: 4 }}>SIM</span>
        </div>
        <div className="mono" style={{ fontSize: 22, fontWeight: 900, color: 'var(--color-text)', marginBottom: 4 }}>
          ${simTotal.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>수령 펀딩</span>
            <span className="mono" style={{ fontWeight: 700, color: simTotalFundingEarned >= 0 ? '#10b981' : '#ef4444' }}>
              {simTotalFundingEarned >= 0 ? '+' : ''}${fmtNum(simTotalFundingEarned, 4)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>수수료</span>
            <span className="mono" style={{ fontWeight: 700, color: '#ef4444' }}>-${fmtNum(simTotalFees, 4)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(59,130,246,0.2)', paddingTop: 3 }}>
            <span style={{ color: '#3b82f6', fontWeight: 600 }}>순수익</span>
            <span className="mono" style={{ fontWeight: 800, color: netProfit >= 0 ? '#10b981' : '#ef4444' }}>
              {netProfit >= 0 ? '+' : ''}${fmtNum(netProfit, 2)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>거래</span>
            <span className="mono" style={{ color: 'var(--color-text)' }}>{pnl.count}건</span>
          </div>
        </div>
      </div>

      {/* 거래소별 미니 카드 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
        {enabledExchanges.map(ex => <ExchangeMiniCard key={ex} exchange={ex} />)}
      </div>
    </div>
  );
}
