import { NextRequest, NextResponse } from 'next/server';
import { listDates, readLogs, type FileLogEntry } from '@/lib/fileLogger';
import type { LogLevel } from '@/lib/types';
import { formatTimestampYmdHmsMs } from '@/lib/timeFormat';

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function parseLevel(value: string | null): LogLevel | null {
  if (!value || value === 'all') return null;
  if (value === 'info' || value === 'success' || value === 'warning' || value === 'error') return value;
  return null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || undefined;
  const allDates = url.searchParams.get('all') === 'true';
  const listOnly = url.searchParams.get('list') === 'true';
  const from = parseTimestamp(url.searchParams.get('from'));
  const to = parseTimestamp(url.searchParams.get('to'));
  const limit = parsePositiveInt(url.searchParams.get('limit'));
  const page = parsePositiveInt(url.searchParams.get('page'));
  const pageSize = parsePositiveInt(url.searchParams.get('pageSize'));
  const level = parseLevel(url.searchParams.get('level'));

  const dates = listDates('logs');
  if (listOnly) {
    return NextResponse.json({ success: true, dates });
  }

  const sourceEntries = allDates ? dates.flatMap((targetDate) => readLogs(targetDate)) : readLogs(date);
  const allEntries: FileLogEntry[] = [];
  for (const entry of sourceEntries) {
    const rawTimestamp = (entry as { timestamp?: unknown }).timestamp;
    const timestamp = typeof rawTimestamp === 'number'
      ? (Number.isFinite(rawTimestamp) ? rawTimestamp : null)
      : typeof rawTimestamp === 'string'
        ? parseTimestamp(rawTimestamp)
        : null;
    if (timestamp == null) continue;
    if (level && entry.level !== level) continue;
    if (from != null && timestamp < from) continue;
    if (to != null && timestamp > to) continue;
    allEntries.push({ ...entry, timestamp });
  }
  allEntries.sort((a, b) => b.timestamp - a.timestamp);

  const total = allEntries.length;
  let entries = allEntries;

  let resolvedPage: number | null = null;
  let resolvedPageSize: number | null = null;
  let totalPages: number | null = null;
  let fromIndex = 0;
  let toIndex = 0;

  if (page != null || pageSize != null) {
    resolvedPageSize = pageSize ?? limit ?? 15;
    totalPages = Math.max(1, Math.ceil(total / resolvedPageSize));
    resolvedPage = Math.min(Math.max(page ?? 1, 1), totalPages);
    const start = (resolvedPage - 1) * resolvedPageSize;
    const end = start + resolvedPageSize;
    entries = allEntries.slice(start, end);
    fromIndex = total === 0 ? 0 : start + 1;
    toIndex = total === 0 ? 0 : Math.min(end, total);
  } else if (limit != null && entries.length > limit) {
    entries = entries.slice(0, limit);
  }

  return NextResponse.json({
    success: true,
    date: allDates ? null : (date || 'today'),
    allDates,
    count: entries.length,
    total,
    page: resolvedPage,
    pageSize: resolvedPageSize,
    totalPages,
    fromIndex,
    toIndex,
    entries: entries.map((entry) => ({
      ...entry,
      timestampText: formatTimestampYmdHmsMs(entry.timestamp),
    })),
  });
}
