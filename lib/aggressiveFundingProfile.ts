import type { ExchangeId } from './types';

/**
 * Aggressive funding scan + near-perfect hedge execution profile.
 *
 * This file centralizes the requested high-coverage profile so runtime code,
 * scheduler code, and review scripts can consume the same values instead of
 * scattering magic numbers across the app.
 */
export const AGGRESSIVE_FUNDING_PROFILE_ID = 'aggressive-funding-hedge-v1';

/** Enable every supported exchange for scan candidates, including OKX, Bitget, and BingX. */
export const AGGRESSIVE_SCAN_EXCHANGES: ExchangeId[] = [
  'binance',
  'bybit',
  'okx',
  'bitget',
  'gate',
  'bingx',
];

/**
 * Minimum notional volume filter for the aggressive profile.
 * Keep this low enough to maximize coin coverage, while still avoiding symbols
 * that are likely impossible to hedge without material slippage.
 */
export const AGGRESSIVE_MIN_VOLUME_24H_USD = 1_000_000;

/**
 * Maximum result count for scan output. This intentionally raises the ceiling
 * so the scheduler can rank many more symbols before final fee/slippage guards.
 */
export const AGGRESSIVE_OPPORTUNITY_LIMIT = 500;

/**
 * Safety margin after explicit fee and spread calculations.
 * The entry gate should be based on spread - fee - impact - reserve, so this
 * reserve is intentionally small rather than a large fixed minimum spread.
 */
export const AGGRESSIVE_SAFETY_MARGIN_PCT = 0.005; // 0.5 bps

/** Strict hedge targets for delta-neutral funding capture. */
export const AGGRESSIVE_HEDGE_RATIO_MIN = 0.999;
export const AGGRESSIVE_HEDGE_RATIO_MAX = 1.001;
export const AGGRESSIVE_MAX_HEDGE_MISMATCH_PCT = 0.10;
export const AGGRESSIVE_MAX_ORPHAN_LEG_MS = 250;

/** Prefer IOC-limit execution so both legs either fill quickly or are reconciled. */
export const AGGRESSIVE_IOC_LIMIT_ONLY = true;

export interface AggressiveEntryGateInput {
  spreadPercent: number;
  roundTripFeePercent: number;
  entryImpactPercent?: number;
  exitImpactPercent?: number;
  driftReservePercent?: number;
  safetyMarginPercent?: number;
}

export interface AggressiveEntryGateResult {
  netSpreadPercent: number;
  shouldEnter: boolean;
}

/**
 * Fee-aware minimum entry gate:
 * enter only when spread remains positive after fees, entry/exit impact,
 * funding drift reserve, and a small safety margin.
 */
export function calcAggressiveEntryGate(input: AggressiveEntryGateInput): AggressiveEntryGateResult {
  const entryImpactPercent = Math.max(0, input.entryImpactPercent ?? 0);
  const exitImpactPercent = Math.max(0, input.exitImpactPercent ?? entryImpactPercent);
  const driftReservePercent = Math.max(0, input.driftReservePercent ?? 0);
  const safetyMarginPercent = Math.max(0, input.safetyMarginPercent ?? AGGRESSIVE_SAFETY_MARGIN_PCT);

  const netSpreadPercent = input.spreadPercent
    - input.roundTripFeePercent
    - entryImpactPercent
    - exitImpactPercent
    - driftReservePercent
    - safetyMarginPercent;

  return {
    netSpreadPercent,
    shouldEnter: netSpreadPercent > 0,
  };
}

export function isAggressiveHedgeRatioAcceptable(shortNotional: number, longNotional: number): boolean {
  if (!Number.isFinite(shortNotional) || !Number.isFinite(longNotional)) return false;
  if (shortNotional <= 0 || longNotional <= 0) return false;
  const ratio = Math.min(shortNotional, longNotional) / Math.max(shortNotional, longNotional);
  return ratio >= AGGRESSIVE_HEDGE_RATIO_MIN;
}
