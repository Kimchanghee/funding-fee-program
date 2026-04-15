'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Zap, Crosshair, Check, Clock, TrendingDown, TrendingUp, ChevronDown, ChevronUp, Settings } from 'lucide-react';
import {
  buildSchedulerConfig,
  buildServerSimSchedulerConfig,
  useFundingStore,
} from '@/store/fundingStore';
import {
  EXCHANGE_COLORS,
  EXCHANGE_NAMES,
  MAX_ROUND_TRIP_IMPACT_BPS,
  OPERABLE_EXCHANGES,
  type ExchangeId,
  type Position,
  type SimPosition,
  type FeeOverrides,
  type PaybackOverrides,
} from '@/lib/types';
import { estimateProfit, getOpportunityId } from '@/lib/opportunities';
import { fmtNum, fmtPctOrInfinity, fmtUsdOrInfinity, isInfiniteProfitDisplay } from '@/lib/format';
import { buildManagedOpportunityItems, type ManagedOpportunityItem } from '@/lib/managedOpportunities';
import { hasRequiredApiCredentials, getMissingApiCredentialFields } from '@/lib/apiCredentials';

type ScheduleProbeEventStatus = 'selected' | 'rejected' | 'unselected' | 'analysis_summary' | string;
type OpportunityRowStatus = 'active' | 'scheduled' | 'opportunity' | 'blocked';

type RawTradeEvent = {
  type: 'schedule_probe' | 'guard_block' | string;
  timestamp: number;
  simulation?: boolean;
  reason?: string;
  detail?: string;
  baseAsset?: string;
  shortExchange?: string;
  longExchange?: string;
  analysis?: {
    opportunityId?: string;
    status?: string;
    selected?: boolean;
    rejectReasons?: unknown;
    timeToFundingMs?: unknown;
  };
  timeToFundingMs?: number;
};

type TradeDecisionByRouteKey = {
  probe?: {
    status: string;
    selected: boolean;
    rejectReasons: string[];
    timestamp: number;
    timeToFundingMs?: number;
  };
  guard?: {
    reason?: string;
    detail?: string;
    timestamp: number;
  };
};

const REJECT_REASON_LABELS: Record<string, string> = {
  already_scheduled_or_active: '?꾩옱 ?ㅼ?以??ъ???議댁옱',
  route_failure_blocked: '嫄곕옒???μ븷 李⑤떒',
  leg_occupied: '?숈씪 ?덇렇媛 ?대? ?먯쑀',
  short_exchange_disabled: '??嫄곕옒??鍮꾪솢??,
  long_exchange_disabled: '濡?嫄곕옒??鍮꾪솢??,
  tier_c_exchange_disabled: 'Tier C 嫄곕옒??鍮꾪솢??,
  outside_schedule_window: '?ㅽ뻾 ?덈룄????,
  funding_time_past: '????쒓컙 珥덇낵',
  spread_below_threshold: '?ㅽ봽?덈뱶 誘몃떖',
  profitability_calculation_failed: '?섏씡 怨꾩궛 ?ㅽ뙣',
  profitability_scan_failed: '?섏씡 議곌굔 誘몃떖',
  volume_below_min: '嫄곕옒??誘몃떖',
  funding_timestamp_mismatch: '?????꾩뒪?ы봽 遺덉씪移?,
  not_in_candidates: '?꾨낫援??쒖쇅',
  allocation_skip: '?щ’/?먮낯 諛곕텇 誘몄땐議?,
  balance_insufficient: '?붽퀬 遺議?,
  slot_full: '?щ’ 媛??李?,
  slot_fulls: '?щ’ 媛??李?,
  leg_overlap_after_selection: '?숈씪 ?덇렇 以묐났 ?좏깮',
  slots_full: '?щ’ 媛??李?,
  disabled_exchange: '嫄곕옒??鍮꾪솢??,
  tier_c_disabled: 'Tier C 嫄곕옒??鍮꾪솢??,
  near_due_grace_block: '留덇컧 ?꾨컯 蹂대쪟',
  not_scheduled: '?꾩옱 ?꾨낫 誘몄삁??,
  api_config_missing: 'API ?ㅼ젙 ?꾨씫',
  execution_timing_early: '?ㅽ뻾 ??대컢 ?대Ⅸ ?곹깭',
  execution_timing_stale: '?ㅽ뻾 ??대컢 吏??,
  funding_revalidate_missing: '????ш?利??ㅽ뙣',
  live_spread_reverted: '?ㅼ떆媛??ㅽ봽?덈뱶 ??쟾',
  funding_window_shifted: '???李??대룞',
  scheduler_inactive: '?ㅼ?以꾨윭 鍮꾪솢??,
  route_failure: '?ㅽ뻾 寃쎈줈 ?ㅽ뙣',
  replaced_by_better_candidate: '더 높은 순수익 후보로 교체',
  selected_without_timer: '예약 대상은 생성됨. 다만 타이머 미존재(재배치/캔슬 필요)',
};

type OpportunityDisplayItem = ManagedOpportunityItem & {
  displayStatus: OpportunityRowStatus;
  blockReason?: string;
  blockDetail?: string;
  isActuallyScheduled?: boolean;
};

type TradeDecisionSource = {
  byId: Record<string, TradeDecisionByRouteKey>;
  byRoute: Record<string, TradeDecisionByRouteKey>;
};

const ACTIVE_MODE_PREFIX = {
  sim: 'sim',
  real: 'real',
} as const;

function formatMinutesToFunding(ttfMs: number | null): string | null {
  if (ttfMs == null || !Number.isFinite(ttfMs)) return null;
  const totalMin = Math.round(ttfMs / 60_000);
  const mins = Math.max(0, totalMin);
  const sign = totalMin > 0 ? '+' : '';
  return `${sign}${mins}m`;
}

function describeScheduleMissingReason(ttfMs: number | undefined): string {
  if (typeof ttfMs === 'number' && Number.isFinite(ttfMs)) {
    const formatted = formatMinutesToFunding(ttfMs);
    return `스케줄 타이머 미존재 (${formatted ?? '0m'}), 재배치/캔슬 필요`;
  }
  return '스케줄 타이머 미존재';
}

function getOpportunityRouteKeyFromItem(item: Pick<ManagedOpportunityItem, 'opp'>): string | null {
  return getOpportunityRouteKey({
    baseAsset: item.opp.baseAsset,
    shortExchange: item.opp.shortExchange,
    longExchange: item.opp.longExchange,
  });
}

function parseRejectReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function getOpportunityRouteKey(event: Pick<RawTradeEvent, 'baseAsset' | 'shortExchange' | 'longExchange'>): string | null {
  if (!event.baseAsset || !event.shortExchange || !event.longExchange) return null;
  return `${event.baseAsset}:${event.shortExchange}:${event.longExchange}`;
}

function describeRejectReasons(rejectReasons: string[]): string {
  if (rejectReasons.length === 0) return '거래 미실행 사유 없음';
  return rejectReasons.map((reason) => REJECT_REASON_LABELS[reason] ?? reason).join(', ');
}

function buildBlockedDecision(
  status: ManagedOpportunityItem['status'],
  decision: TradeDecisionByRouteKey | undefined,
  hasActualSchedule: boolean,
): {
  displayStatus: OpportunityRowStatus;
  blockReason?: string;
  blockDetail?: string;
} {
  if (status === 'active') return { displayStatus: 'active' };
  if (status === 'scheduled' && !hasActualSchedule) {
    return {
      displayStatus: 'blocked',
      blockReason: REJECT_REASON_LABELS.selected_without_timer,
      blockDetail: describeScheduleMissingReason(undefined),
    };
  }

  const guard = decision?.guard;
  const probe = decision?.probe;

  if (guard) {
    return {
      displayStatus: 'blocked',
      blockReason: describeGuardReason(guard.reason, guard.detail),
      blockDetail: guard.detail,
    };
  }

  if (!probe) {
    return { displayStatus: status };
  }

  if (probe.status === 'analysis_summary') {
    return { displayStatus: status };
  }

  const selected = probe.selected || probe.status === 'selected';
  if (selected) {
    if (!hasActualSchedule) {
      return {
        displayStatus: 'blocked',
        blockReason: REJECT_REASON_LABELS.selected_without_timer,
        blockDetail: describeScheduleMissingReason(probe.timeToFundingMs),
      };
    }
    return { displayStatus: status === 'opportunity' ? 'scheduled' : status };
  }

  return {
    displayStatus: 'blocked',
    blockReason: describeRejectReasons(probe.rejectReasons),
    blockDetail: `schedule status: ${probe.status || 'rejected'}`,
  };
}

function buildBlockedReasonText(item: OpportunityDisplayItem): string | null {
  if (item.displayStatus !== 'blocked') return null;
  const reason = item.blockReason?.trim();
  const detail = item.blockDetail?.trim();
  if (!reason && !detail) return '거래 미실행(사유 미기재)';
  if (!detail) return reason;
  if (!reason) return detail;
  return `${reason} (${detail})`;
}

function describeGuardReason(reason?: string, detail?: string): string {
  if (reason && REJECT_REASON_LABELS[reason]) {
    return `${REJECT_REASON_LABELS[reason]}${detail ? ` (${detail})` : ''}`;
  }
  if (reason) return `${reason}${detail ? ` (${detail})` : ''}`;
  return detail ? `吏꾩엯 李⑤떒 (${detail})` : '吏꾩엯 李⑤떒';
}


/* ??? Tiny countdown hook ??? */
function useCountdown(targetMs: number) {
  const [remaining, setRemaining] = useState(() => Math.max(0, targetMs - Date.now()));
  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, targetMs - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetMs]);
  const totalSec = Math.floor(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { remaining, text: `${pad(h)}:${pad(m)}:${pad(s)}`, totalSec, expired: totalSec === 0 && targetMs > 0 };
}

/* ??? Mini exchange badge ??? */
function ExBadge({ ex, size = 'sm' }: { ex: ExchangeId; size?: 'sm' | 'xs' }) {
  const color = EXCHANGE_COLORS[ex] || '#94a3b8';
  const name = EXCHANGE_NAMES[ex] || ex.toUpperCase();
  const fontSize = size === 'xs' ? 9 : 10;
  const pad = size === 'xs' ? '1px 5px' : '2px 7px';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: pad, borderRadius: 4, fontSize, fontWeight: 700,
      background: `${color}22`, color, border: `1px solid ${color}33`,
      letterSpacing: '0.05em', lineHeight: 1.2,
    }}>
      {name}
    </span>
  );
}

/* ??? Inline countdown for each row ??? */
function InlineCountdown({ targetMs }: { targetMs: number }) {
  const { text, totalSec, expired } = useCountdown(targetMs);
  const urgent = !expired && totalSec < 300;
  if (targetMs === 0) return <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>??/span>;
  if (expired) return <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>?뺤궛 以?..</span>;
  return (
    <span className="mono" style={{
      fontSize: 13, fontWeight: 700,
      color: urgent ? '#ef4444' : '#10b981',
      animation: urgent ? 'blink 1s step-end infinite' : 'none',
    }}>
      {text}
    </span>
  );
}

