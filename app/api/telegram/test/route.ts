import { NextResponse } from 'next/server';
import { isAuthenticatedRequest, unauthorizedJson } from '@/lib/apiAuth';

const TELEGRAM_API = 'https://api.telegram.org/bot';

export async function POST(req: Request) {
  if (!isAuthenticatedRequest(req)) return unauthorizedJson();

  const { botToken, chatId } = await req.json();

  if (!botToken || !chatId) {
    return NextResponse.json({ error: 'botToken과 chatId가 필요합니다.' }, { status: 400 });
  }

  try {
    const res = await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ 펀딩피 아비트라지 알림이 연결되었습니다!',
        parse_mode: 'HTML',
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      return NextResponse.json({ error: data.description || '텔레그램 API 오류' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
