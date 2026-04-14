function pickPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '00';
}

/**
 * Format timestamp as: YYYY-MM-DD-HH-mm-ss-SSS
 * Defaults to Asia/Seoul timezone.
 */
export function formatTimestampYmdHmsMs(
  timestamp: number,
  options?: { timeZone?: string },
): string {
  if (!Number.isFinite(timestamp)) return '-';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '-';

  const timeZone = options?.timeZone ?? 'Asia/Seoul';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const year = pickPart(parts, 'year');
  const month = pickPart(parts, 'month');
  const day = pickPart(parts, 'day');
  const hour = pickPart(parts, 'hour');
  const minute = pickPart(parts, 'minute');
  const second = pickPart(parts, 'second');
  const millisecond = String(date.getMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day}-${hour}-${minute}-${second}-${millisecond}`;
}
