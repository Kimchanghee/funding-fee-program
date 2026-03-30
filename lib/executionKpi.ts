/**
 * KPI auto-collection for trade execution quality monitoring.
 * Computes promotion-readiness metrics from completed execution states.
 */

import { getCompletedStates, type ExecutionStateEntry } from './executionState';

export interface ExecutionKpiSnapshot {
  /** Total completed trades in sample */
  sampleSize: number;
  /** Trades where funding was successfully captured / total */
  fundingCaptureSuccessRate: number;
  /** Trades that ended in forced_close / total */
  forcedCloseRate: number;
  /** Trades that ended in error or aborted / total */
  fillFailureRate: number;
  /** 95th percentile orphan leg exposure time (ms) */
  orphanLegP95Ms: number;
  /** Median realized EV / decision EV ratio */
  realizedEvRatio: number;
  /** Trades where settlement was confirmed vs attempted */
  settlementCheckSuccessRate: number;
  /** Whether all promotion thresholds are met */
  promotionReady: boolean;
  /** Per-threshold pass/fail detail */
  thresholds: Record<string, { value: number; threshold: number; passed: boolean }>;
  /** Computed at */
  computedAt: number;
}

const PROMOTION_THRESHOLDS = {
  fundingCaptureSuccessRate: 0.95,
  forcedCloseRate: 0.05,
  fillFailureRate: 0.10,
  orphanLegP95Ms: 150,
  realizedEvRatio: 0.70,
  settlementCheckSuccessRate: 0.98,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

export function computeKpi(states?: ExecutionStateEntry[]): ExecutionKpiSnapshot {
  const completed = states ?? getCompletedStates();
  const n = completed.length;
  const now = Date.now();

  if (n === 0) {
    return {
      sampleSize: 0,
      fundingCaptureSuccessRate: 0,
      forcedCloseRate: 0,
      fillFailureRate: 0,
      orphanLegP95Ms: 0,
      realizedEvRatio: 0,
      settlementCheckSuccessRate: 0,
      promotionReady: false,
      thresholds: {},
      computedAt: now,
    };
  }

  const fundingCaptured = completed.filter(s => s.fundingCaptured === true).length;
  const forcedCloses = completed.filter(s => s.outcome === 'forced_close').length;
  const failures = completed.filter(s => s.outcome === 'error' || s.outcome === 'aborted').length;
  const settlementAttempted = completed.filter(s => s.settlementConfirmed !== undefined).length;
  const settlementSucceeded = completed.filter(s => s.settlementConfirmed === true).length;

  const orphanTimes = completed
    .map(s => s.orphanLegMs ?? 0)
    .sort((a, b) => a - b);

  const evRatios = completed
    .filter(s => s.evDecision && s.evDecision > 0 && s.evRealized !== undefined)
    .map(s => s.evRealized! / s.evDecision!);
  const medianEvRatio = evRatios.length > 0
    ? evRatios.sort((a, b) => a - b)[Math.floor(evRatios.length / 2)]
    : 0;

  const fundingCaptureSuccessRate = fundingCaptured / n;
  const forcedCloseRate = forcedCloses / n;
  const fillFailureRate = failures / n;
  const orphanLegP95Ms = percentile(orphanTimes, 95);
  const realizedEvRatio = medianEvRatio;
  const settlementCheckSuccessRate = settlementAttempted > 0
    ? settlementSucceeded / settlementAttempted
    : 1; // no attempts = not a blocker

  const thresholds: ExecutionKpiSnapshot['thresholds'] = {
    fundingCaptureSuccessRate: {
      value: fundingCaptureSuccessRate,
      threshold: PROMOTION_THRESHOLDS.fundingCaptureSuccessRate,
      passed: fundingCaptureSuccessRate >= PROMOTION_THRESHOLDS.fundingCaptureSuccessRate,
    },
    forcedCloseRate: {
      value: forcedCloseRate,
      threshold: PROMOTION_THRESHOLDS.forcedCloseRate,
      passed: forcedCloseRate <= PROMOTION_THRESHOLDS.forcedCloseRate,
    },
    fillFailureRate: {
      value: fillFailureRate,
      threshold: PROMOTION_THRESHOLDS.fillFailureRate,
      passed: fillFailureRate <= PROMOTION_THRESHOLDS.fillFailureRate,
    },
    orphanLegP95Ms: {
      value: orphanLegP95Ms,
      threshold: PROMOTION_THRESHOLDS.orphanLegP95Ms,
      passed: orphanLegP95Ms <= PROMOTION_THRESHOLDS.orphanLegP95Ms,
    },
    realizedEvRatio: {
      value: realizedEvRatio,
      threshold: PROMOTION_THRESHOLDS.realizedEvRatio,
      passed: realizedEvRatio >= PROMOTION_THRESHOLDS.realizedEvRatio,
    },
    settlementCheckSuccessRate: {
      value: settlementCheckSuccessRate,
      threshold: PROMOTION_THRESHOLDS.settlementCheckSuccessRate,
      passed: settlementCheckSuccessRate >= PROMOTION_THRESHOLDS.settlementCheckSuccessRate,
    },
  };

  const promotionReady = Object.values(thresholds).every(t => t.passed);

  return {
    sampleSize: n,
    fundingCaptureSuccessRate,
    forcedCloseRate,
    fillFailureRate,
    orphanLegP95Ms,
    realizedEvRatio,
    settlementCheckSuccessRate,
    promotionReady,
    thresholds,
    computedAt: now,
  };
}
