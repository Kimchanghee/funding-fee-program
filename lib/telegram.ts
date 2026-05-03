const TELEGRAM_API = 'https://api.telegram.org/bot';
const TELEGRAM_SEND_ATTEMPTS = 3;
const TELEGRAM_SEND_TIMEOUT_MS = 8_000;
const TELEGRAM_RETRY_DELAY_MS = 1_000;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: '',
  chatId: '',
  enabled: false,
};

function normalizeTelegramConfig(config: Partial<TelegramConfig> | null | undefined): TelegramConfig {
  return {
    botToken: typeof config?.botToken === 'string' ? config.botToken.trim() : '',
    chatId: typeof config?.chatId === 'string' ? config.chatId.trim() : '',
    enabled: config?.enabled === true,
  };
}

export function isTelegramReady(config: TelegramConfig): boolean {
  return config.enabled && config.botToken.trim().length > 0 && config.chatId.trim().length > 0;
}

export function getTelegramConfig(): TelegramConfig {
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem('telegram_config');
      if (saved) return normalizeTelegramConfig(JSON.parse(saved) as Partial<TelegramConfig>);
    } catch {
      return DEFAULT_TELEGRAM_CONFIG;
    }
  }
  return DEFAULT_TELEGRAM_CONFIG;
}

export function saveTelegramConfig(config: TelegramConfig): void {
  const normalized = normalizeTelegramConfig(config);
  if (typeof window !== 'undefined') {
    localStorage.setItem('telegram_config', JSON.stringify(normalized));
    void fetch('/api/telegram/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalized),
    }).catch(() => {});
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface TelegramSendResult {
  success: boolean;
  messageId?: number;
  error?: string;
  /** Set when the call short-circuited because telegram is not configured. */
  skipped?: boolean;
}

/**
 * Detailed variant — captures `message_id` from Telegram's response so callers
 * (notably the server-side archive) can persist it. Use the boolean wrapper
 * `sendTelegramMessageWithConfig` below when you only need ok/not-ok.
 */
export async function sendTelegramMessageWithConfigDetailed(
  config: TelegramConfig,
  message: string,
): Promise<TelegramSendResult> {
  const normalized = normalizeTelegramConfig(config);
  if (!isTelegramReady(normalized) || !message.trim()) {
    return { success: false, skipped: true, error: 'telegram_not_ready_or_empty_message' };
  }

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= TELEGRAM_SEND_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_SEND_TIMEOUT_MS);

    try {
      const res = await fetch(`${TELEGRAM_API}${normalized.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: normalized.chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => null) as
          | { ok?: boolean; result?: { message_id?: number } }
          | null;
        if (data?.ok !== false) {
          return { success: true, messageId: data?.result?.message_id };
        }
      }

      lastError = `HTTP ${res.status}`;
      try {
        const payload = await res.json() as { description?: string };
        if (payload.description) lastError = payload.description;
      } catch {
        // Keep the HTTP status as the failure detail.
      }
    } catch (error) {
      lastError = getErrorMessage(error);
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < TELEGRAM_SEND_ATTEMPTS) {
      await sleep(TELEGRAM_RETRY_DELAY_MS * attempt);
    }
  }

  console.error(`[telegram] sendMessage failed after ${TELEGRAM_SEND_ATTEMPTS} attempts: ${lastError}`);
  return { success: false, error: lastError };
}

export async function sendTelegramMessageWithConfig(
  config: TelegramConfig,
  message: string,
): Promise<boolean> {
  const result = await sendTelegramMessageWithConfigDetailed(config, message);
  return result.success;
}

export async function sendTelegramMessage(message: string): Promise<boolean> {
  const config = getTelegramConfig();
  if (!isTelegramReady(config) || !message.trim()) return false;

  if (typeof window !== 'undefined') {
    try {
      const res = await fetch('/api/telegram/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, config }),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null) as { success?: boolean } | null;
      return data?.success !== false;
    } catch {
      return false;
    }
  }

  return sendTelegramMessageWithConfig(config, message);
}

function formatModePrefix(simulation: boolean): string {
  return simulation ? '[SIM] ' : '[REAL] ';
}

function formatSignedUsd(value: number, digits = 4): string {
  const abs = Math.abs(value).toFixed(digits);
  return value >= 0 ? `+$${abs}` : `-$${abs}`;
}

export function formatTradeAlert(type: 'entry' | 'exit', data: {
  baseAsset: string;
  shortExchange: string;
  longExchange: string;
  spreadPercent: number;
  investmentUSDT: number;
  simulation: boolean;
}): string {
  const action = type === 'entry' ? '진입' : '청산';
  const mode = formatModePrefix(data.simulation);
  return [
    `<b>${mode}${action}: ${data.baseAsset}/USDT</b>`,
    `숏 ${data.shortExchange.toUpperCase()} / 롱 ${data.longExchange.toUpperCase()}`,
    `스프레드: ${data.spreadPercent.toFixed(4)}%`,
    `증거금: $${data.investmentUSDT.toFixed(0)}`,
  ].join('\n');
}

export function formatFundingAlert(data: {
  baseAsset: string;
  exchange: string;
  side: string;
  amount: number;
  rate: number;
  simulation: boolean;
}): string {
  const mode = formatModePrefix(data.simulation);
  return [
    `<b>${mode}펀딩 수령: ${data.baseAsset}/USDT</b>`,
    `거래소: ${data.exchange.toUpperCase()} (${data.side})`,
    `금액: ${formatSignedUsd(data.amount)}`,
    `펀딩률: ${(data.rate * 100).toFixed(4)}%`,
  ].join('\n');
}

export function formatTransferAlert(data: {
  from: string;
  to: string;
  amount: number;
  reason: string;
  simulation: boolean;
}): string {
  const mode = formatModePrefix(data.simulation);
  return [
    `<b>${mode}잔고 이동</b>`,
    `${data.from.toUpperCase()} -> ${data.to.toUpperCase()}`,
    `금액: $${data.amount.toFixed(2)}`,
    `사유: ${data.reason}`,
  ].join('\n');
}

export function formatBalanceWarning(data: {
  lowExchange: string;
  lowBalance: number;
  avgBalance: number;
  exchanges: { name: string; balance: number }[];
  simulation: boolean;
}): string {
  const mode = formatModePrefix(data.simulation);
  const avgRatio = data.avgBalance > 0 ? (data.lowBalance / data.avgBalance) * 100 : 0;
  const exList = data.exchanges
    .map((exchange) => `  ${exchange.name.toUpperCase()}: $${exchange.balance.toFixed(0)}`)
    .join('\n');
  return [
    `<b>${mode}잔고 부족 경고</b>`,
    `${data.lowExchange.toUpperCase()}: $${data.lowBalance.toFixed(0)} (평균 대비 ${avgRatio.toFixed(0)}%)`,
    `평균 잔고: $${data.avgBalance.toFixed(0)}`,
    '',
    '<b>거래소별 잔고:</b>',
    exList,
  ].join('\n');
}

export function formatSnipeCompleteAlert(data: {
  baseAsset: string;
  shortExchange: string;
  longExchange: string;
  fundingCollected?: number | null;
  pnl?: number | null;
  simulation: boolean;
  note?: string;
}): string {
  const mode = formatModePrefix(data.simulation);
  const fundingLine = data.fundingCollected == null
    ? '펀딩: 확인 중'
    : `펀딩: ${formatSignedUsd(data.fundingCollected)}`;
  const pnlLine = data.pnl == null
    ? '최종순손익: 확인 중'
    : `최종순손익(펀딩 포함): ${formatSignedUsd(data.pnl)}`;
  const priceFeeLine = data.pnl == null || data.fundingCollected == null
    ? null
    : `가격PnL-수수료: ${formatSignedUsd(data.pnl - data.fundingCollected)}`;

  return [
    `<b>${mode}스나이프 완료: ${data.baseAsset}/USDT</b>`,
    `숏 ${data.shortExchange.toUpperCase()} / 롱 ${data.longExchange.toUpperCase()}`,
    fundingLine,
    ...(priceFeeLine ? [priceFeeLine] : []),
    pnlLine,
    ...(data.note ? [data.note] : []),
  ].join('\n');
}
