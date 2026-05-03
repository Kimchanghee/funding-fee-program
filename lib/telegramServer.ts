import { loadServerTelegramConfig } from './serverTelegramConfig';
import { sendTelegramMessageWithConfigDetailed } from './telegram';
import {
  appendTelegramArchive,
  type TelegramArchiveMetadata,
} from './telegramArchive';

/**
 * Server-side Telegram dispatch with persistent archive.
 *
 * Every call writes a record to `data/telegram/<KST date>.jsonl` whether the
 * underlying network call succeeded, failed, or was skipped (telegram not
 * configured). Archive failures are swallowed — they must not block delivery
 * or break callers that fire-and-forget with `void sendTelegramMessage(...)`.
 *
 * The optional `metadata` argument lets callers attach structured fields
 * (kind, tradeId, symbol, expNet, etc.) so the archive can be cross-joined
 * with `data/trades-executed/sim/<date>.jsonl` in post-hoc analysis without
 * re-parsing message text.
 */
export async function sendTelegramMessage(
  message: string,
  metadata?: TelegramArchiveMetadata,
): Promise<boolean> {
  const config = loadServerTelegramConfig();
  const detailed = await sendTelegramMessageWithConfigDetailed(config, message);
  // Archive must not throw. Even if telegram is not configured (skipped=true)
  // we still record the attempt so analysis can see expected-but-unsent alerts.
  try {
    appendTelegramArchive({
      kind: metadata?.kind ?? 'other',
      tradeId: metadata?.tradeId,
      pairId: metadata?.pairId,
      symbol: metadata?.symbol,
      exchanges: metadata?.exchanges,
      side: metadata?.side,
      fundingTime: metadata?.fundingTime,
      structured: metadata?.structured,
      synthetic: metadata?.synthetic,
      chatId: config.chatId ?? '',
      text: message,
      messageId: detailed.messageId,
      deliverySuccess: detailed.success,
      deliveryError: detailed.error,
    });
  } catch (err) {
    console.error('[telegramServer] archive append failed:', err);
  }
  return detailed.success;
}
