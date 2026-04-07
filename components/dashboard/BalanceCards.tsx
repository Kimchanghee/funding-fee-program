'use client';

import { useState } from 'react';
import { Wallet, TrendingUp, FlaskConical, RotateCcw } from 'lucide-react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import StatusDot from '@/components/ui/StatusDot';
import { useFundingStore } from '@/store/fundingStore';
import { EXCHANGE_COLORS, EXCHANGE_NAMES, type ExchangeId } from '@/lib/types';
import { fmtNum } from '@/lib/format';

/** 거래소 미니 카드 (상세 잔고 분석) */
function ExchangeMiniCard({ exchange }: { exchange: ExchangeId }) {
  const { simBalances, simInitialBalances, simPositions, fundingHistory, simClosedPnlPerExchange, simClosedFeesPerExchange } = useFundingStore();
  const color = EXCHANGE_COLORS[exchange];

  const bal = simBalances[exchange] ?? 0;
  const initialBal = simInitialBalances[exchange] ?? simBalances[exchange] ?? 0;
  const exPositions = simPositions.filter(p =>
    p.exchange === exchange && (p.positionType === 'hedge_long' || p.positionType === 'hedge_short')
  );
  const margin = exPositions.reduce((s, p) => s + p.margin, 0);
  const unrealizedPnl = exPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const openEntryFees = exPositions.reduce((s, p) => s + p.entryFee, 0);

  // 청산된 포지션의 가격 PnL 및 수수료 (슬리피지 포함)
  const closedPnl = simClosedPnlPerExchange[exchange] ?? 0;
  const closedFees = simClosedFeesPerExchange[exchange] ?? 0;
  const totalFees = openEntryFees + closedFees;

  // 펀딩 수령 (수령 vs 지급 분리)
  const fundingEntries = fundingHistory.filter(p => p.exchange === exchange);
  const fundingReceived = fundingEntries.filter(p => p.amount >= 0).reduce((s, p) => s + p.amount, 0);
  const fundingPaid = fundingEntries.filter(p => p.amount < 0).reduce((s, p) => s + p.amount, 0);
  const fundingNet = fundingReceived + fundingPaid;

  // 총 자산 = 가용 + 마진
  const totalAsset = bal + margin;
  // 잔고 변동 = 현재 총자산 - 초기자산
  const balanceChange = totalAsset - initialBal;
  // 순입출금 (이체) = 잔고변동 - 펀딩 - 청산PnL + 총수수료
  const netTransfer = balanceChange - fundingNet - closedPnl + totalFees;

  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8,
      background: `${color}08`, border: `1px solid ${color}22`,
    }}>
      {/* 거래소명 + 총 자산 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: '0.05em' }}>
            {EXCHANGE_NAMES[exchange]}
          </span>
          <span style={{
            fontSize: 8, fontWeight: 700, padding: '1px 4px', borderRadius: 3,
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

      {/* 잔고 구성 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', marginBottom: 4 }}>
        <span>가용 <span className="mono">${fmtNum(bal)}</span></span>
        <span>마진 <span className="mono">${fmtNum(margin)}</span></span>
      </div>

      <div style={{ height: 1, background: `${color}22`, margin: '4px 0' }} />

      {/* 상세 항목 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#64748b' }}>초기 잔고</span>
          <span className="mono" style={{ color: '#94a3b8' }}>${fmtNum(initialBal)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#64748b' }}>펀딩 수령</span>
          <span className="mono" style={{ color: '#10b981', fontWeight: 600 }}>+${fmtNum(fundingReceived, 4)}</span>
        </div>
        {fundingPaid < 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>펀딩 지급</span>
            <span className="mono" style={{ color: '#ef4444', fontWeight: 600 }}>${fmtNum(fundingPaid, 4)}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#64748b' }}>거래 수수료</span>
          <span className="mono" style={{ color: '#ef4444', fontWeight: 600 }}>-${fmtNum(totalFees, 4)}</span>
        </div>
        {Math.abs(closedPnl) > 0.01 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>슬리피지/가격PnL</span>
            <span className="mono" style={{ color: closedPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
              {closedPnl >= 0 ? '+' : ''}${fmtNum(closedPnl, 4)}
            </span>
          </div>
        )}
        {Math.abs(netTransfer) > 0.01 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>{netTransfer >= 0 ? '타 거래소→입금' : '타 거래소→출금'}</span>
            <span className="mono" style={{ color: netTransfer >= 0 ? '#3b82f6' : '#f59e0b', fontWeight: 600 }}>
              {netTransfer >= 0 ? '+' : ''}${fmtNum(netTransfer, 2)}
            </span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#64748b' }}>PnL</span>
          <span className="mono" style={{ color: unrealizedPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
            {unrealizedPnl >= 0 ? '+' : ''}${fmtNum(unrealizedPnl, 4)}
          </span>
        </div>

        <div style={{ height: 1, background: `${color}22`, margin: '2px 0' }} />

        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color, fontWeight: 700 }}>잔고 변동</span>
          <span className="mono" style={{ color: balanceChange >= 0 ? '#10b981' : '#ef4444', fontWeight: 800 }}>
            {balanceChange >= 0 ? '+' : ''}${fmtNum(balanceChange, 2)}
          </span>
        </div>
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

/** 시뮬 모드 컬럼 카드 (헷징) */
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
  const modePnl = modePositions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const netProfit = fundingEarned - fees + modePnl + simTotalClosedPnl;
  const posCount = modePositions.filter(p => p.positionType === 'hedge_short').length;

  return (
    <div className="glass-card" style={{
      flex: 1, minWidth: 0, padding: '14px 16px',
      background: `linear-gradient(135deg, ${accentColor}12, var(--bg-card))`,
      borderColor: `${accentColor}40`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <FlaskConical size={13} color={accentColor} />
        <span style={{ fontSize: 12, fontWeight: 700, color: accentColor }}>{title}</span>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          background: compoundInvesting ? 'rgba(167,139,250,0.2)' : 'rgba(16,185,129,0.2)',
          color: compoundInvesting ? '#a78bfa' : '#10b981',
        }}>
          {compoundInvesting ? '복리' : '단리'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 9, color: accentColor, background: `${accentColor}20`, padding: '2px 6px', borderRadius: 4 }}>SIM</span>
      </div>

      {/* 투자금 정보 */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 10, color: '#94a3b8' }}>
        <span>포지션당 <span className="mono" style={{ color: '#a78bfa', fontWeight: 700 }}>${investmentUSDT.toLocaleString()}</span></span>
        <span>거래소당 <span className="mono" style={{ fontWeight: 700 }}>${(investmentUSDT * 2).toLocaleString()}</span> <span style={{ fontSize: 9 }}>(롱+숏)</span></span>
        <span>총 투입 <span className="mono" style={{ color: '#f59e0b', fontWeight: 700 }}>${(investmentUSDT * 2 * enabledExchanges.length).toLocaleString()}</span> <span style={{ fontSize: 9 }}>({enabledExchanges.length}개)</span></span>
        <span>노셔널 <span className="mono" style={{ fontWeight: 700 }}>${(investmentUSDT * leverage).toLocaleString()}</span> ({leverage}x)</span>
      </div>

      {/* 순수익 (메인 숫자) */}
      <div className="mono" style={{ fontSize: 22, fontWeight: 900, color: netProfit >= 0 ? '#10b981' : '#ef4444', marginBottom: 2 }}>
        {netProfit >= 0 ? '+' : ''}${fmtNum(netProfit, 2)}
      </div>
      <div style={{ fontSize: 10, color: '#64748b', marginBottom: 8 }}>
        {posCount}개 포지션 | 마진 ${fmtNum(modeMargin)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#64748b' }}>수령 펀딩</span>
          <span className="mono" style={{ fontWeight: 700, color: fundingEarned >= 0 ? '#10b981' : '#ef4444' }}>
            {fundingEarned >= 0 ? '+' : ''}${fmtNum(fundingEarned, 4)}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#64748b' }}>수수료</span>
          <span className="mono" style={{ fontWeight: 700, color: '#ef4444' }}>-${fmtNum(fees, 4)}</span>
        </div>
        {Math.abs(simTotalClosedPnl) > 0.01 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>슬리피지/가격PnL</span>
            <span className="mono" style={{ fontWeight: 700, color: simTotalClosedPnl >= 0 ? '#10b981' : '#ef4444' }}>
              {simTotalClosedPnl >= 0 ? '+' : ''}${fmtNum(simTotalClosedPnl, 4)}
            </span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#64748b' }}>PnL</span>
          <span className="mono" style={{ fontWeight: 700, color: modePnl >= 0 ? '#10b981' : '#ef4444' }}>
            {modePnl >= 0 ? '+' : ''}${fmtNum(modePnl, 4)}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${accentColor}20`, paddingTop: 3 }}>
          <span style={{ color: accentColor, fontWeight: 600 }}>합계</span>
          <span className="mono" style={{ fontWeight: 800, color: netProfit >= 0 ? '#10b981' : '#ef4444' }}>
            {netProfit >= 0 ? '+' : ''}${fmtNum(netProfit, 2)}
          </span>
        </div>
      </div>

      {/* 거래소 미니 카드 */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${enabledExchanges.length}, 1fr)`, gap: 8, marginTop: 10 }}>
        {enabledExchanges.map(ex => <ExchangeMiniCard key={ex} exchange={ex} />)}
      </div>
    </div>
  );
}

export default function BalanceCards() {
  const {
    balances, simulationMode, simPositions,
    simTotalFundingEarned, simTotalFees,
    enabledExchanges, resetSimulation, strategyConfig,
  } = useFundingStore();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
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

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 초기화 버튼 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={() => setShowResetConfirm(true)}
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

        {/* 헷징 컬럼 */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
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
