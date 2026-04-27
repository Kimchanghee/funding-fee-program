import { NextResponse } from 'next/server';
import {
  getMaskedServerTelegramConfig,
  saveServerTelegramConfig,
} from '@/lib/serverTelegramConfig';
import { isAuthenticatedRequest, unauthorizedJson } from '@/lib/apiAuth';

export async function GET(req: Request) {
  if (!isAuthenticatedRequest(req)) return unauthorizedJson();

  return NextResponse.json({
    success: true,
    config: getMaskedServerTelegramConfig(),
  });
}

export async function POST(req: Request) {
  if (!isAuthenticatedRequest(req)) return unauthorizedJson();

  const body = await req.json().catch(() => null) as {
    botToken?: string;
    chatId?: string;
    enabled?: boolean;
  } | null;

  if (!body) {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const config = saveServerTelegramConfig(body);
  return NextResponse.json({
    success: true,
    config: {
      chatId: config.chatId,
      enabled: config.enabled,
      botTokenSet: config.botToken.length > 0,
    },
  });
}
