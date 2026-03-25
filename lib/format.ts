/**
 * 숫자 포맷 유틸리티
 * - 천 단위 콤마 + 소수점 자리수 고정
 */

/** 숫자를 콤마 + 소수점 포맷 (예: 1234.56 -> "1,234.56") */
export function fmtNum(value: number, decimals = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export const PROFIT_INFINITY_THRESHOLD_USD = 10_000_000;

export function isInfiniteProfitDisplay(
  value: number,
  threshold = PROFIT_INFINITY_THRESHOLD_USD,
): boolean {
  return !Number.isFinite(value) || Math.abs(value) > threshold;
}

/** 달러 포맷 (예: 1234.56 -> "$1,234.56", -50 -> "-$50.00") */
export function fmtUSD(value: number, decimals = 2): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

/** 퍼센트 포맷 (예: 0.1234 -> "+0.1234%") */
export function fmtPct(value: number, decimals = 4, showSign = true): string {
  const formatted = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (showSign) {
    return value >= 0 ? `+${formatted}%` : `-${formatted}%`;
  }
  return `${formatted}%`;
}

export function fmtUsdOrInfinity(
  value: number,
  decimals = 2,
  options?: { showPlus?: boolean; threshold?: number },
): string {
  const showPlus = options?.showPlus ?? true;
  const threshold = options?.threshold ?? PROFIT_INFINITY_THRESHOLD_USD;
  const infinity = '\u221e';

  if (isInfiniteProfitDisplay(value, threshold)) {
    if (value < 0) return `-$${infinity}`;
    return showPlus ? `+$${infinity}` : `$${infinity}`;
  }

  const abs = fmtNum(Math.abs(value), decimals);
  if (value < 0) return `-$${abs}`;
  return showPlus ? `+$${abs}` : `$${abs}`;
}

export function fmtPctOrInfinity(
  value: number,
  decimals = 2,
  options?: { showPlus?: boolean; forceInfinity?: boolean },
): string {
  const showPlus = options?.showPlus ?? true;
  const infinity = '\u221e';

  if (options?.forceInfinity || !Number.isFinite(value)) {
    if (value < 0) return `-${infinity}%`;
    return showPlus ? `+${infinity}%` : `${infinity}%`;
  }

  return fmtPct(value, decimals, showPlus);
}
