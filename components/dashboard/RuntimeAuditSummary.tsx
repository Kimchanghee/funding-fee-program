'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';

interface CountItem {
  key: string;
  count: number;
}

interface RuntimeAuditResponse {
  success?: boolean;
  generatedAtText?: string;
  runtime?: {
    real?: { active?: boolean; startedAt?: number | null };
    sim?: { active?: boolean; startedAt?: number | null };
  };
  diagnosis?: {
    code?: string;
    summary?: string;
    hoursSinceLastExecution?: number | null;
  };
  report?: {
    window?: {
      hours?: number;
      fromText?: string;
      toText?: string;
    };
    execution?: {
      total?: number;
      byType?: CountItem[];
      byMode?: CountItem[];
    };
    guardBlocks?: {
      total?: number;
      byReason?: CountItem[];
      byMode?: CountItem[];
    };
    nonExecutionTradeEvents?: {
      total?: number;
      byType?: CountItem[];
      byMode?: CountItem[];
    };
    scheduleProbes?: {
      total?: number;
      byMilestone?: CountItem[];
      byStatus?: CountItem[];
      byRejectReason?: CountItem[];
    };
    systemLogs?: {
      total?: number;
      byLevel?: CountItem[];
    };
  };
}

const REFRESH_MS = 15_000;

function pickColorByDiagnosis(code: string | undefined): string {
  switch (code) {
    case 'normal':
      return '#10b981';
    case 'scheduler_inactive':
      return '#f59e0b';
    case 'guard_blocked':
      return '#f97316';
    case 'execution_stale':
      return '#eab308';
    default:
      return '#ef4444';
  }
}

function formatTopItems(items: CountItem[] | undefined, limit = 3): string {
  if (!items || items.length === 0) return '-';
  return items
    .slice(0, limit)
    .map((item) => `${item.key}:${item.count}`)
    .join(' | ');
}

function StatCell(props: {
  title: string;
  value: number;
  color: string;
  detail: string;
}) {
  return (
    <div
      style={{
        border: '1px solid rgba(51,65,85,0.8)',
        borderRadius: 10,
        padding: '10px 12px',
        background: 'rgba(15,23,42,0.55)',
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>{props.title}</div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: props.color }}>
        {props.value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.3 }}>
        {props.detail}
      </div>
    </div>
  );
}

