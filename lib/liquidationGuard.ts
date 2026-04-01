/**
 * Liquidation distance guard — checks how close a position is to liquidation
 * and blocks entry or triggers flatten when distance is too small.
 */
import { fetchPositions } from './exchanges';
import type { ApiConfig, ExchangeId } from './types';

/** Minimum distance to liquidation price (%) to allow entry */
export const MIN_LIQ_DISTANCE_PCT = 10;

/** Critical distance to liquidation price (%) that triggers immediate flatten */
export const CRITICAL_LIQ_DISTANCE_PCT = 5;

export interface LiqDistanceResult {
  distancePct: number | null;
  markPrice: number | null;
  liquidationPrice: number | null;
}

/**
 * Check the liquidation distance for a specific symbol on an exchange.
 * Returns null distancePct if no matching position found or data unavailable.
 */
export async function getLiquidationDistance(
  exchange: ExchangeId,
  config: ApiConfig,
  symbol: string,
): Promise<LiqDistanceResult> {
  // Do NOT catch errors here — let them propagate to the caller's fail-closed handler.
  // Only return null distancePct when there is genuinely no matching position.
  const positions = await fetchPositions(exchange, config);
  const pos = positions.find(
    (p) => p.symbol === symbol || p.displaySymbol === symbol.replace(':USDT', ''),
  );

  if (!pos || !pos.markPrice || !pos.liquidationPrice || pos.liquidationPrice === 0) {
    return { distancePct: null, markPrice: null, liquidationPrice: null };
  }

  const distancePct = Math.abs(
    (pos.markPrice - pos.liquidationPrice) / pos.markPrice,
  ) * 100;

  return {
    distancePct,
    markPrice: pos.markPrice,
    liquidationPrice: pos.liquidationPrice,
  };
}

/**
 * Check liquidation distance for both legs of a hedge pair.
 * Returns the minimum distance across both exchanges.
 */
export async function checkPairLiquidationDistance(
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
  shortConfig: ApiConfig,
  longConfig: ApiConfig,
  shortSymbol: string,
  longSymbol: string,
): Promise<{
  safe: boolean;
  critical: boolean;
  minDistancePct: number | null;
  detail: string;
}> {
  const [shortLiq, longLiq] = await Promise.all([
    getLiquidationDistance(shortExchange, shortConfig, shortSymbol),
    getLiquidationDistance(longExchange, longConfig, longSymbol),
  ]);

  const distances = [shortLiq.distancePct, longLiq.distancePct].filter(
    (d): d is number => d !== null,
  );

  if (distances.length === 0) {
    // No existing positions — safe to enter
    return { safe: true, critical: false, minDistancePct: null, detail: 'no existing positions' };
  }

  const minDistancePct = Math.min(...distances);

  return {
    safe: minDistancePct >= MIN_LIQ_DISTANCE_PCT,
    critical: minDistancePct < CRITICAL_LIQ_DISTANCE_PCT,
    minDistancePct,
    detail: `short=${shortLiq.distancePct?.toFixed(1) ?? 'n/a'}% long=${longLiq.distancePct?.toFixed(1) ?? 'n/a'}% min=${minDistancePct.toFixed(1)}%`,
  };
}
