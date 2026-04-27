import {
  listFundingReceiptDates,
  listTradeHistoryDates,
  readFundingReceipts,
  readTradeHistory,
  type TradeEvent,
} from './fileLogger';
import {
  SUPPORTED_EXCHANGES,
  type ExchangeId,
  type FundingPayment,
} from './types';

const ENTRY_TYPES = new Set<TradeEvent['type']>(['entry', 'snipe_entry']);
const EXIT_TYPES = new Set<TradeEvent['type']>(['exit', 'snipe_exit', 'auto_exit']);
const ACCOUNTING_TYPES = new Set<TradeEvent['type']>([
  'entry',
  'snipe_entry',
  'exit',
  'snipe_exit',
  'auto_exit',
  'funding',
  'snipe_complete',
]);

export interface SimAccountingSummary {
  eventCount: number;
  entryCount: number;
  exitCount: number;
  fundingCount: number;
  completedCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  simTotalFundingEarned: number;
  simTotalFees: number;
  simTotalClosedPnl: number;
  fundingByExchange: Partial<Record<ExchangeId, number>>;
  closedPnlPerExchange: Partial<Record<ExchangeId, number>>;
  feesPerExchange: Partial<Record<ExchangeId, number>>;
  closedFeesPerExchange: Partial<Record<ExchangeId, number>>;
  fundingHistory: FundingPayment[];
}

export interface SimAccountingOptions {
  from?: number;
  to?: number;
}

function emptyExchangeMap(): Record<ExchangeId, number> {
  const result = {} as Record<ExchangeId, number>;
  for (const exchange of SUPPORTED_EXCHANGES) result[exchange] = 0;
  return result;
}

