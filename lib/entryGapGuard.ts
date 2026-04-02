type EntryGapInput = {
  shortPrice: number;
  longPrice: number;
  baselineShortPrice?: number;
  baselineLongPrice?: number;
};

export type EntryGapMetrics = {
  liveGapPercent: number;
  baselineGapPercent: number;
  driftPercent: number;
};

function calcGapPercent(shortPrice: number, longPrice: number): number {
  if (!Number.isFinite(shortPrice) || shortPrice <= 0 || !Number.isFinite(longPrice)) {
    return 0;
  }
  return ((longPrice - shortPrice) / shortPrice) * 100;
}

export function getEntryGapMetrics(input: EntryGapInput): EntryGapMetrics {
  const liveGapPercent = calcGapPercent(input.shortPrice, input.longPrice);
  const baselineGapPercent = calcGapPercent(
    input.baselineShortPrice ?? input.shortPrice,
    input.baselineLongPrice ?? input.longPrice,
  );
  return {
    liveGapPercent,
    baselineGapPercent,
    driftPercent: Math.abs(liveGapPercent - baselineGapPercent),
  };
}
