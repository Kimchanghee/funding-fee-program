export const EXECUTED_TRADE_EVENT_TYPES = new Set([
  'entry',
  'snipe_entry',
  'exit',
  'snipe_exit',
  'auto_exit',
  'funding',
  'snipe_complete',
]);

export const REASON_TRADE_EVENT_TYPES = new Set(['guard_block', 'schedule_probe']);

export type TradeSide = 'long' | 'short';

export interface TradeEventLike {
  timestamp: number;
  timestampText?: string;
  type: string;
  simulation: boolean;
  baseAsset?: string;
  shortExchange?: string;
  longExchange?: string;
  exchange?: string;
  side?: TradeSide | string;
  symbol?: string;
  spread?: number;
  spreadPercent?: number;
  margin?: number;
  leverage?: number;
  notional?: number;
  netProfit?: number;
  perFunding?: number;
  totalRoundTripFees?: number;
  pairId?: string;
  entryFee?: number;
  exitFee?: number;
  fundingAmount?: number;
  fundingRate?: number;
  fundingCollected?: number | null;
  pnl?: number;
  pricePnl?: number;
  reason?: string;
  milestone?: string;
  analysis?: Record<string, unknown>;
  detail?: string;
}

export interface TradePairSummary {
  pairId: string;
  baseAsset: string;
  simulation: boolean;
  entryTime: number;
  shortExchange: string;
  longExchange: string;
  margin: number;
  leverage: number;
  notional: number;
  spreadPercent: number;
  expectedProfit: number;
  expectedRoiPercent: number;
  shortExit: TradeEventLike | null;
  longExit: TradeEventLike | null;
  shortPnl: number;
  longPnl: number;
  shortFunding: number;
  longFunding: number;
  shortPricePnl: number;
  longPricePnl: number;
  totalPnl: number;
  totalFunding: number;
  totalPricePnl: number;
  totalFees: number;
  totalMargin: number;
  realizedRoiPercent: number;
  status: 'open' | 'partial' | 'closed';
  fundingVerified?: boolean | null;
  fundingEventsTotal: number;
  completionFunding: number | null;
  completionEvent: TradeEventLike | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function valueOrZero(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

function makeFallbackPairId(event: TradeEventLike): string {
  const asset = event.baseAsset ?? 'UNKNOWN';
  const exchange = event.exchange ?? event.shortExchange ?? event.longExchange ?? 'unknown';
  return `${event.simulation ? 'sim' : 'real'}:${asset}:${exchange}:${event.timestamp}`;
}

function totalMarginFrom(pair: Pick<TradePairSummary, 'margin' | 'notional' | 'leverage'>): number {
  if (pair.margin > 0) return pair.margin * 2;
  if (pair.notional > 0 && pair.leverage > 0) return (pair.notional / pair.leverage) * 2;
  return 0;
}

function recalcPair(pair: TradePairSummary): void {
  pair.totalPricePnl = pair.shortPricePnl + pair.longPricePnl;
  pair.totalFees = (pair.shortExit?.entryFee ?? 0)
    + (pair.shortExit?.exitFee ?? 0)
    + (pair.longExit?.entryFee ?? 0)
    + (pair.longExit?.exitFee ?? 0);

  if (pair.completionEvent) {
    pair.totalPnl = valueOrZero(pair.completionEvent.pnl);
    if (isFiniteNumber(pair.completionEvent.pricePnl)) {
      pair.totalPricePnl = pair.completionEvent.pricePnl;
    }
    pair.totalFees = valueOrZero(pair.completionEvent.entryFee) + valueOrZero(pair.completionEvent.exitFee);
  } else {
    pair.totalPnl = pair.shortPnl + pair.longPnl;
  }

  if (pair.completionFunding != null) {
    pair.totalFunding = pair.completionFunding;
  } else {
    pair.totalFunding = pair.shortFunding + pair.longFunding;
    if (pair.totalFunding === 0 && pair.fundingEventsTotal !== 0) {
      pair.totalFunding = pair.fundingEventsTotal;
    }
  }

  pair.totalMargin = totalMarginFrom(pair);
  pair.expectedRoiPercent = pair.totalMargin > 0 ? (pair.expectedProfit / pair.totalMargin) * 100 : 0;
  pair.realizedRoiPercent = pair.totalMargin > 0 ? (pair.totalPnl / pair.totalMargin) * 100 : 0;

  if (pair.completionEvent || (pair.shortExit && pair.longExit)) {
    pair.status = 'closed';
  } else if (pair.shortExit || pair.longExit) {
    pair.status = 'partial';
  } else {
    pair.status = 'open';
  }
}

function createPairFromEvent(event: TradeEventLike): TradePairSummary {
  const pairId = event.pairId ?? makeFallbackPairId(event);
  const margin = valueOrZero(event.margin);
  const leverage = valueOrZero(event.leverage) || 1;
  const notional = valueOrZero(event.notional);
  const expectedProfit = valueOrZero(event.netProfit);
  const pair: TradePairSummary = {
    pairId,
    baseAsset: event.baseAsset ?? 'UNKNOWN',
    simulation: !!event.simulation,
    entryTime: event.timestamp,
    shortExchange: event.shortExchange ?? (event.side === 'short' ? event.exchange : undefined) ?? '?',
    longExchange: event.longExchange ?? (event.side === 'long' ? event.exchange : undefined) ?? '?',
    margin,
    leverage,
    notional,
    spreadPercent: valueOrZero(event.spreadPercent),
    expectedProfit,
    expectedRoiPercent: 0,
    shortExit: null,
    longExit: null,
    shortPnl: 0,
    longPnl: 0,
    shortFunding: 0,
    longFunding: 0,
    shortPricePnl: 0,
    longPricePnl: 0,
    totalPnl: 0,
    totalFunding: 0,
    totalPricePnl: 0,
    totalFees: 0,
    totalMargin: 0,
    realizedRoiPercent: 0,
    status: 'open',
    fundingVerified: null,
    fundingEventsTotal: 0,
    completionFunding: null,
    completionEvent: null,
  };
  recalcPair(pair);
  return pair;
}

function updatePairFromEvent(pair: TradePairSummary, event: TradeEventLike): void {
  if (event.baseAsset) pair.baseAsset = event.baseAsset;
  pair.simulation = !!event.simulation;
  if (event.shortExchange) pair.shortExchange = event.shortExchange;
  if (event.longExchange) pair.longExchange = event.longExchange;
  if (isFiniteNumber(event.margin) && event.margin > 0) pair.margin = event.margin;
  if (isFiniteNumber(event.leverage) && event.leverage > 0) pair.leverage = event.leverage;
  if (isFiniteNumber(event.notional) && event.notional > 0) pair.notional = event.notional;
  if (isFiniteNumber(event.spreadPercent)) pair.spreadPercent = event.spreadPercent;
  if (isFiniteNumber(event.netProfit)) pair.expectedProfit = event.netProfit;
  pair.entryTime = Math.min(pair.entryTime, event.timestamp);
}

export function buildTradePairsFromEvents(events: TradeEventLike[]): TradePairSummary[] {
  const pairs = new Map<string, TradePairSummary>();

  const getPair = (event: TradeEventLike): TradePairSummary => {
    const pairId = event.pairId ?? makeFallbackPairId(event);
    const existing = pairs.get(pairId);
    if (existing) {
      updatePairFromEvent(existing, event);
      return existing;
    }
    const created = createPairFromEvent(event);
    pairs.set(created.pairId, created);
    return created;
  };

  for (const event of events) {
    if ((event.type === 'entry' || event.type === 'snipe_entry') && event.pairId) {
      getPair(event);
    }
  }

  for (const event of events) {
    if (event.type !== 'exit' && event.type !== 'snipe_exit' && event.type !== 'auto_exit') continue;
    const pair = event.pairId
      ? getPair(event)
      : [...pairs.values()].find((candidate) => {
        if (candidate.baseAsset !== event.baseAsset) return false;
        if (event.side === 'short') return candidate.shortExchange === event.exchange && !candidate.shortExit;
        if (event.side === 'long') return candidate.longExchange === event.exchange && !candidate.longExit;
        return false;
      }) ?? getPair(event);

    if (event.side === 'short') {
      pair.shortExit = event;
      pair.shortExchange = event.exchange ?? pair.shortExchange;
      pair.shortPnl = valueOrZero(event.pnl);
      pair.shortFunding = valueOrZero(event.fundingAmount);
      pair.shortPricePnl = valueOrZero(event.pricePnl);
    } else if (event.side === 'long') {
      pair.longExit = event;
      pair.longExchange = event.exchange ?? pair.longExchange;
      pair.longPnl = valueOrZero(event.pnl);
      pair.longFunding = valueOrZero(event.fundingAmount);
      pair.longPricePnl = valueOrZero(event.pricePnl);
    }
    recalcPair(pair);
  }

  for (const event of events) {
    if (event.type !== 'funding') continue;
    const pair = event.pairId ? getPair(event) : undefined;
    if (!pair) continue;
    pair.fundingEventsTotal += valueOrZero(event.fundingAmount);
    recalcPair(pair);
  }

  for (const event of events) {
    if (event.type !== 'snipe_complete') continue;
    const pair = getPair(event);
    pair.completionEvent = event;
    if (isFiniteNumber(event.fundingCollected)) {
      pair.completionFunding = event.fundingCollected;
    }
    if (event.detail) {
      const verified = event.detail.match(/fundingVerified:(true|false)/);
      if (verified) pair.fundingVerified = verified[1] === 'true';
    }
    recalcPair(pair);
  }

  return [...pairs.values()]
    .map((pair) => {
      recalcPair(pair);
      return pair;
    })
    .sort((a, b) => b.entryTime - a.entryTime);
}

export function getExecutionModeLabel(simulation: boolean): '[SIM]실체결' | '[REAL]실체결' {
  return simulation ? '[SIM]실체결' : '[REAL]실체결';
}

function formatSignedUsd(value: number, digits = 4): string {
  const abs = Math.abs(value).toFixed(digits);
  return value >= 0 ? `+$${abs}` : `-$${abs}`;
}

function formatSignedPercent(value: number, digits = 4): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatTradePairTelegramMessage(
  pair: TradePairSummary,
  phase: 'entry' | 'close' | 'manual_close',
  options: {
    currentTotalBalanceUSDT?: number;
    note?: string;
  } = {},
): string {
  const modeLabel = getExecutionModeLabel(pair.simulation);
  const realized = phase !== 'entry';
  const titleAction = phase === 'entry'
    ? '거래 진입'
    : phase === 'manual_close'
      ? '수동청산'
      : '거래 청산';
  const titleSuffix = realized ? '[실현]' : '[예상]';
  const profit = realized ? pair.totalPnl : pair.expectedProfit;
  const roi = realized ? pair.realizedRoiPercent : pair.expectedRoiPercent;
  const lines = [
    `${modeLabel} ${titleAction}${titleSuffix} ${pair.baseAsset}`,
    `투자금(총 마진): $${pair.totalMargin.toFixed(2)}`,
    `순수익(${realized ? '실현' : '예상'}): ${formatSignedUsd(profit)}`,
    `수익률(${realized ? '실현' : '예상'}): ${formatSignedPercent(roi)}`,
  ];

  if (options.currentTotalBalanceUSDT != null) {
    lines.push(`현재 전체 잔액: $${options.currentTotalBalanceUSDT.toFixed(2)}`);
  }
  if (realized) {
    lines.push(`펀딩 정산: ${formatSignedUsd(pair.totalFunding)}`);
    lines.push(`가격PnL: ${formatSignedUsd(pair.totalPricePnl)}`);
    lines.push(`수수료: -$${Math.abs(pair.totalFees).toFixed(4)}`);
  }
  lines.push(`pairId: ${pair.pairId}`);
  lines.push(`route: ${pair.shortExchange.toUpperCase()} -> ${pair.longExchange.toUpperCase()}`);
  if (!realized) {
    lines.push(`spread: +${pair.spreadPercent.toFixed(4)}%`);
    lines.push('실현손익은 청산 알림/대시보드 PnL 기준');
  }
  if (options.note) lines.push(options.note);
  return lines.join('\n');
}
