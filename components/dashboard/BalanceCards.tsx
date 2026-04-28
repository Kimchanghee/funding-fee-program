'use client';

import { useState } from 'react';
import { FlaskConical, RotateCcw, TrendingUp, Wallet } from 'lucide-react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import StatusDot from '@/components/ui/StatusDot';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId } from '@/lib/types';
import { fmtNum } from '@/lib/format';

function MiniRow({
  label,
  value,
  color = 'var(--color-text)',
  strong = false,
}: {
  label: string;
  value: string;
  color?: string;
  strong?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, minHeight: 18 }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span className="mono" style={{ color, fontWeight: strong ? 800 : 600, textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

function ExchangeMiniCard({ exchange }: { exchange: ExchangeId }) {
  const {
    simBalances,
    simInitialBalances,
    simPositions,
    fundingHistory,
    simClosedPnlPerExchange,
    simClosedFeesPerExchange,
  } = useFundingStore();
  const color = EXCHANGE_COLORS[exchange];

  const bal = simBalances[exchange] ?? 0;
  const initialBal = simInitialBalances[exchange] ?? simBalances[exchange] ?? 0;
  const exPositions = simPositions.filter(p =>
    p.exchange === exchange && (p.positionType === 'hedge_long' || p.positionType === 'hedge_short')
  );
  const margin = exPositions.reduce((s, p) => s + p.margin, 0);
  const openPricePnl = exPositions.reduce((s, p) => s + p.unrealizedPnl + p.entryFee, 0);
  const openEntryFees = exPositions.reduce((s, p) => s + p.entryFee, 0);
  const closedPnl = simClosedPnlPerExchange[exchange] ?? 0;
  const closedFees = simClosedFeesPerExchange[exchange] ?? 0;
  const totalFees = openEntryFees + closedFees;
  const fundingEntries = fundingHistory.filter(p => p.exchange === exchange);
  const fundingReceived = fundingEntries.filter(p => p.amount >= 0).reduce((s, p) => s + p.amount, 0);
  const fundingPaid = fundingEntries.filter(p => p.amount < 0).reduce((s, p) => s + p.amount, 0);
  const fundingNet = fundingReceived + fundingPaid;
  const totalAsset = bal + margin + openPricePnl;
  const balanceChange = totalAsset - initialBal;
  const netPnl = fundingNet + closedPnl + openPricePnl - totalFees;
  const netTransfer = balanceChange - fundingNet - closedPnl - openPricePnl + totalFees;

  return (
    <div
      className="exchange-mini-card"
      style={{
        padding: '10px 12px',
        borderRadius: 8,
        background: `${color}08`,
        border: `1px solid ${color}22`,
        minHeight: 246,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, minHeight: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: '0.05em' }}>
            {EXCHANGE_NAMES[exchange]}
          </span>
          <span style={{
            fontSize: 8,
            fontWeight: 700,
            padding: '1px 4px',
            borderRadius: 3,
            background: fundingEntries.length > 0 ? `${color}20` : 'rgba(100,116,139,0.15)',
            color: fundingEntries.length > 0 ? color : '#64748b',
          }}>
            {fundingEntries.length}회
          </span>
        </div>
        <span className="mono" style={{ fontSize: 12, fontWeight: 800, color: 'var(--color-text)' }}>
          ${fmtNum(totalAsset)}
        </span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', marginBottom: 4, minHeight: 18 }}>
        <span>가용 <span className="mono">${fmtNum(bal)}</span></span>
        <span>마진 <span className="mono">${fmtNum(margin)}</span></span>
      </div>

      <div style={{ height: 1, background: `${color}22`, margin: '4px 0' }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10 }}>
        <MiniRow label="초기 잔고" value={`$${fmtNum(initialBal)}`} color="#94a3b8" />
        <MiniRow label="펀딩 수령" value={`+$${fmtNum(fundingReceived, 4)}`} color="#10b981" />
        <MiniRow label="펀딩 지급" value={`$${fmtNum(fundingPaid, 4)}`} color={fundingPaid < 0 ? '#ef4444' : '#94a3b8'} />
        <MiniRow label="거래 수수료" value={`-$${fmtNum(totalFees, 4)}`} color="#ef4444" />
        <MiniRow
          label="슬리피지/가격PnL"
          value={`${closedPnl >= 0 ? '+' : ''}$${fmtNum(closedPnl, 4)}`}
          color={closedPnl >= 0 ? '#10b981' : '#ef4444'}
        />
        <MiniRow
          label="미실현 가격PnL"
          value={`${openPricePnl >= 0 ? '+' : ''}$${fmtNum(openPricePnl, 4)}`}
          color={openPricePnl >= 0 ? '#10b981' : '#ef4444'}
        />
        <MiniRow
          label={netTransfer >= 0 ? '타 거래소->입금' : '타 거래소->출금'}
          value={`${netTransfer >= 0 ? '+' : ''}$${fmtNum(netTransfer, 2)}`}
          color={netTransfer >= 0 ? '#3b82f6' : '#f59e0b'}
        />

        <div style={{ height: 1, background: `${color}22`, margin: '2px 0' }} />

        <MiniRow
          label="PnL"
          value={`${netPnl >= 0 ? '+' : ''}$${fmtNum(netPnl, 4)}`}
          color={netPnl >= 0 ? '#10b981' : '#ef4444'}
          strong
        />
        <MiniRow
          label="잔고 변동"
          value={`${balanceChange >= 0 ? '+' : ''}$${fmtNum(balanceChange, 2)}`}
          color={balanceChange >= 0 ? '#10b981' : '#ef4444'}
          strong
        />
      </div>
    </div>
  );
}

function RealCard({ exchange }: { exchange: ExchangeId }) {
  const { balances, apiConfigs, openApiPanelFor } = useFundingStore();
  const color = EXCHANGE_COLORS[exchange];
  const balance = balances[exchange];
  const hasConfig = !!apiConfigs[exchange];
  const status = !hasConfig ? 'disconnected' : balance?.status ?? 'disconnected';
  const isClickableToConfigure = !hasConfig;

  return (
    <div
      className="glass-card balance-real-card"
      onClick={isClickableToConfigure ? () => openApiPanelFor(exchange) : undefined}
      role={isClickableToConfigure ? 'button' : undefined}
      tabIndex={isClickableToConfigure ? 0 : undefined}
      onKeyDown={isClickableToConfigure ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openApiPanelFor(exchange);
        }
      } : undefined}
      title={isClickableToConfigure ? `${EXCHANGE_NAMES[exchange]} API 설정하기` : undefined}
      style={{
        minWidth: 200,
        minHeight: 142,
        padding: '16px 20px',
        borderColor: status === 'connected' ? `${color}44` : 'var(--color-border)',
        background: status === 'connected' ? `linear-gradient(135deg, ${color}0a, var(--bg-card))` : 'var(--bg-card)',
        flexShrink: 0,
        cursor: isClickableToConfigure ? 'pointer' : 'default',
      }}
    >
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
            <MiniRow label="가용" value={`$${balance.availableUSDT.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
            <MiniRow label="사용중" value={`$${balance.usedUSDT.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          </div>
        </>
      ) : (
        <div style={{ minHeight: 80, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}>
          <Wallet size={20} color={hasConfig ? 'var(--color-text-muted)' : color} style={{ margin: '0 auto 8px' }} />
          <div style={{ fontSize: 12, color: hasConfig ? 'var(--color-text-muted)' : color, fontWeight: hasConfig ? 400 : 700 }}>
            {hasConfig ? '잔고 로딩 중...' : '+ API 키 설정'}
          </div>
        </div>
      )}
    </div>
  );
}

function SimModeColumn({
  title,
  accentColor,
  fundingEarned,
  fees,
  positions,
  enabledExchanges,
  investmentUSDT,
  leverage,
  compoundInvesting,
}: {
  title: string;
  accentColor: string;
  fundingEarned: number;
  fees: number;
  positions: import('@/lib/types').SimPosition[];
  enabledExchanges: ExchangeId[];
  investmentUSDT: number;
  leverage: number;
  compoundInvesting: boolean;
}) {
  const { simTotalClosedPnl } = useFundingStore();
  const modePositions = positions.filter(p =>
    p.positionType === 'hedge_long' || p.positionType === 'hedge_short'
  );
  const modeMargin = modePositions.reduce((s, p) => s + p.margin, 0);
  const openPricePnl = modePositions.reduce((s, p) => s + p.unrealizedPnl + p.entryFee, 0);
  const netProfit = fundingEarned - fees + openPricePnl + simTotalClosedPnl;
  const posCount = modePositions.filter(p => p.positionType === 'hedge_short').length;
  const hedgeMarginUSDT = investmentUSDT * 2;
  const matchedNotionalUSDT = investmentUSDT * leverage;
  const grossHedgeNotionalUSDT = matchedNotionalUSDT * 2;
  const portfolioReserveUSDT = hedgeMarginUSDT * Math.max(1, enabledExchanges.length);

  return (
    <div
      className="glass-card sim-mode-column"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 360,
        padding: '14px 16px',
        background: `linear-gradient(135deg, ${accentColor}12, var(--bg-card))`,
        borderColor: `${accentColor}40`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minHeight: 22 }}>
        <FlaskConical size={13} color={accentColor} />
        <span style={{ fontSize: 12, fontWeight: 700, color: accentColor }}>{title}</span>
        <span style={{
          fontSize: 9,
          fontWeight: 700,
          padding: '2px 6px',
          borderRadius: 4,
          background: compoundInvesting ? 'rgba(167,139,250,0.2)' : 'rgba(16,185,129,0.2)',
          color: compoundInvesting ? '#a78bfa' : '#10b981',
        }}>
          {compoundInvesting ? '복리' : '단리'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 9, color: accentColor, background: `${accentColor}20`, padding: '2px 6px', borderRadius: 4 }}>SIM</span>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 10, color: '#94a3b8', flexWrap: 'wrap', minHeight: 34 }}>
        <span>레그당 <span className="mono" style={{ color: '#a78bfa', fontWeight: 700 }}>${investmentUSDT.toLocaleString()}</span></span>
        <span>헤지 1건 <span className="mono" style={{ fontWeight: 700 }}>${hedgeMarginUSDT.toLocaleString()}</span></span>
        <span>운용 기준 <span className="mono" style={{ color: '#f59e0b', fontWeight: 700 }}>${portfolioReserveUSDT.toLocaleString()}</span> <span style={{ fontSize: 9 }}>({enabledExchanges.length}개)</span></span>
        <span>매칭 노셔널 <span className="mono" style={{ fontWeight: 700 }}>${matchedNotionalUSDT.toLocaleString()}</span> ({leverage}x)</span>
        <span>양방향 노셔널 <span className="mono" style={{ fontWeight: 700 }}>${grossHedgeNotionalUSDT.toLocaleString()}</span></span>
      </div>

      <div className="mono" style={{ fontSize: 22, fontWeight: 900, color: netProfit >= 0 ? '#10b981' : '#ef4444', marginBottom: 2, minHeight: 28 }}>
        {netProfit >= 0 ? '+' : ''}${fmtNum(netProfit, 2)}
      </div>
      <div style={{ fontSize: 10, color: '#64748b', marginBottom: 8, minHeight: 14 }}>
        {posCount}개 포지션 | 마진 ${fmtNum(modeMargin)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, minHeight: 92 }}>
        <MiniRow label="펀딩 순액" value={`${fundingEarned >= 0 ? '+' : ''}$${fmtNum(fundingEarned, 4)}`} color={fundingEarned >= 0 ? '#10b981' : '#ef4444'} strong />
        <MiniRow label="수수료" value={`-$${fmtNum(fees, 4)}`} color="#ef4444" strong />
        <MiniRow label="슬리피지/가격PnL" value={`${simTotalClosedPnl >= 0 ? '+' : ''}$${fmtNum(simTotalClosedPnl, 4)}`} color={simTotalClosedPnl >= 0 ? '#10b981' : '#ef4444'} strong />
        <MiniRow label="미실현 가격PnL" value={`${openPricePnl >= 0 ? '+' : ''}$${fmtNum(openPricePnl, 4)}`} color={openPricePnl >= 0 ? '#10b981' : '#ef4444'} strong />
        <div style={{ borderTop: `1px solid ${accentColor}20`, paddingTop: 3 }}>
          <MiniRow label="합계" value={`${netProfit >= 0 ? '+' : ''}$${fmtNum(netProfit, 2)}`} color={netProfit >= 0 ? '#10b981' : '#ef4444'} strong />
        </div>
      </div>

      <div
        className="hedge-exchange-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 8,
          marginTop: 10,
          width: '100%',
        }}
      >
        {enabledExchanges.map(ex => <ExchangeMiniCard key={ex} exchange={ex} />)}
      </div>
    </div>
  );
}

