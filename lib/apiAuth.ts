import { NextResponse } from 'next/server';

export function isAuthenticatedRequest(request: Request): boolean {
  const cookieHeader = request.headers.get('cookie') ?? '';
  return cookieHeader.split(';').some((cookie) => {
    const [rawName, ...rawValue] = cookie.trim().split('=');
    if (rawName !== 'site-auth') return false;
    const value = rawValue.join('=');
    if (value === 'authenticated') return true;
    try {
      return decodeURIComponent(value) === 'authenticated';
    } catch {
      return false;
    }
  });
}

export function unauthorizedJson() {
  return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
}