export default function RuntimeAuditSummary() {
  const [hours, setHours] = useState<10 | 24 | 72>(10);
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<RuntimeAuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const consecutiveFailuresRef = useRef(0);
  const inFlightRef = useRef(false);
  const hasPayloadRef = useRef(false);

  const fetchAudit = useCallback(async (targetHours: 10 | 24 | 72) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const query = new URLSearchParams({
        hours: String(targetHours),
        sampleLimit: '0',
        t: String(Date.now()),
      });
      const response = await fetch(`/api/analysis/runtime-audit?${query.toString()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const json = await response.json() as RuntimeAuditResponse;
      if (!response.ok || !json.success) {
        throw new Error('runtime audit fetch failed');
      }
      hasPayloadRef.current = true;
      setPayload(json);
      consecutiveFailuresRef.current = 0;
      setError(null);
    } catch (err) {
      consecutiveFailuresRef.current += 1;
      if (!hasPayloadRef.current || consecutiveFailuresRef.current >= 3) {
        setError((err as Error).message || 'unknown error');
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAudit(hours);
  }, [hours, fetchAudit]);

  useEffect(() => {
    const timer = setInterval(() => {
      void fetchAudit(hours);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [hours, fetchAudit]);

  const diagnosisCode = payload?.diagnosis?.code;
  const diagnosisColor = pickColorByDiagnosis(diagnosisCode);
  const runtimeRealActive = !!payload?.runtime?.real?.active;
  const runtimeSimActive = !!payload?.runtime?.sim?.active;
  const executionTotal = payload?.report?.execution?.total ?? 0;
  const guardTotal = payload?.report?.guardBlocks?.total ?? 0;
  const scheduleProbeTotal = payload?.report?.scheduleProbes?.total
    ?? payload?.report?.nonExecutionTradeEvents?.total
    ?? 0;
  const systemTotal = payload?.report?.systemLogs?.total ?? 0;
  const lastCheckedText = payload?.generatedAtText ?? '-';
  const windowText = useMemo(() => {
    const from = payload?.report?.window?.fromText;
    const to = payload?.report?.window?.toText;
    if (!from || !to) return '-';
    return `${from} ~ ${to}`;
  }, [payload]);

  return (
    <div className="glass-card runtime-audit-panel" style={{ overflow: 'hidden' }}>
      <div
        className="runtime-audit-header"
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Activity size={15} color="#3b82f6" />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>런타임 거래 감사 요약</div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            실행/차단/비실행/시스템 로그를 분리 집계
          </div>
        </div>
        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            className="btn btn-ghost"
            style={{ padding: '4px 8px', fontSize: 11, color: hours === 10 ? '#93c5fd' : 'var(--color-text-muted)' }}
            onClick={() => setHours(10)}
          >
            10H
          </button>
          <button
            className="btn btn-ghost"
            style={{ padding: '4px 8px', fontSize: 11, color: hours === 24 ? '#93c5fd' : 'var(--color-text-muted)' }}
            onClick={() => setHours(24)}
          >
            24H
          </button>
          <button
            className="btn btn-ghost"
            style={{ padding: '4px 8px', fontSize: 11, color: hours === 72 ? '#93c5fd' : 'var(--color-text-muted)' }}
            onClick={() => setHours(72)}
          >
            72H
          </button>
          <button
            className="btn btn-ghost"
            style={{ padding: '4px 8px' }}
            onClick={() => void fetchAudit(hours)}
            disabled={loading}
            title="새로고침"
          >
            <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>
      </div>

      <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(30,45,66,0.5)' }}>
        <div className="runtime-audit-headline" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              borderRadius: 999,
              border: `1px solid ${diagnosisColor}55`,
              background: `${diagnosisColor}20`,
              color: diagnosisColor,
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            진단 {diagnosisCode ?? 'unknown'}
          </span>

          <span
            style={{
              fontSize: 10,
              color: runtimeRealActive ? '#10b981' : '#f59e0b',
              fontWeight: 700,
            }}
          >
            REAL {runtimeRealActive ? 'ON' : 'OFF'}
          </span>

          <span
            style={{
              fontSize: 10,
              color: runtimeSimActive ? '#10b981' : '#f59e0b',
              fontWeight: 700,
            }}
          >
            SIM {runtimeSimActive ? 'ON' : 'OFF'}
          </span>

          {payload?.diagnosis?.hoursSinceLastExecution != null && (
            <span className="mono" style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
              마지막 실행 후 {payload.diagnosis.hoursSinceLastExecution}h
            </span>
          )}
        </div>

        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text)' }}>
          {payload?.diagnosis?.summary ?? '진단 정보 없음'}
        </div>

        <div className="runtime-audit-meta" style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span className="mono" style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            윈도우: {windowText}
          </span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            마지막 확인: {lastCheckedText}
          </span>
        </div>
      </div>

      <div className="runtime-audit-grid" style={{ padding: 12, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <StatCell
          title="실행 이벤트"
          value={executionTotal}
          color={executionTotal > 0 ? '#10b981' : '#f59e0b'}
          detail={formatTopItems(payload?.report?.execution?.byType)}
        />
        <StatCell
          title="가드 차단"
          value={guardTotal}
          color={guardTotal > 0 ? '#f97316' : '#64748b'}
          detail={formatTopItems(payload?.report?.guardBlocks?.byReason)}
        />
        <StatCell
          title="스케줄 분석"
          value={scheduleProbeTotal}
          color={scheduleProbeTotal > 0 ? '#22d3ee' : '#64748b'}
          detail={formatTopItems(payload?.report?.scheduleProbes?.byStatus)}
        />
        <StatCell
          title="시스템 로그"
          value={systemTotal}
          color={systemTotal > 0 ? '#93c5fd' : '#64748b'}
          detail={formatTopItems(payload?.report?.systemLogs?.byLevel)}
        />
      </div>

      {error && (
        <div
          style={{
            margin: '0 12px 12px',
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid rgba(239,68,68,0.3)',
            background: 'rgba(239,68,68,0.12)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: '#ef4444',
            fontSize: 11,
          }}
        >
          <AlertTriangle size={13} />
          감사 데이터 조회 실패: {error}
        </div>
      )}
    </div>
  );
}
