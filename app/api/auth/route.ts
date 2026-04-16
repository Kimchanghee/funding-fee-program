import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const { password } = await request.json();
  const sitePassword = process.env.SITE_PASSWORD;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const isSecure = request.nextUrl.protocol === 'https:' || forwardedProto === 'https';

  if (!sitePassword) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  if (password === sitePassword) {
    const response = NextResponse.json({ success: true });
    response.cookies.set('site-auth', 'authenticated', {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    });
    return response;
  }

  return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
}