function isExchangeId(value: unknown): value is ExchangeId {
  return typeof value === 'string' && SUPPORTED_EXCHANGES.includes(value as ExchangeId);
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function eventTimestamp(event: TradeEvent): number | null {
  const timestamp = finiteNumber(event.timestamp);
  return timestamp > 0 ? timestamp : null;
}

function inRange(event: TradeEvent, options: SimAccountingOptions): boolean {
  const timestamp = eventTimestamp(event);
  if (timestamp == null) return false;
  if (options.from != null && timestamp < options.from) return false;
  if (options.to != null && timestamp > options.to) return false;
  return true;
}

function eventKey(event: TradeEvent): string {
  return [
    event.type,
    event.timestamp,
    event.pairId ?? '',
    event.exchange ?? '',
    event.shortExchange ?? '',
    event.longExchange ?? '',
    event.symbol ?? '',
    event.side ?? '',
    finiteNumber(event.fundingAmount).toFixed(8),
    finiteNumber(event.pnl).toFixed(8),
    finiteNumber(event.pricePnl).toFixed(8),
    finiteNumber(event.entryFee).toFixed(8),
    finiteNumber(event.exitFee).toFixed(8),
  ].join('|');
}

function dedupeEvents(events: TradeEvent[]): TradeEvent[] {
  const seen = new Set<string>();
  const deduped: TradeEvent[] = [];
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function legKey(event: TradeEvent): string {
  return [
    event.pairId ?? '',
    event.exchange ?? '',
    event.symbol ?? '',
    event.side ?? '',
  ].join('|');
}

function fundingPaymentKey(payment: FundingPayment): string {
  return [
    payment.exchange,
    payment.symbol,
    payment.side,
    payment.timestamp,
    payment.amount.toFixed(8),
  ].join('|');
}

function addToExchangeMap(
  map: Partial<Record<ExchangeId, number>>,
  exchange: unknown,
  amount: number,
) {
  if (!isExchangeId(exchange) || !Number.isFinite(amount) || amount === 0) return;
  map[exchange] = (map[exchange] ?? 0) + amount;
}

function addFundingPayment(
  payments: Map<string, FundingPayment>,
  event: TradeEvent,
  amount: number,
) {
  if (!isExchangeId(event.exchange) || !event.symbol || !event.side) return;
  if (event.side !== 'long' && event.side !== 'short') return;
  if (!Number.isFinite(amount) || Math.abs(amount) <= 0.0000001) return;

  const timestamp = eventTimestamp(event);
  if (timestamp == null) return;

  const payment: FundingPayment = {
    exchange: event.exchange,
    symbol: event.symbol,
    amount,
    rate: finiteNumber(event.fundingRate),
    timestamp,
    side: event.side,
  };
  payments.set(fundingPaymentKey(payment), payment);
}

function addEntryFeeByExchange(
  feesPerExchange: Partial<Record<ExchangeId, number>>,
  entry: TradeEvent,
  entryFee: number,
) {
  if (!Number.isFinite(entryFee) || entryFee === 0) return;

  if (isExchangeId(entry.exchange)) {
    addToExchangeMap(feesPerExchange, entry.exchange, entryFee);
    return;
  }

  const legs = [entry.shortExchange, entry.longExchange].filter(isExchangeId);
  if (legs.length === 0) return;
  const perLegFee = entryFee / legs.length;
  for (const exchange of legs) {
    addToExchangeMap(feesPerExchange, exchange, perLegFee);
  }
}

function inferPricePnl(event: TradeEvent): number {
  const explicit = finiteNumber(event.pricePnl);
  if (explicit !== 0 || typeof event.pricePnl === 'number') return explicit;

  const pnl = finiteNumber(event.pnl);
  if (pnl === 0 && typeof event.pnl !== 'number') return 0;
  return pnl
    - finiteNumber(event.fundingAmount)
    + finiteNumber(event.entryFee)
    + finiteNumber(event.exitFee);
}

function loadRawSimAccountingEvents(options: SimAccountingOptions): TradeEvent[] {
  const events: TradeEvent[] = [];

  for (const date of listTradeHistoryDates('sim_executed')) {
    events.push(...readTradeHistory('sim_executed', date));
  }

  for (const date of listFundingReceiptDates('sim')) {
    events.push(...readFundingReceipts('sim', date));
  }

  return dedupeEvents(events)
    .filter((event) => event.simulation === true)
    .filter((event) => ACCOUNTING_TYPES.has(event.type))
    .filter((event) => inRange(event, options))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function loadSimAccountingFromTradeLogs(
  options: SimAccountingOptions = {},
): SimAccountingSummary {
  const events = loadRawSimAccountingEvents(options);
  const entries = events.filter((event) => ENTRY_TYPES.has(event.type));
  const exits = events.filter((event) => EXIT_TYPES.has(event.type));
  const fundingEvents = events.filter((event) => event.type === 'funding');
  const completedEvents = events.filter((event) => event.type === 'snipe_complete');

  const fundingByExchange = emptyExchangeMap();
  const closedPnlPerExchange = emptyExchangeMap();
  const feesPerExchange = emptyExchangeMap();
  const closedFeesPerExchange = emptyExchangeMap();
  const fundingPayments = new Map<string, FundingPayment>();
  const fundingLegKeys = new Set<string>();

  let simTotalFundingEarned = 0;
  let simTotalClosedPnl = 0;
  let exitFees = 0;
  let exitEntryFeesWithoutPair = 0;

  const exitEntryFeesByPair = new Map<string, number>();
  const entryFeesByPair = new Map<string, { event: TradeEvent; amount: number }>();
  const pairIdsWithExit = new Set<string>();

  for (const entry of entries) {
    const entryFee = finiteNumber(entry.entryFee);
    if (entryFee === 0) continue;
    if (entry.pairId) {
      const previous = entryFeesByPair.get(entry.pairId)?.amount ?? 0;
      entryFeesByPair.set(entry.pairId, { event: entry, amount: previous + entryFee });
    } else {
      exitEntryFeesWithoutPair += entryFee;
      addEntryFeeByExchange(feesPerExchange, entry, entryFee);
    }
  }

  for (const event of fundingEvents) {
    const amount = finiteNumber(event.fundingAmount);
    if (amount === 0 && typeof event.fundingAmount !== 'number') continue;
    simTotalFundingEarned += amount;
    addToExchangeMap(fundingByExchange, event.exchange, amount);
    fundingLegKeys.add(legKey(event));
    addFundingPayment(fundingPayments, event, amount);
  }

  for (const exit of exits) {
    if (exit.pairId) pairIdsWithExit.add(exit.pairId);
    const exitFee = finiteNumber(exit.exitFee);
    exitFees += exitFee;
    addToExchangeMap(feesPerExchange, exit.exchange, exitFee);
    addToExchangeMap(closedFeesPerExchange, exit.exchange, exitFee);

    const entryFee = finiteNumber(exit.entryFee);
    if (entryFee !== 0) {
      if (exit.pairId) {
        exitEntryFeesByPair.set(exit.pairId, (exitEntryFeesByPair.get(exit.pairId) ?? 0) + entryFee);
      } else {
        exitEntryFeesWithoutPair += entryFee;
      }
      addToExchangeMap(feesPerExchange, exit.exchange, entryFee);
      addToExchangeMap(closedFeesPerExchange, exit.exchange, entryFee);
    }

    const pricePnl = inferPricePnl(exit);
    simTotalClosedPnl += pricePnl;
    addToExchangeMap(closedPnlPerExchange, exit.exchange, pricePnl);

    const fallbackFunding = finiteNumber(exit.fundingAmount);
    if (fallbackFunding !== 0 && !fundingLegKeys.has(legKey(exit))) {
      simTotalFundingEarned += fallbackFunding;
      addToExchangeMap(fundingByExchange, exit.exchange, fallbackFunding);
      addFundingPayment(fundingPayments, exit, fallbackFunding);
    }
  }

  let entryFees = exitEntryFeesWithoutPair;
  const pairIds = new Set<string>([
    ...Array.from(entryFeesByPair.keys()),
    ...Array.from(exitEntryFeesByPair.keys()),
  ]);
  for (const pairId of pairIds) {
    const entry = entryFeesByPair.get(pairId);
    const exitEntryFee = exitEntryFeesByPair.get(pairId) ?? 0;

    if (entry) {
      entryFees += entry.amount;
      if (exitEntryFee === 0) {
        addEntryFeeByExchange(feesPerExchange, entry.event, entry.amount);
        if (pairIdsWithExit.has(pairId)) {
          addEntryFeeByExchange(closedFeesPerExchange, entry.event, entry.amount);
        }
      } else {
        const unallocatedEntryFee = Math.max(0, entry.amount - exitEntryFee);
        addEntryFeeByExchange(feesPerExchange, entry.event, unallocatedEntryFee);
      }
      continue;
    }

    if (exitEntryFee !== 0) {
      entryFees += exitEntryFee;
    }
  }

  const simTotalFees = entryFees + exitFees;
  const timestamps = events.map((event) => event.timestamp).filter((value) => Number.isFinite(value));

  return {
    eventCount: events.length,
    entryCount: entries.length,
    exitCount: exits.length,
    fundingCount: fundingEvents.length,
    completedCount: completedEvents.length,
    firstTimestamp: timestamps.length > 0 ? timestamps[0] : null,
    lastTimestamp: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
    simTotalFundingEarned,
    simTotalFees,
    simTotalClosedPnl,
    fundingByExchange,
    closedPnlPerExchange,
    feesPerExchange,
    closedFeesPerExchange,
    fundingHistory: Array.from(fundingPayments.values()).sort((a, b) => b.timestamp - a.timestamp),
  };
}
