'use client';

import { useEffect } from 'react';
import Header from '@/components/dashboard/Header';
import OpportunityCard from '@/components/dashboard/OpportunityCard';
import FeePaybackSummary from '@/components/dashboard/FeePaybackSummary';
import FundingRateTable from '@/components/dashboard/FundingRateTable';
import BalanceCards from '@/components/dashboard/BalanceCards';
import BalanceEqualizationPanel from '@/components/dashboard/BalanceEqualizationPanel';
import PositionsTable from '@/components/dashboard/PositionsTable';
import LogPanel from '@/components/dashboard/LogPanel';
import ApiPanel from '@/components/dashboard/ApiPanel';
import StrategyPanel from '@/components/dashboard/StrategyPanel';
import DataStatusBar from '@/components/dashboard/DataStatusBar';
import RuntimeAuditSummary from '@/components/dashboard/RuntimeAuditSummary';
import FundingHistory from '@/components/dashboard/FundingHistory';
import TradeHistory from '@/components/dashboard/TradeHistory';

import { useFundingStore } from '@/store/fundingStore';

export default function DashboardPage() {
  const { init, showApiPanel, showStrategyPanel } = useFundingStore();

  useEffect(() => {
    console.log('[Page] init() 호출');
    init();

    // 10초 후에도 데이터 없으면 강제 재시도
    const recovery = setTimeout(() => {
      const s = useFundingStore.getState();
      if (!s.lastRatesUpdate) {
        console.warn('[Page] 10초 경과 — 데이터 없음, 강제 재시도');
        s.stopPolling();
        // isLoadingRates 강제 리셋 후 재시도
        useFundingStore.setState({ isLoadingRates: false, ratesStatus: 'loading' });
        s.refreshRates();
        s.startPolling();
      }
    }, 10000);

    return () => {
      clearTimeout(recovery);
      useFundingStore.getState().stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dashboard-root" style={{ minHeight: '100vh', background: '#0a0e17' }}>
      <Header />

      <main
        className="main-content"
        style={{
          maxWidth: 1800,
          margin: '0 auto',
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Data Fetch Status */}
        <DataStatusBar />

        {/* Runtime Audit Summary */}
        <RuntimeAuditSummary />

        {/* Best Opportunity (Hero) */}
        <OpportunityCard />

        {/* Fee / Payback Summary */}
        <FeePaybackSummary />

        {/* Balance Cards */}
        <BalanceCards />

        {/* Exchange Balance Flow */}
        <BalanceEqualizationPanel />

        {/* Funding History — 펀딩피 수령 내역 */}
        <FundingHistory />

        {/* Trade History — 페어별 숏/롱 손익 추적 */}
        <TradeHistory />

        {/* Funding Rate Table */}
        <FundingRateTable />

        {/* Positions */}
        <PositionsTable />

        {/* Logs */}
        <LogPanel />

        {/* Footer */}
        <div className="dashboard-footer" style={{ textAlign: 'center', padding: '16px 0', fontSize: 11, color: 'var(--color-text-muted)' }}>
          펀딩피 헷징 프로그램 • 멀티 거래소 WS + REST 이중화 모니터링 • 8시간마다 펀딩 수령
        </div>
      </main>

      {/* Modals */}
      {showApiPanel && <ApiPanel />}
      {showStrategyPanel && <StrategyPanel />}
    </div>
  );
}
