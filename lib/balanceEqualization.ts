import type { ArbitrageOpportunity, ExchangeId } from './types';

export interface BalanceTransferRecommendation {
  fromExchange: ExchangeId;
  toExchange: ExchangeId;
  amountUSDT: number;
}

export interface BalanceEqualizationPlan {
  enabledExchanges: ExchangeId[];
  totalBalanceUSDT: number;
  averageBalanceUSDT: number;
  actualBalances: Record<ExchangeId, number>;
  virtualTransferBalances: Record<ExchangeId, number>;
  cappedPlanningBalances: Record<ExchangeId, number>;
  deficitsByExchange: Partial<Record<ExchangeId, number>>;
  surplusesByExchange: Partial<Record<ExchangeId, number>>;
  transfers: BalanceTransferRecommendation[];
}

const DEFAULT_MIN_TRANSFER_USDT = 25;

function sanitizeBalance(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

export function buildBalanceEqualizationPlan(
  enabledExchanges: ExchangeId[],
  balances: Partial<Record<ExchangeId, number>>,
  options?: {
    minTransferUSDT?: number;
  },
): BalanceEqualizationPlan {
  const actualBalances = {} as Record<ExchangeId, number>;
  for (const exchange of enabledExchanges) {
    actualBalances[exchange] = sanitizeBalance(balances[exchange]);
  }

  const totalBalanceUSDT = enabledExchanges.reduce((sum, exchange) => sum + actualBalances[exchange], 0);
  const averageBalanceUSDT = enabledExchanges.length > 0 ? totalBalanceUSDT / enabledExchanges.length : 0;
  const minTransferUSDT = Math.max(1, options?.minTransferUSDT ?? DEFAULT_MIN_TRANSFER_USDT);

  const surplusesByExchange: Partial<Record<ExchangeId, number>> = {};
  const deficitsByExchange: Partial<Record<ExchangeId, number>> = {};
  const cappedPlanningBalances = { ...actualBalances };
  const virtualTransferBalances = { ...actualBalances };
  const transfers: BalanceTransferRecommendation[] = [];

  if (enabledExchanges.length === 0 || averageBalanceUSDT <= 0) {
    return {
      enabledExchanges,
      totalBalanceUSDT,
      averageBalanceUSDT,
      actualBalances,
      virtualTransferBalances,
      cappedPlanningBalances,
      deficitsByExchange,
      surplusesByExchange,
      transfers,
    };
  }

  const donors = enabledExchanges
    .map((exchange) => ({
      exchange,
      remaining: Math.max(0, actualBalances[exchange] - averageBalanceUSDT),
    }))
    .filter((entry) => entry.remaining >= minTransferUSDT)
    .sort((a, b) => b.remaining - a.remaining);

  const receivers = enabledExchanges
    .map((exchange) => ({
      exchange,
      remaining: Math.max(0, averageBalanceUSDT - actualBalances[exchange]),
    }))
    .filter((entry) => entry.remaining >= minTransferUSDT)
    .sort((a, b) => b.remaining - a.remaining);

  for (const donor of donors) {
    surplusesByExchange[donor.exchange] = donor.remaining;
  }
  for (const receiver of receivers) {
    deficitsByExchange[receiver.exchange] = receiver.remaining;
  }

  let donorIndex = 0;
  let receiverIndex = 0;
  while (donorIndex < donors.length && receiverIndex < receivers.length) {
    const donor = donors[donorIndex];
    const receiver = receivers[receiverIndex];
    const amountUSDT = Math.min(donor.remaining, receiver.remaining);

    if (amountUSDT < minTransferUSDT) {
      if (donor.remaining <= receiver.remaining) {
        donorIndex += 1;
      } else {
        receiverIndex += 1;
      }
      continue;
    }

    transfers.push({
      fromExchange: donor.exchange,
      toExchange: receiver.exchange,
      amountUSDT,
    });

    donor.remaining -= amountUSDT;
    receiver.remaining -= amountUSDT;

    cappedPlanningBalances[donor.exchange] = Math.max(0, cappedPlanningBalances[donor.exchange] - amountUSDT);
    virtualTransferBalances[donor.exchange] = Math.max(0, virtualTransferBalances[donor.exchange] - amountUSDT);
    virtualTransferBalances[receiver.exchange] += amountUSDT;

    if (donor.remaining < minTransferUSDT) donorIndex += 1;
    if (receiver.remaining < minTransferUSDT) receiverIndex += 1;
  }

  return {
    enabledExchanges,
    totalBalanceUSDT,
    averageBalanceUSDT,
    actualBalances,
    virtualTransferBalances,
    cappedPlanningBalances,
    deficitsByExchange,
    surplusesByExchange,
    transfers,
  };
}

export function getBalanceEqualizationPlanningBalances(
  plan: BalanceEqualizationPlan,
  useVirtualTransfers: boolean,
): Record<ExchangeId, number> {
  return useVirtualTransfers
    ? { ...plan.virtualTransferBalances }
    : { ...plan.cappedPlanningBalances };
}

export function getOpportunityBalanceEqualizationMultiplier(
  plan: BalanceEqualizationPlan | null | undefined,
  opportunity: Pick<ArbitrageOpportunity, 'shortExchange' | 'longExchange'>,
): number {
  if (!plan || plan.averageBalanceUSDT <= 0) return 1;

  const average = plan.averageBalanceUSDT;
  const shortPlanning = plan.cappedPlanningBalances[opportunity.shortExchange] ?? 0;
  const longPlanning = plan.cappedPlanningBalances[opportunity.longExchange] ?? 0;
  const shortSupport = Math.min(1, shortPlanning / average);
  const longSupport = Math.min(1, longPlanning / average);
  const supportMultiplier = 0.9 + (0.1 * Math.min(shortSupport, longSupport));

  const alignedFlowNeed = Math.min(
    plan.surplusesByExchange[opportunity.longExchange] ?? 0,
    plan.deficitsByExchange[opportunity.shortExchange] ?? 0,
  );
  const reverseFlowNeed = Math.min(
    plan.surplusesByExchange[opportunity.shortExchange] ?? 0,
    plan.deficitsByExchange[opportunity.longExchange] ?? 0,
  );
  const directionDelta = (alignedFlowNeed - reverseFlowNeed) / average;
  const directionMultiplier = Math.max(0.85, Math.min(1.15, 1 + (directionDelta * 0.25)));

  return supportMultiplier * directionMultiplier;
}