/* ??? Next trade hero countdown ??? */
function NextTradeCountdown({ targetMs, asset, shortEx, longEx }: {
  targetMs: number; asset: string; shortEx: ExchangeId; longEx?: ExchangeId;
}) {
  const { text, totalSec, expired } = useCountdown(targetMs);
  const urgent = !expired && totalSec < 300;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      padding: '16px 24px', borderRadius: 14,
      background: urgent
        ? 'linear-gradient(135deg, rgba(239,68,68,0.12), rgba(239,68,68,0.04))'
        : 'linear-gradient(135deg, rgba(16,185,129,0.10), rgba(59,130,246,0.06))',
      border: `1px solid ${urgent ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.2)'}`,
      minWidth: 200,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Clock size={13} color={urgent ? '#ef4444' : '#10b981'} />
        <span style={{ fontSize: 11, color: urgent ? '#ef4444' : 'var(--color-text-muted)', fontWeight: 600 }}>
          ?ㅼ쓬 嫄곕옒源뚯?
        </span>
      </div>
      {expired ? (
        <span style={{ fontSize: 28, fontWeight: 800, color: '#f59e0b' }}>?뺤궛 以?..</span>
      ) : (
        <span className="mono" style={{
          fontSize: 36, fontWeight: 900, letterSpacing: '0.04em',
          color: urgent ? '#ef4444' : '#10b981',
          animation: urgent ? 'blink 1s step-end infinite' : 'none',
          lineHeight: 1,
        }}>
          {text}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-text)' }}>{asset}</span>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          <ExBadge ex={shortEx} size="xs" />
          {longEx && (
            <>
              <span style={{ margin: '0 3px', opacity: 0.5 }}>??/span>
              <ExBadge ex={longEx} size="xs" />
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/* ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧
   Main Component
   ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧 */
export default function OpportunityCard() {
  const {
    opportunities, strategyConfig, setShowStrategyPanel,
    apiConfigs, simulationMode, simPositions,
    simSnipeActive, realSnipeActive,
    snipeTargets, _snipeTimers, snipeAllocations, cancelSnipe,
    closeSimPosition, ratesStatus, ratesError, isLoadingRates,
    lastRatesUpdate, strategyRunning, realSpreads,
    simBalances, simInitialBalances, balances, fundingRates, enabledExchanges,
    tradesClearedAt,
  } = useFundingStore();

  const snipeActive = simulationMode ? simSnipeActive : realSnipeActive;

  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'snipe' | 'error' } | null>(null);
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const [compoundMode, setCompoundMode] = useState(true);
  const [manualActionKey, setManualActionKey] = useState<string | null>(null);
  const [tradeDecisionMap, setTradeDecisionMap] = useState<TradeDecisionSource>({ byId: {}, byRoute: {} });
  const isProcessing = strategyRunning;

  const positions = useFundingStore(s => s.positions);
  const executeStrategy = useFundingStore(s => s.executeStrategy);
  const isRunning = simulationMode ? simPositions.length > 0 : positions.length > 0;

  // Toast auto-dismiss
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  useEffect(() => {
    let aborted = false;
    const scope = simulationMode ? 'sim_executed' : 'real_executed';
    const from = Math.max(tradesClearedAt, Date.now() - 24 * 60 * 60 * 1000);
    const load = async () => {
      try {
        const params = new URLSearchParams({
          all: 'true',
          scope,
          type: 'schedule_probe,guard_block',
          from: String(from),
          limit: '400',
        });
        const response = await fetch(`/api/trades/list?${params}`);
        const json = await response.json() as { success?: boolean; events?: RawTradeEvent[] };
        if (aborted || !json.success || !Array.isArray(json.events)) return;

        const byId: Record<string, TradeDecisionByRouteKey> = {};
        const byRoute: Record<string, TradeDecisionByRouteKey> = {};
        const resolveRouteId = (event: RawTradeEvent) => {
          const direct = event.analysis?.opportunityId;
          if (direct) return direct;
          const routeKey = getOpportunityRouteKey(event);
          if (!routeKey) return null;
          const matched = opportunities
            .filter((opportunity) => getOpportunityRouteKey({
              baseAsset: opportunity.baseAsset,
              shortExchange: opportunity.shortExchange,
              longExchange: opportunity.longExchange,
            }) === routeKey)
            .map((opportunity) => ({ opportunity, id: getOpportunityId(opportunity) }));
          if (matched.length === 0) return null;
          if (typeof event.analysis?.timeToFundingMs === 'number' && Number.isFinite(event.analysis.timeToFundingMs)) {
            const targetMs = event.timestamp + event.analysis.timeToFundingMs;
            const nearest = matched.reduce((acc, current) => {
              const ttf = Math.abs(current.opportunity.nextFundingTime - targetMs);
              if (!acc || ttf < acc.ttf) return { ...current, ttf };
              return acc;
            }, null as null | ({ opportunity: (typeof matched)[number]['opportunity']; id: string; ttf: number }));
            return nearest?.id ?? null;
          }
          return matched.sort((a, b) => a.opportunity.nextFundingTime - b.opportunity.nextFundingTime)[0]?.id ?? null;
        };

        for (const event of json.events) {
          if (!event || typeof event.timestamp !== 'number' || event.timestamp <= 0) continue;
          const eventTime = event.timestamp;
          const routeKey = getOpportunityRouteKey(event);
          const opportunityId = resolveRouteId(event);
          if (!opportunityId) continue;

          const currentById = byId[opportunityId] ?? {};
          const currentByRoute = routeKey ? (byRoute[routeKey] ?? {}) : {};
          const decisionByRoute = routeKey ? (byRoute[routeKey] ?? currentById) : currentById;
          if (event.type === 'guard_block') {
            const shouldReplace = !currentById.guard || eventTime >= currentById.guard.timestamp;
            if (shouldReplace) {
              const next = {
                ...decisionByRoute,
                guard: {
                reason: event.reason,
                detail: event.detail,
                timestamp: eventTime,
                },
              };
              byId[opportunityId] = next;
              if (routeKey) byRoute[routeKey] = next;
            }
            continue;
          }
          if (event.type !== 'schedule_probe' || !event.analysis) continue;
          const status = (event.reason || event.analysis.status || '') as ScheduleProbeEventStatus;
          if (status === 'analysis_summary') continue;
          const rejectReasons = parseRejectReasons(event.analysis.rejectReasons);
          const existing = byId[opportunityId];
          if (!existing || !existing.probe || eventTime >= existing.probe.timestamp) {
            const next = existing ? { ...existing } : { ...currentByRoute };
            next.probe = {
              status,
              selected: event.analysis.selected ?? status === 'selected',
              rejectReasons,
              timeToFundingMs: event.analysis.timeToFundingMs,
              timestamp: eventTime,
            };
            byId[opportunityId] = next;
            if (routeKey) byRoute[routeKey] = next;
          }
        }

        if (!aborted) {
          setTradeDecisionMap({ byId, byRoute });
        }
      } catch {
        if (aborted) { /* no-op */ }
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 5_000);
    return () => {
      aborted = true;
      clearInterval(interval);
    };
  }, [simulationMode, tradesClearedAt, opportunities]);

  // ?? Handlers ??
  const closeRealPosition = useFundingStore(s => s.closePosition);
  const handleToggle = useCallback(async () => {
    if (!isRunning || isProcessing) return;
    if (simulationMode) {
      const ids = simPositions.map(p => p.simId);
      for (const id of ids) await closeSimPosition(id);
    } else if (positions.length > 0) {
      const results = await Promise.allSettled(positions.map(p => closeRealPosition(p)));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        setToastMsg({ text: `${positions.length - failed}媛?泥?궛 ?꾨즺, ${failed}媛??ㅽ뙣`, type: 'error' });
        return;
      }
    }
    if (snipeActive) {
      if (simulationMode) {
        try {
          const res = await fetch('/api/sim-scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          setToastMsg({ text: `[SIM] ?쒕쾭 ?쒕? ?ㅼ?以꾨윭 以묒? ?ㅽ뙣: ${(err as Error).message}`, type: 'error' });
          return;
        }
      }
      cancelSnipe(simulationMode ? 'sim' : 'real');
      // ?쒕쾭??鍮꾪솢???곹깭 ???(紐⑤뱺 湲곌린 ?숆린??
      try {
        await fetch('/api/snipe-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(simulationMode ? { simSnipeActive: false } : { realSnipeActive: false }),
        });
      } catch { /* silent */ }
    }
    setToastMsg({ text: '?꾩껜 ?ъ???泥?궛 ?꾨즺', type: 'success' });
  }, [isProcessing, isRunning, simulationMode, simPositions, closeSimPosition, snipeActive, cancelSnipe, positions, closeRealPosition]);

  const handleSnipe = useCallback(async () => {
    if (snipeActive) {
      // ?? ?뺤? ??
      if (!simulationMode) {
        // REAL: ?쒕쾭 ?ㅼ?以꾨윭 ?뺤?瑜?癒쇱? ?뺤씤 ???깃났 ?꾩뿉留??곹깭 媛깆떊
        try {
          const res = await fetch('/api/scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          setToastMsg({ text: `[REAL] ?쒕쾭 ?ㅼ?以꾨윭 ?뺤? ?ㅽ뙣 ???ъ떆???꾩슂: ${(err as Error).message}`, type: 'error' });
          return; // ?쒕쾭 ?ㅼ?以꾨윭媛 硫덉텛吏 ?딆븯?쇰㈃ ?곹깭瑜?OFF濡?諛붽씀吏 ?딆쓬
        }
      } else {
        try {
          const res = await fetch('/api/sim-scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          setToastMsg({ text: `[SIM] ?쒕쾭 ?쒕? ?ㅼ?以꾨윭 以묒? ?ㅽ뙣: ${(err as Error).message}`, type: 'error' });
          return;
        }
      }
      cancelSnipe(simulationMode ? 'sim' : 'real');
      // cancelSnipe ?대??먯꽌 /api/snipe-state + /api/scheduler stop ?몄텧?섏?留?
      // REAL? ?대? ?꾩뿉???뺤씤 ?꾨즺. snipe-state留?異붽? ???
      try {
        await fetch('/api/snipe-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(simulationMode ? { simSnipeActive: false } : { realSnipeActive: false }),
        });
      } catch { /* snipe-state ????ㅽ뙣??鍮꾩튂紐낆쟻 */ }
      setToastMsg({ text: `${simulationMode ? '[SIM]' : '[REAL]'} ?먮룞 ?ъ옄 以묒???, type: 'success' });
    } else {
      // ?? ?쒖옉 ??
      const state = useFundingStore.getState();
      const realEnabledExchanges = state.enabledExchanges
        .filter((exchange) => hasRequiredApiCredentials(exchange, state.apiConfigs[exchange]));
      const totalCapital = simulationMode
        ? state.strategyConfig.investmentUSDT * 2 * state.enabledExchanges.length
        : state.strategyConfig.investmentUSDT * 2 * realEnabledExchanges.length;

      if (!simulationMode) {
        if (realEnabledExchanges.length < 2) {
          const missingByExchange = state.enabledExchanges
            .map((exchange) => {
              const missing = getMissingApiCredentialFields(exchange, state.apiConfigs[exchange]);
              if (missing.length === 0) return null;
              return `${exchange.toUpperCase()}(${missing.join('/')})`;
            })
            .filter((item): item is string => item !== null);
          const detail = missingByExchange.length > 0 ? ` Missing: ${missingByExchange.join(', ')}` : '';
          setToastMsg({ text: `[REAL] Need valid API credentials on at least 2 exchanges.${detail}`, type: 'error' });
          return;
        }
        // REAL: ?쒕쾭 ?ㅼ?以꾨윭 ?쒖옉??癒쇱? ?뺤씤 ???깃났 ?꾩뿉留??곹깭瑜?ON?쇰줈
        try {
          const res = await fetch('/api/scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'start',
              config: buildSchedulerConfig(state.strategyConfig, realEnabledExchanges),
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json() as { success?: boolean; error?: string };
          if (!json.success) throw new Error(json.error || 'scheduler start failed');
        } catch (err) {
          setToastMsg({ text: `[REAL] ?쒕쾭 ?ㅼ?以꾨윭 ?쒖옉 ?ㅽ뙣: ${(err as Error).message}`, type: 'error' });
          return; // ?쒕쾭 ?ㅼ?以꾨윭媛 ???댁쑝硫??곹깭瑜?ON?쇰줈 諛붽씀吏 ?딆쓬
        }
        useFundingStore.setState({ realSnipeActive: true, realSnipeStartCapital: totalCapital });
        await fetch('/api/snipe-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ realSnipeActive: true }),
        }).catch(() => {});
        setToastMsg({ text: '[REAL] ?ㅻ굹?댄븨 ?쒖옉! (?쒕쾭 諛깃렇?쇱슫??ON)', type: 'success' });
      } else {
        // SIM: ?대씪?댁뼵????대㉧ 湲곕컲
        try {
          const res = await fetch('/api/sim-scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'start',
              config: buildServerSimSchedulerConfig(state.strategyConfig, state.enabledExchanges),
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json() as {
            success?: boolean;
            error?: string;
            status?: {
              snipeTargets?: Record<string, number>;
              snipeAllocations?: Record<string, number>;
            };
          };
          if (!json.success) throw new Error(json.error || 'sim scheduler start failed');
          useFundingStore.setState({
            simSnipeActive: true,
            simSnipeStartCapital: totalCapital,
            snipeTargets: {
              ...Object.fromEntries(
                Object.entries(useFundingStore.getState().snipeTargets).filter(([key]) => !key.startsWith('sim:')),
              ),
              ...(json.status?.snipeTargets ?? {}),
            },
            snipeAllocations: {
              ...Object.fromEntries(
                Object.entries(useFundingStore.getState().snipeAllocations).filter(([key]) => !key.startsWith('sim:')),
              ),
              ...(json.status?.snipeAllocations ?? {}),
            },
          });
        } catch (err) {
          setToastMsg({ text: `[SIM] ?쒕쾭 ?쒕? ?ㅼ?以꾨윭 ?쒖옉 ?ㅽ뙣: ${(err as Error).message}`, type: 'error' });
          return;
        }
        await fetch('/api/snipe-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ simSnipeActive: true }),
        }).catch(() => {});
        const count = Object.keys(useFundingStore.getState().snipeTargets).filter((key) => key.startsWith('sim:')).length;
        setToastMsg({ text: `[SIM] ?ㅻ굹?댄븨 ?쒖옉! ${count}媛?肄붿씤 ?덉빟`, type: 'success' });
      }
    }
  }, [snipeActive, simulationMode, cancelSnipe]);

  // ?? Portfolio ??

  const matchManagedPosition = useCallback(
    (item: ManagedOpportunityItem, position: Position | SimPosition) => {
      if (item.pairId && position.pairId) return item.pairId === position.pairId;
      if (position.baseAsset !== item.asset) return false;
      return position.exchange === item.opp.shortExchange || position.exchange === item.opp.longExchange;
    },
    [],
  );

  const getMatchedSimPositions = useCallback(
    (item: ManagedOpportunityItem) => simPositions.filter((position) => matchManagedPosition(item, position)),
    [matchManagedPosition, simPositions],
  );

  const getMatchedRealPositions = useCallback(
    (item: ManagedOpportunityItem) => positions.filter((position) => matchManagedPosition(item, position)),
    [matchManagedPosition, positions],
  );

  const perExchangeInvestment = strategyConfig.investmentUSDT;
  const best = opportunities[0];
  const configuredRealExchangeCount = enabledExchanges.filter((exchange) => {
    return hasRequiredApiCredentials(exchange, apiConfigs[exchange]);
  }).length;
  const canExecute = simulationMode
    ? true
    : configuredRealExchangeCount >= 2;

  const handleManualEnter = useCallback(async (item: ManagedOpportunityItem) => {
    if (isProcessing || manualActionKey) return;
    if (!simulationMode && !canExecute) {
      setToastMsg({ text: '[REAL] API ?ㅺ? ?ㅼ젙??嫄곕옒??2媛??댁긽???꾩슂?⑸땲??', type: 'error' });
      return;
    }

    setManualActionKey(`enter:${item.id}`);
    try {
      const result = await executeStrategy(
        item.opp,
        simulationMode,
        item.investmentUSDT ?? strategyConfig.investmentUSDT,
      );
      if (result?.success) {
        setToastMsg({ text: `${simulationMode ? '[SIM]' : '[REAL]'} ${item.asset} 吏꾩엯 ?깃났`, type: 'success' });
      } else {
        const detail = result?.error || result?.reason || '?ъ쟾 寃利??ㅽ뙣';
        setToastMsg({ text: `${simulationMode ? '[SIM]' : '[REAL]'} ${item.asset} 吏꾩엯 ?ㅽ뙣: ${detail}`, type: 'error' });
      }
    } catch (error) {
      setToastMsg({ text: `${simulationMode ? '[SIM]' : '[REAL]'} ${item.asset} 吏꾩엯 ?ㅻ쪟: ${(error as Error).message}`, type: 'error' });
    } finally {
      setManualActionKey(null);
    }
  }, [
    canExecute,
    executeStrategy,
    isProcessing,
    manualActionKey,
    simulationMode,
    strategyConfig.investmentUSDT,
  ]);

  const handleManualExit = useCallback(async (item: ManagedOpportunityItem) => {
    if (isProcessing || manualActionKey) return;

    setManualActionKey(`exit:${item.id}`);
    try {
      if (simulationMode) {
        const targets = getMatchedSimPositions(item);
        if (targets.length === 0) {
          setToastMsg({ text: `[SIM] ${item.asset} 泥?궛 ????ъ??섏씠 ?놁뒿?덈떎.`, type: 'error' });
          return;
        }
        const results = await Promise.allSettled(targets.map((position) => closeSimPosition(position.simId)));
        const failed = results.filter((result) => result.status === 'rejected').length;
        if (failed > 0) {
          setToastMsg({ text: `[SIM] ${item.asset} 泥?궛 遺遺??ㅽ뙣 (${targets.length - failed}/${targets.length})`, type: 'error' });
        } else {
          setToastMsg({ text: `[SIM] ${item.asset} 泥?궛 ?꾨즺`, type: 'success' });
        }
        return;
      }

      const targets = getMatchedRealPositions(item);
      if (targets.length === 0) {
        setToastMsg({ text: `[REAL] ${item.asset} 泥?궛 ????ъ??섏씠 ?놁뒿?덈떎.`, type: 'error' });
        return;
      }
      const results = await Promise.allSettled(targets.map((position) => closeRealPosition(position)));
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed > 0) {
        setToastMsg({ text: `[REAL] ${item.asset} 泥?궛 遺遺??ㅽ뙣 (${targets.length - failed}/${targets.length})`, type: 'error' });
      } else {
        setToastMsg({ text: `[REAL] ${item.asset} 泥?궛 ?꾨즺`, type: 'success' });
      }
    } finally {
      setManualActionKey(null);
    }
  }, [
    closeRealPosition,
    closeSimPosition,
    getMatchedRealPositions,
    getMatchedSimPositions,
    isProcessing,
    manualActionKey,
    simulationMode,
  ]);

  // ?? Build scheduled list: snipe targets + active positions mapped to opportunities ??
  // ??realSpreads ?ы븿: 嫄곕옒??媛?媛寃?愿대━媛 ????ぉ? memo ?④퀎?먯꽌 利됱떆 ?쒓굅
  const managedOpportunityItems = useMemo(
    () => {
      const items = buildManagedOpportunityItems({
        opportunities,
        snipeTargets,
        snipeAllocations,
        activePositions: (simulationMode ? simPositions : positions) as Array<Position | SimPosition>,
        simulationMode,
        defaultInvestmentUSDT: strategyConfig.investmentUSDT,
        leverage: strategyConfig.leverage,
        feeOverrides: strategyConfig.feeOverrides,
        paybackOverrides: strategyConfig.paybackOverrides,
        useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
        limit: 15,
      });
      // realSpread ?ы븿: ?ㅼ쭏 ?섏씡??留덉씠?덉뒪硫??덉빟/?꾨낫 ?④?
      return items.filter(item => {
        if (item.status === 'active') return true;
        const rs = realSpreads[item.id] ?? realSpreads[item.asset];
        if (!rs) return true;
        // effectiveSpread濡??ㅼ쭏 ?섏씡 吏곸젒 怨꾩궛
        const perSide = item.investmentUSDT ?? strategyConfig.investmentUSDT;
        const effectiveOpp = { ...item.opp, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread };
        const snipeCfg = strategyConfig.confirmedSnipeConfig;
        const measuredImpactPercent = Math.max(0, (rs.shortSlippage ?? 0) + (rs.longSlippage ?? 0));
        const fallbackImpactPercent = snipeCfg?.useImpactGuards
          ? ((snipeCfg.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 200)
          : ((snipeCfg?.targetImpactBps ?? 4) / 100);
        const impactPercent = measuredImpactPercent > 0 ? measuredImpactPercent : fallbackImpactPercent;
        const profit = estimateProfit(effectiveOpp, perSide, strategyConfig.leverage, {
          skipFees: false,
          feeOverrides: strategyConfig.feeOverrides,
          paybackOverrides: strategyConfig.paybackOverrides,
          useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
          entryImpactPercent: impactPercent,
          exitImpactPercent: impactPercent,
        });
        return profit.netPerFunding > 0;
      });
    },
    [
      opportunities,
      positions,
      simulationMode,
      simPositions,
      snipeAllocations,
      snipeTargets,
      strategyConfig.feeOverrides,
      strategyConfig.paybackOverrides,
      strategyConfig.investmentUSDT,
      strategyConfig.leverage,
      strategyConfig.confirmedSnipeConfig,
      realSpreads,
    ],
  );

  const scheduledCoins: OpportunityDisplayItem[] = useMemo(() => {
    const modePrefix = simulationMode ? ACTIVE_MODE_PREFIX.sim : ACTIVE_MODE_PREFIX.real;
    const isActuallyScheduled = (item: ManagedOpportunityItem) => {
      const key = `${modePrefix}:${item.id}`;
      const targetAt = snipeTargets[key];
      const targetInFuture = typeof targetAt === 'number' && targetAt > Date.now();
      const hasActiveTimer = Boolean(_snipeTimers?.[key]);
      return targetInFuture && hasActiveTimer;
    };
    return managedOpportunityItems.map((item) => {
      const routeKey = getOpportunityRouteKeyFromItem(item);
      const decision = tradeDecisionMap.byId[item.id] ?? (routeKey ? tradeDecisionMap.byRoute[routeKey] : undefined);
      const derived = buildBlockedDecision(item.status, decision, isActuallyScheduled(item));
      return {
        ...item,
        isActuallyScheduled: isActuallyScheduled(item),
        displayStatus: derived.displayStatus,
        blockReason: derived.blockReason,
        blockDetail: derived.blockDetail,
      };
    });
  }, [managedOpportunityItems, tradeDecisionMap, snipeTargets, _snipeTimers, simulationMode]);
  // Nearest upcoming trade ???덉빟/?쒖꽦 以?媛??鍮좊Ⅸ 寃?(?섏씡 臾닿?)
  const nextTrade = useMemo(() => {
    const scheduled = scheduledCoins.filter(c => c.displayStatus === 'scheduled' || c.displayStatus === 'active');
    if (scheduled.length === 0) return null;
    return scheduled.reduce((a, b) => a.fundingTime < b.fundingTime ? a : b);
  }, [scheduledCoins]);

  // Status banner
  const statusMsg = !best
    ? ((isLoadingRates || ratesStatus === 'loading') && !lastRatesUpdate) ? '??⑸쪧 ?곗씠??議고쉶 以?..'
      : (ratesStatus === 'error' && !lastRatesUpdate) ? `議고쉶 ?ㅽ뙣 ??${ratesError || '?먮룞 ?ъ떆??以?}`
      : lastRatesUpdate ? '?좏슚???룹쭠 湲고쉶 ?놁쓬 ???ㅽ봽?덈뱶 湲곗? 誘몃떖'
      : '??⑸쪧 ?곗씠??議고쉶 以?..'
    : null;

  // ?ㅼ젣 ?쒖떆?섎뒗 ??ぉ 湲곗? 移댁슫??(?뚯닔 ?섏씡?쇰줈 ?④꺼吏??덉빟? ?쒖쇅)
  const scheduledCount = scheduledCoins.filter(c => c.displayStatus === 'scheduled').length;
  const activeCount = scheduledCoins.filter(c => c.displayStatus === 'active').length;
  const candidateCount = scheduledCoins.filter(c => c.displayStatus === 'opportunity').length;
  const blockedCount = scheduledCoins.filter(c => c.displayStatus === 'blocked').length;

  const totalBalanceSummary = useMemo(() => {
    if (simulationMode) {
      const currentTotal = OPERABLE_EXCHANGES
        .reduce((sum, exchange) => sum + (simBalances[exchange] ?? 0), 0);
      const initialTotal = OPERABLE_EXCHANGES
        .reduce((sum, exchange) => sum + (simInitialBalances[exchange] ?? 0), 0);
      const pnl = currentTotal - initialTotal;
      const roiPercent = initialTotal > 0 ? (pnl / initialTotal) * 100 : 0;
      return {
        currentTotal,
        initialTotal,
        pnl,
        roiPercent,
        availableTotal: currentTotal,
        usedTotal: 0,
        unrealizedTotal: 0,
      };
    }

    const currentTotal = OPERABLE_EXCHANGES
      .reduce((sum, exchange) => sum + (balances[exchange]?.totalUSDT ?? 0), 0);
    const availableTotal = OPERABLE_EXCHANGES
      .reduce((sum, exchange) => sum + (balances[exchange]?.availableUSDT ?? 0), 0);
    const usedTotal = OPERABLE_EXCHANGES
      .reduce((sum, exchange) => sum + (balances[exchange]?.usedUSDT ?? 0), 0);
    const unrealizedTotal = OPERABLE_EXCHANGES
      .reduce((sum, exchange) => sum + (balances[exchange]?.unrealizedPnl ?? 0), 0);

    return {
      currentTotal,
      initialTotal: 0,
      pnl: 0,
      roiPercent: 0,
      availableTotal,
      usedTotal,
      unrealizedTotal,
    };
  }, [balances, simBalances, simInitialBalances, simulationMode]);

  // ???二쇨린蹂??꾪솴 (1h, 4h, 8h) ???덉빟+?쒖꽦 vs ?꾩껜 ???媛??肄붿씤 ??  const intervalStats = useMemo(() => {
    const buckets: Record<string, { scheduled: number; total: number; assets: string[] }> = {
      '1h': { scheduled: 0, total: 0, assets: [] },
      '4h': { scheduled: 0, total: 0, assets: [] },
      '8h': { scheduled: 0, total: 0, assets: [] },
    };
    // ?꾩껜 肄붿씤 ??(fundingRates?먯꽌 怨좎쑀 baseAsset 湲곗?)
    const seenByInterval = new Set<string>();
    for (const rate of fundingRates) {
      const key2 = `${rate.baseAsset}:${rate.intervalHours <= 1 ? '1h' : rate.intervalHours <= 4 ? '4h' : '8h'}`;
      if (seenByInterval.has(key2)) continue;
      seenByInterval.add(key2);
      const iKey = rate.intervalHours <= 1 ? '1h' : rate.intervalHours <= 4 ? '4h' : '8h';
      buckets[iKey].total++;
    }
    // ?덉빟 + ?쒖꽦 移댁슫??    for (const item of scheduledCoins) {
      if (item.displayStatus === 'opportunity') continue;
      const h = item.opp.fundingIntervalMs ? Math.round(item.opp.fundingIntervalMs / 3600000) : 8;
      const key = h <= 1 ? '1h' : h <= 4 ? '4h' : '8h';
      buckets[key].scheduled++;
      buckets[key].assets.push(item.asset);
    }
    return buckets;
  }, [scheduledCoins, fundingRates]);

  return (
    <>
      {/* Toast */}
      {toastMsg && (
        <div className={`toast toast-${toastMsg.type}`}>
          {toastMsg.type === 'success' ? <Check size={16} /> : toastMsg.type === 'error' ? <Zap size={16} /> : <Crosshair size={16} />}
          {toastMsg.text}
        </div>
      )}

      <div className="glass-card opportunity-glow" style={{
        padding: '20px 24px',
        background: 'linear-gradient(135deg, rgba(16,185,129,0.04), rgba(15,22,35,1) 60%)',
        borderColor: 'rgba(16,185,129,0.2)',
      }}>

        {/* ?먥븧??SECTION 1: Status Bar + Next Trade ?먥븧??*/}
        <div className="opp-hero-section" style={{
          display: 'flex', alignItems: 'stretch', gap: 16, marginBottom: 16,
          flexWrap: 'wrap',
        }}>
          {/* Next Trade Countdown */}
          {nextTrade ? (
            <NextTradeCountdown
              targetMs={nextTrade.fundingTime}
              asset={nextTrade.asset}
              shortEx={nextTrade.opp.shortExchange}
              longEx={nextTrade.opp.longExchange}
            />
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 4, padding: '16px 24px', borderRadius: 14,
              background: 'linear-gradient(135deg, rgba(100,116,139,0.08), rgba(100,116,139,0.03))',
              border: '1px solid rgba(100,116,139,0.2)', minWidth: 200,
            }}>
              <Clock size={13} color="var(--color-text-muted)" />
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>?덉빟??嫄곕옒 ?놁쓬</span>
            </div>
          )}

          {/* Quick Stats */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, minWidth: 180 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <StatPill label="?덉빟/湲고쉶" value={`${scheduledCount + activeCount} / ${opportunities.length}`} color="#3b82f6" active={scheduledCount + activeCount > 0} />
                <StatPill label="?쒖꽦" value={`${activeCount}媛?} color="#f59e0b" active={activeCount > 0} />
                <StatPill label="?덉빟" value={`${scheduledCount}媛?} color="#10b981" active={scheduledCount > 0} />
                <StatPill label="?쒖닔" value={`${blockedCount}媛?} color="#ef4444" active={blockedCount > 0} />
                <StatPill label="?꾨낫" value={`${candidateCount}媛?} color="#64748b" active={candidateCount > 0} />
              </div>
            {/* Config summary */}
            <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--color-text-muted)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{
                color: '#3b82f6',
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: 4,
                background: 'rgba(59,130,246,0.15)',
                fontSize: 10,
              }}>
                ?룹쭠
              </span>
              <span>?ъ??섎떦 <strong style={{ color: 'var(--color-text)' }}>${perExchangeInvestment.toLocaleString()}</strong></span>
              <span>嫄곕옒?뚮떦 <strong style={{ color: '#f59e0b' }}>${(perExchangeInvestment * 2).toLocaleString()}</strong> <span style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>(濡???</span></span>
              <span>?덈쾭由ъ? <strong style={{ color: 'var(--color-text)' }}>{strategyConfig.leverage}x</strong></span>
              <span style={{ color: strategyConfig.compoundInvesting ? '#a78bfa' : '#10b981', fontWeight: 700 }}>
                {strategyConfig.compoundInvesting ? '蹂듬━' : '?⑤━'}
              </span>
              <button
                onClick={() => setShowStrategyPanel(true)}
                style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 11, padding: 0, display: 'flex', alignItems: 'center', gap: 2 }}
              >
                <Settings size={11} /> ?섏젙
              </button>
            </div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(56,189,248,0.08), rgba(16,185,129,0.06))',
              border: '1px solid rgba(56,189,248,0.25)',
              flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 10, color: 'var(--color-text-muted)', fontWeight: 700, letterSpacing: '0.03em' }}>
                  TOTAL BALANCE
                </span>
                <span className="mono" style={{ fontSize: 20, fontWeight: 900, color: '#22d3ee', lineHeight: 1 }}>
                  ${fmtNum(totalBalanceSummary.currentTotal, 2)}
                </span>
              </div>
              {simulationMode ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right' }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    Initial ${fmtNum(totalBalanceSummary.initialTotal, 2)}
                  </span>
                  <span className="mono" style={{
                    fontSize: 13,
                    fontWeight: 800,
                    color: totalBalanceSummary.pnl >= 0 ? '#10b981' : '#ef4444',
                  }}>
                    PnL {totalBalanceSummary.pnl >= 0 ? '+' : ''}${fmtNum(totalBalanceSummary.pnl, 2)}
                    {' '}
                    ({totalBalanceSummary.roiPercent >= 0 ? '+' : ''}{fmtNum(totalBalanceSummary.roiPercent, 2)}%)
                  </span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right', fontSize: 11, color: 'var(--color-text-muted)' }}>
                  <span>Avail ${fmtNum(totalBalanceSummary.availableTotal, 2)} / Used ${fmtNum(totalBalanceSummary.usedTotal, 2)}</span>
                  <span className="mono" style={{ color: totalBalanceSummary.unrealizedTotal >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>
                    Unrealized {totalBalanceSummary.unrealizedTotal >= 0 ? '+' : ''}${fmtNum(totalBalanceSummary.unrealizedTotal, 2)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Action Button */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, minWidth: 180 }}>
            {isRunning ? (
              <button
                className="btn btn-danger"
                style={{
                  padding: '12px 20px', fontSize: 13, fontWeight: 800, borderRadius: 10,
                  opacity: isProcessing ? 0.5 : 1,
                  cursor: isProcessing ? 'not-allowed' : 'pointer',
                  background: 'linear-gradient(135deg, #f59e0b, #f97316)',
                  border: '2px solid #fbbf24',
                  boxShadow: '0 0 12px rgba(245,158,11,0.3)',
                  animation: 'pulse-glow 2s ease-in-out infinite',
                  display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                }}
                disabled={isProcessing}
                onClick={handleToggle}
              >
                {isProcessing ? (
                  <>
                    <div style={{ width: 14, height: 14, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                    泥섎━ 以?..
                  </>
                ) : (
                  <>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff', boxShadow: '0 0 6px #fff', animation: 'blink 1.5s ease-in-out infinite' }} />
                    {simulationMode ? '[SIM] ' : ''}?ㅽ뻾 以?({activeCount}媛? ??泥?궛
                  </>
                )}
              </button>
            ) : (
              <button
                className={`btn ${snipeActive ? 'snipe-scheduled' : ''}`}
                style={{
                  padding: '12px 20px', fontSize: 13, fontWeight: 800, borderRadius: 10,
                  cursor: 'pointer',
                  opacity: 1,
                  background: snipeActive
                    ? 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(16,185,129,0.08))'
                    : 'linear-gradient(135deg, #10b981, #059669)',
                  border: `1px solid ${snipeActive ? 'rgba(16,185,129,0.5)' : 'rgba(16,185,129,0.5)'}`,
                  color: snipeActive ? '#10b981' : '#fff',
                  display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                }}
                disabled={false}
                onClick={handleSnipe}
              >
                {snipeActive ? (
                  <>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px #10b981', animation: 'blink 1.5s ease-in-out infinite' }} />
                    {simulationMode ? '[SIM] ' : ''}?먮룞 ?ъ옄 ON ???꾧린
                  </>
                ) : (
                  <>
                    <Crosshair size={14} />
                    {simulationMode ? '[SIM] ' : ''}?먮룞 ?ъ옄 ?쒖옉
                  </>
                )}
              </button>
            )}
            {!canExecute && !isRunning && !simulationMode && best && (
              <div style={{ fontSize: 10, color: 'var(--color-warning)', textAlign: 'center' }}>
                REAL requires valid API credentials on at least 2 enabled exchanges.
              </div>
            )}
          </div>
        </div>

        {/* Status banner */}
        {statusMsg && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '8px 16px', marginBottom: 12, borderRadius: 8,
            background: ratesStatus === 'error' && !lastRatesUpdate ? 'rgba(239,68,68,0.08)' : 'rgba(59,130,246,0.08)',
            border: `1px solid ${ratesStatus === 'error' && !lastRatesUpdate ? 'rgba(239,68,68,0.2)' : 'rgba(59,130,246,0.2)'}`,
          }}>
            {(!lastRatesUpdate && ratesStatus !== 'error') && (
              <div style={{ width: 14, height: 14, border: '2px solid var(--color-primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
            )}
            <span style={{ fontSize: 12, color: ratesStatus === 'error' && !lastRatesUpdate ? '#ef4444' : 'var(--color-text-muted)' }}>
              {statusMsg}
            </span>
          </div>
        )}

        {/* ?먥븧??Funding Interval Dashboard ?먥븧??*/}
        {snipeActive && (
          <div style={{
            display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap',
          }}>
            {(['1h', '4h', '8h'] as const).map(interval => {
              const stat = intervalStats[interval];
              const hasItems = stat.scheduled > 0;
              const colorMap = { '1h': '#06b6d4', '4h': '#8b5cf6', '8h': '#64748b' };
              const color = colorMap[interval];
              return (
                <div key={interval} style={{
                  flex: 1, minWidth: 120, padding: '8px 12px', borderRadius: 10,
                  background: hasItems ? `${color}0d` : 'rgba(100,116,139,0.04)',
                  border: `1px solid ${hasItems ? `${color}33` : 'rgba(100,116,139,0.12)'}`,
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 800, color,
                      padding: '1px 6px', borderRadius: 4,
                      background: `${color}1a`,
                    }}>
                      {interval}
                    </span>
                    <span style={{
                      fontSize: 18, fontWeight: 900, lineHeight: 1,
                      color: hasItems ? color : 'var(--color-text-muted)',
                    }}>
                      {stat.scheduled} <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.5 }}>/</span> <span style={{ fontSize: 13, fontWeight: 700, opacity: 0.6 }}>{stat.total}</span>
                    </span>
                  </div>
                  {hasItems ? (
                    <div style={{ fontSize: 10, color, opacity: 0.8, lineHeight: 1.4 }}>
                      {stat.assets.join(', ')}
                    </div>
                  ) : (
                    <div style={{ fontSize: 10, color: 'var(--color-text-muted)', opacity: 0.5 }}>
                      {stat.total > 0 ? `${stat.total}媛?湲고쉶 以??덉빟 ?놁쓬` : '?대떦 二쇨린 湲고쉶 ?놁쓬'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ?먥븧??SECTION 2: Scheduled/Candidate Table ?먥븧??*/}
        {scheduledCoins.length > 0 && (
          <div style={{ marginBottom: 0, overflowX: 'auto' }}>
            {scheduledCount === 0 && activeCount === 0 && candidateCount > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '8px 12px', marginBottom: 10, borderRadius: 8,
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.18)',
                fontSize: 11, color: '#fbbf24',
              }}>
                <strong>?덉빟??/strong> = ????쒓컙???먮룞 吏꾩엯 ?덉젙 (7珥????ㅻ굹?댄봽) &nbsp;|&nbsp;
                <strong>?ㅽ뻾 以?/strong> = ?꾩옱 ?ъ???蹂댁쑀 以?&nbsp;|&nbsp;
                <strong>?꾨낫</strong> = ?섏씡???믪? 湲고쉶 紐⑸줉. &nbsp;|&nbsp;
                <strong>?쒖닔</strong> = ?좏깭?④? ?ㅽ깅????媛 ?꾩뀰??湲고쉶
              </div>
            )}
            {/* Table Header */}
            <div className="opp-table-header" style={{
              display: 'grid',
              gridTemplateColumns: '24px 54px 110px 68px 68px 50px 72px 64px 54px 66px 66px 66px 56px 66px',
              minWidth: 940,
              gap: 4, padding: '6px 10px', marginBottom: 4,
              fontSize: 10, fontWeight: 600, color: 'var(--color-text-muted)',
              borderBottom: '1px solid var(--color-border)',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              <span className="opp-hide-mobile">#</span>
              <span>?곹깭</span>
              <span>肄붿씤</span>
              <span className="opp-hide-mobile" style={{ textAlign: 'center' }}>??/span>
              <span className="opp-hide-mobile" style={{ textAlign: 'center' }}>濡?/span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>嫄곕옒??/span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>?ъ옄湲?/span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>??⑹닔??/span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>?섏닔猷?/span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>?섏닔猷??섏씠諛?/span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>?덊띁???섏씠諛?/span>
              <span style={{ textAlign: 'right' }}>?쒖닔??/span>
              <span style={{ textAlign: 'right' }}>?섏씡瑜?/span>
              <span className="opp-hide-mobile" style={{ textAlign: 'right' }}>??⑷퉴吏</span>
            </div>

            {/* Rows ??15??怨좎젙 */}
            {(() => {
              let visibleIdx = 0;
              const ROW_HEIGHT = 42;
              const MIN_ROWS = 15;
              // ?쒖감???붽퀬 異붿쟻: ?댁쟾 湲고쉶??留덉쭊 ?ъ슜??諛섏쁺
              const remainingBal: Record<string, number> = {};
              if (strategyConfig.compoundInvesting) {
                const allExchanges = simulationMode
                  ? Object.keys(simBalances) as ExchangeId[]
                  : Object.keys(balances) as ExchangeId[];
                for (const ex of allExchanges) {
                  remainingBal[ex] = simulationMode
                    ? (simBalances[ex] ?? 0)
                    : (balances[ex]?.availableUSDT ?? 0);
                  // ?쒖꽦 ?ъ??섏쓽 locked margin 李④컧
                  const locked = (simulationMode ? simPositions : positions)
                    .filter(p => p.exchange === ex).reduce((s, p) => s + p.margin, 0);
                  remainingBal[ex] = Math.max(0, remainingBal[ex] - locked);
                }
              }
              // ????쒓컙?蹂??먭툑 蹂듦? 異붿쟻: ?댁쟾 ?쒓컙? ?ㅻ굹?댄봽 ?꾨즺 ???먭툑 諛섑솚
              let lastFundingWindow = 0; // ?꾩옱 泥섎━ 以묒씤 ????쒓컙 ?덈룄??              const pendingReturns: { exchange: string; amount: number; fundingTime: number }[] = [];

              const renderedRows = scheduledCoins.map((item) => {
              const isExpanded = expandedAsset === item.id;
              const realSpread = realSpreads[item.id] ?? realSpreads[item.asset];

              // ?쒖감 ?붽퀬 湲곕컲 ?ъ옄湲?怨꾩궛 (蹂듬━: ?댁쟾 湲고쉶 留덉쭊 ?뚯쭊 諛섏쁺)
              let itemPerSide = item.investmentUSDT ?? perExchangeInvestment;
              if (strategyConfig.compoundInvesting) {
                // ??????쒓컙?濡??섏뼱媛??? ?댁쟾 ?쒓컙? ?ㅻ굹?댄봽 ?먭툑 蹂듦? 諛섏쁺
                const currentWindow = item.fundingTime;
                if (lastFundingWindow > 0 && currentWindow - lastFundingWindow > 120_000) {
                  // ?꾩옱 ?쒓컙?蹂대떎 ?댁쟾???꾨즺???ㅻ굹?댄봽???먭툑 蹂듦?
                  for (const ret of pendingReturns) {
                    if (ret.fundingTime < currentWindow - 60_000) { // 1遺?留덉쭊
                      remainingBal[ret.exchange] = (remainingBal[ret.exchange] ?? 0) + ret.amount;
                    }
                  }
                  // 蹂듦? ?꾨즺????ぉ ?쒓굅
                  const keepIdx = pendingReturns.findIndex(r => r.fundingTime >= currentWindow - 60_000);
                  if (keepIdx > 0) pendingReturns.splice(0, keepIdx);
                }
                lastFundingWindow = currentWindow;

                if (item.investmentUSDT == null || item.displayStatus === 'opportunity') {
                  const shortBal = remainingBal[item.opp.shortExchange] ?? 0;
                  const longBal = remainingBal[item.opp.longExchange] ?? 0;
                  itemPerSide = Math.max(0, Math.min(shortBal, longBal) * 0.9);
                }
                // ??湲고쉶媛 ?ъ슜??留덉쭊???붽퀬?먯꽌 ?쒖감 李④컧 + 蹂듦? ?덉빟
                if (itemPerSide > 0) {
                  remainingBal[item.opp.shortExchange] = (remainingBal[item.opp.shortExchange] ?? 0) - itemPerSide;
                  remainingBal[item.opp.longExchange] = (remainingBal[item.opp.longExchange] ?? 0) - itemPerSide;
                  // ?ㅻ굹?댄봽 ?꾨즺 ???먭툑 蹂듦? ?덉빟 (留덉쭊 諛섑솚)
                  pendingReturns.push({ exchange: item.opp.shortExchange, amount: itemPerSide, fundingTime: item.fundingTime });
                  pendingReturns.push({ exchange: item.opp.longExchange, amount: itemPerSide, fundingTime: item.fundingTime });
                }
              }
              // ?ъ옄湲?$1 誘몃쭔?대㈃ 嫄곕옒 遺덇? ???꾨낫???④? (?덉빟/?쒖꽦? ?쒖떆)
              if (item.displayStatus === 'opportunity' && itemPerSide < 1) return null;
              const hasRealSpread = !!realSpread;
              const snipeCfg = strategyConfig.confirmedSnipeConfig;
              const measuredImpactPercent = hasRealSpread
                ? Math.max(0, (realSpread.shortSlippage ?? 0) + (realSpread.longSlippage ?? 0))
                : null;
              const fallbackImpactPercent = snipeCfg?.useImpactGuards
                ? ((snipeCfg.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 200)
                : ((snipeCfg?.targetImpactBps ?? 4) / 100);
              const impactPercent = measuredImpactPercent ?? fallbackImpactPercent;
              const displayFeeProfit = estimateProfit(item.opp, itemPerSide, strategyConfig.leverage, {
                skipFees: false,
                feeOverrides: strategyConfig.feeOverrides,
                paybackOverrides: strategyConfig.paybackOverrides,
                useDriftBuffer: snipeCfg?.useDriftBuffer,
                entryImpactPercent: impactPercent,
                exitImpactPercent: impactPercent,
              });
              const executionProfit = displayFeeProfit;
              const displayRawFees = displayFeeProfit.rawTotalFees;
              const displayTraderPayback = displayFeeProfit.traderFeePayback;
              const displayReferralPayback = displayFeeProfit.referralFeePayback;
              if (executionProfit.netPerFunding <= 0 && item.displayStatus !== 'active' && item.displayStatus !== 'blocked') return null;

              visibleIdx++;

              // ???二쇨린蹂??됱긽 (1h=cyan, 4h=purple, 8h=default)
              const intervalH = item.opp.fundingIntervalMs ? Math.round(item.opp.fundingIntervalMs / 3600000) : 8;
              const intervalColor = intervalH <= 1 ? 'rgba(6,182,212,' : intervalH <= 4 ? 'rgba(139,92,246,' : 'rgba(100,116,139,';
              const intervalBg = item.displayStatus === 'opportunity'
                ? `${intervalColor}0.03)` : undefined;
              const intervalBorder = item.displayStatus === 'opportunity'
                ? `${intervalColor}0.15)` : undefined;

              const rowBg = isExpanded
                ? 'rgba(59,130,246,0.08)'
                : item.displayStatus === 'active'
                  ? 'rgba(245,158,11,0.06)'
                  : item.displayStatus === 'scheduled'
                    ? 'rgba(16,185,129,0.04)'
                    : item.displayStatus === 'blocked'
                      ? 'rgba(239,68,68,0.06)'
                    : intervalBg || 'transparent';
              const rowLeftBorder = item.displayStatus === 'blocked'
                ? 'rgba(239,68,68,0.4)'
                : (isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent');

              return (
                <div key={item.id}>
                  {/* Main Row */}
                  <div
                    className="opp-table-row"
                    onClick={() => setExpandedAsset(isExpanded ? null : item.id)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '24px 54px 110px 68px 68px 50px 72px 64px 54px 66px 66px 66px 56px 66px',
                      minWidth: 940,
                      gap: 4, padding: '8px 10px',
                      alignItems: 'center',
                      cursor: 'pointer',
                      borderRadius: 8,
                      background: rowBg,
                      borderTop: isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent',
                      borderRight: isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent',
                      borderBottom: isExpanded ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent',
                      borderLeft: item.displayStatus === 'blocked'
                        ? `2px solid ${rowLeftBorder}`
                        : (intervalBorder ? `2px solid ${intervalBorder}` : rowLeftBorder),
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                    onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = rowBg; }}
                  >
                    {/* Rank */}
                    <span className="mono opp-hide-mobile" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                      {visibleIdx}
                    </span>

                    {/* Status Badge */}
                    <StatusBadge status={item.displayStatus} />

                    {/* Coin + Interval Badge + Mobile Exchange Badges */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--color-text)' }}>
                          {item.asset}
                        </span>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                          color: intervalH <= 1 ? '#06b6d4' : intervalH <= 4 ? '#8b5cf6' : '#64748b',
                          background: intervalH <= 1 ? 'rgba(6,182,212,0.15)' : intervalH <= 4 ? 'rgba(139,92,246,0.15)' : 'rgba(100,116,139,0.12)',
                        }}>
                          {intervalH <= 1 ? '1h' : intervalH <= 4 ? '4h' : '8h'}
                        </span>
                        <span className="opp-hide-mobile" style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>/USDT</span>
                        {isExpanded ? <ChevronUp size={12} color="var(--color-text-muted)" /> : <ChevronDown size={12} color="var(--color-text-muted)" />}
                      </div>
                      {/* 紐⑤컮?? 嫄곕옒??諭껋? ?몃씪??*/}
                      <div className="opp-show-mobile" style={{ display: 'none', alignItems: 'center', gap: 4, fontSize: 9 }}>
                        <ExBadge ex={item.opp.shortExchange} />
                        <span style={{ color: 'var(--color-text-muted)' }}>??/span>
                        <ExBadge ex={item.opp.longExchange} />
                      </div>
                    </div>

                    {/* Short Exchange */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'center' }}>
                      <ExBadge ex={item.opp.shortExchange} />
                    </div>

                    {/* Long Exchange */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'center' }}>
                      <ExBadge ex={item.opp.longExchange} />
                    </div>

                    {/* 嫄곕옒??(?묒そ 以?理쒖냼) */}
                    {(() => {
                      const shortVol = fundingRates.find(r => r.exchange === item.opp.shortExchange && r.baseAsset === item.asset)?.quoteVolume24h;
                      const longVol = fundingRates.find(r => r.exchange === item.opp.longExchange && r.baseAsset === item.asset)?.quoteVolume24h;
                      const minVol = shortVol != null && longVol != null ? Math.min(shortVol, longVol)
                        : shortVol ?? longVol ?? null;
                      const fmt = (v: number) => v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : v.toFixed(0);
                      return (
                        <div className="opp-hide-mobile" style={{ textAlign: 'right' }}>
                          <span className="mono" style={{ fontSize: 10, color: minVol != null && minVol < 7_500_000 ? '#f59e0b' : 'var(--color-text-muted)' }}>
                            {minVol != null ? `$${fmt(minVol)}` : '-'}
                          </span>
                        </div>
                      );
                    })()}

                    {/* ?ъ옄湲?*/}
                    {(() => {
                      const totalInvest = itemPerSide * 2;
                      const posSize = itemPerSide * strategyConfig.leverage;
                      return (
                        <div className="opp-hide-mobile" style={{ textAlign: 'right' }}>
                          <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa' }}>
                            ${fmtNum(totalInvest, 0)}
                          </span>
                          <div style={{ fontSize: 8, color: 'var(--color-text-muted)' }}>
                            {strategyConfig.leverage}x??{fmtNum(posSize, 0)}
                          </div>
                        </div>
                      );
                    })()}

                    {/* ??⑹닔??(gross) */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'right', opacity: item.displayStatus === 'opportunity' ? 0.5 : 1 }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: displayFeeProfit.perFunding >= 0 ? '#10b981' : '#ef4444' }}>
                        {displayFeeProfit.perFunding >= 0 ? '+' : ''}${fmtNum(displayFeeProfit.perFunding)}
                      </span>
                    </div>

                    {/* ?섏닔猷?*/}
                    <div className="opp-hide-mobile" style={{ textAlign: 'right', opacity: item.displayStatus === 'opportunity' ? 0.5 : 1 }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: '#ef4444' }}>
                        -${fmtNum(displayRawFees)}
                      </span>
                    </div>

                    <div className="opp-hide-mobile" style={{ textAlign: 'right', opacity: item.displayStatus === 'opportunity' ? 0.5 : 1 }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: '#22c55e' }}>
                        +${fmtNum(displayTraderPayback)}
                      </span>
                    </div>

                    <div className="opp-hide-mobile" style={{ textAlign: 'right', opacity: item.displayStatus === 'opportunity' ? 0.5 : 1 }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: '#14b8a6' }}>
                        +${fmtNum(displayReferralPayback)}
                      </span>
                    </div>

                    {/* ?쒖닔??*/}
                    <div style={{ textAlign: 'right', opacity: item.displayStatus === 'opportunity' ? 0.5 : 1 }}>
                      <span className="mono" style={{
                        fontSize: 12, fontWeight: 700,
                        color: displayFeeProfit.netPerFunding > 0 ? '#10b981' : '#ef4444',
                      }}>
                        {displayFeeProfit.netPerFunding >= 0 ? '+' : ''}${fmtNum(displayFeeProfit.netPerFunding)}
                      </span>
                    </div>

                    {/* ?섏씡瑜?*/}
                    <div style={{ textAlign: 'right', opacity: item.displayStatus === 'opportunity' ? 0.5 : 1 }}>
                      <span className="mono" style={{
                        fontSize: 11, fontWeight: 700,
                        color: displayFeeProfit.roiPerFunding >= 0 ? '#10b981' : '#ef4444',
                      }}>
                        {displayFeeProfit.roiPerFunding >= 0 ? '+' : ''}{fmtNum(displayFeeProfit.roiPerFunding, 3)}%
                      </span>
                    </div>

                    {/* Countdown + 二쇨린 諭껋? ???꾨낫??dimmed ?쒖떆 */}
                    <div className="opp-hide-mobile" style={{ textAlign: 'right', opacity: item.displayStatus === 'opportunity' ? 0.4 : 1 }}>
                      <InlineCountdown targetMs={item.fundingTime} />
                      {intervalH < 8 && (
                        <span style={{
                          fontSize: 8, fontWeight: 700, marginLeft: 2,
                          padding: '1px 3px', borderRadius: 3,
                          background: intervalH <= 1 ? 'rgba(6,182,212,0.15)' : 'rgba(139,92,246,0.15)',
                          color: intervalH <= 1 ? '#06b6d4' : '#8b5cf6',
                        }}>
                          {intervalH}h
                        </span>
                      )}
                      {item.displayStatus === 'blocked' && (
                        <div style={{ marginTop: 4, textAlign: 'left', color: '#fbbf24', fontSize: 10, lineHeight: 1.3, wordBreak: 'break-all' }}>
                          거래 불가 사유
                          <span style={{ display: 'block', color: 'var(--color-text-muted)', fontSize: 9 }}>
                            {buildBlockedReasonText(item)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Expanded Detail */}
                  {isExpanded && (
                    <CoinDetail
                      item={item}
                      profit={displayFeeProfit}
                      compoundMode={compoundMode}
                      setCompoundMode={setCompoundMode}
                      simPositions={simPositions}
                      realPositions={positions}
                      simulationMode={simulationMode}
                      canExecute={canExecute}
                      isActionRunning={manualActionKey === `enter:${item.id}` || manualActionKey === `exit:${item.id}` || isProcessing}
                      onManualEnter={handleManualEnter}
                      onManualExit={handleManualExit}
                      realSpread={realSpread}
                    />
                  )}
                </div>
              );
            });
              // 鍮??됱쑝濡?15媛?梨꾩슦湲?(踰덊샇 + ????뺥깭 ?좎?)
              const emptyRows = [];
              for (let i = visibleIdx; i < MIN_ROWS; i++) {
                emptyRows.push(
                  <div key={`empty-${i}`} style={{
                    display: 'grid',
                    gridTemplateColumns: '24px 54px 110px 68px 68px 50px 72px 64px 54px 66px 66px 66px 56px 66px',
                    minWidth: 940,
                    gap: 4, padding: '8px 10px', height: ROW_HEIGHT,
                    alignItems: 'center', opacity: 0.2,
                  }}>
                    <span className="mono opp-hide-mobile" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{i + 1}</span>
                    <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'center', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'center', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                    <span className="opp-hide-mobile" style={{ textAlign: 'right', fontSize: 10, color: 'var(--color-text-muted)' }}>-</span>
                  </div>
                );
              }
              return [...renderedRows, ...emptyRows];
            })()}
          </div>
        )}

        {/* ?먥븧??SECTION 3: Portfolio Profit Summary ?먥븧??*/}
        {scheduledCoins.length > 0 && (
          <PortfolioSummaryRow
            label="?룹쭠"
            labelColor="#10b981"
            coins={scheduledCoins}
            investmentUSDT={perExchangeInvestment}
            leverage={strategyConfig.leverage}
            feeOverrides={strategyConfig.feeOverrides}
            paybackOverrides={strategyConfig.paybackOverrides}
            useDriftBuffer={strategyConfig.confirmedSnipeConfig?.useDriftBuffer}
            confirmedSnipeConfig={strategyConfig.confirmedSnipeConfig}
            compoundMode={compoundMode}
            setCompoundMode={setCompoundMode}
            realSpreads={realSpreads}
          />
        )}
      </div>
    </>
  );
}

/* ??? Portfolio Profit Summary Row ??? */
function PortfolioSummaryRow({ label, labelColor, coins, investmentUSDT, leverage, feeOverrides, paybackOverrides, useDriftBuffer, confirmedSnipeConfig, compoundMode, setCompoundMode, realSpreads }: {
  label: string;
  labelColor: string;
  coins: OpportunityDisplayItem[];
  investmentUSDT: number;
  leverage: number;
  feeOverrides?: FeeOverrides;
  paybackOverrides?: PaybackOverrides;
  useDriftBuffer?: boolean;
  confirmedSnipeConfig?: {
    useImpactGuards?: boolean;
    maxRoundTripImpactBps?: number;
    targetImpactBps?: number;
  };
  compoundMode: boolean;
  setCompoundMode: (v: boolean) => void;
  realSpreads?: Record<string, { effectiveSpread: number; shortSlippage: number; longSlippage: number; updatedAt: number }>;
}) {
  const activeCoins = coins.filter(c => c.displayStatus === 'active' || c.displayStatus === 'scheduled');

  const totalCapital = activeCoins.reduce(
    (sum, coin) => sum + ((coin.investmentUSDT ?? investmentUSDT) * 2),
    0,
  );

  const byInterval = useMemo(() => {
    const groups: Record<string, typeof activeCoins> = { '1h': [], '4h': [], '8h': [] };
    for (const c of activeCoins) {
      const h = (c.opp.fundingIntervalMs ?? 8 * 3600000) / 3600000;
      const bucket = h <= 1.5 ? '1h' : h <= 5 ? '4h' : '8h';
      groups[bucket].push(c);
    }
    return groups;
  }, [activeCoins]);

  const totals = useMemo(() => {
    let perDay = 0, per2Day = 0, per3Day = 0, per4Day = 0, per5Day = 0, per6Day = 0;
    let perWeek = 0, per2Week = 0, per3Week = 0, perMonth = 0, per3Month = 0, per6Month = 0;
    let cDay = 0, c2Day = 0, c3Day = 0, c4Day = 0, c5Day = 0, c6Day = 0;
    let cWeek = 0, c2Week = 0, c3Week = 0, cMonth = 0, c3Month = 0, c6Month = 0;

    for (const c of activeCoins) {
      const rs = realSpreads?.[c.id] ?? realSpreads?.[c.asset];
      const perSideInvestment = c.investmentUSDT ?? investmentUSDT;
      // realSpread???щ━?쇱?+踰좎씠?쒖뒪+?섏닔猷?紐⑤몢 諛섏쁺?????섏닔猷?0???붾? 嫄곕옒?뚮줈 ?댁쨷李④컧 諛⑹?
      const opp = rs
        ? { ...c.opp, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread, shortExchange: c.opp.shortExchange, longExchange: c.opp.longExchange }
        : c.opp;
      const profit = rs
        ? estimateProfit({ ...opp, spread: rs.effectiveSpread / 100, spreadPercent: rs.effectiveSpread }, perSideInvestment, leverage, {
          skipFees: false,
          feeOverrides,
          paybackOverrides,
          useDriftBuffer,
          entryImpactPercent: (() => {
            const measured = Math.max(0, (rs.shortSlippage ?? 0) + (rs.longSlippage ?? 0));
            if (measured > 0) return measured;
            return confirmedSnipeConfig?.useImpactGuards
              ? ((confirmedSnipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 200)
              : ((confirmedSnipeConfig?.targetImpactBps ?? 4) / 100);
          })(),
          exitImpactPercent: (() => {
            const measured = Math.max(0, (rs.shortSlippage ?? 0) + (rs.longSlippage ?? 0));
            if (measured > 0) return measured;
            return confirmedSnipeConfig?.useImpactGuards
              ? ((confirmedSnipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 200)
              : ((confirmedSnipeConfig?.targetImpactBps ?? 4) / 100);
          })(),
        })
        : estimateProfit(opp, perSideInvestment, leverage, { feeOverrides, paybackOverrides, useDriftBuffer });
      // 留덉씠?덉뒪 ?섏씡 ??ぉ? ?⑹궛?먯꽌 ?쒖쇅
      if (profit.netPerFunding <= 0) continue;
      perDay += profit.perDay; per2Day += profit.per2Day; per3Day += profit.per3Day;
      per4Day += profit.per4Day; per5Day += profit.per5Day; per6Day += profit.per6Day;
      perWeek += profit.perWeek; per2Week += profit.per2Week; per3Week += profit.per3Week; perMonth += profit.perMonth;
      per3Month += profit.per3Month; per6Month += profit.per6Month;
      cDay += profit.compound.perDay; c2Day += profit.compound.per2Day; c3Day += profit.compound.per3Day;
      c4Day += profit.compound.per4Day; c5Day += profit.compound.per5Day; c6Day += profit.compound.per6Day;
      cWeek += profit.compound.perWeek; c2Week += profit.compound.per2Week; c3Week += profit.compound.per3Week; cMonth += profit.compound.perMonth;
      c3Month += profit.compound.per3Month; c6Month += profit.compound.per6Month;
    }
    return { perDay, per2Day, per3Day, per4Day, per5Day, per6Day, perWeek, per2Week, per3Week, perMonth, per3Month, per6Month,
             cDay, c2Day, c3Day, c4Day, c5Day, c6Day, cWeek, c2Week, c3Week, cMonth, c3Month, c6Month };
  }, [activeCoins, feeOverrides, paybackOverrides, useDriftBuffer, confirmedSnipeConfig, investmentUSDT, leverage, realSpreads]);

  if (activeCoins.length === 0) return null;

  const bgColor = 'rgba(16,185,129,0.04)';
  const borderColor = 'rgba(16,185,129,0.15)';

  return (
    <div style={{ marginTop: 12, padding: '14px 16px', borderRadius: 10, background: bgColor, border: `1px solid ${borderColor}` }}>
      {/* Header */}
      <div className="portfolio-summary-header" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 11, fontWeight: 800, color: labelColor,
          padding: '2px 8px', borderRadius: 4,
          background: `${labelColor}20`, border: `1px solid ${labelColor}33`,
        }}>
          {label}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>?덉긽 ?섏씡</span>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg-accent)', borderRadius: 6, padding: 2 }}>
          {(['?⑤━', '蹂듬━'] as const).map((lb, i) => {
            const active = compoundMode === (i === 1);
            return (
              <button key={lb} onClick={() => setCompoundMode(i === 1)} style={{
                padding: '2px 8px', borderRadius: 4, border: 'none', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                background: active ? (i === 1 ? 'rgba(139,92,246,0.3)' : 'rgba(16,185,129,0.2)') : 'transparent',
                color: active ? (i === 1 ? '#a78bfa' : '#10b981') : 'var(--color-text-muted)',
              }}>{lb}</button>
            );
          })}
        </div>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          ?ъ엯: ${totalCapital.toLocaleString()} ({activeCoins.length}??
        </span>
        <div className="interval-badges" style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {Object.entries(byInterval).map(([interval, list]) => list.length > 0 && (
            <span key={interval} style={{
              fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: interval === '1h' ? 'rgba(16,185,129,0.15)' : interval === '4h' ? 'rgba(59,130,246,0.15)' : 'rgba(139,92,246,0.15)',
              color: interval === '1h' ? '#10b981' : interval === '4h' ? '#3b82f6' : '#a78bfa',
            }}>
              {interval} 횞{list.length}
            </span>
          ))}
        </div>
      </div>

      {/* Profit Grid ??2?? ?곷떒 6?? ?섎떒 1二?2二?1??*/}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {[
          { label: '1??, simple: totals.perDay, compound: totals.cDay },
          { label: '2??, simple: totals.per2Day, compound: totals.c2Day },
          { label: '3??, simple: totals.per3Day, compound: totals.c3Day },
          { label: '4??, simple: totals.per4Day, compound: totals.c4Day },
          { label: '5??, simple: totals.per5Day, compound: totals.c5Day },
          { label: '6??, simple: totals.per6Day, compound: totals.c6Day },
        ].map(({ label: lb, simple, compound }) => {
          const value = compoundMode ? compound : simple;
          const roi = totalCapital > 0 ? (value / totalCapital) * 100 : 0;
          const color = compoundMode ? '#a78bfa' : labelColor;
          const negColor = '#ef4444';
          return (
            <div key={lb} style={{
              padding: '8px 6px', borderRadius: 8, textAlign: 'center',
              background: 'var(--bg-accent)',
              border: `1px solid ${compoundMode ? 'rgba(139,92,246,0.15)' : 'var(--color-border)'}`,
            }}>
              <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>{lb}</div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 800, color: value >= 0 ? color : negColor }}>
                {fmtUsdOrInfinity(value)}
              </div>
              <div className="mono" style={{ fontSize: 10, color: roi >= 0 ? (compoundMode ? '#c4b5fd' : '#6ee7b7') : '#fca5a5', marginTop: 2 }}>
                {fmtPctOrInfinity(roi, 2, { forceInfinity: isInfiniteProfitDisplay(value) })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, marginTop: 4 }}>
        {[
          { label: '1二?, simple: totals.perWeek, compound: totals.cWeek },
          { label: '2二?, simple: totals.per2Week, compound: totals.c2Week },
          { label: '3二?, simple: totals.per3Week, compound: totals.c3Week },
          { label: '1??, simple: totals.perMonth, compound: totals.cMonth },
          { label: '3??, simple: totals.per3Month, compound: totals.c3Month },
          { label: '6??, simple: totals.per6Month, compound: totals.c6Month },
        ].map(({ label: lb, simple, compound }) => {
          const value = compoundMode ? compound : simple;
          const roi = totalCapital > 0 ? (value / totalCapital) * 100 : 0;
          const color = compoundMode ? '#a78bfa' : labelColor;
          const negColor = '#ef4444';
          return (
            <div key={lb} style={{
              padding: '8px 6px', borderRadius: 8, textAlign: 'center',
              background: 'var(--bg-accent)',
              border: `1px solid ${compoundMode ? 'rgba(139,92,246,0.15)' : 'var(--color-border)'}`,
            }}>
              <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>{lb}</div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 800, color: value >= 0 ? color : negColor }}>
                {fmtUsdOrInfinity(value)}
              </div>
              <div className="mono" style={{ fontSize: 10, color: roi >= 0 ? (compoundMode ? '#c4b5fd' : '#6ee7b7') : '#fca5a5', marginTop: 2 }}>
                {fmtPctOrInfinity(roi, 2, { forceInfinity: isInfiniteProfitDisplay(value) })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ??? Status Badge ??? */
function StatusBadge({ status }: { status: OpportunityRowStatus }) {
  const config = {
    active: { label: '?ㅽ뻾 以?, bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: 'rgba(245,158,11,0.3)', dot: true },
    scheduled: { label: '?덉빟??, bg: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'rgba(16,185,129,0.25)', dot: true },
    opportunity: { label: '?꾨낫', bg: 'rgba(100,116,139,0.1)', color: '#94a3b8', border: 'rgba(100,116,139,0.2)', dot: false },
    blocked: { label: '?쒖닔', bg: 'rgba(239,68,68,0.1)', color: '#ef4444', border: 'rgba(239,68,68,0.35)', dot: true },
  }[status];

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700,
      background: config.bg, color: config.color, border: `1px solid ${config.border}`,
    }}>
      {config.dot && (
        <span style={{
          width: 5, height: 5, borderRadius: '50%', background: config.color,
          boxShadow: `0 0 4px ${config.color}`,
          animation: status === 'active' ? 'blink 1.5s ease-in-out infinite' : 'none',
        }} />
      )}
      {config.label}
    </span>
  );
}

/* ??? Stat Pill ??? */
function StatPill({ label, value, color, active }: { label: string; value: string; color: string; active: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 8,
      background: active ? `${color}15` : 'var(--bg-accent)',
      border: `1px solid ${active ? `${color}30` : 'var(--color-border)'}`,
    }}>
      <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: active ? color : 'var(--color-text-muted)' }}>
        {value}
      </span>
    </div>
  );
}

/* ??? Expanded Coin Detail ??? */
function CoinDetail({ item, profit, compoundMode, setCompoundMode, simPositions, realPositions, simulationMode, canExecute, isActionRunning, onManualEnter, onManualExit, realSpread }: {
  item: OpportunityDisplayItem;
  profit: ReturnType<typeof estimateProfit>;
  compoundMode: boolean;
  setCompoundMode: (v: boolean) => void;
  simPositions?: SimPosition[];
  realPositions?: Position[];
  simulationMode: boolean;
  canExecute: boolean;
  isActionRunning: boolean;
  onManualEnter: (item: OpportunityDisplayItem) => Promise<void>;
  onManualExit: (item: OpportunityDisplayItem) => Promise<void>;
  realSpread?: { effectiveSpread: number; shortSlippage: number; longSlippage: number; updatedAt: number } | null;
}) {
  const opp = item.opp;
  const activeSimPos = simPositions?.filter((position) => {
    if (item.pairId && position.pairId) return position.pairId === item.pairId;
    return position.baseAsset === item.asset
      && (position.exchange === opp.shortExchange || position.exchange === opp.longExchange);
  }) ?? [];
  const activeRealPos = realPositions?.filter((position) => {
    if (item.pairId && position.pairId) return position.pairId === item.pairId;
    return position.baseAsset === item.asset
      && (position.exchange === opp.shortExchange || position.exchange === opp.longExchange);
  }) ?? [];
  const activePositions = simulationMode ? activeSimPos : activeRealPos;
  const simShort = activeSimPos.find(p => p.side === 'short');
  const simLong = activeSimPos.find(p => p.side === 'long');
  const entryGap = simShort?.entryGapPercent ?? simLong?.entryGapPercent;
  const canManualEnter = item.displayStatus !== 'active' && profit.netPerFunding > 0 && (simulationMode || canExecute);
  const canManualExit = item.displayStatus === 'active' && activePositions.length > 0;

  return (
    <div style={{
      margin: '0 0 8px 0', padding: '14px 16px', borderRadius: '0 0 10px 10px',
      background: 'rgba(59,130,246,0.04)',
      border: '1px solid rgba(59,130,246,0.15)',
      borderTop: 'none',
    }}>
      {/* Exchange pair detail */}
      <div className="opp-hero-section" style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        {/* Short */}
        <div style={{
          flex: 1, minWidth: 150, padding: '10px 14px', borderRadius: 10,
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <TrendingDown size={12} color="#ef4444" />
            <span style={{ fontSize: 10, fontWeight: 600, color: '#ef4444' }}>SHORT</span>
            <ExBadge ex={opp.shortExchange} size="xs" />
          </div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: opp.shortRate >= 0 ? '#10b981' : '#ef4444' }}>
            {opp.shortRate >= 0 ? '+' : ''}{fmtNum(opp.shortRate * 100, 4)}%
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            {opp.shortRate >= 0 ? '???섎졊' : '??吏遺?} (8h ??⑸쪧)
          </div>
        </div>
        {/* Long */}
        <div style={{
          flex: 1, minWidth: 150, padding: '10px 14px', borderRadius: 10,
          background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <TrendingUp size={12} color="#10b981" />
            <span style={{ fontSize: 10, fontWeight: 600, color: '#10b981' }}>LONG</span>
            <ExBadge ex={opp.longExchange} size="xs" />
          </div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: -opp.longRate >= 0 ? '#10b981' : '#ef4444' }}>
            {-opp.longRate >= 0 ? '+' : ''}{fmtNum(Math.abs(opp.longRate) * 100, 4)}%
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            {-opp.longRate >= 0 ? '???섎졊' : '??吏遺?} (8h ??⑸쪧)
          </div>
        </div>
        {/* Spread summary */}
        <div style={{
          flex: 1, minWidth: 150, padding: '10px 14px', borderRadius: 10,
          background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>8h ?ㅽ봽?덈뱶</div>
          <div className="mono gradient-text-green" style={{ fontSize: 24, fontWeight: 900 }}>
            +{fmtNum(opp.spreadPercent, 4)}%
          </div>
          <div style={{ fontSize: 10, color: '#8b5cf6', marginTop: 2 }}>
            ??~{fmtNum(opp.annualReturnPercent, 0)}%
          </div>
        </div>
      </div>

      {/* Profit grid */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)' }}>?섏씡 ?덉륫</span>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg-accent)', borderRadius: 6, padding: 2 }}>
          {(['?⑤━', '蹂듬━'] as const).map((label, i) => {
            const active = compoundMode === (i === 1);
            return (
              <button
                key={label}
                onClick={() => setCompoundMode(i === 1)}
                style={{
                  padding: '2px 8px', borderRadius: 4, border: 'none', fontSize: 10, fontWeight: 700,
                  cursor: 'pointer',
                  background: active ? (i === 1 ? 'rgba(139,92,246,0.3)' : 'rgba(16,185,129,0.2)') : 'transparent',
                  color: active ? (i === 1 ? '#a78bfa' : '#10b981') : 'var(--color-text-muted)',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          湲곗?: ${profit.totalCapital.toLocaleString()}
        </span>
      </div>

      <div className="coin-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {[
          { label: '8h', value: profit.netPerFunding, compoundValue: profit.netPerFunding, roi: profit.roiPerFunding, compoundRoi: profit.roiPerFunding },
          { label: '??, value: profit.perDay, compoundValue: profit.compound.perDay, roi: profit.roiPerDay, compoundRoi: profit.compound.roiPerDay },
          { label: '二?, value: profit.perWeek, compoundValue: profit.compound.perWeek, roi: profit.roiPerWeek, compoundRoi: profit.compound.roiPerWeek },
          { label: '??, value: profit.perMonth, compoundValue: profit.compound.perMonth, roi: profit.roiPerMonth, compoundRoi: profit.compound.roiPerMonth },
        ].map(({ label, value, compoundValue, roi, compoundRoi }) => {
          const dv = compoundMode ? compoundValue : value;
          const dr = compoundMode ? compoundRoi : roi;
          return (
            <div key={label} style={{
              padding: '6px 8px', borderRadius: 6, textAlign: 'center',
              background: 'var(--bg-accent)', border: `1px solid ${compoundMode ? 'rgba(139,92,246,0.15)' : 'var(--color-border)'}`,
            }}>
              <div style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>{label}</div>
              <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: dv >= 0 ? (compoundMode ? '#a78bfa' : '#10b981') : '#ef4444' }}>
                {fmtUsdOrInfinity(dv)}
              </div>
              <div className="mono" style={{ fontSize: 9, color: dr >= 0 ? (compoundMode ? '#c4b5fd' : '#6ee7b7') : '#fca5a5' }}>
                {fmtPctOrInfinity(dr, 2, { forceInfinity: isInfiniteProfitDisplay(dv) })}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn btn-success"
          style={{
            padding: '6px 12px',
            fontSize: 11,
            borderRadius: 8,
            opacity: canManualEnter && !isActionRunning ? 1 : 0.55,
            cursor: canManualEnter && !isActionRunning ? 'pointer' : 'not-allowed',
          }}
          disabled={!canManualEnter || isActionRunning}
          onClick={() => { void onManualEnter(item); }}
        >
          {isActionRunning && item.displayStatus !== 'active'
            ? '吏꾩엯 泥섎━ 以?..'
            : `${simulationMode ? '[SIM]' : '[REAL]'} ?ъ???吏꾩엯`}
        </button>
        <button
          className="btn btn-danger"
          style={{
            padding: '6px 12px',
            fontSize: 11,
            borderRadius: 8,
            opacity: canManualExit && !isActionRunning ? 1 : 0.55,
            cursor: canManualExit && !isActionRunning ? 'pointer' : 'not-allowed',
          }}
          disabled={!canManualExit || isActionRunning}
          onClick={() => { void onManualExit(item); }}
        >
          {isActionRunning && item.displayStatus === 'active'
            ? '泥?궛 泥섎━ 以?..'
            : `${simulationMode ? '[SIM]' : '[REAL]'} ?ъ???醫낅즺`}
        </button>
        {!simulationMode && !canExecute && (
          <span style={{ fontSize: 10, color: '#f59e0b', display: 'flex', alignItems: 'center' }}>
            REAL 吏꾩엯? API ?ㅺ? ?ㅼ젙??嫄곕옒??2媛??댁긽 ?꾩슂
          </span>
        )}
      </div>

      {/* Fee info */}
      <div style={{
        marginTop: 8, padding: '4px 8px', borderRadius: 4,
        display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6,
        fontSize: 10, color: 'var(--color-text-muted)',
        background: 'rgba(255,255,255,0.02)',
      }}>
        <span>Raw Fee: <span className="mono" style={{ color: '#ef4444' }}>-${fmtNum(profit.rawTotalFees)}</span></span>
        <span>Trader Payback: <span className="mono" style={{ color: '#22c55e' }}>+${fmtNum(profit.traderFeePayback)}</span></span>
        <span>Referral Payback: <span className="mono" style={{ color: '#14b8a6' }}>+${fmtNum(profit.referralFeePayback)}</span></span>
        <span>Net Fee: <span className="mono" style={{ color: '#ef4444' }}>-${fmtNum(profit.totalFees)}</span></span>
        <span>8h Net: <span className="mono" style={{ fontWeight: 700, color: profit.netPerFunding > 0 ? '#10b981' : '#ef4444' }}>
          {profit.netPerFunding > 0 ? '+' : ''}${fmtNum(profit.netPerFunding)}
        </span></span>
      </div>
      <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-text-muted)' }}>
        Formula: 8h Net = Funding - Raw Fee + Trader Payback + Referral Payback
      </div>

      {/* Entry gap & slippage analysis */}
      {(entryGap !== undefined || realSpread) && (
        <div style={{
          marginTop: 6, padding: '4px 8px', borderRadius: 4,
          display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4,
          fontSize: 10, color: 'var(--color-text-muted)',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.04)',
        }}>
          {entryGap !== undefined && (
            <span>
              吏꾩엯媛?{' '}
              <span className="mono" style={{ fontWeight: 700, color: Math.abs(entryGap) > 0.1 ? '#f59e0b' : '#10b981' }}>
                {entryGap >= 0 ? '+' : ''}{fmtNum(entryGap, 4)}%
              </span>
              {' '}
              <span style={{ color: 'var(--color-text-muted)' }}>
                (??{simShort ? fmtNum(simShort.entryPrice, 2) : '??} / 濡?{simLong ? fmtNum(simLong.entryPrice, 2) : '??})
              </span>
            </span>
          )}
          {realSpread && (
            <span>
              ?щ━?쇱?:{' '}
              <span className="mono" style={{ color: '#ef4444' }}>??{fmtNum(realSpread.shortSlippage, 4)}%</span>
              {' / '}
              <span className="mono" style={{ color: '#10b981' }}>濡?{fmtNum(realSpread.longSlippage, 4)}%</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}



