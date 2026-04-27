import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { getDataDir } from './dataDir';
import type { TelegramConfig } from './telegram';

const TELEGRAM_CONFIG_FILE = path.join(getDataDir(), 'telegram-config.json');

function normalizeTelegramConfig(config: Partial<TelegramConfig> | null | undefined): TelegramConfig {
  return {
    botToken: typeof config?.botToken === 'string' ? config.botToken.trim() : '',
    chatId: typeof config?.chatId === 'string' ? config.chatId.trim() : '',
    enabled: config?.enabled === true,
  };
}

function loadEnvTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? '';
  const enabledEnv = process.env.TELEGRAM_ENABLED?.trim().toLowerCase();
  const enabled = enabledEnv == null
    ? botToken.length > 0 && chatId.length > 0
    : ['1', 'true', 'yes', 'on'].includes(enabledEnv);
  return { botToken, chatId, enabled };
}

export function loadServerTelegramConfig(): TelegramConfig {
  try {
    if (existsSync(TELEGRAM_CONFIG_FILE)) {
      const raw = readFileSync(TELEGRAM_CONFIG_FILE, 'utf-8');
      return normalizeTelegramConfig(JSON.parse(raw) as Partial<TelegramConfig>);
    }
  } catch {
    // Fall back to env config below.
  }
  return loadEnvTelegramConfig();
}

export function saveServerTelegramConfig(config: Partial<TelegramConfig>): TelegramConfig {
  const normalized = normalizeTelegramConfig(config);
  mkdirSync(path.dirname(TELEGRAM_CONFIG_FILE), { recursive: true });
  writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

export function getMaskedServerTelegramConfig(): Omit<TelegramConfig, 'botToken'> & { botTokenSet: boolean } {
  const config = loadServerTelegramConfig();
  return {
    chatId: config.chatId,
    enabled: config.enabled,
    botTokenSet: config.botToken.length > 0,
  };
}
