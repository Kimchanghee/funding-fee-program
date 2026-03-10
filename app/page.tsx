'use client';

import { useEffect } from 'react';
import Header from '@/components/dashboard/Header';
import OpportunityCard from '@/components/dashboard/OpportunityCard';
import FundingRateTable from '@/components/dashboard/FundingRateTable';
import BalanceCards from '@/components/dashboard/BalanceCards';
import PositionsTable from '@/components/dashboard/PositionsTable';
import LogPanel from '@/components/dashboard/LogPanel';
import ApiPanel from '@/components/dashboard/ApiPanel';
import StrategyPanel from '@/components/dashboard/StrategyPanel';
import WsStatusBar from '@/components/dashboard/WsStatusBar';
import FundingHistory from '@/components/dashboard/FundingHistory';
import { useFundingStore } from '@/store/fundingStore';
import { useWebSockets } from '@/hooks/useWebSockets';

export default function DashboardPage() {
  const { init, showApiPanel, showStrategyPanel } = useFundingStore();

  useWebSockets();

  useEffect(() => {
    init();
    // Cleanup polling on unmount
    return () => {
      useFundingStore.getState().stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Header />

      <main
        style={{
          maxWidth: 1800,
          margin: '0 auto',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* WebSocket Status */}
        <WsStatusBar />

        {/* Best Opportunity (Hero) */}
        <OpportunityCard />

        {/* Balance Cards */}
        <BalanceCards />

        {/* Funding Rate Table */}
        <FundingRateTable />

        {/* Positions */}
        <PositionsTable />

        {/* Funding History */}
        <FundingHistory />

        {/* Logs */}
        <LogPanel />

        {/* Footer */}
        <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 11, color: 'var(--color-text-muted)' }}>
          펀딩피 헷징 프로그램 • 5개 거래소 실시간 모니터링 • 8시간마다 펀딩 수령
        </div>
      </main>

      {/* Modals */}
      {showApiPanel && <ApiPanel />}
      {showStrategyPanel && <StrategyPanel />}
    </div>
  );
}
