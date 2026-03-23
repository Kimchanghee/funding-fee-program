// Simple Telegram Bot API wrapper - no dependency needed, just fetch
const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

// 기본 텔레그램 설정 (하드코딩)
const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: '7753483534:AAEHvlP7lYa2wYL0fv5IwG-tZ6LGgfNR4n4',
  chatId: '499792971',
  enabled: true,
};

export function getTelegramConfig(): TelegramConfig {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('telegram_config');
    if (saved) return JSON.parse(saved);
  }
  return DEFAULT_TELEGRAM_CONFIG;
}

export function saveTelegramConfig(config: TelegramConfig) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('telegram_config', JSON.stringify(config));
  }
}

export async function sendTelegramMessage(message: string): Promise<boolean> {
  const config = getTelegramConfig();
  if (!config.enabled || !config.botToken || !config.chatId) return false;

  try {
    const res = await fetch(`${TELEGRAM_API}${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Pre-formatted alert messages
export function formatTradeAlert(type: 'entry' | 'exit', data: {
  baseAsset: string;
  shortExchange: string;
  longExchange: string;
  spreadPercent: number;
  investmentUSDT: number;
  simulation: boolean;
}): string {
  const icon = type === 'entry' ? '🟢' : '🔴';
  const action = type === 'entry' ? '진입' : '청산';
  const sim = data.simulation ? '[SIM] ' : '';
  return [
    `${icon} <b>${sim}${action}: ${data.baseAsset}/USDT</b>`,
    `숏: ${data.shortExchange.toUpperCase()} ↔ 롱: ${data.longExchange.toUpperCase()}`,
    `스프레드: ${data.spreadPercent.toFixed(4)}%`,
    `투자금: $${data.investmentUSDT.toFixed(0)}`,
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
  const sim = data.simulation ? '[SIM] ' : '';
  const icon = data.amount >= 0 ? '💰' : '💸';
  return [
    `${icon} <b>${sim}펀딩 수령: ${data.baseAsset}/USDT</b>`,
    `거래소: ${data.exchange.toUpperCase()} (${data.side})`,
    `금액: ${data.amount >= 0 ? '+' : ''}$${data.amount.toFixed(4)}`,
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
  const sim = data.simulation ? '[SIM] ' : '';
  return [
    `🔄 <b>${sim}잔고 이동</b>`,
    `${data.from.toUpperCase()} → ${data.to.toUpperCase()}`,
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
  const sim = data.simulation ? '[SIM] ' : '';
  const exList = data.exchanges.map(e => `  ${e.name.toUpperCase()}: $${e.balance.toFixed(0)}`).join('\n');
  return [
    `⚠️ <b>${sim}잔고 부족 경고</b>`,
    `${data.lowExchange.toUpperCase()}: $${data.lowBalance.toFixed(0)} (평균 대비 ${((data.lowBalance / data.avgBalance) * 100).toFixed(0)}%)`,
    `평균 잔고: $${data.avgBalance.toFixed(0)}`,
    ``,
    `<b>거래소별 잔고:</b>`,
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
  const sim = data.simulation ? '[SIM] ' : '';
  const icon = data.pnl == null ? 'ℹ️' : data.pnl >= 0 ? '✅' : '⚠️';
  const fundingLine = data.fundingCollected == null
    ? '펀딩 수익: 확인 중'
    : `펀딩 수익: ${data.fundingCollected >= 0 ? '+' : ''}$${data.fundingCollected.toFixed(4)}`;
  const pnlLine = data.pnl == null
    ? '순손익: 확인 중'
    : `순손익: ${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(4)}`;
  return [
    `${icon} <b>${sim}스나이프 완료: ${data.baseAsset}/USDT</b>`,
    `${data.shortExchange.toUpperCase()} ↔ ${data.longExchange.toUpperCase()}`,
    fundingLine,
    pnlLine,
    ...(data.note ? [data.note] : []),
  ].join('\n');
}
