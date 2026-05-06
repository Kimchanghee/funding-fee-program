/**
 * Centralized feature-flag reader for guard-relaxation experiments.
 *
 * Background
 * ----------
 * The 2026-04-30 outage post-mortem found that the funding-window guard
 * (LIVE_FUNDING_TIME_DRIFT_MS, 1 minute tolerance + single-cycle rollover only)
 * and the immediate-fail behaviour on `orderbook_unavailable` were dropping a
 * meaningful fraction of high-EV entries. A 4-day backtest showed that
 * relaxing those two guards would have grown realised P&L roughly 3.4-6x.
 *
 * Funding-window relaxation stays hidden behind an OFF-by-default environment
 * variable. Orderbook retry/defer defaults ON because the 48h review showed
 * high-EV entries were being lost to transient book/API gaps; set
 * ORDERBOOK_DEFER_ENABLED=false for instant rollback.
 *
 * Env vars
 * --------
 *   RELAX_FUNDING_WINDOW=true|false   (default: false)
 *     - When true:
 *       a) The funding-time drift tolerance bumps from 60_000ms (1m) to
 *          600_000ms (10m).
 *       b) Funding-time shift is also accepted when it matches any of the
 *          standard funding cycles {1h, 4h, 8h} within the same tolerance,
 *          not only the opportunity's specific interval. This lets us pair
 *          1h-funded legs against 4h/8h-funded legs without the guard
 *          panicking on the cross-interval shift.
 *
 *   ORDERBOOK_DEFER_ENABLED=true|false  (default: true)
 *     - When true:
 *       a) Orderbook fetch failures during execute trigger an extra
 *          backoff retry layer (500ms -> 1s -> 2s, up to 3 attempts).
 *       b) If those still fail, the scheduled entry is REQUEUED for the
 *          next funding cycle (targetTime += fundingIntervalMs) instead of
 *          being recorded as a terminal `execute_failed`. The deferral is
 *          logged with a new milestone `deferred_to_next_cycle`.
 *
 * Example: enable relaxed funding windows in production
 *   export RELAX_FUNDING_WINDOW=true
 *
 * Example: emergency rollback for orderbook defer only
 *   unset  RELAX_FUNDING_WINDOW
 *   export ORDERBOOK_DEFER_ENABLED=false
 *   pm2 reload ecosystem.config.cjs --update-env
 */

const TRUE_PATTERN = /^(1|true|yes|on)$/i;

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return TRUE_PATTERN.test(String(raw).trim());
}

/** Tolerance when scenario B is active (10 minutes). */
export const RELAXED_LIVE_FUNDING_TIME_DRIFT_MS = 10 * 60 * 1000;

/** Standard funding cycles considered when scenario B is active. */
export const RELAXED_FUNDING_CYCLE_INTERVALS_MS: readonly number[] = [
  1 * 60 * 60 * 1000, // 1h
  4 * 60 * 60 * 1000, // 4h
  8 * 60 * 60 * 1000, // 8h
];

/** Backoff schedule (ms) for scenario C in-cycle retries. */
export const ORDERBOOK_BACKOFF_DELAYS_MS: readonly number[] = [500, 1000, 2000];

/** Maximum number of times one entry may be deferred to a future cycle. */
export const MAX_DEFERRALS_PER_ENTRY = 1;

export interface RelaxGuardsFlags {
  relaxFundingWindow: boolean;
  orderbookDeferEnabled: boolean;
}

/**
 * Read flags freshly from process.env. We deliberately don't memoise so that
 * `pm2 reload --update-env` can flip behaviour at runtime without a code
 * deploy. The cost (a couple of env lookups per scheduler tick) is negligible.
 */
export function getRelaxGuardsFlags(): RelaxGuardsFlags {
  return {
    relaxFundingWindow: readBooleanEnv('RELAX_FUNDING_WINDOW', false),
    orderbookDeferEnabled: readBooleanEnv('ORDERBOOK_DEFER_ENABLED', true),
  };
}

/**
 * Return the active funding-time drift tolerance in ms. When scenario B is
 * disabled this returns the supplied baseline (preserves current behaviour
 * exactly). When enabled, returns 10 minutes.
 */
export function getActiveLiveFundingTimeDriftMs(baselineMs: number): number {
  return getRelaxGuardsFlags().relaxFundingWindow
    ? RELAXED_LIVE_FUNDING_TIME_DRIFT_MS
    : baselineMs;
}

/**
 * Check whether a measured funding-time shift between expected and observed
 * `nextFundingTime` is acceptable.
 *
 * Strict mode (relaxFundingWindow=false): the shift must equal exactly one
 * `fundingIntervalMs` cycle within `toleranceMs`. This matches the existing
 * `isSingleCycleFundingRolloverShift` semantics.
 *
 * Relaxed mode (relaxFundingWindow=true): in addition to the single-cycle
 * match against `fundingIntervalMs`, the shift may also match any of
 * {1h, 4h, 8h} within the same tolerance. This lets cross-interval pairs
 * (e.g. binance 8h vs bybit 1h) survive the guard.
 *
 * NOTE: A shift smaller than `toleranceMs` (i.e. essentially aligned) is
 * intentionally NOT handled here — the call sites still gate on `<=
 * toleranceMs` separately. This function answers only "is it a clean
 * one-cycle rollover?".
 */
export function isAcceptableFundingShift(
  shiftMs: number,
  fundingIntervalMs: number,
  toleranceMs: number,
  options: { allowMultiCycle?: boolean } = {},
): boolean {
  if (!Number.isFinite(shiftMs) || shiftMs < 0) return false;
  if (Number.isFinite(fundingIntervalMs) && fundingIntervalMs > 0) {
    if (Math.abs(shiftMs - fundingIntervalMs) <= toleranceMs) return true;
  }
  if (!options.allowMultiCycle) return false;
  for (const interval of RELAXED_FUNDING_CYCLE_INTERVALS_MS) {
    if (Math.abs(shiftMs - interval) <= toleranceMs) return true;
  }
  return false;
}
