import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { auth0, isAuth0Configured } from '@/lib/auth0';

function buildReturnTo(request: NextRequest): string {
  const { pathname, search } = request.nextUrl;
  return `${pathname}${search}`;
}

export async function middleware(request: NextRequest) {
  if (!isAuth0Configured || !auth0) {
    return NextResponse.next();
  }

  const authResponse = await auth0.middleware(request);
  const { pathname } = request.nextUrl;

  const isAuthRoute = pathname === '/auth' || pathname.startsWith('/auth/');
  // Keep notification ingress reachable for local agent processes that are not browser-authenticated.
  const isNotificationIngress = pathname === '/api/notifications' && request.method === 'POST';

  if (isAuthRoute || isNotificationIngress) {
    return authResponse;
  }

  const session = await auth0.getSession(request);
  if (session) {
    return authResponse;
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const loginUrl = new URL('/auth/login', request.url);
  loginUrl.searchParams.set('returnTo', buildReturnTo(request));
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
