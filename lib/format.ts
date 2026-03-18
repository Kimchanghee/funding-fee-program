/**
 * 숫자 포맷팅 유틸리티
 * - 천 단위 쉼표 + 소수점 자릿수 고정
 */

/** 숫자를 쉼표 + 소수점 포맷 (예: 1234.56 → "1,234.56") */
export function fmtNum(value: number, decimals = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 달러 포맷 (예: 1234.56 → "$1,234.56", -50 → "-$50.00") */
export function fmtUSD(value: number, decimals = 2): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

/** 퍼센트 포맷 (예: 0.1234 → "+0.1234%") */
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
