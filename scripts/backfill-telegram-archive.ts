/**
 * One-shot backfill: walk every executed trade in
 * `data/trades-executed/{sim,real}/<date>.jsonl` for KST 2026-04-27 ~ 04-30
 * and write synthetic Telegram archive records that *would have* been sent
 * at entry/exit. The bot's own message history is unrecoverable so this is
 * a best-effort reconstruction:
 *  - synthetic: true
 *  - messageId: undefined
 *  - text: rebuilt from the same `formatTradePairTelegramMessage` used by
 *    the live path so the archive is regex-compatible with future records
 *
 * Run:  npx tsx scripts/backfill-telegram-archive.ts
 *
 * The script never modifies original trade files. Re-running is safe — by
 * default it appends; pass `--purge` to remove existing synthetic entries
 * for the targeted dates first (does NOT touch real entries).
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

import {
  appendTelegramArchive,
  rebuildTelegramArchiveIndex,
  type TelegramArchiveRecord,
} from '../lib/telegramArchive';
import {
  buildTradePairsFromEvents,
  formatTradePairTelegramMessage,
  type TradeEventLike,
} from '../lib/tradeEvents';
import { getDataDir } from '../lib/dataDir';

const TARGET_DATES = ['2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30'];

interface CliOptions {
  purge: boolean;
  scopes: ('sim' | 'real')[];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { purge: false, scopes: ['sim', 'real'] };
  for (const arg of argv.slice(2)) {
    if (arg === '--purge') opts.purge = true;
    if (arg === '--sim-only') opts.scopes = ['sim'];
    if (arg === '--real-only') opts.scopes = ['real'];
  }
  return opts;
}

function loadJsonl(path: string): TradeEventLike[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const events: TradeEventLike[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TradeEventLike);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

function purgeSyntheticForDate(date: string): number {
  const file = join(getDataDir(), 'telegram', `${date}.jsonl`);
  if (!existsSync(file)) return 0;
  const raw = readFileSync(file, 'utf-8');
  const out: string[] = [];
  let removed = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as TelegramArchiveRecord;
      if (rec.synthetic) {
        removed += 1;
        continue;
      }
      out.push(line);
    } catch {
      out.push(line);
    }
  }
  writeFileSync(file, out.length ? `${out.join('\n')}\n` : '', 'utf-8');
  return removed;
}

function main(): void {
  const opts = parseArgs(process.argv);
  const dataDir = getDataDir();
  let totalSynthesized = 0;
  let totalPurged = 0;
  const seenMessageHashes = new Set<string>();

  if (opts.purge) {
    for (const date of TARGET_DATES) {
      totalPurged += purgeSyntheticForDate(date);
    }
    console.log(`[backfill] purged ${totalPurged} prior synthetic record(s)`);
  } else {
    // Load existing telegram archive lines so we don't double-write across
    // multiple runs without --purge. We key on a content hash of (kind+text).
    for (const date of TARGET_DATES) {
      const file = join(dataDir, 'telegram', `${date}.jsonl`);
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf-8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as TelegramArchiveRecord;
          if (rec.synthetic) {
            seenMessageHashes.add(`${rec.kind}|${rec.tsUnix}|${rec.pairId ?? ''}`);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  for (const scope of opts.scopes) {
    const dir = join(dataDir, 'trades-executed', scope);
    if (!existsSync(dir)) {
      console.log(`[backfill] skip ${scope}: ${dir} missing`);
      continue;
    }
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .filter((name) => TARGET_DATES.some((d) => name.startsWith(d)));

    for (const name of files) {
      const path = join(dir, name);
      const events = loadJsonl(path);
      if (events.length === 0) continue;

      const pairs = buildTradePairsFromEvents(events);
      // For each pair, synthesize an entry record (if entry event present)
      // and an exit record (if completion event present).
      for (const pair of pairs) {
        const entryEvent = events.find((e) =>
          (e.type === 'entry' || e.type === 'snipe_entry') && e.pairId === pair.pairId,
        );
        const completionEvent = events.find((e) =>
          e.type === 'snipe_complete' && e.pairId === pair.pairId,
        );

        if (entryEvent) {
          const tsUnix = entryEvent.timestamp;
          const hashKey = `entry|${tsUnix}|${pair.pairId}`;
          if (seenMessageHashes.has(hashKey)) {
            // already backfilled
          } else {
            const text = formatTradePairTelegramMessage(pair, 'entry', {});
            appendTelegramArchive({
              tsUnix,
              kind: 'entry',
              pairId: pair.pairId,
              symbol: pair.baseAsset,
              exchanges: `${pair.shortExchange}/${pair.longExchange}`,
              text,
              chatId: '',
              deliverySuccess: false,
              deliveryError: 'synthetic_backfill_no_real_send',
              synthetic: true,
              structured: {
                expNet: pair.expectedProfit,
                perFunding: pair.perFunding,
                totalRoundTripFees: pair.totalRoundTripFees,
                totalReservesUSD: pair.totalReservesUSD,
                margin: pair.margin,
                notional: pair.notional,
                leverage: pair.leverage,
                spreadPercent: pair.spreadPercent,
                expectedRoiPercent: pair.expectedRoiPercent,
              },
            });
            totalSynthesized += 1;
          }
        }
        if (completionEvent) {
          const tsUnix = completionEvent.timestamp;
          const hashKey = `exit|${tsUnix}|${pair.pairId}`;
          if (!seenMessageHashes.has(hashKey)) {
            const text = formatTradePairTelegramMessage(pair, 'close', {});
            appendTelegramArchive({
              tsUnix,
              kind: 'exit',
              pairId: pair.pairId,
              symbol: pair.baseAsset,
              exchanges: `${pair.shortExchange}/${pair.longExchange}`,
              text,
              chatId: '',
              deliverySuccess: false,
              deliveryError: 'synthetic_backfill_no_real_send',
              synthetic: true,
              structured: {
                realPnl: pair.totalPnl,
                totalFunding: pair.totalFunding,
                totalPricePnl: pair.totalPricePnl,
                totalFees: pair.totalFees,
                margin: pair.margin,
                notional: pair.notional,
                leverage: pair.leverage,
                spreadPercent: pair.spreadPercent,
                expNet: pair.expectedProfit,
                expectedRoiPercent: pair.expectedRoiPercent,
                realizedRoiPercent: pair.realizedRoiPercent,
              },
            });
            totalSynthesized += 1;
          }
        }
      }
      console.log(`[backfill] ${scope}/${name}: ${pairs.length} pairs processed`);
    }
  }

  // Rebuild index from disk so the rolled-up totals reflect this batch.
  const idx = rebuildTelegramArchiveIndex();
  console.log(`[backfill] synthesized ${totalSynthesized} record(s); index totalMessages=${idx.totalMessages} byKind=${JSON.stringify(idx.byKind)}`);
  console.log('[backfill] also touched dates:', Array.from(new Set(Object.keys(idx.byDate))).sort().join(', '));
}

main();
