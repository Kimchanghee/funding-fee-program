import { loadServerTelegramConfig } from './serverTelegramConfig';
import { sendTelegramMessageWithConfig } from './telegram';

export async function sendTelegramMessage(message: string): Promise<boolean> {
  return sendTelegramMessageWithConfig(loadServerTelegramConfig(), message);
}
