import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PAGE_PATHS = ['/login'];
const PUBLIC_API_PATHS = new Set([
  '/api/auth',
  '/api/market-data-health',
  '/api/scheduler',
  '/api/sim-scheduler',
  '/api/funding-rates',
]);
const PUBLIC_EXCHANGE_READ_RE = /^\/api\/exchanges\/[^/]+\/(funding-rates|orderbook)$/;
const SIGNED_AUTH_COOKIE_NAME = 'site-auth-token';

function isPublicAsset(pathname: string): boolean {
  return pathname.startsWith('/_next') || pathname.startsWith('/favicon');
}

function isPublicApi(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (pathname === '/api/auth') return true;
  if (request.method !== 'GET') return false;
  return PUBLIC_API_PATHS.has(pathname) || PUBLIC_EXCHANGE_READ_RE.test(pathname);
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function signAuthExpiry(expiresAt: number, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`v1:${expiresAt}`));
  return hex(signature);
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const secret = process.env.SITE_PASSWORD?.trim();
  if (!secret) return false;

  const value = request.cookies.get(SIGNED_AUTH_COOKIE_NAME)?.value;
  if (!value) return false;

  const [version, expiresRaw, signature] = value.split('.');
  if (version !== 'v1' || !expiresRaw || !signature) return false;

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const expected = await signAuthExpiry(expiresAt, secret);
  return safeEqual(signature, expected);
}

function unauthorizedApi() {
  return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicAsset(pathname) || PUBLIC_PAGE_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    if (isPublicApi(request) || await isAuthenticated(request)) {
      return NextResponse.next();
    }
    return unauthorizedApi();
  }

  if (await isAuthenticated(request)) {
    return NextResponse.next();
  }

  const loginUrl = new URL('/login', request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
