import crypto from 'crypto';
import { NextResponse } from 'next/server';

export const LEGACY_AUTH_COOKIE_NAME = 'site-auth';
export const SIGNED_AUTH_COOKIE_NAME = 'site-auth-token';
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function parseCookies(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const cookie of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = cookie.trim().split('=');
    if (!rawName) continue;
    const value = rawValue.join('=');
    try {
      cookies.set(rawName, decodeURIComponent(value));
    } catch {
      cookies.set(rawName, value);
    }
  }
  return cookies;
}

function authSecret(): string {
  return process.env.SITE_PASSWORD?.trim() ?? '';
}

function signAuthExpiry(expiresAt: number, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`v1:${expiresAt}`)
    .digest('hex');
}

function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  try {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

export function createSignedAuthCookieValue(now = Date.now()): string | null {
  const secret = authSecret();
  if (!secret) return null;

  const expiresAt = now + (AUTH_MAX_AGE_SECONDS * 1000);
  const signature = signAuthExpiry(expiresAt, secret);
  return `v1.${expiresAt}.${signature}`;
}

function isValidSignedAuthCookie(value: string | undefined): boolean {
  const secret = authSecret();
  if (!secret || !value) return false;

  const [version, expiresRaw, signature] = value.split('.');
  if (version !== 'v1' || !expiresRaw || !signature) return false;

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const expected = signAuthExpiry(expiresAt, secret);
  return safeEqualHex(signature, expected);
}

export function isAuthenticatedRequest(request: Request): boolean {
  const cookies = parseCookies(request.headers.get('cookie') ?? '');
  return isValidSignedAuthCookie(cookies.get(SIGNED_AUTH_COOKIE_NAME));
}

export function unauthorizedJson() {
  return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
}
