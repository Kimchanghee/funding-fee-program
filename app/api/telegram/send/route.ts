import { NextResponse } from 'next/server';
import { loadServerTelegramConfig } from '@/lib/serverTelegramConfig';
import {
  isTelegramReady,
  sendTelegramMessageWithConfig,
  type TelegramConfig,
} from '@/lib/telegram';
import { isAuthenticatedRequest, unauthorizedJson } from '@/lib/apiAuth';

export async function POST(req: Request) {
  if (!isAuthenticatedRequest(req)) return unauthorizedJson();

  const body = await req.json().catch(() => null) as {
    message?: string;
    config?: Partial<TelegramConfig>;
  } | null;

  const message = typeof body?.message === 'string' ? body.message : '';
  if (!message.trim()) {
    return NextResponse.json({ success: false, error: 'message is required' }, { status: 400 });
  }

  const config = body?.config && isTelegramReady({
    botToken: body.config.botToken?.trim() ?? '',
    chatId: body.config.chatId?.trim() ?? '',
    enabled: body.config.enabled === true,
  })
    ? {
      botToken: body.config.botToken?.trim() ?? '',
      chatId: body.config.chatId?.trim() ?? '',
      enabled: body.config.enabled === true,
    }
    : loadServerTelegramConfig();

  if (!isTelegramReady(config)) {
    return NextResponse.json({ success: false, error: 'telegram is disabled or not configured' }, { status: 400 });
  }

  const ok = await sendTelegramMessageWithConfig(config, message);
  return NextResponse.json({ success: ok }, { status: ok ? 200 : 502 });
}
