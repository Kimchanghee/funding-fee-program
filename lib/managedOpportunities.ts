import type {
  ArbitrageOpportunity,
  FeeOverrides,
  PaybackOverrides,
  Position,
} from './types';
import {
  estimateProfit,
  getOpportunityId,
  makeOpportunityId,
} from './opportunities';

export type ManagedOpportunityItem = {
  id: string;
  asset: string;
  opp: ArbitrageOpportunity;
  fundingTime: number;
  status: 'scheduled' | 'active' | 'opportunity';
  investmentUSDT?: number;
  pairId?: string;
};

type ManagedPositionLike = Pick<
  Position,
  'baseAsset' | 'exchange' | 'side' | 'pairId' | 'margin' | 'positionType'
> & {
  fundingIntervalMs?: number;
  simId?: string;
};

export function parseManagedOpportunityKey(key: string) {
  return {
    isSim: key.startsWith('sim:'),
    opportunityId: key.slice(key.indexOf(':') + 1),
  };
}

export function findOpportunityByRoute(
  opportunities: ArbitrageOpportunity[],
  baseAsset: string,
  shortExchange: ArbitrageOpportunity['shortExchange'],
  longExchange: ArbitrageOpportunity['longExchange'],
  fundingIntervalMs?: number,
): ArbitrageOpportunity | undefined {
  if (fundingIntervalMs) {
    const opportunityId = makeOpportunityId(
      baseAsset,
      shortExchange,
      longExchange,
      fundingIntervalMs,
    );
    const exact = opportunities.find(
      (opportunity) => getOpportunityId(opportunity) === opportunityId,
    );
    if (exact) return exact;
  }

  return opportunities.find(
    (opportunity) =>
      opportunity.baseAsset === baseAsset
      && opportunity.shortExchange === shortExchange
      && opportunity.longExchange === longExchange,
  );
}

function buildActiveItem(
  opportunities: ArbitrageOpportunity[],
  positions: ManagedPositionLike[],
  position: ManagedPositionLike,
): ManagedOpportunityItem | null {
  const pair = position.pairId
    ? positions.find(
      (candidate) =>
        candidate.pairId === position.pairId
        && candidate.side !== position.side
        && candidate !== position,
    )
    : undefined;

  const shortPosition = position.side === 'short'
    ? position
    : pair?.side === 'short'
      ? pair
      : undefined;
  const longPosition = position.side === 'long'
    ? position
    : pair?.side === 'long'
      ? pair
      : undefined;

  if (!shortPosition || !longPosition) return null;

  const opportunity = findOpportunityByRoute(
    opportunities,
    position.baseAsset,
    shortPosition.exchange,
    longPosition.exchange,
    shortPosition.fundingIntervalMs ?? longPosition.fundingIntervalMs,
  );
  if (!opportunity) return null;

  const investmentUSDT = (shortPosition.margin + longPosition.margin) / 2;
  return {
    id: getOpportunityId(opportunity),
    asset: opportunity.baseAsset,
    opp: opportunity,
    fundingTime: opportunity.nextFundingTime,
    status: 'active',
    investmentUSDT,
    pairId: position.pairId,
  };
}

export function buildManagedOpportunityItems(params: {
  opportunities: ArbitrageOpportunity[];
  snipeTargets: Record<string, number>;
  snipeAllocations?: Record<string, number>;
  activePositions: ManagedPositionLike[];
  simulationMode: boolean;
  defaultInvestmentUSDT: number;
  leverage: number;
  feeOverrides?: FeeOverrides;
  paybackOverrides?: PaybackOverrides;
  useDriftBuffer?: boolean;
  limit?: number;
}) {
  const {
    opportunities,
    snipeTargets,
    snipeAllocations = {},
    activePositions,
    simulationMode,
    defaultInvestmentUSDT,
    leverage,
    feeOverrides,
    paybackOverrides,
    useDriftBuffer = false,
    limit = 15,
  } = params;

  const items = new Map<string, ManagedOpportunityItem>();

  for (const [snipeKey, fundingTime] of Object.entries(snipeTargets)) {
    const { isSim, opportunityId } = parseManagedOpportunityKey(snipeKey);
    if (isSim !== simulationMode) continue;
    const opportunity = opportunities.find(
      (candidate) => getOpportunityId(candidate) === opportunityId,
    );
    if (!opportunity) continue;
    items.set(opportunityId, {
      id: opportunityId,
      asset: opportunity.baseAsset,
      opp: opportunity,
      fundingTime,
      status: 'scheduled',
      investmentUSDT: snipeAllocations[snipeKey] ?? defaultInvestmentUSDT,
    });
  }

  for (const position of activePositions) {
    if (position.positionType === 'manual') continue;
    const activeItem = buildActiveItem(opportunities, activePositions, position);
    if (!activeItem) continue;
    const existing = items.get(activeItem.id);
    if (existing) {
      items.set(activeItem.id, {
        ...existing,
        status: 'active',
        investmentUSDT: activeItem.investmentUSDT ?? existing.investmentUSDT,
        pairId: activeItem.pairId ?? existing.pairId,
      });
      continue;
    }
    items.set(activeItem.id, activeItem);
  }

  for (const opportunity of opportunities) {
    const opportunityId = getOpportunityId(opportunity);
    if (items.has(opportunityId)) continue;
    if (items.size >= limit) break;
    items.set(opportunityId, {
      id: opportunityId,
      asset: opportunity.baseAsset,
      opp: opportunity,
      fundingTime: opportunity.nextFundingTime,
      status: 'opportunity',
    });
  }

  const estimatedNetPerFundingCache = new Map<string, number>();
  const getEstimatedNetPerFunding = (item: ManagedOpportunityItem) => {
    const cacheKey = `${item.id}:${item.investmentUSDT ?? defaultInvestmentUSDT}`;
    const cached = estimatedNetPerFundingCache.get(cacheKey);
    if (cached != null) return cached;
    const investment = item.investmentUSDT ?? defaultInvestmentUSDT;
    const profit = estimateProfit(item.opp, investment, leverage, {
      feeOverrides,
      paybackOverrides,
      useDriftBuffer,
    });
    estimatedNetPerFundingCache.set(cacheKey, profit.netPerFunding);
    return profit.netPerFunding;
  };
  const getEstimatedHourlyNet = (item: ManagedOpportunityItem) => {
    const intervalHours = Math.max(1 / 60, (item.opp.fundingIntervalMs ?? 8 * 3600000) / 3600000);
    return getEstimatedNetPerFunding(item) / intervalHours;
  };

  return Array.from(items.values())
    .filter((item) => item.status === 'active' || getEstimatedNetPerFunding(item) > 0)
    .sort((a, b) => {
      const priority = { active: 0, scheduled: 1, opportunity: 2 };
      if (priority[a.status] !== priority[b.status]) {
        return priority[a.status] - priority[b.status];
      }

      const timeDiff = a.fundingTime - b.fundingTime;
      if (Math.abs(timeDiff) > 120_000) return timeDiff;
      return getEstimatedHourlyNet(b) - getEstimatedHourlyNet(a);
    });
}
