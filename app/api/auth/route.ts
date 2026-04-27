import { NextRequest, NextResponse } from 'next/server';
import {
  AUTH_MAX_AGE_SECONDS,
  LEGACY_AUTH_COOKIE_NAME,
  SIGNED_AUTH_COOKIE_NAME,
  createSignedAuthCookieValue,
} from '@/lib/apiAuth';

export async function POST(request: NextRequest) {
  const { password } = await request.json();
  const sitePassword = process.env.SITE_PASSWORD;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const isSecure = request.nextUrl.protocol === 'https:' || forwardedProto === 'https';

  if (!sitePassword) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  if (password === sitePassword) {
    const signedAuth = createSignedAuthCookieValue();
    if (!signedAuth) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const response = NextResponse.json({ success: true });
    const cookieOptions = {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      maxAge: AUTH_MAX_AGE_SECONDS,
      path: '/',
    } as const;

    response.cookies.set(LEGACY_AUTH_COOKIE_NAME, 'authenticated', cookieOptions);
    response.cookies.set(SIGNED_AUTH_COOKIE_NAME, signedAuth, cookieOptions);
    return response;
  }

  return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
}