export default function BalanceCards() {
  const {
    balances,
    simulationMode,
    simPositions,
    simTotalFundingEarned,
    simTotalFees,
    enabledExchanges,
    resetSimulation,
    strategyConfig,
  } = useFundingStore();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const totalUSDT = Object.values(balances)
    .filter(b => b?.status === 'connected')
    .reduce((sum, b) => sum + (b?.totalUSDT || 0), 0);

  if (!simulationMode) {
    return (
      <div className="balance-cards-container balance-cards-real" style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4, minHeight: 150 }}>
        <div
          className="glass-card"
          style={{
            minWidth: 220,
            minHeight: 142,
            padding: '16px 20px',
            flexShrink: 0,
            background: 'linear-gradient(135deg, rgba(59,130,246,0.08), var(--bg-card))',
            borderColor: 'rgba(59,130,246,0.3)',
          }}
        >
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

  return (
    <>
      <div className="balance-cards-container balance-cards-sim" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="balance-cards-toolbar" style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 24 }}>
          <button
            onClick={() => setShowResetConfirm(true)}
            style={{
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 6,
              padding: '4px 10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontWeight: 700,
              color: '#ef4444',
            }}
          >
            <RotateCcw size={11} /> 전체 초기화
          </button>
        </div>

        <div className="balance-hedge-row" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <SimModeColumn
            title="헷징 (Hedge)"
            accentColor="#3b82f6"
            fundingEarned={simTotalFundingEarned}
            fees={simTotalFees}
            positions={simPositions}
            enabledExchanges={enabledExchanges}
            investmentUSDT={strategyConfig.investmentUSDT}
            leverage={strategyConfig.leverage}
            compoundInvesting={strategyConfig.compoundInvesting}
          />
        </div>
      </div>

      <ConfirmDialog
        open={showResetConfirm}
        tone="danger"
        title="전체 초기화"
        description="SIM 잔고, 포지션, 누적 손익, 펀딩 내역을 모두 초기화합니다. 계속 진행할까요?"
        confirmLabel="전체 초기화"
        cancelLabel="취소"
        onCancel={() => setShowResetConfirm(false)}
        onConfirm={() => {
          setShowResetConfirm(false);
          resetSimulation();
        }}
      />
    </>
  );
}
