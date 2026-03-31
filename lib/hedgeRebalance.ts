/**
 * Shared hedge rebalance logic — used by both route.ts and serverScheduler.ts
 * to trim notional mismatch after entry execution.
 */
import { closePosition } from './exchanges';
import type { ExecutedOrderSummary } from './exchanges';
import {
  MAX_HEDGE_MISMATCH_PCT,
  type ApiConfig,
  type ExchangeId,
  type FeeOverrides,
} from './types';

export interface HedgeTrimParams {
  shortExchange: ExchangeId;
  longExchange: ExchangeId;
  shortConfig: ApiConfig;
  longConfig: ApiConfig;
  shortSymbol: string;
  longSymbol: string;
  shortEntry: ExecutedOrderSummary;
  longEntry: ExecutedOrderSummary;
  useStrictHedge: boolean;
  feeOverrides?: FeeOverrides;
}

export interface HedgeTrimResult {
  trimmed: boolean;
  detail?: string;
  /** Updated amounts after trim (only set when trimmed=true) */
  shortAmount?: number;
  longAmount?: number;
  shortFilledNotional?: number;
  longFilledNotional?: number;
}

/**
 * Check notional mismatch between two executed legs and trim the excess side.
 *
 * When useStrictHedge is ON, threshold is MAX_HEDGE_MISMATCH_PCT (0.20%).
 * Otherwise, legacy 2% threshold is used.
 *
 * Returns whether trim was performed and the resulting amounts.
 */
export async function rebalanceExecutedHedge(
  params: HedgeTrimParams,
): Promise<HedgeTrimResult> {
  const { shortEntry, longEntry } = params;
  const shortNotional = shortEntry.filledNotional;
  const longNotional = longEntry.filledNotional;
  const diff = Math.abs(shortNotional - longNotional);
  const maxNotional = Math.max(shortNotional, longNotional);
  const diffPercent = maxNotional > 0 ? (diff / maxNotional) * 100 : 0;
  const trimThreshold = params.useStrictHedge ? MAX_HEDGE_MISMATCH_PCT : 2;

  if (diffPercent <= trimThreshold) {
    return { trimmed: false };
  }

  const minNotional = Math.min(shortNotional, longNotional);

  if (shortNotional > longNotional) {
    const excessQty = (shortNotional - minNotional) / shortEntry.price;
    await closePosition(
      params.shortExchange, params.shortConfig,
      params.shortSymbol, 'short', excessQty, params.feeOverrides,
    );
    return {
      trimmed: true,
      detail: `short excess $${(shortNotional - minNotional).toFixed(2)} trimmed (${diffPercent.toFixed(3)}%)`,
      shortAmount: shortEntry.amount - excessQty,
      longAmount: longEntry.amount,
      shortFilledNotional: minNotional,
      longFilledNotional: longNotional,
    };
  } else {
    const excessQty = (longNotional - minNotional) / longEntry.price;
    await closePosition(
      params.longExchange, params.longConfig,
      params.longSymbol, 'long', excessQty, params.feeOverrides,
    );
    return {
      trimmed: true,
      detail: `long excess $${(longNotional - minNotional).toFixed(2)} trimmed (${diffPercent.toFixed(3)}%)`,
      shortAmount: shortEntry.amount,
      longAmount: longEntry.amount - excessQty,
      shortFilledNotional: shortNotional,
      longFilledNotional: minNotional,
    };
  }
}
