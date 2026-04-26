import type { FileLogEntry, TradeEvent } from '@/lib/fileLogger';

export interface RuntimeAuditWindow {
  from: number;
  to: number;
  hours: number;
}

export interface RuntimeAuditCountItem {
  key: string;
  count: number;
}

export interface RuntimeAuditTradeSection {
  total: number;
  byType: RuntimeAuditCountItem[];
  byMode: RuntimeAuditCountItem[];
  latestAt: number | null;
  samples: TradeEvent[];
}

export interface RuntimeAuditGuardSection {
  total: number;
  byReason: RuntimeAuditCountItem[];
  byMode: RuntimeAuditCountItem[];
  latestAt: number | null;
  samples: TradeEvent[];
}

export interface RuntimeAuditSystemLogSection {
  total: number;
  byLevel: RuntimeAuditCountItem[];
  latestAt: number | null;
  samples: FileLogEntry[];
}

export interface RuntimeAuditScheduleProbeSection {
  total: number;
  byMilestone: RuntimeAuditCountItem[];
  byStatus: RuntimeAuditCountItem[];
  byRejectReason: RuntimeAuditCountItem[];
  latestAt: number | null;
}

export interface RuntimeAuditResult {
  window: RuntimeAuditWindow;
  tradeEventsTotal: number;
  execution: RuntimeAuditTradeSection;
  guardBlocks: RuntimeAuditGuardSection;
  nonExecutionTradeEvents: RuntimeAuditTradeSection;
  scheduleProbes: RuntimeAuditScheduleProbeSection;
  systemLogs: RuntimeAuditSystemLogSection;
}
