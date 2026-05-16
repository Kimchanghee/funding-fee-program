import type { ExchangeId } from './types';

export type ExchangeTier = 'A' | 'B' | 'C';

export interface ExchangeProfile {
  /** Exchange identifier */
  id: ExchangeId;
  /** Operational tier: A=default REAL, B=confirmed REAL only, C=observe only */
  tier: ExchangeTier;
  /** Max seconds to wait for funding settlement confirmation before force-close */
  maxSettlementWaitSec: number;
  /** Seconds before funding time to enter */
  entryLeadSec: number;
  /** Whether funding rate updates more frequently than settlement (e.g. Bybit every minute) */
  frequentRateUpdates: boolean;
  /** Whether settlement uses the rate at the exact moment (vs accumulated) */
  usesInstantaneousRate: boolean;

  // ── Capability flags ──
  /** Can query funding settlement history reliably */
  supportsFundingSettlementCheck: boolean;
  /** Returns usable raw orderbook depth (not aggregated/sparse) */
  supportsRawOrderbook: boolean;
  /** IOC limit orders work reliably */
  supportsIocLimit: boolean;
  /** Enabled for REAL trading by default */
  realEnabledByDefault: boolean;
}

/**
 * Per-exchange operational profiles based on documented settlement behavior.
 * Aggressive profile keeps all supported venues eligible for scan and REAL mode.
 */
export const EXCHANGE_PROFILES: Record<ExchangeId, ExchangeProfile> = {
  binance: {
    id: 'binance',
    tier: 'A',
    maxSettlementWaitSec: 20,
    entryLeadSec: 7,
    frequentRateUpdates: false,
    usesInstantaneousRate: false,
    supportsFundingSettlementCheck: true,
    supportsRawOrderbook: true,
    supportsIocLimit: true,
    realEnabledByDefault: true,
  },
  bybit: {
    id: 'bybit',
    tier: 'A',
    maxSettlementWaitSec: 12,
    entryLeadSec: 5,
    frequentRateUpdates: true,
    usesInstantaneousRate: false,
    supportsFundingSettlementCheck: true,
    supportsRawOrderbook: true,
    supportsIocLimit: true,
    realEnabledByDefault: true,
  },
  okx: {
    id: 'okx',
    tier: 'A',
    maxSettlementWaitSec: 75,
    entryLeadSec: 7,
    frequentRateUpdates: false,
    usesInstantaneousRate: true,
    supportsFundingSettlementCheck: true,
    supportsRawOrderbook: true,
    supportsIocLimit: true,
    realEnabledByDefault: true,
  },
  bitget: {
    id: 'bitget',
    tier: 'A',
    maxSettlementWaitSec: 20,
    entryLeadSec: 7,
    frequentRateUpdates: false,
    usesInstantaneousRate: false,
    supportsFundingSettlementCheck: true,
    supportsRawOrderbook: true,
    supportsIocLimit: true,
    realEnabledByDefault: true,
  },
  gate: {
    id: 'gate',
    tier: 'A',
    maxSettlementWaitSec: 12,
    entryLeadSec: 5,
    frequentRateUpdates: false,
    usesInstantaneousRate: false,
    supportsFundingSettlementCheck: true,
    supportsRawOrderbook: true,
    supportsIocLimit: true,
    realEnabledByDefault: true,
  },
  bingx: {
    id: 'bingx',
    tier: 'A',
    maxSettlementWaitSec: 75,
    entryLeadSec: 35,
    frequentRateUpdates: false,
    usesInstantaneousRate: false,
    supportsFundingSettlementCheck: false,
    supportsRawOrderbook: true,
    supportsIocLimit: true,
    realEnabledByDefault: true,
  },
};

/** Get the effective entry lead time in ms for a pair of exchanges */
export function getPairEntryLeadMs(
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
): number {
  const shortLead = EXCHANGE_PROFILES[shortExchange].entryLeadSec;
  const longLead = EXCHANGE_PROFILES[longExchange].entryLeadSec;
  return Math.max(shortLead, longLead) * 1000;
}

/** Get max settlement wait for a pair (use the longer one) */
export function getPairMaxSettlementWaitMs(
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
): number {
  const shortWait = EXCHANGE_PROFILES[shortExchange].maxSettlementWaitSec;
  const longWait = EXCHANGE_PROFILES[longExchange].maxSettlementWaitSec;
  return Math.max(shortWait, longWait) * 1000;
}

/** Check if a pair involves any Tier C (observe-only) exchange */
export function hasTierCExchange(
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
): boolean {
  return EXCHANGE_PROFILES[shortExchange].tier === 'C'
    || EXCHANGE_PROFILES[longExchange].tier === 'C';
}

/** Check if either exchange uses instantaneous rate (needs larger drift buffer) */
export function pairUsesInstantaneousRate(
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
): boolean {
  return EXCHANGE_PROFILES[shortExchange].usesInstantaneousRate
    || EXCHANGE_PROFILES[longExchange].usesInstantaneousRate;
}

/** Check if both exchanges support confirmed funding settlement check */
export function pairSupportsConfirmedClose(
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
): boolean {
  return EXCHANGE_PROFILES[shortExchange].supportsFundingSettlementCheck
    && EXCHANGE_PROFILES[longExchange].supportsFundingSettlementCheck;
}

/** Check if both exchanges support IOC limit orders */
export function pairSupportsIocLimit(
  shortExchange: ExchangeId,
  longExchange: ExchangeId,
): boolean {
  return EXCHANGE_PROFILES[shortExchange].supportsIocLimit
    && EXCHANGE_PROFILES[longExchange].supportsIocLimit;
}
